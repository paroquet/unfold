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
      { path: 'src/gone.ts', reason: '内容不可读（已删除或二进制）' },
    ])
  })

  it('不产生自环', () => {
    const files = ['src/a.ts']
    const contents = new Map([['src/a.ts', "import { x } from './a.js'\n"]])
    expect(buildDepGraph(files, contents).edges.get('src/a.ts')?.size ?? 0).toBe(0)
  })
})
