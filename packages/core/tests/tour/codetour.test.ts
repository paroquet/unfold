import { describe, it, expect } from 'vitest'
import { toCodeTours } from '../../src/tour/codetour.js'
import type { Plan } from '../../src/narrate/plan.js'
import type { FileChange } from '../../src/narrate/diff.js'

const change = (path: string, newStart: number): FileChange => ({
  path, kind: 'modify', binary: false, mode: '100644',
  blob: 'b'.repeat(40), oldMode: '100644', oldBlob: 'a'.repeat(40),
  hunks: [{ id: `${path}#0`, oldStart: newStart, oldLines: 1, newStart, newLines: 1, lines: ['-x', '+y'] }],
})

const plan: Plan = {
  version: 1, base: 'a'.repeat(40), snapshot: 'b'.repeat(40), plannerId: 'rule',
  chapters: [
    { key: 'contract', index: 1, title: '第 1 层：契约', intro: '先看类型。', hunkIds: ['src/types.ts#0'], filePaths: ['src/types.ts'] },
    { key: 'core', index: 2, title: '第 2 层：核心逻辑', intro: '再看实现。', hunkIds: ['src/engine.ts#0'], filePaths: ['src/engine.ts'] },
  ],
}

describe('toCodeTours', () => {
  it('一章一个 tour，step 指向该章 hunk 的新行号', () => {
    const tours = toCodeTours(plan, [change('src/types.ts', 12), change('src/engine.ts', 40)], 'unfold/rev-1')
    expect(tours.length).toBe(2)
    expect(tours[0]!.title).toBe('1. 第 1 层：契约')
    expect(tours[0]!.description).toBe('先看类型。')
    expect(tours[0]!.ref).toBe('unfold/rev-1')
    expect(tours[0]!.steps).toEqual([
      { file: 'src/types.ts', line: 12, description: '第 1 层：契约 — src/types.ts' },
    ])
    expect(tours[1]!.steps[0]!.line).toBe(40)
  })

  it('无 hunk 的文件（二进制）也产一个指向第 1 行的 step', () => {
    const binary: FileChange = {
      path: 'img.bin', kind: 'modify', binary: true, mode: '100644',
      blob: 'b'.repeat(40), oldMode: '100644', oldBlob: 'a'.repeat(40), hunks: [],
    }
    const p: Plan = { ...plan, chapters: [{ key: 'core', index: 1, title: '第 2 层：核心逻辑', intro: 'x', hunkIds: [], filePaths: ['img.bin'] }] }
    const tours = toCodeTours(p, [binary], 'unfold/rev-1')
    expect(tours[0]!.steps).toEqual([
      { file: 'img.bin', line: 1, description: '第 2 层：核心逻辑 — img.bin' },
    ])
  })

  it('多章节各有无 hunk 文件时，description 分别反映各自章节标题', () => {
    const binary1: FileChange = {
      path: 'img1.bin', kind: 'modify', binary: true, mode: '100644',
      blob: 'b'.repeat(40), oldMode: '100644', oldBlob: 'a'.repeat(40), hunks: [],
    }
    const binary2: FileChange = {
      path: 'img2.bin', kind: 'modify', binary: true, mode: '100644',
      blob: 'b'.repeat(40), oldMode: '100644', oldBlob: 'a'.repeat(40), hunks: [],
    }
    const p: Plan = {
      version: 1, base: 'a'.repeat(40), snapshot: 'b'.repeat(40), plannerId: 'rule',
      chapters: [
        { key: 'ch1', index: 1, title: '第 1 章', intro: 'intro1', hunkIds: [], filePaths: ['img1.bin'] },
        { key: 'ch2', index: 2, title: '第 2 章', intro: 'intro2', hunkIds: [], filePaths: ['img2.bin'] },
      ],
    }
    const tours = toCodeTours(p, [binary1, binary2], 'unfold/rev-1')
    expect(tours.length).toBe(2)
    expect(tours[0]!.steps[0]!.description).toBe('第 1 章 — img1.bin')
    expect(tours[1]!.steps[0]!.description).toBe('第 2 章 — img2.bin')
  })
})
