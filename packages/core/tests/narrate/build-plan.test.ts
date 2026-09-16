import { describe, it, expect } from 'vitest'
import { buildPlan } from '../../src/narrate/build-plan.js'
import { DEFAULT_RULES } from '../../src/narrate/rules.js'
import type { PlanContext } from '../../src/narrate/plan.js'
import type { Registry } from '../../src/narrate/registry.js'
import type { FileChange, Hunk } from '../../src/narrate/diff.js'

const hunk = (id: string): Hunk => ({ id, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] })
const change = (path: string, hunkIds: string[]): FileChange => ({
  path, kind: 'modify', binary: false, mode: '100644', blob: 'b',
  oldMode: '100644', oldBlob: 'o', hunks: hunkIds.map(hunk),
})

const registry = (chapters: Array<Partial<Registry['chapters'][number]>>): Registry => ({
  version: 1,
  chapters: chapters.map((c, i) => ({
    key: `k${i}`, index: i + 1, title: `T${i}`, intro: `I${i}`, status: 'active',
    members: [], keyRenamedFrom: null, createdRound: 1, lastActiveRound: 1, ...c,
  })),
})

const ctx = (over: Partial<PlanContext>): PlanContext => ({
  base: 'b', snapshot: 's', changes: [], rules: DEFAULT_RULES,
  canonical: new Map(), registry: registry([]), pinned: new Map(), deps: new Map(), ...over,
})

describe('buildPlan', () => {
  it('章节顺序与册一致，index 含空章、commitIndex 只数有内容的章', () => {
    const plan = buildPlan(ctx({
      changes: [change('a.ts', ['a.ts#0'])],
      canonical: new Map([['a.ts', 'a.ts']]),
      registry: registry([
        { key: 'a.ts', members: ['a.ts'], status: 'active' },
        { key: 'gone.ts', members: [], status: 'deleted' },
      ]),
    }), { byChapter: new Map() }, 'test')

    expect(plan.chapters.map((c) => c.index)).toEqual([1, 2])
    expect(plan.chapters.map((c) => c.commitIndex)).toEqual([1, null])
    expect(plan.chapters[1]?.status).toBe('deleted')
  })

  it('批注钉住的 hunk 回到批注所在章，哪怕它的文件归别的章', () => {
    const plan = buildPlan(ctx({
      changes: [change('a.ts', ['a.ts#0', 'a.ts#1'])],
      canonical: new Map([['a.ts', 'a.ts']]),
      registry: registry([
        { key: 'note.ts', members: ['note.ts'] },
        { key: 'a.ts', members: ['a.ts'] },
      ]),
      pinned: new Map([['a.ts#0', 'note.ts']]),
    }), { byChapter: new Map() }, 'test')

    expect(plan.chapters[0]?.hunkIds).toEqual(['a.ts#0'])
    expect(plan.chapters[1]?.hunkIds).toEqual(['a.ts#1'])
  })

  it('文件落在「它最后一个 hunk 所在的章」，replay 靠这条达到终态', () => {
    const plan = buildPlan(ctx({
      changes: [change('a.ts', ['a.ts#0', 'a.ts#1'])],
      canonical: new Map([['a.ts', 'a.ts']]),
      registry: registry([
        { key: 'note.ts', members: ['note.ts'] },
        { key: 'a.ts', members: ['a.ts'] },
      ]),
      pinned: new Map([['a.ts#1', 'note.ts']]),
    }), { byChapter: new Map() }, 'test')

    // 最后一个 hunk 被钉到第 1 章 ⇒ 文件在第 1 章达到终态
    expect(plan.chapters[0]?.filePaths).toEqual(['a.ts'])
    expect(plan.chapters[1]?.filePaths).toEqual([])
  })

  it('测试文件跟着它的实现进同一章', () => {
    const plan = buildPlan(ctx({
      changes: [change('src/a.ts', ['src/a.ts#0']), change('tests/a.test.ts', ['tests/a.test.ts#0'])],
      canonical: new Map([['src/a.ts', 'src/a.ts'], ['tests/a.test.ts', 'src/a.ts']]),
      registry: registry([{ key: 'src/a.ts', members: ['src/a.ts'] }]),
    }), { byChapter: new Map() }, 'test')

    expect(plan.chapters[0]?.filePaths).toEqual(['src/a.ts', 'tests/a.test.ts'])
  })

  it('有文件没被任何章认领时抛错，指名是哪个', () => {
    expect(() => buildPlan(ctx({
      changes: [change('orphan.ts', ['orphan.ts#0'])],
      canonical: new Map([['orphan.ts', 'orphan.ts']]),
      registry: registry([{ key: 'a.ts', members: ['a.ts'] }]),
    }), { byChapter: new Map() }, 'test')).toThrow(/orphan\.ts/)
  })

  it('rules.titles 覆盖自动生成的标题', () => {
    const plan = buildPlan(ctx({
      changes: [change('a.ts', ['a.ts#0'])],
      canonical: new Map([['a.ts', 'a.ts']]),
      registry: registry([{ key: 'a.ts', members: ['a.ts'] }]),
      rules: { ...DEFAULT_RULES, titles: { 'a.ts': { title: '手写的标题' } } },
    }), { byChapter: new Map() }, 'test')

    expect(plan.chapters[0]?.title).toBe('手写的标题')
  })
})
