import { describe, it, expect } from 'vitest'
import { createTempRepo } from '../helpers/repo.js'
import { resolveBase } from '../../src/git/range.js'

describe('resolveBase', () => {
  it('显式指定时原样解析成 sha', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', '1\n')
    const first = await repo.commit('first')
    await repo.write('a.txt', '2\n')
    await repo.commit('second')

    const r = await resolveBase(repo.dir, { explicit: first })
    expect(r).toEqual({ base: first, source: 'explicit' })
    await repo.cleanup()
  })

  it('有 upstream 时取与 upstream 的 merge-base', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', '1\n')
    const forkPoint = await repo.commit('base')
    await repo.git('branch', 'origin-main')
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.git('config', 'branch.feature.remote', '.')
    await repo.git('config', 'branch.feature.merge', 'refs/heads/origin-main')
    await repo.write('a.txt', '2\n')
    await repo.commit('work')

    const r = await resolveBase(repo.dir)
    expect(r).toEqual({ base: forkPoint, source: 'upstream' })
    await repo.cleanup()
  })

  it('无 upstream 时退到与默认分支的 merge-base', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', '1\n')
    const forkPoint = await repo.commit('base')
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.write('a.txt', '2\n')
    await repo.commit('work')

    const r = await resolveBase(repo.dir, { defaultBranch: 'main' })
    expect(r).toEqual({ base: forkPoint, source: 'default-branch' })
    await repo.cleanup()
  })

  it('默认分支不存在或就在当前分支上时退到 HEAD', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', '1\n')
    const head = await repo.commit('only')

    const r = await resolveBase(repo.dir, { defaultBranch: 'nonexistent' })
    expect(r).toEqual({ base: head, source: 'head' })
    await repo.cleanup()
  })
})
