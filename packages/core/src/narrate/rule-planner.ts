import type { Assignment, ChapterPlanner, PlanContext } from './plan.js'
import type { Segment } from './segment.js'

/**
 * 确定性的规则 planner：把切段结果原样交出去。
 *
 * 它不再自己做分类——分组、定序、切段都在 pipeline 里完成了，
 * planner 只负责把「这些新单元归哪一章」这个答案交出来。
 * spec §9.2 里它同时是 AI 不可用时的兜底；两者产出同一种 Assignment，
 * 从 AI 回落到规则不会让任何文件换章。
 */
export class RulePlanner implements ChapterPlanner {
  readonly id = 'rule'

  constructor(private readonly segments: Segment[]) {}

  async assign(_ctx: PlanContext): Promise<Assignment> {
    const byChapter = new Map<string, string>()
    const proposed = new Map<string, { title: string; intro: string }>()
    for (const s of this.segments) {
      proposed.set(s.key, { title: s.title, intro: s.intro })
      for (const member of s.members) byChapter.set(member, s.key)
    }
    return { byChapter, proposed }
  }
}
