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
    const { order } = topoOrder(
      ['src/bin/x.ts', 'src/git/a.ts', 'src/git/b.ts'],
      graph({ 'src/git/b.ts': ['src/git/a.ts'], 'src/git/a.ts': [], 'src/bin/x.ts': [] }),
      ['src/bin', 'src/git'],
    )
    expect(order).toEqual(['src/bin/x.ts', 'src/git/a.ts', 'src/git/b.ts'])
  })

  it('未被任何前缀命中的节点排在命中者之后', () => {
    const { order } = topoOrder(
      ['z/other.ts', 'src/git/a.ts'],
      graph({ 'z/other.ts': [], 'src/git/a.ts': [] }),
      ['src/git'],
    )
    expect(order).toEqual(['src/git/a.ts', 'z/other.ts'])
  })
})
