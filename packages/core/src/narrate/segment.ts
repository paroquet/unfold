export interface Segment {
  /** 段首文件的 canonical path。往段中间插文件不会改它，批注因此不漂 */
  key: string
  title: string
  intro: string
  /** canonical path，按依赖序 */
  members: string[]
}

export interface SegmentInput {
  order: string[]
  cycles: string[][]
  maxFiles: number
  /** 该单元含几个真实文件（实现 + 它的测试）。切段按真实文件数封顶 */
  fileCount: (canonical: string) => number
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function baseOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

function labelOf(dir: string): string {
  if (dir === '') return '仓库根'
  return baseOf(dir)
}

/**
 * 沿拓扑序贪心切段。两条断章规则：
 *
 * - **跨目录必断**：同一目录里连续的数据流阶段合成一章，跨模块一定分开
 * - **超 `maxFiles` 必断**：按真实文件数算，因为读的人面对的是文件不是单元
 *
 * 单个单元自己就超标时仍然成章——章可以过大（会由 `chapter-oversized`
 * 警告出来），但绝不能因为装不下就把文件丢了。
 */
export function segment(input: SegmentInput): Segment[] {
  const { order, cycles, maxFiles, fileCount } = input
  const cycleOf = new Map<string, string[]>()
  for (const cycle of cycles) {
    for (const member of cycle) cycleOf.set(member, cycle)
  }

  const groups: string[][] = []
  let current: string[] = []
  let currentFiles = 0

  for (const node of order) {
    const files = fileCount(node)
    const sameDir = current.length > 0 && dirOf(current[0] as string) === dirOf(node)
    const fits = currentFiles + files <= maxFiles
    if (current.length > 0 && (!sameDir || !fits)) {
      groups.push(current)
      current = []
      currentFiles = 0
    }
    current.push(node)
    currentFiles += files
  }
  if (current.length > 0) groups.push(current)

  return groups.map((members) => {
    const head = members[0] as string
    const tail = members[members.length - 1] as string
    const label = labelOf(dirOf(head))
    const names = members.length === 1 ? baseOf(head) : `${baseOf(head)} → ${baseOf(tail)}`

    const inCycle = members.filter((m) => cycleOf.has(m))
    const cycleNote =
      inCycle.length > 0
        ? `其中 ${inCycle.map(baseOf).join('、')} 互相依赖，先后不代表调用方向。`
        : ''

    return {
      key: head,
      title: `${label}：${names}`,
      intro: `按依赖顺序，这一章从 ${baseOf(head)} 讲到 ${baseOf(tail)}。${cycleNote}`,
      members,
    }
  })
}
