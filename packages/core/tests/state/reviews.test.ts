import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'

import { createTempRepo } from '../helpers/repo.js'
import { narrate } from '../../src/narrate/run.js'
import { listReviews, readPlan } from '../../src/state/reviews.js'
import { cleanReviews } from '../../src/state/cleanup.js'
import { repoStateDir } from '../../src/state/paths.js'

async function dirtyRepo(): Promise<Awaited<ReturnType<typeof createTempRepo>>> {
  const repo = await createTempRepo()
  await repo.write('src/types.ts', 'export type T = 1\n')
  await repo.write('src/engine.ts', 'export const run = () => 1\n')
  await repo.commit('base')
  await repo.git('checkout', '-q', '-b', 'feature')
  await repo.write('src/types.ts', 'export type T = 2\n')
  return repo
}

describe('listReviews', () => {
  it('没有任何 review 时返回空数组，而不是抛错', async () => {
    const repo = await dirtyRepo()
    expect(await listReviews(repo.dir)).toEqual([])
    await repo.cleanup()
  })

  it('按时间倒序列出 review，最新的在前', async () => {
    const repo = await dirtyRepo()
    const first = await narrate(repo.dir, { defaultBranch: 'main' })
    await repo.write('src/engine.ts', 'export const run = () => 2\n')
    const second = await narrate(repo.dir, { defaultBranch: 'main' })
    if (!first.hasChanges || !second.hasChanges) throw new Error('期望两次都有改动')

    const reviews = await listReviews(repo.dir)
    expect(reviews.map((r) => r.reviewId)).toEqual([second.reviewId, first.reviewId])
    expect(reviews[0]!.root).toBe(second.reviewRoot)

    await cleanReviews(repo.dir)
    await repo.cleanup()
  })
})

describe('readPlan', () => {
  it('读得回某一次 review 落盘的 plan.json', async () => {
    const repo = await dirtyRepo()
    const result = await narrate(repo.dir, { defaultBranch: 'main' })
    if (!result.hasChanges) throw new Error('期望有改动')

    const plan = await readPlan(repo.dir, result.reviewId)
    expect(plan.version).toBe(1)
    expect(plan.chapters.length).toBe(result.chapters)

    await cleanReviews(repo.dir)
    await repo.cleanup()
  })

  it("'latest' 解析为最近一次 review", async () => {
    const repo = await dirtyRepo()
    await narrate(repo.dir, { defaultBranch: 'main' })
    await repo.write('src/added.ts', 'export const x = 1\n')
    const second = await narrate(repo.dir, { defaultBranch: 'main' })
    if (!second.hasChanges) throw new Error('期望有改动')

    const plan = await readPlan(repo.dir, 'latest')
    expect(plan.snapshot).toBe(second.snapshot)

    await cleanReviews(repo.dir)
    await repo.cleanup()
  })

  it('reviewId 不存在时抛错，不静默返回空 plan', async () => {
    const repo = await dirtyRepo()
    await expect(readPlan(repo.dir, 'nope-20260101-000000-000-aaaaaa')).rejects.toThrow()
    await repo.cleanup()
  })
})

describe('cleanReviews', () => {
  it('删掉全部 review 目录、注销 worktree、清掉 refs/unfold', async () => {
    const repo = await dirtyRepo()
    const first = await narrate(repo.dir, { defaultBranch: 'main' })
    await repo.write('src/engine.ts', 'export const run = () => 3\n')
    const second = await narrate(repo.dir, { defaultBranch: 'main' })
    if (!first.hasChanges || !second.hasChanges) throw new Error('期望两次都有改动')

    expect(await repo.git('for-each-ref', 'refs/unfold')).not.toBe('')

    const cleaned = await cleanReviews(repo.dir)
    expect(cleaned.removedReviews.sort()).toEqual([first.reviewId, second.reviewId].sort())
    expect(cleaned.removedRefs.length).toBeGreaterThan(0)

    expect(existsSync(first.reviewRoot)).toBe(false)
    expect(existsSync(second.reviewRoot)).toBe(false)
    expect(await repo.git('for-each-ref', 'refs/unfold')).toBe('')
    const worktreeLines = (await repo.git('worktree', 'list', '--porcelain'))
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
    expect(worktreeLines.length).toBe(1)

    await repo.cleanup()
  })

  it('没有任何 review 时是无操作，不抛错', async () => {
    const repo = await dirtyRepo()
    const cleaned = await cleanReviews(repo.dir)
    expect(cleaned).toEqual({ removedReviews: [], removedRefs: [] })
    expect(existsSync(await repoStateDir(repo.dir))).toBe(false)
    await repo.cleanup()
  })
})
