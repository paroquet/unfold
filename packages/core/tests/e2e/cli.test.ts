import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
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
    await expect(cli(repo.dir, '--base', '--default-branch')).rejects.toMatchObject({ code: 2 })
    await repo.cleanup()
  })
})
