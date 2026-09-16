import { describe, it, expect } from 'vitest'
import { topoOrder } from '../../src/narrate/order.js'

const graph = (spec: Record<string, string[]>): Map<string, Set<string>> =>
  new Map(Object.entries(spec).map(([k, v]) => [k, new Set(v)]))

describe('topoOrder', () => {
  it('被依赖的排在前面', () => {
    const { order } = topoOrder(['run', 'diff', 'plan'], graph({
      run: ['plan'], plan: ['diff'], diff: [],
    }))
    expect(order).toEqual(['diff', 'plan', 'run'])
  })

  it('同层按字典序，且与输入顺序无关', () => {
    const nodes = ['c', 'a', 'b']
    const e = graph({ a: [], b: [], c: [] })
    expect(topoOrder(nodes, e).order).toEqual(['a', 'b', 'c'])
    expect(topoOrder([...nodes].reverse(), e).order).toEqual(['a', 'b', 'c'])
  })

  it('环被缩成一个分量，整体参与排序，内部按字典序', () => {
    const { order, cycles } = topoOrder(['tour', 'narrate', 'bin'], graph({
      narrate: ['tour'], tour: ['narrate'], bin: ['narrate'],
    }))
    expect(cycles).toEqual([['narrate', 'tour']])
    expect(order).toEqual(['narrate', 'tour', 'bin'])
  })

  it('分量内部按字典序，而不是 Tarjan 的出栈顺序', () => {
    // a 与 b 互相依赖。Tarjan 出栈是发现顺序的逆序，这里会得到 ['b','a']；
    // 没有内部排序的话 cycles 就是 [['b','a']]，跨轮 key 会跟着 Tarjan 的
    // 遍历细节漂。上一条测试的输入（narrate/tour）出栈恰好已是字典序，
    // 钉不住这个行为，所以需要这一条。
    const { order, cycles } = topoOrder(['a', 'b'], graph({ a: ['b'], b: ['a'] }))
    expect(cycles).toEqual([['a', 'b']])
    expect(order).toEqual(['a', 'b'])
  })

  it('单点自成分量不算环', () => {
    expect(topoOrder(['a', 'b'], graph({ a: ['b'], b: [] })).cycles).toEqual([])
  })

  it('order 前缀命中的节点按给定顺序排到最前，桶内仍走依赖序', () => {
    // 前缀顺序刻意与字典序相反（src/git 在 src/bin 前），
    // 这样只有真的按桶号排才能通过——退化成纯字典序会先给出 src/bin/x.ts
    const { order } = topoOrder(
      ['src/bin/x.ts', 'src/git/a.ts', 'src/git/b.ts'],
      graph({ 'src/git/b.ts': ['src/git/a.ts'], 'src/git/a.ts': [], 'src/bin/x.ts': [] }),
      ['src/git', 'src/bin'],
    )
    expect(order).toEqual(['src/git/a.ts', 'src/git/b.ts', 'src/bin/x.ts'])
  })

  it('非源码文件统一排到最后，哪怕字典序在源码之前（spec §4.5）', () => {
    // README.md 字典序在 src/a.ts 之前。不单开一个桶的话，它就是第 1 章，
    // 整条叙事从一篇文档讲起。
    const { order } = topoOrder(
      ['README.md', 'src/a.ts'],
      graph({ 'README.md': [], 'src/a.ts': [] }),
    )
    expect(order).toEqual(['src/a.ts', 'README.md'])
  })

  it('非源码桶内部仍按路径字典序', () => {
    const { order } = topoOrder(
      ['pnpm-lock.yaml', 'docs/b.md', 'docs/a.md', 'src/z.ts'],
      graph({ 'pnpm-lock.yaml': [], 'docs/b.md': [], 'docs/a.md': [], 'src/z.ts': [] }),
    )
    expect(order).toEqual(['src/z.ts', 'docs/a.md', 'docs/b.md', 'pnpm-lock.yaml'])
  })

  it('order 前缀也管不到非源码：命中前缀的 .md 仍排在源码之后', () => {
    // 否则「把 docs 前缀写进 order」会意外把文档整体提到最前，
    // 而 §4.5 说的是非源码一律最后
    const { order } = topoOrder(
      ['docs/x.md', 'src/a.ts'],
      graph({ 'docs/x.md': [], 'src/a.ts': [] }),
      ['docs'],
    )
    expect(order).toEqual(['src/a.ts', 'docs/x.md'])
  })

  it('未被任何前缀命中的节点排在命中者之后', () => {
    // 命中前缀的是 z/other.ts，字典序却排在 src/git/a.ts 之后，
    // 所以这条只有在桶号真的生效时才成立
    const { order } = topoOrder(
      ['z/other.ts', 'src/git/a.ts'],
      graph({ 'z/other.ts': [], 'src/git/a.ts': [] }),
      ['z'],
    )
    expect(order).toEqual(['z/other.ts', 'src/git/a.ts'])
  })
})
