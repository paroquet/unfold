import type { FileChange } from './diff.js'

export interface Chapter {
  /** 从 1 起，连续 */
  index: number
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
  /** 上一轮的 plan，用于跨轮稳定（spec §7.3） */
  previous?: Plan
}

export interface ChapterPlanner {
  readonly id: string
  plan(ctx: PlanContext): Promise<Plan>
}
