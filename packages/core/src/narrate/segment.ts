import { roleOf } from './pair.js'

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
 * 沿拓扑序贪心切段。断章规则：
 *
 * - **角色变化必断**：代码、构建配置、文档永不同章
 * - **跨目录必断、超 `maxFiles` 必断**——但只对 `source` 生效。
 *   非源码章不按目录、也不按 maxFiles 断：maxFiles 的理由是「一章要能
 *   一口气读完代码」，而构建配置与文档是扫读的；按目录断则会把同一件事
 *   （比如整个项目的构建配置）按归档位置切成好几章。
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
    const role = roleOf(node)
    const roleChanged = current.length > 0 && roleOf(current[0] as string) !== role
    const sameDir = current.length > 0 && dirOf(current[0] as string) === dirOf(node)
    const fits = currentFiles + files <= maxFiles
    const structuralBreak = role === 'source' && (!sameDir || !fits)
    if (current.length > 0 && (roleChanged || structuralBreak)) {
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
    const role = roleOf(head)
    const label = role === 'source' ? labelOf(dirOf(head)) : role === 'build' ? '构建与配置' : '文档'
    const names = members.length === 1 ? baseOf(head) : `${baseOf(head)} → ${baseOf(tail)}`

    const inCycle = members.filter((m) => cycleOf.has(m))
    const cycleNote =
      inCycle.length > 0
        ? `其中 ${inCycle.map(baseOf).join('、')} 互相依赖，先后不代表调用方向。`
        : ''

    // source 是依赖序，「先讲到后」有因果意味；build/doc 之间没有依赖边
    // （deps.ts 的 buildDepGraph 不接指向非源码文件的边，spec §4.5），
    // 排列纯粹是路径字典序，说成「依赖顺序」是假的，要说实话。
    const intro = role === 'source'
      ? `按依赖顺序，这一章从 ${baseOf(head)} 讲到 ${baseOf(tail)}。${cycleNote}`
      : `这一章收纳${label}相关的改动，按路径顺序从 ${baseOf(head)} 排到 ${baseOf(tail)}。${cycleNote}`

    return {
      key: head,
      title: `${label}：${names}`,
      intro,
      members,
    }
  })
}
