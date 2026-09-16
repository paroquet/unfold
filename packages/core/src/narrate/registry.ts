import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Segment } from './segment.js'

export type ChapterStatus = 'active' | 'empty' | 'deleted'

export interface ChapterRecord {
  /** 段首文件的 canonical path */
  key: string
  /** 册内序号，从 1 连续。与 commit 序号不是一回事 */
  index: number
  title: string
  intro: string
  status: ChapterStatus
  /** 累积的成员（canonical path），按依赖序 */
  members: string[]
  /** 段首被删导致 key 顺延时，记下旧 key，好让上层把批注迁过去 */
  keyRenamedFrom: string | null
  createdRound: number
  lastActiveRound: number
}

export interface Registry {
  version: 1
  chapters: ChapterRecord[]
}

export const EMPTY_REGISTRY: Registry = { version: 1, chapters: [] }
export const REGISTRY_FILE = 'registry.json'

export interface UpdateInput {
  registry: Registry
  /**
   * 本轮按依赖序切出来的段。只有**未被册认领**的成员会从这里取。
   *
   * 调用方契约：段成员必须是 `activeUnits` 的子集——两者在 run.ts 里同源于
   * 本轮改动算出的 units。下面「并入同 key 已有章即置 active」正是靠这条才成立；
   * 若将来有调用方传入本轮没有改动的单元，那句无条件置 active 就会把一个
   * 实际没动的章标成 active，需连同改掉。
   */
  segments: Segment[]
  round: number
  /** 快照里仍然存在的 canonical path */
  present: Set<string>
  /** 本轮真有改动的 canonical 单元。章是否 active 由它的成员是否在这里决定 */
  activeUnits: Set<string>
  /** 本轮的依赖序，用来给新章定位 */
  order: string[]
}

/**
 * 把本轮的切段结果并进册里。**册优先于本轮的重新计算**——
 * 已经在册的文件留在原章，哪怕这一轮算出来该去别处；否则每加一个文件
 * 就可能把一批文件拽到新章，人写的批注全部漂走。
 */
export function updateRegistry(input: UpdateInput): Registry {
  const { registry, segments, round, present, activeUnits, order } = input
  const orderPos = new Map(order.map((path, i) => [path, i]))

  // 1) 已有章：剔掉已删成员，决定状态，必要时顺延 key
  const claimed = new Set<string>()
  const kept: ChapterRecord[] = []
  for (const chapter of registry.chapters) {
    const members = chapter.members.filter((m) => present.has(m))
    for (const m of members) claimed.add(m)

    if (members.length === 0) {
      kept.push({ ...chapter, members: [], status: 'deleted' })
      continue
    }

    const active = members.some((m) => activeUnits.has(m))
    const renamed = !members.includes(chapter.key)
    kept.push({
      ...chapter,
      key: renamed ? (members[0] as string) : chapter.key,
      keyRenamedFrom: renamed ? chapter.key : chapter.keyRenamedFrom,
      members,
      status: active ? 'active' : 'empty',
      lastActiveRound: active ? round : chapter.lastActiveRound,
    })
  }

  // 2) 本轮段里没被册认领的成员 —— 并入同 key 的已有章，否则开新章
  const byKey = new Map(kept.map((c) => [c.key, c]))
  const fresh: ChapterRecord[] = []
  for (const s of segments) {
    const members = s.members.filter((m) => !claimed.has(m))
    if (members.length === 0) continue

    const existing = byKey.get(s.key)
    if (existing !== undefined) {
      // 并入已有章可能让它超过 maxFiles —— 由 chapter-oversized 警告，不在这里拦
      existing.members = [...existing.members, ...members]
      existing.status = 'active'
      existing.lastActiveRound = round
      continue
    }

    fresh.push({
      key: s.key,
      index: 0,
      title: s.title,
      intro: s.intro,
      status: 'active',
      members,
      keyRenamedFrom: null,
      createdRound: round,
      lastActiveRound: round,
    })
  }

  // 3) 新章按依赖序插位；已有章保持相对顺序
  const posOf = (chapter: ChapterRecord): number => {
    let best = Number.POSITIVE_INFINITY
    for (const m of chapter.members) {
      const at = orderPos.get(m)
      if (at !== undefined && at < best) best = at
    }
    return best
  }

  const chapters = [...kept]
  for (const candidate of fresh.sort((a, b) => posOf(a) - posOf(b))) {
    const at = posOf(candidate)
    // 插到第一个「本轮确实排在它后面」的已有章之前；没有这样的邻居就追加到末尾。
    //
    // **只拿本轮有位置的章当锚点**：本轮没动的章（empty / deleted）没有任何成员
    // 出现在 order 里，posOf 给的是 +Infinity。把它也算成「更靠后」的话，
    // 册里只要有一个空章，findIndex 就永远命中它，新章一律插到它前面——
    // 实测过一次：被依赖方落在第 4 章、依赖它的新章落到第 2 章，读者先读到
    // 调用方。spec §5.1 要的是「新章按依赖序插到该去的位置」。
    const index = chapters.findIndex((c) => {
      const pos = posOf(c)
      return Number.isFinite(pos) && pos > at
    })
    if (index < 0) chapters.push(candidate)
    else chapters.splice(index, 0, candidate)
  }

  return {
    version: 1,
    chapters: chapters.map((c, i) => ({ ...c, index: i + 1 })),
  }
}

/** 读册。文件不存在表示这是第一轮，返回空册而不是报错。 */
export async function readRegistry(reviewRoot: string): Promise<Registry> {
  const path = join(reviewRoot, REGISTRY_FILE)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_REGISTRY
    throw err
  }
  try {
    return JSON.parse(text) as Registry
  } catch (err) {
    // JSON.parse 抛的 SyntaxError 没有 .code，不会撞上面的 ENOENT 判断，
    // 但原样冒出去只说"不是合法 JSON"，不说是哪个文件——排查时得先反查
    // 调用栈才知道是哪个 review 的册坏了。带上路径再抛。
    throw new Error(`章节册不是合法 JSON：${path}（${(err as Error).message}）`)
  }
}

export async function writeRegistry(reviewRoot: string, registry: Registry): Promise<void> {
  await writeFile(
    join(reviewRoot, REGISTRY_FILE),
    `${JSON.stringify(registry, null, 2)}\n`,
    'utf8',
  )
}
