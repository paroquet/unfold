import { roleOf } from './pair.js'

export interface OrderResult {
  /** 全序：被依赖的在前。同样的输入永远产出同样的顺序 */
  order: string[]
  /** 元素数 > 1 的强连通分量，内部按字典序 */
  cycles: string[][]
}

/**
 * 字符串比较**不用 `localeCompare`**：它的结果依赖 ICU 版本与 locale，
 * 换台机器就可能换顺序，而章节 key 的稳定性全靠这个顺序。
 * 裸比较走 UTF-16 码元序，跨机器恒定。
 */
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 迭代版 Tarjan。递归版在超大改动集上会爆栈，而改动集大小不由我们控制。 */
function stronglyConnected(
  nodes: string[],
  edges: Map<string, Set<string>>,
): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  for (const root of nodes) {
    if (index.has(root)) continue
    // 手工栈：每帧记住「这个节点的邻居遍历到第几个了」
    const work: Array<{ node: string; neighbors: string[]; at: number }> = [
      { node: root, neighbors: [...(edges.get(root) ?? [])].sort(byName), at: 0 },
    ]
    index.set(root, counter)
    low.set(root, counter)
    counter += 1
    stack.push(root)
    onStack.add(root)

    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: string; neighbors: string[]; at: number }
      if (frame.at < frame.neighbors.length) {
        const next = frame.neighbors[frame.at] as string
        frame.at += 1
        if (!index.has(next)) {
          index.set(next, counter)
          low.set(next, counter)
          counter += 1
          stack.push(next)
          onStack.add(next)
          work.push({ node: next, neighbors: [...(edges.get(next) ?? [])].sort(byName), at: 0 })
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(next) as number))
        }
        continue
      }

      work.pop()
      const parent = work[work.length - 1]
      if (parent !== undefined) {
        low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(frame.node) as number))
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = []
        for (;;) {
          const popped = stack.pop() as string
          onStack.delete(popped)
          component.push(popped)
          if (popped === frame.node) break
        }
        components.push(component.sort(byName))
      }
    }
  }

  return components
}

/**
 * 确定性拓扑排序。
 *
 * 三条保证，缺一条跨轮 key 就会漂：
 * 1. 强连通分量整体作为一个节点参与排序，内部按字典序——环里没有真正的先后
 * 2. 同时可选的分量按「桶号 + 分量内字典序最小的成员」排，而不是按入队顺序
 * 3. `prefixes` 命中的节点整体提前，但桶内仍走依赖序
 */
export function topoOrder(
  nodes: string[],
  edges: Map<string, Set<string>>,
  prefixes: string[] = [],
): OrderResult {
  const components = stronglyConnected(nodes, edges)
  const componentOf = new Map<string, number>()
  for (const [i, component] of components.entries()) {
    for (const node of component) componentOf.set(node, i)
  }

  // 缩点后的 DAG：分量 → 它依赖的分量
  const deps = components.map(() => new Set<number>())
  const dependents = components.map(() => new Set<number>())
  for (const node of nodes) {
    const from = componentOf.get(node) as number
    for (const target of edges.get(node) ?? []) {
      const to = componentOf.get(target)
      if (to === undefined || to === from) continue
      deps[from]?.add(to)
      dependents[to]?.add(from)
    }
  }

  /**
   * 该成员落在第几层。层号从小到大依次是：`prefixes` 里的每个前缀、
   * 未命中前缀的源码、**build**、**doc**（spec §4.5 的「非源码」现在
   * 按角色再分两层，而不是合并成一个桶）。
   *
   * build/doc 文件不参与依赖图，一条边都没有，跟源码混在同一层里就只按
   * 字典序排——`README.md` 于是排在 `packages/...` 前面，整条叙事从一篇
   * 文档讲起。分两层是为了让构建配置排在文档之前：两者都不是「代码」，
   * 但构建配置更接近代码，读者应该先看完怎么编译/怎么跑，再看文档。
   *
   * 判据复用 `pair.ts` 的 `roleOf`（order 不被任何人 import，引它不成环），
   * 而不是另起一份扩展名清单——两份清单迟早会漂。
   */
  const tierOf = (member: string): number => {
    const role = roleOf(member)
    if (role === 'build') return prefixes.length + 1
    if (role === 'doc') return prefixes.length + 2
    let best = prefixes.length
    for (const [i, prefix] of prefixes.entries()) {
      if (i < best && (member === prefix || member.startsWith(`${prefix}/`))) best = i
    }
    return best
  }
  // 强连通分量可能横跨角色（前提是它们之间真的有依赖边）。这种时候取
  // 分量里最低的层号——代码不该被一个混进来的构建文件拖到最后。
  // 用循环取最小值而不是 `Math.min(...arr)`：展开传参会把数组元素铺进
  // 调用栈，超大强连通分量会爆栈——`stronglyConnected` 当初特意改成迭代版
  // Tarjan 就是为了避免这类问题，这里不能用一行展开语法把它绕回去。
  const bucketOf = (component: string[]): number => {
    let best = Infinity
    for (const member of component) {
      const tier = tierOf(member)
      if (tier < best) best = tier
    }
    return best
  }
  const bucket = components.map(bucketOf)
  const head = components.map((component) => component[0] as string)

  const remaining = components.map((_, i) => (deps[i] as Set<number>).size)
  const ready: number[] = components.map((_, i) => i).filter((i) => remaining[i] === 0)
  const order: string[] = []

  while (ready.length > 0) {
    // 每轮取排序键最小的：用排序取代优先队列，分量数不会大到需要堆
    ready.sort(
      (a, b) =>
        (bucket[a] as number) - (bucket[b] as number) ||
        byName(head[a] as string, head[b] as string),
    )
    const current = ready.shift() as number
    order.push(...(components[current] as string[]))
    for (const dependent of dependents[current] ?? []) {
      remaining[dependent] = (remaining[dependent] as number) - 1
      if (remaining[dependent] === 0) ready.push(dependent)
    }
  }

  return {
    order,
    cycles: components
      .filter((c) => c.length > 1)
      .sort((a, b) => byName(a[0] as string, b[0] as string)),
  }
}
