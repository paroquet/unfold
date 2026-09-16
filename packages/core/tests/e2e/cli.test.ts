import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { createTempRepo, type TempRepo } from '../helpers/repo.js'

const execFileAsync = promisify(execFile)

// tests/e2e/ → packages/core/
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = join(PKG, 'dist', 'bin', 'unfold.js')

/** 跑真实的 CLI（`pnpm build` 的产物），返回 stdout。 */
async function cli(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [CLI, 'narrate', '--repo', repo, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
}

async function dirtyRepo(): Promise<TempRepo> {
  const repo = await createTempRepo()
  await repo.write('src/types.ts', 'export type T = 1\n')
  await repo.write('src/engine.ts', 'export const run = () => 1\n')
  await repo.write('tests/a.test.ts', 'ok\n')
  await repo.commit('base')
  await repo.git('checkout', '-q', '-b', 'feature')
  await repo.write('src/types.ts', 'export type T = 2\n')
  await repo.write('src/added.ts', 'export const added = true\n')
  return repo
}

describe('unfold narrate（真实 CLI）', () => {
  it('dist/bin/unfold.js 存在——e2e 跑的是构建产物而不是源码', () => {
    expect(existsSync(CLI)).toBe(true)
  })

  it('--dry-run 打印分章但什么都不落地', async () => {
    const repo = await dirtyRepo()
    const stdout = await cli(repo.dir, '--default-branch', 'main', '--dry-run')

    expect(stdout).toContain('dry-run')
    expect(stdout).toContain('src/types.ts')
    expect(await repo.git('for-each-ref', 'refs/unfold')).toBe('')
    expect(await repo.git('branch', '--list', 'unfold/*')).toBe('')

    await repo.cleanup()
  })

  it('正式跑：打印的每条「怎么看」命令都能真的执行', async () => {
    const repo = await dirtyRepo()
    const stdout = await cli(repo.dir, '--default-branch', 'main')

    // 按人真实粘贴的方式切：注释的分隔符是「两个空格 + #」。
    // 不要用 lastIndexOf('#') 去切——那等于先把粘连的坏输出净化一遍再执行，
    // 测试就再也测不出「注释紧贴命令末尾」这类格式缺陷了。
    const gitCommands = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('git -C '))
      .map((l) => {
        const at = l.indexOf('  #')
        return (at < 0 ? l : l.slice(0, at)).trim()
      })
    expect(gitCommands.length).toBeGreaterThan(1)

    // 逐条真的跑一遍——命令里若混进了注释符或缺空格，这里会炸
    for (const command of gitCommands) {
      const parts = command.split(/\s+/).slice(1) // 去掉开头的 'git'
      await execFileAsync('git', parts, { maxBuffer: 64 * 1024 * 1024 })
    }

    await cli(repo.dir, '--clean')
    await repo.cleanup()
  })

  it('--compare latest 比的是上一轮，而不是本轮自己', async () => {
    const repo = await dirtyRepo()
    await cli(repo.dir, '--default-branch', 'main')

    // 第二轮引入一个会落到新章节的文件
    await repo.write('tests/new.test.ts', 'fresh\n')
    const stdout = await cli(repo.dir, '--default-branch', 'main', '--reuse', '--compare', 'latest')

    expect(stdout).toContain('与 latest 对比')
    expect(stdout).toContain('tests/new.test.ts')
    expect(stdout).not.toContain('文件归属没有变化')

    await cli(repo.dir, '--clean')
    await repo.cleanup()
  })

  it('--clean 清掉 review 与快照 ref，但不删叙事分支', async () => {
    const repo = await dirtyRepo()
    await cli(repo.dir, '--default-branch', 'main')
    expect(await repo.git('for-each-ref', 'refs/unfold')).not.toBe('')

    const stdout = await cli(repo.dir, '--clean')
    expect(stdout).toContain('已清理')
    expect(await repo.git('for-each-ref', 'refs/unfold')).toBe('')
    expect(await repo.git('branch', '--list', 'unfold/*')).not.toBe('')

    await repo.cleanup()
  })

  it('参数写错时给 usage 并以退出码 2 结束，不炸出 git 原始报错', async () => {
    const repo = await createTempRepo()
    const err = await cli(repo.dir, '--base', '--default-branch').then(
      () => {
        throw new Error('期望以退出码 2 失败')
      },
      (e: { code?: number; stderr?: string }) => e,
    )
    expect(err.code).toBe(2)
    expect(err.stderr).toContain('--reset-chapters')
    // v1 的「内置四层」已经删了，usage 里不该还留着它的说法
    expect(err.stderr).not.toContain('四层')
    await repo.cleanup()
  })

  it('--dry-run --reset-chapters：丢册重推、依赖证据与体检提示都打出来，且不落盘', async () => {
    const repo = await createTempRepo()
    await repo.write('src/a.ts', 'export const a = 1\n')
    await repo.commit('base')
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.write('src/a.ts', 'export const a = 2\n')
    // 提交它，好让下面能把 main 快进到这一步——否则 a.ts 的改动永远相对
    // main 存在，没法在下一轮的 diff 里真正消失
    await repo.commit('touch a')

    // 第一轮：真跑，把 a.ts 的章节记进册（--reuse 让后面的轮次落在同一个 review 上）
    const first = await cli(repo.dir, '--default-branch', 'main', '--reuse')
    const rootLine = first.split('\n').find((l) => l.startsWith('状态目录'))
    expect(rootLine).toBeDefined()
    const reviewRoot = (rootLine as string).replace('状态目录', '').trim()
    const registryPath = join(reviewRoot, 'registry.json')
    const registryBefore = await readFile(registryPath, 'utf8')

    // 把 main 快进到 a.ts 的改动上——下一轮 feature 相对 main 的 diff 里
    // a.ts 会彻底消失（内容与 main 一致了），但它在册里的章是历史记录，
    // 不会因为这一轮没改就被册悄悄忘掉
    await repo.git('checkout', 'main')
    await repo.git('merge', '--ff-only', 'feature')
    await repo.git('checkout', 'feature')

    // 第二轮：只新增一个不相关的文件；a.ts 已经不在 diff 里了，它在册里的
    // 旧章应该以「本轮无改动」的空章形式继续出现（除非 --reset-chapters）
    await repo.write('src/b.ts', 'export const b = 1\n')

    const withoutReset = await cli(repo.dir, '--default-branch', 'main', '--reuse', '--dry-run')
    expect(withoutReset).toContain('本轮无改动') // a.ts 的旧章沿用下来，成了空章
    expect(withoutReset).toContain('依赖证据') // 罩住 depGraph/cycles 的接线
    expect(withoutReset).toContain('建议')
    expect(withoutReset).toContain('提示') // 罩住 warnings 的接线（b.ts 有实现无测试）

    const withReset = await cli(
      repo.dir,
      '--default-branch',
      'main',
      '--reuse',
      '--dry-run',
      '--reset-chapters',
    )
    // 丢册重推：a.ts 那个不属于本轮改动的旧章不会被凭空造出来
    expect(withReset).not.toContain('本轮无改动')
    // spec §5.5：唯一能让章节消失的操作，得交代它影响了多少条批注
    expect(withReset).toContain('已丢弃章节册重新推导')
    expect(withoutReset).not.toContain('已丢弃章节册重新推导')
    expect(withReset).toContain('依赖证据')
    expect(withReset).toContain('建议')
    expect(withReset).toContain('提示')

    // dry-run 不落盘：不管带不带 --reset-chapters，registry.json 字节都没变过
    const registryAfter = await readFile(registryPath, 'utf8')
    expect(registryAfter).toBe(registryBefore)

    await cli(repo.dir, '--clean')
    await repo.cleanup()
  })
})
