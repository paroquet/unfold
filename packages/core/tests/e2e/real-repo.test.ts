import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { narrate } from '../../src/narrate/run.js'
import { cleanReviews } from '../../src/state/cleanup.js'
import { git } from '../../src/git/exec.js'

const execFileAsync = promisify(execFile)

/**
 * 对**真实仓库**跑一遍，断言四条产品承诺。
 *
 * 合成的临时仓库构造不出真实工程里的东西：submodule、符号链接、权限位、
 * 超大 diff、非 ASCII 路径、几百个文件的改动。这个用例就是拿来撞这些的。
 *
 * 用法：`UNFOLD_E2E_REPO=/path/to/dirty/workspace pnpm test:e2e`
 * 未设该环境变量时整组跳过——它需要一个你指定的、带未提交改动的工作区。
 */
const REPO = process.env['UNFOLD_E2E_REPO']

describe.skipIf(REPO === undefined)('真实仓库端到端', () => {
  it('四条产品承诺在真实仓库上同样成立', async () => {
    const repo = REPO as string
    expect(existsSync(repo), `UNFOLD_E2E_REPO 指向的目录不存在：${repo}`).toBe(true)

    const statusBefore = await git(repo, ['status', '--porcelain'])
    const headBefore = await git(repo, ['rev-parse', 'HEAD'])
    const stashBefore = await git(repo, ['stash', 'list'])

    expect(
      statusBefore !== '',
      'UNFOLD_E2E_REPO 指向的工作区是干净的，没有可叙的改动——请指一个 agent 刚干完活的 worktree',
    ).toBe(true)

    const result = await narrate(repo, {})
    if (!result.hasChanges) throw new Error('期望有改动')

    try {
      // 承诺 1：零干扰——原工作区逐字节未变
      expect(await git(repo, ['status', '--porcelain'])).toBe(statusBefore)
      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(headBefore)
      expect(await git(repo, ['stash', 'list'])).toBe(stashBefore)

      // 承诺 2：字节一致
      expect(await git(repo, ['rev-parse', `${result.tip}^{tree}`])).toBe(
        await git(repo, ['rev-parse', `${result.snapshot}^{tree}`]),
      )

      // 承诺 3：产物齐全，且全在仓库外
      for (const rel of ['meta.json', 'plan.json', 'worktree']) {
        expect(existsSync(`${result.reviewRoot}/${rel}`), `缺少产物 ${rel}`).toBe(true)
      }
      expect(result.reviewRoot.startsWith(repo)).toBe(false)

      // 承诺 4：叙事 worktree 真的挂在 tip 上，且章节链长度与 plan 一致
      const { stdout } = await execFileAsync(
        'git',
        ['-C', result.worktree, 'rev-parse', 'HEAD'],
        { maxBuffer: 16 * 1024 * 1024 },
      )
      expect(stdout.trim()).toBe(result.tip)
      const log = await git(repo, [
        'log',
        '--format=%H',
        `${result.base}..${result.branch}`,
      ])
      expect(log.split('\n').filter((l) => l !== '').length).toBe(result.chapters)
    } finally {
      // 清理干净：review 目录 + 快照 ref + 我们建出来的叙事分支
      await cleanReviews(repo)
      await git(repo, ['branch', '-D', result.branch]).catch(() => undefined)
    }
  }, 300_000)
})
