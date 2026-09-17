import { describe, it, expect } from 'vitest'
import { segment } from '../../src/narrate/segment.js'
import { buildDepGraph } from '../../src/narrate/deps.js'
import { topoOrder } from '../../src/narrate/order.js'

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

  it('build 文件跨三个目录仍合成一章：按归档位置切分正是要消灭的缺陷', () => {
    const got = segment({
      order: ['package.json', 'core/package.json', 'contract/.gitkeep'],
      cycles: [], maxFiles: 8, fileCount: one,
    })
    expect(got).toHaveLength(1)
    expect(got[0]?.members).toEqual(['package.json', 'core/package.json', 'contract/.gitkeep'])
  })

  it('source 后接 doc：角色变化必断，两章', () => {
    const got = segment({ order: ['s/a.ts', 'README.md'], cycles: [], maxFiles: 8, fileCount: one })
    expect(got).toHaveLength(2)
  })

  it('十个文档文件在 maxFiles: 2 下仍合成一章：文档是扫读的，不按 maxFiles 断', () => {
    const docs = Array.from({ length: 10 }, (_, i) => `docs/d${i}.md`)
    const got = segment({ order: docs, cycles: [], maxFiles: 2, fileCount: one })
    expect(got).toHaveLength(1)
    expect(got[0]?.members).toHaveLength(10)
  })

  it('build 章标题以「构建与配置」开头', () => {
    const [chapter] = segment({
      order: ['package.json', 'vitest.config.ts'], cycles: [], maxFiles: 8, fileCount: one,
    })
    expect(chapter?.title).toBe('构建与配置：package.json → vitest.config.ts')
  })

  it('doc 章标题与导语：文档开头，且说明按路径顺序而非依赖顺序', () => {
    const [chapter] = segment({
      order: ['README.md', 'docs/getting-started.md'], cycles: [], maxFiles: 8, fileCount: one,
    })
    expect(chapter?.title).toBe('文档：README.md → getting-started.md')
    expect(chapter?.intro).toContain('路径')
    expect(chapter?.intro).not.toContain('依赖顺序')
  })

  it('端到端：源码 import 改动中的 .json 时，构建文件仍聚成一章且排在代码之后（spec §4.5）', () => {
    // src/z.ts 依赖 fixtures/data.json；若 buildDepGraph 给这条 import 连边，
    // topoOrder 会被迫把 data.json 排到 z.ts 前面，segment 就会切出
    // src:a→b / 构建与配置:data.json / src:z / 构建与配置:tsconfig.json / 文档:README.md
    // 这种代码中间插了一章构建配置、构建配置本身又被拆成两处的形状——
    // 正是这次改造要消灭的碎片。
    const files = ['src/a.ts', 'src/b.ts', 'src/z.ts', 'fixtures/data.json', 'tsconfig.json', 'README.md']
    const contents = new Map([
      ['src/a.ts', 'export const a = 1\n'],
      ['src/b.ts', "import { a } from './a.js'\n"],
      ['src/z.ts', "import data from '../fixtures/data.json'\n"],
    ])
    const graph = buildDepGraph(files, contents)
    const { order, cycles } = topoOrder(files, graph.edges)
    const chapters = segment({ order, cycles, maxFiles: 8, fileCount: one })

    expect(chapters).toHaveLength(3)
    expect(chapters[0]?.members).toEqual(['src/a.ts', 'src/b.ts', 'src/z.ts'])
    expect(chapters[1]?.members).toEqual(['fixtures/data.json', 'tsconfig.json'])
    expect(chapters[1]?.title).toMatch(/^构建与配置/)
    expect(chapters[2]?.members).toEqual(['README.md'])
  })
})
