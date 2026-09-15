import { describe, it, expect } from 'vitest'
import { createTempRepo } from '../helpers/repo.js'
import { snapshot, pinSnapshot, unpinReview } from '../../src/git/snapshot.js'

describe('snapshot', () => {
  it('抓到已跟踪文件的改动', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'base\n')
    await repo.commit('base')
    await repo.write('a.txt', 'changed\n')

    const snap = await snapshot(repo.dir)
    const content = await repo.git('cat-file', 'blob', `${snap.commit}:a.txt`)
    expect(content).toBe('changed')
    await repo.cleanup()
  })

  it('抓到未跟踪的新文件', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'base\n')
    await repo.commit('base')
    await repo.write('new.txt', 'brand new\n')

    const snap = await snapshot(repo.dir)
    const files = await repo.git('ls-tree', '-r', '--name-only', snap.commit)
    expect(files.split('\n')).toContain('new.txt')
    await repo.cleanup()
  })

  it('排除 gitignore 命中的文件', async () => {
    const repo = await createTempRepo()
    await repo.write('.gitignore', 'ignored.txt\n')
    await repo.commit('gitignore')
    await repo.write('ignored.txt', 'nope\n')

    const snap = await snapshot(repo.dir)
    const files = await repo.git('ls-tree', '-r', '--name-only', snap.commit)
    expect(files.split('\n')).not.toContain('ignored.txt')
    await repo.cleanup()
  })

  it('零干扰：工作区、index、stash 栈都不变，临时 index 不进 tree 也不残留', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'base\n')
    await repo.commit('base')
    await repo.write('a.txt', 'dirty\n')
    await repo.write('untracked.txt', 'u\n')

    const statusBefore = await repo.git('status', '--porcelain')
    const stashBefore = await repo.git('stash', 'list')

    const snap = await snapshot(repo.dir)

    expect(await repo.git('status', '--porcelain')).toBe(statusBefore)
    expect(await repo.git('stash', 'list')).toBe(stashBefore)
    expect(await repo.git('diff', '--cached', '--name-only')).toBe('')

    const files = (await repo.git('ls-tree', '-r', '--name-only', snap.commit)).split('\n')
    expect(files.some((f) => f.includes('unfold-snapshot-index'))).toBe(false)

    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const gitDir = await repo.git('rev-parse', '--absolute-git-dir')
    expect(existsSync(join(gitDir, 'unfold-snapshot-index'))).toBe(false)
    await repo.cleanup()
  })

  it('parent 是 HEAD，tree 是快照 tree', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'base\n')
    const head = await repo.commit('base')
    await repo.write('a.txt', 'dirty\n')

    const snap = await snapshot(repo.dir)
    expect(snap.parent).toBe(head)
    expect(await repo.git('rev-parse', `${snap.commit}^{tree}`)).toBe(snap.tree)
    await repo.cleanup()
  })
})

describe('pinSnapshot', () => {
  it('钉住之后快照能扛过激进 gc，unpin 之后不再可达', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'base\n')
    await repo.commit('base')
    await repo.write('a.txt', 'dirty\n')

    const snap = await snapshot(repo.dir)
    const ref = await pinSnapshot(repo.dir, 'rev-1', 1, snap.commit)
    expect(ref).toBe('refs/unfold/rev-1/round-001')

    await repo.git('reflog', 'expire', '--expire=now', '--all')
    await repo.git('gc', '--prune=now', '-q')
    expect(await repo.git('cat-file', '-t', snap.commit)).toBe('commit')

    await unpinReview(repo.dir, 'rev-1')
    expect(await repo.git('for-each-ref', 'refs/unfold/rev-1')).toBe('')
    await repo.cleanup()
  })
})
