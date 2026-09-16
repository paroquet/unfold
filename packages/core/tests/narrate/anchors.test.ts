import { describe, it, expect } from 'vitest'
import { migrateAnchors, pinnedByAnnotations } from '../../src/narrate/anchors.js'
import type { Annotation } from '../../src/narrate/anchors.js'
import type { FileChange, Hunk } from '../../src/narrate/diff.js'

const hunk = (id: string, oldStart: number, oldLines: number, newStart: number, newLines: number): Hunk =>
  ({ id, oldStart, oldLines, newStart, newLines, lines: [] })

const change = (path: string, hunks: Hunk[], kind: FileChange['kind'] = 'modify'): FileChange => ({
  path, kind, binary: false, mode: '100644', blob: 'b', oldMode: '100644', oldBlob: 'o', hunks,
})

const note = (over: Partial<Annotation> = {}): Annotation => ({
  id: 'n1', chapterKey: 'c1', path: 'a.ts', startLine: 20, endLine: 24,
  anchorHash: 'sha256:x', body: '看这里', state: 'live', round: 1, ...over,
})

describe('migrateAnchors', () => {
  it('文件本轮没动时行号不变', () => {
    const [got] = migrateAnchors([note()], [change('other.ts', [])])
    expect(got).toMatchObject({ startLine: 20, endLine: 24, state: 'live' })
  })

  it('批注之前的 hunk 净增行时，锚点整体下移', () => {
    // 第 1-3 行被换成 6 行 ⇒ 净增 3
    const [got] = migrateAnchors([note()], [change('a.ts', [hunk('a.ts#0', 1, 3, 1, 6)])])
    expect(got).toMatchObject({ startLine: 23, endLine: 27, state: 'live' })
  })

  it('与批注重叠的 hunk 让它变 stale，范围重算成 hunk 的新范围', () => {
    const [got] = migrateAnchors([note()], [change('a.ts', [hunk('a.ts#0', 22, 2, 22, 5)])])
    expect(got).toMatchObject({ startLine: 22, endLine: 26, state: 'stale' })
  })

  it('批注之后的 hunk 不影响锚点', () => {
    const [got] = migrateAnchors([note()], [change('a.ts', [hunk('a.ts#0', 90, 1, 90, 9)])])
    expect(got).toMatchObject({ startLine: 20, endLine: 24, state: 'live' })
  })

  // 以下三条钉住纯插入的边界。git 对「在 L2 与 L3 之间插两行」实测给出
  // `@@ -2,0 +3,2 @@`——oldStart 指的是插入点**之前**那一行，不是插入后的位置。
  // 批注是 20-24 时：oldStart=19 在批注之前，=20 已经插进批注内部，=24 在批注之后。

  it('纯插入落在批注之前时，锚点整体下移', () => {
    const [got] = migrateAnchors([note()], [change('a.ts', [hunk('a.ts#0', 19, 0, 20, 3)])])
    expect(got).toMatchObject({ startLine: 23, endLine: 27, state: 'live' })
  })

  it('纯插入落在批注内部时标 stale，而不是把批注整体下移', () => {
    const [got] = migrateAnchors([note()], [change('a.ts', [hunk('a.ts#0', 20, 0, 21, 3)])])
    expect(got?.state).toBe('stale')
  })

  it('纯插入落在批注之后时，锚点不动', () => {
    const [got] = migrateAnchors([note()], [change('a.ts', [hunk('a.ts#0', 24, 0, 25, 3)])])
    expect(got).toMatchObject({ startLine: 20, endLine: 24, state: 'live' })
  })

  it('文件被删除时批注标 orphaned，但不丢弃', () => {
    const [got] = migrateAnchors([note()], [change('a.ts', [], 'delete')])
    expect(got).toMatchObject({ state: 'orphaned' })
    expect(got?.body).toBe('看这里')
  })

  it('已经 stale 的批注不会因为这一轮没碰它就变回 live', () => {
    const [got] = migrateAnchors([note({ state: 'stale' })], [change('other.ts', [])])
    expect(got?.state).toBe('stale')
  })
})

describe('pinnedByAnnotations', () => {
  it('与批注新范围重叠的 hunk 被钉到批注所在章', () => {
    const got = pinnedByAnnotations([note()], [change('a.ts', [hunk('a.ts#0', 22, 2, 22, 2)])])
    expect(got.get('a.ts#0')).toBe('c1')
  })

  it('不重叠的 hunk 不被钉住', () => {
    const got = pinnedByAnnotations([note()], [change('a.ts', [hunk('a.ts#0', 90, 1, 90, 1)])])
    expect(got.size).toBe(0)
  })

  it('orphaned 的批注不钉任何东西', () => {
    const got = pinnedByAnnotations(
      [note({ state: 'orphaned' })],
      [change('a.ts', [hunk('a.ts#0', 22, 2, 22, 2)])],
    )
    expect(got.size).toBe(0)
  })

  it('两条批注争同一个 hunk 时，按 id 字典序定夺，保证确定性', () => {
    const changes = [change('a.ts', [hunk('a.ts#0', 20, 4, 20, 4)])]
    const a = note({ id: 'b', chapterKey: 'cb' })
    const b = note({ id: 'a', chapterKey: 'ca' })
    expect(pinnedByAnnotations([a, b], changes).get('a.ts#0')).toBe('ca')
    expect(pinnedByAnnotations([b, a], changes).get('a.ts#0')).toBe('ca')
  })
})
