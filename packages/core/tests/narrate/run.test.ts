import { describe, it, expect } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempRepo } from '../helpers/repo.js'
import { narrate, planOnly } from '../../src/narrate/run.js'
import { newReviewId } from '../../src/state/paths.js'

describe('newReviewId', () => {
  it('由分支 slug、时间戳、毫秒与随机后缀组成', () => {
    const id = newReviewId('feat/charybdis', new Date(Date.UTC(2026, 8, 15, 6, 7, 8, 42)))
    expect(id).toMatch(/^feat-charybdis-20260915-\d{6}-042-[0-9a-f]{6}$/)
  })

  it('同一秒（甚至同一 Date 实例）内重复调用也不会撞出同一个 id（C1 回归）', () => {
    // reviewId 直接决定 refs/unfold/<reviewId>/round-NNN 这个 ref 名字；
    // 只精确到秒的话，同秒内重跑 narrate 会撞上同一个 reviewId，第二次跑
    // 覆盖第一轮钉住的快照 ref，第一轮快照就此失去唯一可达 ref，
    // 下次 gc 即被清除（spec §4.3 的可达性保证被打破）。
    const now = new Date(Date.UTC(2026, 8, 15, 6, 7, 8))
    const ids = new Set(Array.from({ length: 20 }, () => newReviewId('feat/charybdis', now)))
    expect(ids.size).toBe(20)
  })
})

