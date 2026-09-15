import { describe, it, expect } from 'vitest'
import { composeContent } from '../../src/narrate/compose.js'
import { computeChanges } from '../../src/narrate/diff.js'
import type { Hunk } from '../../src/narrate/diff.js'
import { createTempRepo } from '../helpers/repo.js'

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

  // 结尾换行的四种组合都必须用真实 git diff 产出的 hunk 来测——手搓的 hunk
  // 字面量会把作者对 `\ No newline` marker 位置的理解一起编码进去，一旦理解
  // 有偏差，测试和实现会一起错，测了个寂寞（本任务复盘的教训）。
  async function realHunksFor(base: string, head: string): Promise<Hunk[]> {
    const repo = await createTempRepo()
    await repo.write('f.txt', base)
    const baseSha = await repo.commit('base')
    await repo.write('f.txt', head)
    const headSha = await repo.commit('head')
    const changes = await computeChanges(repo.dir, baseSha, headSha)
    const file = changes[0]!
    await repo.cleanup()
    return file.hunks
  }

  it('结尾换行组合：旧有换行 → 新无换行', async () => {
    const base = 'a\nb\nc\n'
    const head = 'a\nB\nc'
    const hunks = await realHunksFor(base, head)
    expect(hunks.length).toBeGreaterThan(0)
    expect(composeContent(base, hunks)).toBe(head)
  })

  it('结尾换行组合：旧无换行 → 新有换行（曾经的 bug：单向标志位只能降级，不能升级）', async () => {
    const base = 'a\nb\nc'
    const head = 'a\nB\nc\n'
    const hunks = await realHunksFor(base, head)
    expect(hunks.length).toBeGreaterThan(0)
    expect(composeContent(base, hunks)).toBe(head)
  })

  it('结尾换行组合：两侧都无换行', async () => {
    const base = 'a\nb\nc'
    const head = 'a\nB\nc'
    const hunks = await realHunksFor(base, head)
    expect(hunks.length).toBeGreaterThan(0)
    expect(composeContent(base, hunks)).toBe(head)
  })

  it('结尾换行组合：两侧都有换行', async () => {
    const base = 'a\nb\nc\n'
    const head = 'a\nB\nc\n'
    const hunks = await realHunksFor(base, head)
    expect(hunks.length).toBeGreaterThan(0)
    expect(composeContent(base, hunks)).toBe(head)
  })
})
