import type { FileChange } from './diff.js'
import type { NarrativeRules } from './rules.js'
import type { ChapterStatus, Registry } from './registry.js'

export interface Chapter {
  /** 册内序号，从 1 起连续（含 empty 与 deleted 章） */
  index: number
  /**
   * 本轮 commit 序号，从 1 起连续。**没有任何改动的章为 null**——
   * 册里可能有 20 章而本轮只动了 3 章，不能产 17 个空 commit。
   */
  commitIndex: number | null
  /** 段首文件的 canonical path，跨轮锚点 */
  key: string
  title: string
  intro: string
  status: ChapterStatus
  /** 段首被删导致 key 顺延时的旧 key，供上层迁移批注 */
  keyRenamedFrom: string | null
  hunkIds: string[]
  filePaths: string[]
}

export interface Plan {
  version: 1
  rulesFingerprint: string
  base: string
  snapshot: string
  plannerId: string
  chapters: Chapter[]
}

export interface PlanContext {
  base: string
  snapshot: string
  changes: FileChange[]
  rules: NarrativeRules
  /** 真实路径 → canonical path（测试已规约到实现） */
  canonical: Map<string, string>
  /** 本轮更新后的章节册 */
  registry: Registry
  /** 归属阶梯第一级：hunkId → 批注所在的章 key */
  pinned: Map<string, string>
  /** canonical 单元之间的依赖边，供 chapter-backward-dep 检查 */
  deps: Map<string, Set<string>>
  /**
   * 快照树里字面存在的路径（原始 `ls-tree` 结果，不是册用的那个更宽的
   * `present`）。体检用它判断「测试配对到的 canonical 单元是否真的对应
   * 一个存在的文件」——配对规约不到实现时会虚构一个路径，那个路径不该
   * 被当成「存在」。
   */
  present: Set<string>
  previous?: Plan
}

/**
 * planner 的产出：**只回答增量归属**。
 *
 * 阶梯的前两级（批注钉定、册沿用）由 TS 先算完，直接从 planner 的取值域里
 * 拿掉——存量归属不容商量，planner 只对本轮新出现的单元表态。
 */
export interface Assignment {
  /** canonical 单元 → 章 key */
  byChapter: Map<string, string>
  /** 提议的新章。byChapter 里出现的、册中没有的 key 必须在这里声明 */
  proposed?: Map<string, { title: string; intro: string }>
  /** 本轮定制的导语，按章 key 覆盖 */
  intros?: Map<string, string>
}

export interface ChapterPlanner {
  readonly id: string
  assign(ctx: PlanContext): Promise<Assignment>
}
