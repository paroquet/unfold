import { describe, it, expect } from 'vitest'
import { buildPlan } from '../../src/narrate/build-plan.js'
import { rulesFingerprint } from '../../src/narrate/rules.js'
import type { NarrativeRules } from '../../src/narrate/rules.js'
import type { Assignment, Plan, PlanContext } from '../../src/narrate/plan.js'
import type { FileChange } from '../../src/narrate/diff.js'

const RULES: NarrativeRules = {
  version: 1,
  fallback: 'core',
  layers: [
    { key: 'contract', title: '契约', intro: '先看契约' },
    { key: 'core', title: '核心逻辑', intro: '再看核心' },
    { key: 'test-doc', title: '测试与文档', intro: '最后看测试' },
  ],
}

function change(path: string, hunks = 1): FileChange {
  return {
    path,
    kind: 'modify',
    binary: false,
    mode: '100644',
    blob: 'b'.repeat(40),
    oldMode: '100644',
    oldBlob: 'a'.repeat(40),
    hunks: Array.from({ length: hunks }, (_, i) => ({
      id: `${path}#${i}`,
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ['-x', '+y'],
    })),
  }
}

function ctx(changes: FileChange[], previous?: Plan): PlanContext {
  return {
    base: 'a'.repeat(40),
    snapshot: 'b'.repeat(40),
    changes,
    rules: RULES,
    ...(previous !== undefined ? { previous } : {}),
  }
}

function assign(pairs: Array<[string, string]>, intros?: Array<[string, string]>): Assignment {
  return {
    byLayer: new Map(pairs),
    ...(intros !== undefined ? { intros: new Map(intros) } : {}),
  }
}

describe('buildPlan', () => {
  it('按 rules.layers 顺序建章，index 从 1 连续', () => {
    const c = ctx([change('t.ts'), change('a.ts'), change('s.ts')])
    const plan = buildPlan(c, assign([['s.ts', 'contract'], ['a.ts', 'core'], ['t.ts', 'test-doc']]), 'rule')
    expect(plan.chapters.map((x) => x.key)).toEqual(['contract', 'core', 'test-doc'])
    expect(plan.chapters.map((x) => x.index)).toEqual([1, 2, 3])
  })

  it('空层不产出章节，index 仍然连续', () => {
    const c = ctx([change('s.ts'), change('t.ts')])
    const plan = buildPlan(c, assign([['s.ts', 'contract'], ['t.ts', 'test-doc']]), 'rule')
    expect(plan.chapters.map((x) => x.key)).toEqual(['contract', 'test-doc'])
    expect(plan.chapters.map((x) => x.index)).toEqual([1, 2])
  })

  it('title 与 intro 取自 rules', () => {
    const c = ctx([change('s.ts')])
    const plan = buildPlan(c, assign([['s.ts', 'contract']]), 'rule')
    expect(plan.chapters[0]!.title).toBe('契约')
    expect(plan.chapters[0]!.intro).toBe('先看契约')
  })

  it('assignment.intros 覆盖 rules 里的静态文案', () => {
    const c = ctx([change('s.ts')])
    const plan = buildPlan(c, assign([['s.ts', 'contract']], [['contract', '这次契约改的是鉴权返回值']]), 'ai')
    expect(plan.chapters[0]!.intro).toBe('这次契约改的是鉴权返回值')
    expect(plan.chapters[0]!.title).toBe('契约')
  })

  it('hunkIds 与 filePaths 都填对', () => {
    const c = ctx([change('s.ts', 2), change('a.ts', 1)])
    const plan = buildPlan(c, assign([['s.ts', 'contract'], ['a.ts', 'contract']]), 'rule')
    expect(plan.chapters[0]!.filePaths.sort()).toEqual(['a.ts', 's.ts'])
    expect(plan.chapters[0]!.hunkIds.sort()).toEqual(['a.ts#0', 's.ts#0', 's.ts#1'])
  })

  it('分到 rules 里不存在的层就抛错，并指名是哪个文件、哪个 key', () => {
    const c = ctx([change('s.ts')])
    expect(() => buildPlan(c, assign([['s.ts', 'nope']]), 'ai')).toThrow(/nope/)
    expect(() => buildPlan(c, assign([['s.ts', 'nope']]), 'ai')).toThrow(/s\.ts/)
  })

  it('有文件没被分配就抛错，并指名是哪个文件', () => {
    const c = ctx([change('s.ts'), change('forgotten.ts')])
    expect(() => buildPlan(c, assign([['s.ts', 'contract']]), 'ai')).toThrow(/forgotten\.ts/)
  })

  it('plan 带上规则指纹与 plannerId', () => {
    const c = ctx([change('s.ts')])
    const plan = buildPlan(c, assign([['s.ts', 'contract']]), 'rule')
    expect(plan.rulesFingerprint).toBe(rulesFingerprint(RULES))
    expect(plan.plannerId).toBe('rule')
  })
})

describe('buildPlan 的跨轮稳定', () => {
  it('指纹相同：文件被钉回上一轮所在的层', () => {
    const first = buildPlan(ctx([change('a.ts')]), assign([['a.ts', 'core']]), 'rule')
    // 本轮规则不变，但 planner 把它分到了 contract —— 应被钉回 core
    const second = buildPlan(ctx([change('a.ts')], first), assign([['a.ts', 'contract']]), 'ai')
    expect(second.chapters.find((ch) => ch.filePaths.includes('a.ts'))!.key).toBe('core')
  })

  it('指纹不同：不沿用上一轮归属，按本轮规则重新划分', () => {
    const first = buildPlan(ctx([change('a.ts')]), assign([['a.ts', 'core']]), 'rule')
    const changedRules: NarrativeRules = { ...RULES, fallback: 'contract' }
    const c: PlanContext = { ...ctx([change('a.ts')], first), rules: changedRules }
    const second = buildPlan(c, assign([['a.ts', 'contract']]), 'ai')
    expect(second.chapters.find((ch) => ch.filePaths.includes('a.ts'))!.key).toBe('contract')
  })

  it('上一轮的 plan 没有指纹字段（旧版产物）：视为不同，重新划分', () => {
    const first = buildPlan(ctx([change('a.ts')]), assign([['a.ts', 'core']]), 'rule')
    const legacy: Plan = { ...first }
    delete (legacy as { rulesFingerprint?: string }).rulesFingerprint
    const second = buildPlan(ctx([change('a.ts')], legacy as Plan), assign([['a.ts', 'contract']]), 'ai')
    expect(second.chapters.find((ch) => ch.filePaths.includes('a.ts'))!.key).toBe('contract')
  })

  it('钉回之后文件仍然只出现在一个章节里', () => {
    const first = buildPlan(ctx([change('a.ts')]), assign([['a.ts', 'core']]), 'rule')
    const second = buildPlan(ctx([change('a.ts')], first), assign([['a.ts', 'contract']]), 'ai')
    const owners = second.chapters.filter((ch) => ch.filePaths.includes('a.ts'))
    expect(owners.length).toBe(1)
    const hunkOwners = second.chapters.filter((ch) => ch.hunkIds.includes('a.ts#0'))
    expect(hunkOwners.length).toBe(1)
  })
})
