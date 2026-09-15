import { describe, it, expect } from 'vitest'
import { createTempRepo } from '../helpers/repo.js'
import { computeChanges } from '../../src/narrate/diff.js'
import type { FileChange } from '../../src/narrate/diff.js'
import { RulePlanner, classifyPath, pinToPreviousChapters } from '../../src/narrate/rule-planner.js'
import type { Plan, PlanContext } from '../../src/narrate/plan.js'

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

  it('跨轮稳定：previous 的归属与本轮自然分类冲突时，钉回 previous 的章而非自然归属', async () => {
    // src/engine.ts 的自然归属（classifyPath）是 core。构造一个「上一轮由 AI
    // planner 排章」的 previous（spec §9.2：AI 不可用时回落到 RulePlanner，
    // 此时 previous 的 key 来自 AI、可能与规则的自然归属不一致——这正是跨轮
    // 稳定机制唯一有用武之地的场景）：AI 把 engine.ts 放进了 contract 章。
    const ctx = await ctxFor({ 'src/types.ts': 'a\n', 'src/engine.ts': 'b\n' })
    const previous: Plan = {
      version: 1,
      base: ctx.base,
      snapshot: ctx.snapshot,
      plannerId: 'ai-stub',
      chapters: [
        {
          index: 1,
          key: 'contract',
          title: '契约与核心（AI 排的章）',
          intro: 'AI 把这两个文件放进了同一章。',
          hunkIds: ctx.changes.flatMap((c) => c.hunks.map((h) => h.id)),
          filePaths: ['src/types.ts', 'src/engine.ts'],
        },
      ],
    }

    const plan = await new RulePlanner().plan({ ...ctx, previous })

    const contractChapter = plan.chapters.find((c) => c.key === 'contract')!
    const coreChapter = plan.chapters.find((c) => c.key === 'core')
    expect(contractChapter.filePaths).toContain('src/engine.ts')
    expect(coreChapter?.filePaths.includes('src/engine.ts')).not.toBe(true)

    // 钉回去之后，engine.ts 不能同时出现在两个章的 filePaths 里，也不能丢失
    const owners = plan.chapters.filter((c) => c.filePaths.includes('src/engine.ts'))
    expect(owners.length).toBe(1)
  })
})

describe('pinToPreviousChapters（可独立单测的跨轮收敛函数）', () => {
  function fakeChange(path: string): FileChange {
    return {
      path,
      kind: 'modify',
      binary: false,
      mode: '100644',
      blob: 'deadbeef',
      oldMode: '100644',
      oldBlob: 'beadfeed',
      hunks: [{ id: `${path}#0`, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' x'] }],
    }
  }

  it('把文件从当前章搬到 previous 记录的 key 所在章，不重复、不丢失', () => {
    const chapters = [
      { index: 1, key: 'core', title: '核心', intro: 'x', hunkIds: ['src/engine.ts#0'], filePaths: ['src/engine.ts'] },
      { index: 2, key: 'contract', title: '契约', intro: 'x', hunkIds: [], filePaths: [] },
    ]
    const previous: Plan = {
      version: 1,
      base: 'b',
      snapshot: 's',
      plannerId: 'ai-stub',
      chapters: [
        {
          index: 1,
          key: 'contract',
          title: '契约（AI 排的章）',
          intro: 'x',
          hunkIds: ['src/engine.ts#0'],
          filePaths: ['src/engine.ts'],
        },
      ],
    }

    pinToPreviousChapters(chapters, [fakeChange('src/engine.ts')], previous)

    const core = chapters.find((c) => c.key === 'core')!
    const contract = chapters.find((c) => c.key === 'contract')!
    expect(contract.filePaths).toEqual(['src/engine.ts'])
    expect(contract.hunkIds).toEqual(['src/engine.ts#0'])
    expect(core.filePaths).toEqual([])
    expect(core.hunkIds).toEqual([])

    const owners = chapters.filter((c) => c.filePaths.includes('src/engine.ts'))
    expect(owners.length).toBe(1)
  })

  it('previous 为 undefined 或其 key 在本轮不存在时，什么都不做', () => {
    const chapters = [
      { index: 1, key: 'core', title: '核心', intro: 'x', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
    ]
    pinToPreviousChapters(chapters, [fakeChange('a.ts')], undefined)
    expect(chapters[0]!.filePaths).toEqual(['a.ts'])

    const previousWithUnknownKey: Plan = {
      version: 1,
      base: 'b',
      snapshot: 's',
      plannerId: 'ai-stub',
      chapters: [
        { index: 1, key: 'wiring', title: '接线', intro: 'x', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
      ],
    }
    pinToPreviousChapters(chapters, [fakeChange('a.ts')], previousWithUnknownKey)
    // 本轮没有 key 为 wiring 的章，不能凭空造一个出来，文件原地不动
    expect(chapters[0]!.filePaths).toEqual(['a.ts'])
    expect(chapters.length).toBe(1)
  })
})
