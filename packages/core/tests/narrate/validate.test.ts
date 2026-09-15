import { describe, it, expect } from 'vitest'
import { validatePlan } from '../../src/narrate/validate.js'
import type { Plan, PlanContext } from '../../src/narrate/plan.js'
import type { FileChange } from '../../src/narrate/diff.js'

function change(path: string, hunkCount: number): FileChange {
  return {
    path, kind: 'modify', binary: false, mode: '100644',
    blob: 'b'.repeat(40), oldMode: '100644', oldBlob: 'a'.repeat(40),
    hunks: Array.from({ length: hunkCount }, (_, i) => ({
      id: `${path}#${i}`, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'],
    })),
  }
}

function ctx(changes: FileChange[], previous?: Plan): PlanContext {
  return { base: 'a'.repeat(40), snapshot: 'b'.repeat(40), changes, ...(previous ? { previous } : {}) }
}

function plan(chapters: Plan['chapters']): Plan {
  return { version: 1, base: 'a'.repeat(40), snapshot: 'b'.repeat(40), plannerId: 'test', chapters }
}

describe('validatePlan', () => {
  it('完全覆盖且不重复时通过', () => {
    const c = ctx([change('a.ts', 2)])
    const p = plan([{ key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0', 'a.ts#1'], filePaths: ['a.ts'] }])
    expect(validatePlan(p, c)).toEqual([])
  })

  it('漏掉 hunk 会报 hunk-missing', () => {
    const c = ctx([change('a.ts', 2)])
    const p = plan([{ key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] }])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('hunk-missing')
  })

  it('同一 hunk 分到两章会报 hunk-duplicated', () => {
    const c = ctx([change('a.ts', 1)])
    const p = plan([
      { key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
      { key: 'k2', index: 2, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: [] },
    ])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('hunk-duplicated')
  })

  it('引用不存在的 hunk 会报 hunk-unknown', () => {
    const c = ctx([change('a.ts', 1)])
    const p = plan([{ key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0', 'ghost.ts#0'], filePaths: ['a.ts'] }])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('hunk-unknown')
  })

  it('章号不连续会报 chapter-index', () => {
    const c = ctx([change('a.ts', 1)])
    const p = plan([{ key: 'k1', index: 2, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] }])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('chapter-index')
  })

  it('index 变了但 key 没变不算漂移（位置序号会随本轮非空的类合法变动）', () => {
    const c0 = change('a.ts', 1)
    const previous = plan([
      { key: 'contract', index: 1, title: 't', intro: 'i', hunkIds: [], filePaths: [] },
      { key: 'core', index: 2, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
    ])
    // 本轮 contract 类为空、未产出章节，core 章的 index 因此从 2 变成 1
    const shifted = plan([
      { key: 'core', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
    ])
    expect(validatePlan(shifted, ctx([c0], previous)).map((i) => i.code)).not.toContain(
      'cross-round-drift',
    )
  })

  it('已分配文件换了章（key 变化）会报 cross-round-drift', () => {
    const c0 = change('a.ts', 1)
    const c1 = change('b.ts', 1)
    const previous = plan([
      { key: 'contract', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
      { key: 'core', index: 2, title: 't', intro: 'i', hunkIds: ['b.ts#0'], filePaths: ['b.ts'] },
    ])
    // a.ts 从 contract 章挪到了 core 章 —— 这才是真漂移
    const drifted = plan([
      { key: 'core', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0', 'b.ts#0'], filePaths: ['a.ts', 'b.ts'] },
    ])
    const issues = validatePlan(drifted, ctx([c0, c1], previous))
    expect(issues.map((i) => i.code)).toContain('cross-round-drift')
  })

  it('无 hunk 的文件漏掉会报 file-missing', () => {
    // 模拟二进制文件或纯 mode 变更（无 hunk）
    const binary = { path: 'lib.a', kind: 'modify' as const, binary: true, mode: '100644', blob: 'b'.repeat(40), oldMode: '100644', oldBlob: 'a'.repeat(40), hunks: [] as any }
    const c = ctx([binary])
    const p = plan([{ key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: [], filePaths: [] }])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('file-missing')
  })

  it('同一文件分到两章会报 file-duplicated', () => {
    const c = ctx([change('a.ts', 0)])
    const p = plan([
      { key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: [], filePaths: ['a.ts'] },
      { key: 'k2', index: 2, title: 't', intro: 'i', hunkIds: [], filePaths: ['a.ts'] },
    ])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('file-duplicated')
  })

  it('引用不存在的文件会报 file-unknown', () => {
    const c = ctx([change('a.ts', 0)])
    const p = plan([{ key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: [], filePaths: ['a.ts', 'ghost.ts'] }])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('file-unknown')
  })

  it('ctx.previous 为 undefined 时不报 cross-round-drift', () => {
    const c = ctx([change('a.ts', 1)])
    const p = plan([{ key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] }])
    expect(validatePlan(p, c).map((i) => i.code)).not.toContain('cross-round-drift')
  })

  it('上一轮有、本轮消失的文件不报漂移', () => {
    // 上一轮 a.ts 在 contract 章
    const previous = plan([
      { key: 'contract', index: 1, title: 't', intro: 'i', hunkIds: [], filePaths: ['a.ts'] },
    ])
    // 本轮 a.ts 完全消失（不在 changes 中）
    const changes = [change('b.ts', 1)]
    const p = plan([{ key: 'core', index: 1, title: 't', intro: 'i', hunkIds: ['b.ts#0'], filePaths: ['b.ts'] }])
    expect(validatePlan(p, ctx(changes, previous)).map((i) => i.code)).not.toContain('cross-round-drift')
  })

  it('本轮新增、上一轮没有的文件不报漂移', () => {
    // 上一轮只有 a.ts
    const previous = plan([
      { key: 'core', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
    ])
    // 本轮 a.ts 保留，b.ts 新增
    const c0 = change('a.ts', 1)
    const c1 = change('b.ts', 1)
    const p = plan([{ key: 'core', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0', 'b.ts#0'], filePaths: ['a.ts', 'b.ts'] }])
    expect(validatePlan(p, ctx([c0, c1], previous)).map((i) => i.code)).not.toContain('cross-round-drift')
  })
})
