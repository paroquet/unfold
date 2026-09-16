import { rulesFingerprint } from './rules.js'
import type { Plan, PlanContext } from './plan.js'

export type ValidationCode =
  | 'hunk-missing'
  | 'hunk-duplicated'
  | 'hunk-unknown'
  | 'file-missing'
  | 'file-duplicated'
  | 'file-unknown'
  | 'chapter-index'
  | 'cross-round-drift'

export interface ValidationIssue {
  code: ValidationCode
  message: string
}

/**
 * schema 管不到、但错了会毁掉字节一致或跨轮稳定的语义规则（spec §7.3）。
 * 返回空数组表示通过。
 */
export function validatePlan(plan: Plan, ctx: PlanContext): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const [i, ch] of plan.chapters.entries()) {
    if (ch.index !== i + 1) {
      issues.push({
        code: 'chapter-index',
        message: `第 ${i + 1} 个章节的 index 是 ${ch.index}，章号必须从 1 起连续`,
      })
    }
  }

  const knownHunks = new Set(ctx.changes.flatMap((c) => c.hunks.map((h) => h.id)))
  const knownFiles = new Set(ctx.changes.map((c) => c.path))

  const seenHunks = new Map<string, number>()
  const seenFiles = new Map<string, number>()
  for (const ch of plan.chapters) {
    for (const id of ch.hunkIds) seenHunks.set(id, (seenHunks.get(id) ?? 0) + 1)
    for (const p of ch.filePaths) seenFiles.set(p, (seenFiles.get(p) ?? 0) + 1)
  }

  for (const id of knownHunks) {
    if (!seenHunks.has(id)) {
      issues.push({ code: 'hunk-missing', message: `hunk ${id} 没有被分配到任何章节` })
    }
  }
  for (const [id, n] of seenHunks) {
    if (!knownHunks.has(id)) {
      issues.push({ code: 'hunk-unknown', message: `hunk ${id} 不存在于本轮改动中` })
    } else if (n > 1) {
      issues.push({ code: 'hunk-duplicated', message: `hunk ${id} 被分配了 ${n} 次` })
    }
  }
  for (const p of knownFiles) {
    if (!seenFiles.has(p)) {
      issues.push({ code: 'file-missing', message: `文件 ${p} 没有被分配到任何章节` })
    }
  }
  for (const [p, n] of seenFiles) {
    if (!knownFiles.has(p)) {
      issues.push({ code: 'file-unknown', message: `文件 ${p} 不存在于本轮改动中` })
    } else if (n > 1) {
      issues.push({ code: 'file-duplicated', message: `文件 ${p} 被分配了 ${n} 次` })
    }
  }

  // 跨轮漂移只在**同一套规则**的两轮之间才有意义：规则变了就是故意要换
  // 一种讲法，这时候报漂移会把「调规则」这件事本身变成不可能。buildPlan
  // 同样按指纹决定要不要沿用上一轮归属，两处判据必须一致。
  const sameRules =
    ctx.previous !== undefined && ctx.previous.rulesFingerprint === rulesFingerprint(ctx.rules)

  if (ctx.previous !== undefined && sameRules) {
    // 按 key 而非 index 比对：index 是位置序号，会随「本轮哪些类非空」
    // 合法变动，拿它判漂移会大量误报
    const before = new Map<string, string>()
    for (const ch of ctx.previous.chapters) {
      for (const p of ch.filePaths) before.set(p, ch.key)
    }
    const after = new Map<string, string>()
    for (const ch of plan.chapters) {
      for (const p of ch.filePaths) after.set(p, ch.key)
    }
    for (const [p, wasKey] of before) {
      const nowKey = after.get(p)
      if (nowKey !== undefined && nowKey !== wasKey) {
        issues.push({
          code: 'cross-round-drift',
          message: `文件 ${p} 上一轮在「${wasKey}」章，本轮变成「${nowKey}」章；批注会漂移`,
        })
      }
    }
  }

  return issues
}
