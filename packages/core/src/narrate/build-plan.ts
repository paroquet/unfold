import { hunkPath } from './diff.js'
import { rulesFingerprint } from './rules.js'
import type { Assignment, Chapter, Plan, PlanContext } from './plan.js'

/**
 * 把「归属」装配成完整的 Plan。**两个 planner 共用这一份实现**——
 * 层的顺序、空层不产出、index 连续编号、跨轮钉回全在这里，
 * 不会被复制进 AI planner 再各自漂移。
 *
 * 不再有「其余」兜底章：rules.fallback 指向一个真实存在的层，每个文件
 * 必定有归属。漏分配的文件在这里**抛错**而不是被悄悄补进兜底章——
 * planner 漏了文件是它出错了，该被发现（spec §7.2：重试 → 降级到规则 planner）。
 */
export function buildPlan(
  ctx: PlanContext,
  assignment: Assignment,
  plannerId: string,
): Plan {
  const known = new Set(ctx.rules.layers.map((l) => l.key))

  for (const [path, key] of assignment.byLayer) {
    if (!known.has(key)) {
      throw new Error(
        `planner「${plannerId}」把 ${path} 分到了规则里不存在的层「${key}」` +
          `（已声明的层：${[...known].join(', ')}）`,
      )
    }
  }

  const missing = ctx.changes.map((c) => c.path).filter((p) => !assignment.byLayer.has(p))
  if (missing.length > 0) {
    throw new Error(
      `planner「${plannerId}」漏了 ${missing.length} 个文件没有分配：${missing.join(', ')}`,
    )
  }

  const byLayer = applyPrevious(ctx, assignment)

  const changeOf = new Map(ctx.changes.map((c) => [c.path, c]))
  const chapters: Chapter[] = []
  for (const layer of ctx.rules.layers) {
    const paths = ctx.changes.map((c) => c.path).filter((p) => byLayer.get(p) === layer.key)
    if (paths.length === 0) continue
    chapters.push({
      key: layer.key,
      index: chapters.length + 1,
      title: layer.title,
      intro: assignment.intros?.get(layer.key) ?? layer.intro,
      hunkIds: paths.flatMap((p) => (changeOf.get(p)?.hunks ?? []).map((h) => h.id)),
      filePaths: paths,
    })
  }

  return {
    version: 1,
    base: ctx.base,
    snapshot: ctx.snapshot,
    plannerId,
    rulesFingerprint: rulesFingerprint(ctx.rules),
    chapters,
  }
}

/**
 * 跨轮钉回：把上一轮分配过的文件钉回它当时所在的层，使人标注的批注不会
 * 因为重新规划而跑到别的章去。
 *
 * **只在规则指纹相同的两轮之间生效**——规则变了就是故意要换一种讲法，
 * 沿用旧归属反而是错的。
 */
function applyPrevious(ctx: PlanContext, assignment: Assignment): Map<string, string> {
  const result = new Map(assignment.byLayer)
  const previous = ctx.previous
  if (previous === undefined) return result
  if (previous.rulesFingerprint !== rulesFingerprint(ctx.rules)) return result

  const known = new Set(ctx.rules.layers.map((l) => l.key))
  for (const chapter of previous.chapters) {
    if (!known.has(chapter.key)) continue
    for (const path of chapter.filePaths) {
      if (result.has(path)) result.set(path, chapter.key)
    }
  }
  return result
}

/** 仅为可读性导出：从 hunk id 还原文件路径（与 replay / codetour 同一实现）。 */
export { hunkPath }
