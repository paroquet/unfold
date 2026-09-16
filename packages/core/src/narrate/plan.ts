import type { FileChange } from './diff.js'
import type { NarrativeRules } from './rules.js'

export interface Chapter {
  /** 从 1 起，连续 */
  index: number
  /**
   * planner 指派的稳定标识，跨轮语义不变（例如 RulePlanner 的 PathClass，
   * 或兜底章的 'rest'）。`index` 会因为「本轮哪些桶非空」而在轮次间变化，
   * 不能拿它当跨轮锚点；`key` 才是 applyPreviousAssignment 用来找回
   * 「同一概念章节」的依据（spec §7.3）。
   */
  key: string
  title: string
  /** 「为什么先看这个」 */
  intro: string
  /** 本章包含的 hunk id */
  hunkIds: string[]
  /**
   * 在本章「最终落地」的文件。语义：该文件的最后一个 hunk 所在章；
   * 无 hunk 的文件（二进制）也在此声明。每个文件在全局恰好出现一次，
   * 这条由 validatePlan 的 file-duplicated / file-missing 守住。
   */
  filePaths: string[]
}

export interface Plan {
  version: 1
  /**
   * 产出本 plan 时所用规则的指纹（rules.ts 的 rulesFingerprint）。
   * 跨轮稳定只在指纹相同的两轮之间成立——规则变了就是故意要换一种讲法，
   * 沿用旧归属反而是错的。旧版产物没有这个字段，视为「未知」即不同。
   */
  rulesFingerprint: string
  base: string
  snapshot: string
  /** 产出该 plan 的 planner id，便于复现（spec §7.5） */
  plannerId: string
  chapters: Chapter[]
}

export interface PlanContext {
  base: string
  snapshot: string
  changes: FileChange[]
  /** 章节骨架：有哪些层、什么顺序、怎么匹配 */
  rules: NarrativeRules
  /** 上一轮的 plan，用于跨轮稳定（spec §7.3） */
  previous?: Plan
}

/**
 * planner 的全部产出：**只回答归属**。
 *
 * 章节骨架（有哪些章、什么顺序、标题是什么）由 rules 决定，装配由 buildPlan
 * 完成——planner 造不出 rules 之外的章节，这是结构性的约束，不是靠 prompt 请求。
 */
export interface Assignment {
  /** 文件路径 → 层 key。每个改动文件都必须有归属，漏了 buildPlan 会抛错 */
  byLayer: Map<string, string>
  /** 可选：本轮定制的导语，覆盖 rules 里的静态文案（AI 能写得更贴这次改动） */
  intros?: Map<string, string>
}

export interface ChapterPlanner {
  readonly id: string
  assign(ctx: PlanContext): Promise<Assignment>
}
