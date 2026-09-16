import { hunkPath } from './diff.js'
import { rulesFingerprint } from './rules.js'
import type { Assignment, Chapter, Plan, PlanContext } from './plan.js'

/**
 * 把册装配成完整的 Plan。
 *
 * 归属阶梯在这里落地：`ctx.pinned` 是第一级（批注钉定），`ctx.registry.members`
 * 是第二级（册沿用），`assignment.byChapter` 是第三级（planner 对增量的表态）。
 * 前两级已经由 run.ts 算完，这里只负责按册的顺序装配与校验。
 *
 * 漏分配的文件**抛错**而不是悄悄补进某一章——planner 漏了文件是它出错了，
 * 该被发现（spec §7.2）。
 */
export function buildPlan(
  ctx: PlanContext,
  assignment: Assignment,
  plannerId: string,
): Plan {
  // canonical 单元 → 章 key：册优先，其次是 planner 的表态
  const chapterOfUnit = new Map<string, string>()
  for (const chapter of ctx.registry.chapters) {
    for (const member of chapter.members) chapterOfUnit.set(member, chapter.key)
  }
  for (const [unit, key] of assignment.byChapter) {
    if (!chapterOfUnit.has(unit)) chapterOfUnit.set(unit, key)
  }

  const known = new Set(ctx.registry.chapters.map((c) => c.key))
  for (const [unit, key] of chapterOfUnit) {
    if (!known.has(key)) {
      throw new Error(
        `planner「${plannerId}」把 ${unit} 分到了册里不存在的章「${key}」` +
          `（册里的章：${[...known].join(', ')}）`,
      )
    }
  }

  // 每个 hunk 归哪一章：批注钉定优先，否则跟它的文件走
  const chapterOfPath = (path: string): string | undefined => {
    const unit = ctx.canonical.get(path) ?? path
    return chapterOfUnit.get(unit)
  }

  const missing = ctx.changes.map((c) => c.path).filter((p) => chapterOfPath(p) === undefined)
  if (missing.length > 0) {
    throw new Error(
      `有 ${missing.length} 个文件没有被任何章认领：${missing.join(', ')}`,
    )
  }

  const hunksByChapter = new Map<string, string[]>()
  const filesByChapter = new Map<string, string[]>()
  for (const key of known) {
    hunksByChapter.set(key, [])
    filesByChapter.set(key, [])
  }

  for (const change of ctx.changes) {
    const fallback = chapterOfPath(change.path) as string
    let lastChapter = fallback
    for (const h of change.hunks) {
      const key = ctx.pinned.get(h.id) ?? fallback
      if (!known.has(key)) {
        throw new Error(`批注把 hunk ${h.id} 钉到了册里不存在的章「${key}」`)
      }
      hunksByChapter.get(key)?.push(h.id)
      lastChapter = key
    }
    // 文件在「它最后一个 hunk 所在的章」达到终态；无 hunk 的文件（二进制、
    // 仅 mode 变更）落在它自己的章。replay 依赖这条，改动它会破坏字节一致。
    filesByChapter.get(lastChapter)?.push(change.path)
  }

  let commitIndex = 0
  const chapters: Chapter[] = ctx.registry.chapters.map((record, i) => {
    const hunkIds = hunksByChapter.get(record.key) ?? []
    const filePaths = filesByChapter.get(record.key) ?? []
    const hasContent = hunkIds.length > 0 || filePaths.length > 0
    if (hasContent) commitIndex += 1
    const override = ctx.rules.titles[record.key]
    return {
      index: i + 1,
      commitIndex: hasContent ? commitIndex : null,
      key: record.key,
      title: override?.title ?? record.title,
      intro: assignment.intros?.get(record.key) ?? override?.intro ?? record.intro,
      // 册里标 active、但本轮该章的 hunk 全被批注钉去了别处时，不能跟着册说
      // 'active'——那会产出 status: 'active' 却 commitIndex: null 的自相矛盾章节
      status: hasContent ? 'active' : record.status === 'deleted' ? 'deleted' : 'empty',
      keyRenamedFrom: record.keyRenamedFrom,
      hunkIds,
      filePaths,
    }
  })

  return {
    version: 1,
    base: ctx.base,
    snapshot: ctx.snapshot,
    plannerId,
    rulesFingerprint: rulesFingerprint(ctx.rules),
    chapters,
  }
}

/** 仅为可读性导出：从 hunk id 还原文件路径（与 replay / codetour 同一实现）。 */
export { hunkPath }
