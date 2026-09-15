import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { createTempRepo } from '../helpers/repo.js'
import { git } from '../../src/git/exec.js'

describe('git()', () => {
  it('忽略环境里已设的 GIT_DIR，只认传入的 cwd（C2 回归）', async () => {
    // 「所有 git 子进程调用必须显式传 cwd」这条约束，在环境里存在 GIT_DIR
    // 时会被 git 自己推翻——git 优先信环境变量。本工具的目标场景恰恰是被
    // agent / orca / git hook 拉起，这些环境里 GIT_DIR 很可能是设着的；
    // 一旦如此，Unfold 会操作到另一个仓库上，零干扰承诺直接失效。
    const repo = await createTempRepo()
    await repo.write('a.txt', 'in-repo\n')
    const head = await repo.commit('base')

    const other = await createTempRepo()
    await other.write('b.txt', 'other-repo\n')
    await other.commit('other-base')

    const savedGitDir = process.env['GIT_DIR']
    process.env['GIT_DIR'] = join(other.dir, '.git')
    try {
      // 若 git() 没清洗 GIT_DIR，这里会解析出 other 仓库的 HEAD
      const resolved = await git(repo.dir, ['rev-parse', 'HEAD'])
      expect(resolved).toBe(head)
    } finally {
      if (savedGitDir === undefined) delete process.env['GIT_DIR']
      else process.env['GIT_DIR'] = savedGitDir
    }

    await repo.cleanup()
    await other.cleanup()
  })

  it('调用点仍可通过 opts.env 主动注入 GIT_INDEX_FILE 等变量（不破坏 snapshot / replay 的用法）', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'base\n')
    await repo.commit('base')

    const { join: pathJoin } = await import('node:path')
    const gitDir = await git(repo.dir, ['rev-parse', '--absolute-git-dir'])
    const indexPath = pathJoin(gitDir, 'exec-test-index')
    const env = { GIT_INDEX_FILE: indexPath }

    await git(repo.dir, ['read-tree', 'HEAD'], { env })
    const tree = await git(repo.dir, ['write-tree'], { env })
    expect(tree).toMatch(/^[0-9a-f]{40}$/)

    const { rm } = await import('node:fs/promises')
    await rm(indexPath, { force: true })
    await repo.cleanup()
  })
})
