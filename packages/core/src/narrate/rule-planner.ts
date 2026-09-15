import { hunkPath } from './diff.js'
import type { FileChange } from './diff.js'
import type { Chapter, ChapterPlanner, Plan, PlanContext } from './plan.js'

export type PathClass = 'contract' | 'core' | 'wiring' | 'test-doc'

const ORDER: PathClass[] = ['contract', 'core', 'wiring', 'test-doc']

const TITLES: Record<PathClass, string> = {
  contract: '第 1 层：契约',
  core: '第 2 层：核心逻辑',
  wiring: '第 3 层：接线与调用方',
  'test-doc': '第 4 层：测试与文档',
}

const INTROS: Record<PathClass, string> = {
  contract: '先看类型、schema 与接口——它们定义了后面所有代码要满足的形状。',
  core: '再看核心逻辑：真正实现行为的地方，前面的契约在这里被兑现。',
  wiring: '然后看接线：谁调用了上面这些东西，改动如何被接进系统。',
  'test-doc': '最后看测试与文档：它们说明作者认为哪些行为值得保证。',
}

/** 按路径把文件归到叙事的四层（spec §6.4 的默认顺序） */
export function classifyPath(path: string): PathClass {
  const lower = path.toLowerCase()
  if (/(^|\/)(tests?|__tests__|spec)\//.test(lower) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)) {
    return 'test-doc'
  }
  if (/\.(md|mdx|txt|rst|adoc)$/.test(lower)) return 'test-doc'
  if (/(^|\/)(types?|schema|schemas|proto|api|contracts?)(\/|\.)/.test(lower)) return 'contract'
  if (/\.(d\.ts|proto|graphql|avsc)$/.test(lower)) return 'contract'
  if (/(^|\/)(index|main|app|bootstrap|cli|bin)\.[cm]?[jt]sx?$/.test(lower)) return 'wiring'
  if (/\.(json|ya?ml|toml|ini|cfg)$/.test(lower)) return 'wiring'
  return 'core'
}

function emptyChapter(index: number, cls: PathClass): Chapter {
  return { index, key: cls, title: TITLES[cls], intro: INTROS[cls], hunkIds: [], filePaths: [] }
}

/**
 * v1 的确定性 planner（spec §9.2 的兜底，也是 AI 不可用时的保底路径）。
 * 只产「整文件同章」的分配——文件内分章是 v2（spec §6.5）。
 */
export class RulePlanner implements ChapterPlanner {
  readonly id = 'rule'

  async plan(ctx: PlanContext): Promise<Plan> {
    const buckets = new Map<PathClass, FileChange[]>(ORDER.map((c) => [c, []]))
    for (const change of ctx.changes) {
      buckets.get(classifyPath(change.path))!.push(change)
    }

    const chapters: Chapter[] = []
    for (const cls of ORDER) {
      const files = buckets.get(cls)!
      if (files.length === 0) continue
      const ch = emptyChapter(chapters.length + 1, cls)
      for (const f of files) {
        ch.filePaths.push(f.path)
        for (const h of f.hunks) ch.hunkIds.push(h.id)
      }
      chapters.push(ch)
    }

    // 「其余」章：兜住一切没被上面覆盖的文件，保证 verify 恒真（spec §6.3）。
    // classifyPath 是穷尽的，rest 理论上恒为空；只在真的非空时才 materialize，
    // 避免每轮都产出一个永久空章（下游按章节数一一提交，空章 = 空 commit）。
    const covered = new Set(chapters.flatMap((c) => c.filePaths))
    const rest = ctx.changes.filter((c) => !covered.has(c.path))
    if (rest.length > 0) {
      chapters.push({
        index: chapters.length + 1,
        key: 'rest',
        title: '其余',
        intro: '前面各章未覆盖的改动，一并在此落地，确保终态与原分支逐字节一致。',
        hunkIds: rest.flatMap((c) => c.hunks.map((h) => h.id)),
        filePaths: rest.map((c) => c.path),
      })
    }

    // 跨轮稳定：按 key 把上一轮已分配过的文件放回同一概念章节（spec §7.3）。
    pinToPreviousChapters(chapters, ctx.changes, ctx.previous)

    return {
      version: 1,
      base: ctx.base,
      snapshot: ctx.snapshot,
      plannerId: this.id,
      chapters,
    }
  }
}

/**
 * 跨轮稳定的核心收敛逻辑：把已经在 `previous` 里分配过的文件，钉回它在
 * `previous` 里所在的章（按 `key` 匹配，而非 `index`——`index` 由本轮哪些桶
 * 非空决定，同一概念章节的 index 在轮次间可能变化，不能当锚点）。
 *
 * 若 `previous` 里某文件的 key 在本轮 `chapters` 中不存在，则不强行搬动，
 * 文件保持规则（或调用方）本身给出的位置，不凭空造一个章出来。
 *
 * 导出是因为这段逻辑不是 RulePlanner 专属：v2 的 AI planner 在跨轮场景下
 * （包括 spec §9.2 AI 不可用回落到 RulePlanner 的混合场景——此时 previous
 * 的 key 可能来自 AI 排的章、与规则的自然归属并不一致）同样要收敛到同一批
 * 「已标注过的文件不漂移」的语义，应当复用这一个实现，而不是各自重写一遍。
 */
export function pinToPreviousChapters(
  chapters: Chapter[],
  changes: FileChange[],
  previous: Plan | undefined,
): void {
  if (previous === undefined) return

  // 有 hunk 的文件其路径必在 filePaths 里，无需再从 hunkIds 重复填一遍。
  const previousChapterKeyOf = new Map<string, string>()
  for (const ch of previous.chapters) {
    for (const p of ch.filePaths) previousChapterKeyOf.set(p, ch.key)
  }
  if (previousChapterKeyOf.size === 0) return

  const byKey = new Map(chapters.map((c) => [c.key, c]))
  for (const change of changes) {
    const wantKey = previousChapterKeyOf.get(change.path)
    if (wantKey === undefined) continue
    const target = byKey.get(wantKey)
    if (target === undefined) continue
    for (const ch of chapters) {
      if (ch.key === wantKey) continue
      ch.filePaths = ch.filePaths.filter((p) => p !== change.path)
      ch.hunkIds = ch.hunkIds.filter((id) => hunkPath(id) !== change.path)
    }
    if (!target.filePaths.includes(change.path)) target.filePaths.push(change.path)
    for (const h of change.hunks) {
      if (!target.hunkIds.includes(h.id)) target.hunkIds.push(h.id)
    }
  }
}
