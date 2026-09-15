import { describe, it, expect } from 'vitest'
import { createTempRepo } from '../helpers/repo.js'
import { computeChanges } from '../../src/narrate/diff.js'
import { RulePlanner, classifyPath } from '../../src/narrate/rule-planner.js'
import type { PlanContext } from '../../src/narrate/plan.js'

async function ctxFor(files: Record<string, string>): Promise<PlanContext> {
  const repo = await createTempRepo()
  await repo.write('.keep', '')
  const base = await repo.commit('base')
  for (const [p, c] of Object.entries(files)) await repo.write(p, c)
  const head = await repo.commit('work')
  const changes = await computeChanges(repo.dir, base, head)
  await repo.cleanup()
  return { base, snapshot: head, changes }
}

describe('classifyPath', () => {
  it('按契约 / 核心 / 接线 / 测试文档归类', () => {
    expect(classifyPath('src/types.ts')).toBe('contract')
    expect(classifyPath('api/schema.json')).toBe('contract')
    expect(classifyPath('src/engine/replay.ts')).toBe('core')
    expect(classifyPath('src/index.ts')).toBe('wiring')
    expect(classifyPath('tests/replay.test.ts')).toBe('test-doc')
    expect(classifyPath('README.md')).toBe('test-doc')
  })
})

describe('RulePlanner', () => {
  it('按契约→核心→接线→测试文档排章，每个 hunk 恰好出现一次', async () => {
    const ctx = await ctxFor({
      'README.md': 'doc\n',
      'src/index.ts': 'export * from "./engine.js"\n',
      'src/types.ts': 'export type T = 1\n',
      'src/engine.ts': 'export const run = () => 1\n',
    })
    const plan = await new RulePlanner().plan(ctx)

    const titles = plan.chapters.map((c) => c.title)
    expect(titles[0]).toContain('契约')
    expect(titles[1]).toContain('核心')
    expect(titles[2]).toContain('接线')
    expect(titles[3]).toContain('测试与文档')

    const all = plan.chapters.flatMap((c) => c.hunkIds)
    const expected = ctx.changes.flatMap((c) => c.hunks.map((h) => h.id))
    expect(all.slice().sort()).toEqual(expected.slice().sort())
    expect(new Set(all).size).toBe(all.length)
  })

  it('章号从 1 连续，且每章都有非空导语', async () => {
    const ctx = await ctxFor({ 'src/a.ts': 'a\n', 'src/types.ts': 'b\n' })
    const plan = await new RulePlanner().plan(ctx)
    expect(plan.chapters.map((c) => c.index)).toEqual(
      plan.chapters.map((_, i) => i + 1),
    )
    for (const ch of plan.chapters) expect(ch.intro.length).toBeGreaterThan(0)
  })

  it('二进制文件没有 hunk，只能靠 filePaths 归入某一章；空「其余」章不应被造出来', async () => {
    const repo = await createTempRepo()
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await repo.write('.keep', '')
    const base = await repo.commit('base')
    await writeFile(join(repo.dir, 'img.bin'), Buffer.from([0, 1, 0, 2]))
    const head = await repo.commit('bin')
    const changes = await computeChanges(repo.dir, base, head)

    const plan = await new RulePlanner().plan({ base, snapshot: head, changes })
    const covered = plan.chapters.flatMap((c) => c.hunkIds)
    expect(covered).toEqual([])
    // img.bin 没有 hunk，必须靠 filePaths 才能验证它真的被覆盖
    const owner = plan.chapters.find((c) => c.filePaths.includes('img.bin'))
    expect(owner).toBeDefined()
    // classifyPath 是穷尽的，「其余」章恒为空，不应再被 materialize 成一个空章
    const last = plan.chapters.at(-1)!
    expect(last.hunkIds.length + last.filePaths.length).toBeGreaterThan(0)
    await repo.cleanup()
  })

  it('跨轮稳定：文件按 key（概念章节）保持归属，即便本轮分桶让 index 变化', async () => {
    // 第一轮：types.ts（contract）+ engine.ts（core）两个桶都非空
    const first = await ctxFor({ 'src/types.ts': 'a\n', 'src/engine.ts': 'b\n' })
    const firstPlan = await new RulePlanner().plan(first)
    const engineChapterFirst = firstPlan.chapters.find((c) =>
      c.filePaths.includes('src/engine.ts'),
    )!
    expect(engineChapterFirst.key).toBe('core')

    // 第二轮：只剩 engine.ts 一个改动，本轮自然分桶只有一个「核心」章，
    // 若拿上一轮的 index 当锚点会把它错误地拽进别的章（或不存在的兜底章）。
    const second = await ctxFor({ 'src/engine.ts': 'b2\n' })
    const secondPlan = await new RulePlanner().plan({ ...second, previous: firstPlan })
    const engineChapterSecond = secondPlan.chapters.find((c) =>
      c.filePaths.includes('src/engine.ts'),
    )!
    expect(engineChapterSecond.key).toBe('core')
    expect(engineChapterSecond.title).toContain('核心')
  })
})
