import { describe, it, expect } from 'vitest'
import { composeContent } from '../../src/narrate/compose.js'
import type { Hunk } from '../../src/narrate/diff.js'

const h = (p: Partial<Hunk> & Pick<Hunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines' | 'lines'>): Hunk =>
  ({ id: 'x#0', ...p })

describe('composeContent', () => {
  it('空 hunk 集合时原样返回 base 内容', () => {
    expect(composeContent('a\nb\nc\n', [])).toBe('a\nb\nc\n')
  })

  it('应用单个替换 hunk', () => {
    const hunk = h({ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-b', '+B'] })
    expect(composeContent('a\nb\nc\n', [hunk])).toBe('a\nB\nc\n')
  })

  it('应用两个不相邻 hunk，行号偏移正确', () => {
    const h1 = h({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+A1', '+A2'] })
    const h2 = h({ oldStart: 3, oldLines: 1, newStart: 4, newLines: 1, lines: ['-c', '+C'] })
    expect(composeContent('a\nb\nc\n', [h1, h2])).toBe('A1\nA2\nb\nC\n')
  })

  it('只应用子集时，未选中的 hunk 保持 base 态', () => {
    const h1 = h({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] })
    const h2 = h({ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-c', '+C'] })
    expect(composeContent('a\nb\nc\n', [h2])).toBe('a\nb\nC\n')
    expect(composeContent('a\nb\nc\n', [h1])).toBe('A\nb\nc\n')
  })

  it('保留没有结尾换行的文件形态', () => {
    const hunk = h({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '\\ No newline at end of file', '+A', '\\ No newline at end of file'] })
    expect(composeContent('a', [hunk])).toBe('A')
  })
})
