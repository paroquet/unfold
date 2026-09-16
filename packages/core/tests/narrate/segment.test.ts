import { describe, it, expect } from 'vitest'
import { segment } from '../../src/narrate/segment.js'

const one = (): number => 1

describe('segment', () => {
  it('章节 key 是段首文件，插到段中间不改 key', () => {
    const before = segment({ order: ['s/a.ts', 's/c.ts'], cycles: [], maxFiles: 8, fileCount: one })
    const after = segment({ order: ['s/a.ts', 's/b.ts', 's/c.ts'], cycles: [], maxFiles: 8, fileCount: one })
    expect(before[0]?.key).toBe('s/a.ts')
    expect(after[0]?.key).toBe('s/a.ts')
    expect(after[0]?.members).toEqual(['s/a.ts', 's/b.ts', 's/c.ts'])
  })

  it('跨目录必断，哪怕远没到 maxFiles', () => {
    const got = segment({
      order: ['s/git/a.ts', 's/git/b.ts', 's/bin/c.ts'],
      cycles: [], maxFiles: 8, fileCount: one,
    })
    expect(got.map((s) => s.members)).toEqual([['s/git/a.ts', 's/git/b.ts'], ['s/bin/c.ts']])
  })

  it('超过 maxFiles 必断，且按真实文件数算而不是单元数', () => {
    // 每个单元含 3 个真实文件（实现 + 两个测试），maxFiles 4 ⇒ 每章只装得下一个
    const got = segment({
      order: ['s/a.ts', 's/b.ts'], cycles: [], maxFiles: 4, fileCount: () => 3,
    })
    expect(got).toHaveLength(2)
  })

  it('单个单元自己就超 maxFiles 时仍然成章，不会被丢掉', () => {
    const got = segment({ order: ['s/a.ts'], cycles: [], maxFiles: 1, fileCount: () => 9 })
    expect(got.map((s) => s.members)).toEqual([['s/a.ts']])
  })

  it('标题带上目录名与首尾文件，导语说明这是依赖顺序', () => {
    const [chapter] = segment({
      order: ['s/git/a.ts', 's/git/b.ts'], cycles: [], maxFiles: 8, fileCount: one,
    })
    expect(chapter?.title).toBe('git：a.ts → b.ts')
    expect(chapter?.intro).toContain('依赖顺序')
  })

  it('段内含环时，导语明说先后不代表调用方向', () => {
    const [chapter] = segment({
      order: ['s/x/a.ts', 's/x/b.ts'],
      cycles: [['s/x/a.ts', 's/x/b.ts']],
      maxFiles: 8, fileCount: one,
    })
    expect(chapter?.intro).toContain('先后不代表调用方向')
  })
})
