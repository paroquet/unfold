import { describe, it, expect } from 'vitest'
import { RulePlanner } from '../../src/narrate/rule-planner.js'
import { DEFAULT_RULES } from '../../src/narrate/rules.js'
import { EMPTY_REGISTRY } from '../../src/narrate/registry.js'
import type { PlanContext } from '../../src/narrate/plan.js'

const ctx: PlanContext = {
  base: 'b', snapshot: 's', changes: [], rules: DEFAULT_RULES,
  canonical: new Map(), registry: EMPTY_REGISTRY, pinned: new Map(), deps: new Map(),
}

describe('RulePlanner', () => {
  it('把每个段成员映射到段 key，并声明该段为提议的新章', async () => {
    const planner = new RulePlanner([
      { key: 'a.ts', members: ['a.ts', 'b.ts'], title: 'T', intro: 'I' },
    ])
    const got = await planner.assign(ctx)
    expect([...got.byChapter]).toEqual([['a.ts', 'a.ts'], ['b.ts', 'a.ts']])
    expect(got.proposed?.get('a.ts')).toEqual({ title: 'T', intro: 'I' })
  })

  it('没有段时给出空归属，而不是抛错', async () => {
    expect((await new RulePlanner([]).assign(ctx)).byChapter.size).toBe(0)
  })
})
