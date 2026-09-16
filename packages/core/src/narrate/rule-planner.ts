import { classifyPath } from './rules.js'
import type { Assignment, ChapterPlanner, PlanContext } from './plan.js'

/**
 * 确定性的规则 planner：按路径把每个文件归到一层。
 *
 * 它只做这一件事——章节骨架由 `ctx.rules` 给定，装配由 `buildPlan` 完成。
 * spec §9.2 里它同时是 AI 不可用时的兜底；两者共用同一套由 rules 定义的
 * key 空间，所以从 AI 回落到规则**不会让任何文件换层**，批注不会漂移。
 */
export class RulePlanner implements ChapterPlanner {
  readonly id = 'rule'

  async assign(ctx: PlanContext): Promise<Assignment> {
    const byLayer = new Map<string, string>()
    for (const change of ctx.changes) {
      byLayer.set(change.path, classifyPath(change.path, ctx.rules))
    }
    return { byLayer }
  }
}
