import { describe, it, expect } from 'vitest'
import { mkdtemp, rm as fsRm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTempRepo } from '../helpers/repo.js'
import { repoId } from '../../src/state/paths.js'

describe('repoId', () => {
  it('主 checkout 与它的 linked worktree 必须解出同一个 repo-id（spec §8.1）', async () => {
    // repoId 依赖 --git-common-dir 而非 --absolute-git-dir。在一个 linked
    // worktree 里，--absolute-git-dir 返回 `.git/worktrees/<uuid>`（每个
    // worktree 各不相同），只有 --git-common-dir 才会两边都指回同一个
    // `.git`。这个回归在单 worktree 环境下永远测不出来，必须真的建一个
    // linked worktree 才能暴露。
    const repo = await createTempRepo()
    await repo.write('a.txt', 'base\n')
    const head = await repo.commit('base')

    const linkedParent = await mkdtemp(join(tmpdir(), 'unfold-linked-wt-'))
    const linkedPath = join(linkedParent, 'linked')
    await repo.git('worktree', 'add', '-q', '--detach', linkedPath, head)

    try {
      const idFromMain = await repoId(repo.dir)
      const idFromLinked = await repoId(linkedPath)
      expect(idFromLinked).toBe(idFromMain)
    } finally {
      await repo.git('worktree', 'remove', '--force', linkedPath)
      await repo.git('worktree', 'prune')
      await fsRm(linkedParent, { recursive: true, force: true })
    }

    await repo.cleanup()
  })
})
