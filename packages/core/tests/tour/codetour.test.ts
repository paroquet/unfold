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
  version: 1, base: 'a'.repeat(40), snapshot: 'b'.repeat(40), plannerId: 'rule', rulesFingerprint: 'test',
  chapters: [
    { key: 'contract', index: 1, commitIndex: 1, status: 'active', keyRenamedFrom: null, title: '契约', intro: '先看类型。', hunkIds: ['src/types.ts#0'], filePaths: ['src/types.ts'] },
    { key: 'core', index: 2, commitIndex: 2, status: 'active', keyRenamedFrom: null, title: '核心逻辑', intro: '再看实现。', hunkIds: ['src/engine.ts#0'], filePaths: ['src/engine.ts'] },
  ],
}

describe('toCodeTours', () => {
  it('一章一个 tour，step 指向该章 hunk 的新行号', () => {
    const tours = toCodeTours(plan, [change('src/types.ts', 12), change('src/engine.ts', 40)], 'unfold/rev-1')
    expect(tours.length).toBe(2)
    expect(tours[0]!.tour.title).toBe('1. 契约')
    expect(tours[0]!.tour.description).toBe('先看类型。')
    expect(tours[0]!.tour.ref).toBe('unfold/rev-1')
    expect(tours[0]!.tour.steps).toEqual([
      { file: 'src/types.ts', line: 12, description: '契约 — src/types.ts' },
    ])
    expect(tours[1]!.tour.steps[0]!.line).toBe(40)
  })

  it('无 hunk 的文件（二进制）也产一个指向第 1 行的 step', () => {
    const binary: FileChange = {
      path: 'img.bin', kind: 'modify', binary: true, mode: '100644',
      blob: 'b'.repeat(40), oldMode: '100644', oldBlob: 'a'.repeat(40), hunks: [],
    }
    const p: Plan = { ...plan, chapters: [{ key: 'core', index: 1, commitIndex: 1, status: 'active', keyRenamedFrom: null, title: '核心逻辑', intro: 'x', hunkIds: [], filePaths: ['img.bin'] }] }
    const tours = toCodeTours(p, [binary], 'unfold/rev-1')
    expect(tours[0]!.tour.steps).toEqual([
      { file: 'img.bin', line: 1, description: '核心逻辑 — img.bin' },
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
      version: 1, base: 'a'.repeat(40), snapshot: 'b'.repeat(40), plannerId: 'rule', rulesFingerprint: 'test',
      chapters: [
        { key: 'ch1', index: 1, commitIndex: 1, status: 'active', keyRenamedFrom: null, title: '第 1 章', intro: 'intro1', hunkIds: [], filePaths: ['img1.bin'] },
        { key: 'ch2', index: 2, commitIndex: 2, status: 'active', keyRenamedFrom: null, title: '第 2 章', intro: 'intro2', hunkIds: [], filePaths: ['img2.bin'] },
      ],
    }
    const tours = toCodeTours(p, [binary1, binary2], 'unfold/rev-1')
    expect(tours.length).toBe(2)
    expect(tours[0]!.tour.steps[0]!.description).toBe('第 1 章 — img1.bin')
    expect(tours[1]!.tour.steps[0]!.description).toBe('第 2 章 — img2.bin')
  })

  it('全部内容都是被删除的文件时不生成空壳 tour（M1 回归）：该章虽有 commitIndex，但被删除的文件不产生 step，剩不下任何 step 就不该有 tour', () => {
    const deleted: FileChange = {
      path: 'src/gone.ts', kind: 'delete', binary: false, mode: '', blob: null,
      oldMode: '100644', oldBlob: 'a'.repeat(40),
      hunks: [{ id: 'src/gone.ts#0', oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-bye'] }],
    }
    const deletedBinary: FileChange = {
      path: 'img.bin', kind: 'delete', binary: true, mode: '', blob: null,
      oldMode: '100644', oldBlob: 'a'.repeat(40), hunks: [],
    }
    const p: Plan = {
      version: 1, base: 'a'.repeat(40), snapshot: 'b'.repeat(40), plannerId: 'rule', rulesFingerprint: 'test',
      chapters: [
        {
          key: 'core', index: 1, commitIndex: 1, status: 'active', keyRenamedFrom: null, title: '核心逻辑', intro: 'x',
          hunkIds: ['src/gone.ts#0'], filePaths: ['src/gone.ts', 'img.bin'],
        },
      ],
    }
    const tours = toCodeTours(p, [deleted, deletedBinary], 'unfold/rev-1')
    expect(tours).toHaveLength(0)
  })

  it('同章里删除文件与正常修改的文件混在一起，只有正常文件产生 step', () => {
    const deleted: FileChange = {
      path: 'src/gone.ts', kind: 'delete', binary: false, mode: '', blob: null,
      oldMode: '100644', oldBlob: 'a'.repeat(40),
      hunks: [{ id: 'src/gone.ts#0', oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-bye'] }],
    }
    const modified = change('src/kept.ts', 5)
    const p: Plan = {
      version: 1, base: 'a'.repeat(40), snapshot: 'b'.repeat(40), plannerId: 'rule', rulesFingerprint: 'test',
      chapters: [
        {
          key: 'core', index: 1, commitIndex: 1, status: 'active', keyRenamedFrom: null, title: '核心逻辑', intro: 'x',
          hunkIds: ['src/gone.ts#0', 'src/kept.ts#0'],
          filePaths: ['src/gone.ts', 'src/kept.ts'],
        },
      ],
    }
    const tours = toCodeTours(p, [deleted, modified], 'unfold/rev-1')
    expect(tours[0]!.tour.steps).toEqual([
      { file: 'src/kept.ts', line: 5, description: '核心逻辑 — src/kept.ts' },
    ])
  })

  it('空章不生成 tour', () => {
    const p: Plan = {
      version: 1, rulesFingerprint: 'f', base: 'b', snapshot: 's', plannerId: 'test',
      chapters: [
        { index: 1, commitIndex: null, key: 'empty', title: '空章', intro: '',
          status: 'empty', keyRenamedFrom: null, hunkIds: [], filePaths: [] },
        { index: 2, commitIndex: 1, key: 'a.ts', title: 'a', intro: '',
          status: 'active', keyRenamedFrom: null, hunkIds: [], filePaths: ['a.ts'] },
      ],
    }
    const tours = toCodeTours(p, [], 'unfold/x')
    expect(tours).toHaveLength(1)
    expect(tours[0]?.tour.title).toContain('1.')
  })

  it('中间的纯删除章被跳过时，后面的 tour 仍带着自己的 commitIndex', () => {
    const del: FileChange = {
      path: 'gone.ts', kind: 'delete', binary: false, mode: '', blob: null,
      oldMode: '100644', oldBlob: 'o', hunks: [],
    }
    const keep: FileChange = {
      path: 'keep.ts', kind: 'modify', binary: false, mode: '100644', blob: 'b',
      oldMode: '100644', oldBlob: 'o', hunks: [],
    }
    const p: Plan = {
      version: 1, rulesFingerprint: 'f', base: 'b', snapshot: 's', plannerId: 'test',
      chapters: [
        { index: 1, commitIndex: 1, key: 'a.ts', title: 'a', intro: '', status: 'active',
          keyRenamedFrom: null, hunkIds: [], filePaths: ['keep.ts'] },
        // 中间这一章只含被删文件：有 commitIndex，但 step 会被清空
        { index: 2, commitIndex: 2, key: 'gone.ts', title: '删掉的模块', intro: '',
          status: 'active', keyRenamedFrom: null, hunkIds: [], filePaths: ['gone.ts'] },
        { index: 3, commitIndex: 3, key: 'c.ts', title: 'c', intro: '', status: 'active',
          keyRenamedFrom: null, hunkIds: [], filePaths: ['keep.ts'] },
      ],
    }
    const tours = toCodeTours(p, [del, keep], 'unfold/x')
    expect(tours.map((t) => t.commitIndex)).toEqual([1, 3])
    expect(tours[1]?.tour.title).toContain('3.')
  })
})