describe('narrate 端到端', () => {
  it('从脏工作区产出叙事分支，字节一致，且原工作区零改动', async () => {
    const repo = await createTempRepo()
    await repo.write('src/types.ts', 'export type T = 1\n')
    await repo.write('src/engine.ts', 'export const run = () => 1\n')
    await repo.commit('base')
    await repo.git('checkout', '-q', '-b', 'feature')

    // agent 干完活但没 commit
    await repo.write('src/types.ts', 'export type T = 2\n')
    await repo.write('src/engine.ts', 'export const run = () => 2\n')
    await repo.write('src/added.ts', 'export const added = true\n')

    const statusBefore = await repo.git('status', '--porcelain')
    const headBefore = await repo.git('rev-parse', 'HEAD')

    const result = await narrate(repo.dir, { defaultBranch: 'main' })
    if (!result.hasChanges) throw new Error('测试构造了真实改动，不应该走到 hasChanges: false 分支')

    // 字节一致
    expect(await repo.git('rev-parse', `${result.tip}^{tree}`)).toBe(
      await repo.git('rev-parse', `${result.snapshot}^{tree}`),
    )
    // 原工作区零改动
    expect(await repo.git('status', '--porcelain')).toBe(statusBefore)
    expect(await repo.git('rev-parse', 'HEAD')).toBe(headBefore)
    expect(await repo.git('stash', 'list')).toBe('')

    // 产物齐全
    const planJson = JSON.parse(await readFile(join(result.reviewRoot, 'plan.json'), 'utf8')) as {
      version: number
      chapters: unknown[]
    }
    expect(planJson.version).toBe(1)
    expect(planJson.chapters.length).toBe(result.chapters)

    const meta = JSON.parse(await readFile(join(result.reviewRoot, 'meta.json'), 'utf8')) as {
      base: string
      branch: string
    }
    expect(meta.base).toBe(result.base)

    const tour = JSON.parse(
      await readFile(join(result.reviewRoot, 'tours', 'chapter-001.tour'), 'utf8'),
    ) as { steps: unknown[] }
    expect(tour.steps.length).toBeGreaterThan(0)

    // 快照被钉住，扛得过 gc
    await repo.git('reflog', 'expire', '--expire=now', '--all')
    await repo.git('gc', '--prune=now', '-q')
    expect(await repo.git('cat-file', '-t', result.snapshot)).toBe('commit')

    // worktree 挂在叙事分支上
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: result.worktree,
    })
    expect(stdout.trim()).toBe(result.branch)

    // worktree 真的挂在叙事的 tip 上，不是随便一个 tree 相同的 commit
    // （例如误挂到 snap.commit 上）——否则 `git log unfold/<id>` 会变成
    // 一个孤零零的 snapshot commit，章节链完全丢失，只验证分支名看不出来。
    const tipStdout = await run('git', ['rev-parse', 'HEAD'], { cwd: result.worktree })
    expect(tipStdout.stdout.trim()).toBe(result.tip)

    // 分支上恰好挂着 `chapters` 条章节 commit（base..tip 这一段），
    // 而不是塌缩成一个孤零零的 snapshot commit
    const logStdout = await run(
      'git',
      ['log', '--format=%H', `${result.base}..${result.branch}`],
      { cwd: repo.dir },
    )
    expect(logStdout.stdout.trim().split('\n').filter((l) => l !== '').length).toBe(
      result.chapters,
    )

    await rm(result.reviewRoot, { recursive: true, force: true })
    await repo.cleanup()
  })

  it('干净工作区上跑：不抛错，返回 hasChanges: false，不留下任何 review 状态（D3 回归）', async () => {
    const repo = await createTempRepo()
    await repo.write('src/types.ts', 'export type T = 1\n')
    await repo.commit('base')
    await repo.git('checkout', '-q', '-b', 'feature')
    // 不做任何改动——工作区相对 base 干干净净

    const result = await narrate(repo.dir, { defaultBranch: 'main' })

    expect(result.hasChanges).toBe(false)
    if (result.hasChanges) throw new Error('unreachable')
    expect(result.branch).toBe('feature')

    // 不该留下任何 review 状态目录（没有 reviewRoot 字段可用来清理，
    // 直接确认 XDG_STATE_HOME 下这个仓库对应的 repo-id 目录压根没被建出来）
    const { repoId } = await import('../../src/state/paths.js')
    const { homedir } = await import('node:os')
    const base = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state')
    const repoStateDir = join(base, 'unfold', await repoId(repo.dir))
    const { existsSync } = await import('node:fs')
    expect(existsSync(repoStateDir)).toBe(false)

    await repo.cleanup()
  })

  it('planOnly：算出 plan 就返回，不钉 ref、不建 worktree、不写状态目录', async () => {
    const repo = await createTempRepo()
    await repo.write('src/types.ts', 'export type T = 1\n')
    await repo.write('src/engine.ts', 'export const run = () => 1\n')
    await repo.commit('base')
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.write('src/types.ts', 'export type T = 2\n')
    await repo.write('src/added.ts', 'export const added = true\n')

    const statusBefore = await repo.git('status', '--porcelain')
    const result = await planOnly(repo.dir, { defaultBranch: 'main' })

    if (!result.hasChanges) throw new Error('期望算出 plan')
    expect(result.plan.chapters.length).toBeGreaterThan(0)
    expect(result.plan.chapters.every((c) => c.key.length > 0)).toBe(true)

    // 什么都不该落地
    expect(await repo.git('for-each-ref', 'refs/unfold')).toBe('')
    const worktreeLines = (await repo.git('worktree', 'list', '--porcelain'))
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
    expect(worktreeLines.length).toBe(1) // 只有仓库自己，没有额外注册的叙事 worktree
    expect(await repo.git('branch', '--list', 'unfold/*')).toBe('')
    expect(await repo.git('status', '--porcelain')).toBe(statusBefore)

    const { homedir } = await import('node:os')
    const { repoId } = await import('../../src/state/paths.js')
    const stateBase = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state')
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(stateBase, 'unfold', await repoId(repo.dir)))).toBe(false)

    await repo.cleanup()
  })

  it('--reuse：复用最近一次 review 目录，轮次递增，历轮快照都不被覆盖', async () => {
    const repo = await createTempRepo()
    await repo.write('src/types.ts', 'export type T = 1\n')
    await repo.write('src/engine.ts', 'export const run = () => 1\n')
    await repo.commit('base')
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.write('src/types.ts', 'export type T = 2\n')

    const first = await narrate(repo.dir, { defaultBranch: 'main' })
    if (!first.hasChanges) throw new Error('期望第一轮有改动')

    await repo.write('src/engine.ts', 'export const run = () => 2\n')
    const second = await narrate(repo.dir, { defaultBranch: 'main', reuse: true })
    if (!second.hasChanges) throw new Error('期望第二轮有改动')

    // 同一个 review：id、目录、叙事分支都不变
    expect(second.reviewId).toBe(first.reviewId)
    expect(second.reviewRoot).toBe(first.reviewRoot)
    expect(second.branch).toBe(first.branch)

    // 轮次递增，两轮快照各有自己的 ref
    const refs = (await repo.git('for-each-ref', '--format=%(refname)', 'refs/unfold'))
      .split('\n')
      .sort()
    expect(refs).toEqual([
      `refs/unfold/${first.reviewId}/round-001`,
      `refs/unfold/${first.reviewId}/round-002`,
    ])

    // 两轮快照都扛得过激进 gc —— 第一轮没有被第二轮覆盖掉
    await repo.git('reflog', 'expire', '--expire=now', '--all')
    await repo.git('gc', '--prune=now', '-q')
    expect(await repo.git('cat-file', '-t', first.snapshot)).toBe('commit')
    expect(await repo.git('cat-file', '-t', second.snapshot)).toBe('commit')

    // 没有堆出第二个 review 目录，也没有注册第二个 worktree
    const { listReviews } = await import('../../src/state/reviews.js')
    expect((await listReviews(repo.dir)).length).toBe(1)
    const worktreeLines = (await repo.git('worktree', 'list', '--porcelain'))
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
    expect(worktreeLines.length).toBe(2)

    // 叙事分支指向第二轮的 tip，且 worktree 挂在上面
    expect(await repo.git('rev-parse', second.branch)).toBe(second.tip)

    const { cleanReviews } = await import('../../src/state/cleanup.js')
    await cleanReviews(repo.dir)
    await repo.cleanup()
  })

  it('--reuse 但该仓库还没有任何 review：等同于新建一次', async () => {
    const repo = await createTempRepo()
    await repo.write('src/a.ts', 'export const a = 1\n')
    await repo.commit('base')
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.write('src/a.ts', 'export const a = 2\n')

    const result = await narrate(repo.dir, { defaultBranch: 'main', reuse: true })
    if (!result.hasChanges) throw new Error('期望有改动')
    expect(await repo.git('for-each-ref', '--format=%(refname)', 'refs/unfold')).toBe(
      `refs/unfold/${result.reviewId}/round-001`,
    )

    const { cleanReviews } = await import('../../src/state/cleanup.js')
    await cleanReviews(repo.dir)
    await repo.cleanup()
  })
})
