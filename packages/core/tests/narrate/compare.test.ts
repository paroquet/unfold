import { describe, it, expect } from 'vitest'
import { comparePlans } from '../../src/narrate/compare.js'
import type { Chapter, Plan } from '../../src/narrate/plan.js'

function ch(key: string, index: number, filePaths: string[]): Chapter {
  return { key, index, title: key, intro: 'i', hunkIds: [], filePaths }
}
function plan(chapters: Chapter[]): Plan {
  return {
    version: 1,
    base: 'a'.repeat(40),
    snapshot: 'b'.repeat(40),
    plannerId: 'test',
    chapters,
  }
}

describe('comparePlans', () => {
  it('两个 plan 完全一致时没有任何差异', () => {
    const p = plan([ch('contract', 1, ['a.ts']), ch('core', 2, ['b.ts'])])
    expect(comparePlans(p, p)).toEqual({
      chaptersBefore: 2,
      chaptersAfter: 2,
      moved: [],
      added: [],
      removed: [],
    })
  })

  it('文件换章时报 moved，并给出前后的 key', () => {
    const before = plan([ch('contract', 1, ['a.ts']), ch('core', 2, ['b.ts'])])
    const after = plan([ch('contract', 1, ['a.ts', 'b.ts'])])
    const d = comparePlans(before, after)
    expect(d.moved).toEqual([{ path: 'b.ts', from: 'core', to: 'contract' }])
    expect(d.chaptersBefore).toBe(2)
    expect(d.chaptersAfter).toBe(1)
  })

  it('新增与消失的文件分别进 added / removed，而不是算成 moved', () => {
    const before = plan([ch('core', 1, ['gone.ts', 'stay.ts'])])
    const after = plan([ch('core', 1, ['stay.ts', 'fresh.ts'])])
    const d = comparePlans(before, after)
    expect(d.added).toEqual(['fresh.ts'])
    expect(d.removed).toEqual(['gone.ts'])
    expect(d.moved).toEqual([])
  })

  it('只有章号变了、key 没变，不算 moved（位置序号跨轮本就会合法变动）', () => {
    const before = plan([ch('contract', 1, ['a.ts']), ch('core', 2, ['b.ts'])])
    const after = plan([ch('core', 1, ['b.ts'])])
    const d = comparePlans(before, after)
    expect(d.moved).toEqual([])
    expect(d.removed).toEqual(['a.ts'])
  })

  it('moved / added / removed 均按路径升序，输出稳定可比', () => {
    const before = plan([ch('core', 1, ['z.ts', 'a.ts']), ch('contract', 2, ['m.ts'])])
    const after = plan([ch('contract', 1, ['z.ts', 'a.ts', 'm.ts'])])
    const d = comparePlans(before, after)
    expect(d.moved.map((m) => m.path)).toEqual(['a.ts', 'z.ts'])
  })
})
