import { describe, it, expect } from 'vitest'
import { buildDepGraph, languageOf, scanImports } from '../../src/narrate/deps.js'

describe('languageOf', () => {
  it('认识 TS/JS 与 Kotlin/Java，其余返回 null', () => {
    expect(languageOf('a/b.ts')).toBe('ts')
    expect(languageOf('a/b.mjs')).toBe('ts')
    expect(languageOf('a/B.kt')).toBe('kotlin')
    expect(languageOf('a/B.java')).toBe('kotlin')
    expect(languageOf('a/b.md')).toBeNull()
    expect(languageOf('a/b.rs')).toBeNull()
  })
})

describe('scanImports', () => {
  it('抓 TS 的四种形态', () => {
    const src = [
      "import { a } from './a.js'",
      "export { b } from '../b/index.js'",
      "const c = require('./c.js')",
      "await import('./d.js')",
    ].join('\n')
    expect(scanImports(src, 'ts')).toEqual(['./a.js', '../b/index.js', './c.js', './d.js'])
  })

  it('不抓包名——只有相对路径才可能指向本轮改动的文件', () => {
    expect(scanImports("import x from 'node:fs'\nimport y from 'picomatch'", 'ts')).toEqual([])
  })

  it('抓 Kotlin 的包路径 import', () => {
    expect(scanImports('package com.acme\n\nimport com.acme.order.Order\n', 'kotlin'))
      .toEqual(['com.acme.order.Order'])
  })

  it('跨行的具名 import 也能扫到——这是最常见的 TS 写法', () => {
    expect(scanImports("import {\n  a,\n  b,\n} from './mod.js'\n", 'ts')).toEqual(['./mod.js'])
  })

  it('副作用 import 没有 from，但同样是一条依赖边', () => {
    expect(scanImports("import './register.js'\n", 'ts')).toEqual(['./register.js'])
  })
})

describe('buildDepGraph', () => {
  it('把 TS 相对 import 解析成仓库相对路径，含 .js → .ts 换算', () => {
    const files = ['src/a.ts', 'src/sub/b.ts']
    const contents = new Map([
      ['src/a.ts', "import { b } from './sub/b.js'\n"],
      ['src/sub/b.ts', 'export const b = 1\n'],
    ])
    const graph = buildDepGraph(files, contents)
    expect([...(graph.edges.get('src/a.ts') ?? [])]).toEqual(['src/sub/b.ts'])
    expect(graph.edges.get('src/sub/b.ts')?.size ?? 0).toBe(0)
  })

  it('指向本轮改动之外的文件不连边', () => {
    const files = ['src/a.ts']
    const contents = new Map([['src/a.ts', "import x from './not-changed.js'\n"]])
    expect(buildDepGraph(files, contents).edges.get('src/a.ts')?.size ?? 0).toBe(0)
  })

  it('Kotlin 靠包路径后缀匹配，不需要知道源码根在哪', () => {
    const files = ['app/src/main/kotlin/com/acme/Order.kt', 'app/src/main/kotlin/com/acme/pay/Pay.kt']
    const contents = new Map([
      ['app/src/main/kotlin/com/acme/Order.kt', 'import com.acme.pay.Pay\n'],
      ['app/src/main/kotlin/com/acme/pay/Pay.kt', 'class Pay\n'],
    ])
    const graph = buildDepGraph(files, contents)
    expect([...(graph.edges.get('app/src/main/kotlin/com/acme/Order.kt') ?? [])])
      .toEqual(['app/src/main/kotlin/com/acme/pay/Pay.kt'])
  })

  it('未支持的语言与读不到内容的文件进 skipped，并说明原因', () => {
    const files = ['a.md', 'src/gone.ts']
    const contents = new Map<string, string | null>([['a.md', '# hi'], ['src/gone.ts', null]])
    const graph = buildDepGraph(files, contents)
    expect(graph.scanned).toEqual([])
    expect(graph.skipped).toEqual([
      { path: 'a.md', reason: '未支持依赖扫描的文件类型' },
      { path: 'src/gone.ts', reason: '内容不可读' },
    ])
  })

  it('配对虚构出来的 canonical 路径记「未配对到实现」，不记「内容不可读」', () => {
    // tests/e2e/cli.test.ts 规约不到任何实现，退回一个并不存在的 src/e2e/cli.ts。
    // 它不是一个读不出来的文件，它根本不是文件——说「已删除或二进制」两半都假，
    // 还把一条仓库里搜不到的路径摆到人面前。
    const files = ['src/e2e/cli.ts', 'src/gone.ts']
    const contents = new Map<string, string | null>([
      ['src/e2e/cli.ts', null],
      ['src/gone.ts', null],
    ])
    const graph = buildDepGraph(files, contents, { fabricated: new Set(['src/e2e/cli.ts']) })
    expect(graph.skipped).toEqual([
      { path: 'src/e2e/cli.ts', reason: '未配对到实现' },
      { path: 'src/gone.ts', reason: '内容不可读' },
    ])
  })

  it('import 目标是非源码文件（.json 等）不连边——spec §4.5：非源码不参与依赖图', () => {
    // 不这样做的话，`src/z.ts` 依赖 `fixtures/data.json` 会强迫 topoOrder
    // 把 data.json 排到 z.ts 前面：build/doc 又被一条依赖边拖回代码中间，
    // 重新切散成按角色断章要消灭的那种碎片（见 segment.test.ts 的端到端用例）。
    const files = ['src/z.ts', 'fixtures/data.json']
    const contents = new Map([
      ['src/z.ts', "import data from '../fixtures/data.json'\n"],
      ['fixtures/data.json', '{}'],
    ])
    const graph = buildDepGraph(files, contents)
    expect(graph.edges.get('src/z.ts')?.size ?? 0).toBe(0)
  })

  it('不产生自环', () => {
    const files = ['src/a.ts']
    const contents = new Map([['src/a.ts', "import { x } from './a.js'\n"]])
    expect(buildDepGraph(files, contents).edges.get('src/a.ts')?.size ?? 0).toBe(0)
  })

  it('包路径后缀有歧义时，结果与输入文件的顺序无关', () => {
    const files = [
      'z/src/main/kotlin/com/acme/Order.kt',
      'a/lib/src/main/kotlin/com/acme/Order.kt',
      'x/Main.kt',
    ]
    const contents = new Map(
      files.map((f) => [f, f.endsWith('Main.kt') ? 'import com.acme.Order\n' : 'class Order\n']),
    )
    const forward = buildDepGraph(files, contents)
    const backward = buildDepGraph([...files].reverse(), contents)
    expect([...(forward.edges.get('x/Main.kt') ?? [])])
      .toEqual([...(backward.edges.get('x/Main.kt') ?? [])])
    expect([...(forward.edges.get('x/Main.kt') ?? [])]).toHaveLength(1)
  })
})
