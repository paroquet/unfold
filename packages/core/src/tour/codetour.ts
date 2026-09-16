import { hunkPath } from '../narrate/diff.js'
import type { FileChange } from '../narrate/diff.js'
import type { Plan } from '../narrate/plan.js'

export interface CodeTourStep {
  file: string
  line: number
  description: string
}

export interface CodeTour {
  $schema: string
  title: string
  description: string
  ref: string
  steps: CodeTourStep[]
}

export interface ChapterTour {
  /**
   * 该 tour 对应的**册内章号**（`Chapter.index`）。**必须由它决定文件名**。
   *
   * 两件事都别拿它当别的：
   * - 不是数组下标。tour 数组会因为「纯删除章没有任何 step」而出现空洞，
   *   用下标命名会让文件名、tour 标题和册三者对不上，而且只在中间章
   *   恰好是纯删除章时才发作。
   * - 不是 commit 序号。册里一旦有 empty / deleted 章，`index` 与
   *   `commitIndex` 就会分叉，CLI 说「第 7 章」而 tour 面板说「3.」。
   *   裁决：**一切给人看的章号一律用册内 index**。tour 编号因此会出现
   *   空洞（chapter-001、chapter-007），那是诚实的——它在说「第 2 章
   *   这一轮没有内容」。指向真实 commit 的线索由 tour 的 `ref` 与 CLI
   *   打印的 `git show` 行承担，不由编号承担。
   */
  index: number
  tour: CodeTour
}

const SCHEMA = 'https://aka.ms/codetour-schema'

/**
 * 章节导出成 CodeTour（spec §6.6）：一章 = 一个 tour，指路锚点 = step。
 * 借现成格式而不自己发明，且与 CodeTour 扩展互操作。
 *
 * 被删除的文件不产生 step：叙事 worktree 停在终态（spec §6.3），该文件在
 * 终态里已经不存在，读者走到这一步会直接撞见"文件不存在"。这里选择
 * "跳过生成"而不是"改写成不指向文件的说明"——CodeTour 的 step 结构以
 * `file` 为核心锚点，硬造一个不指向文件的 step 需要引入 schema 没有明确
 * 支持的变体（例如只给 directory），价值不大；被删除文件的改动内容本身
 * 在 diff 里仍然完整可查，只是不适合作为"点开某行"式的导览锚点。
 */
export function toCodeTours(plan: Plan, changes: FileChange[], ref: string): ChapterTour[] {
  const byPath = new Map(changes.map((c) => [c.path, c]))

  return plan.chapters
    // 先按 commitIndex 剔掉没有对应 commit 的空章/删除章——本轮它们没有任何
    // 内容可讲，tour 里会是一页空白。再按实际产出的 step 数筛一遍：一个章可能
    // 真有 commitIndex，但如果全部内容都是被删除的文件（下面的 step 收集会把
    // 它们统统丢掉），剩下的仍是一个 "steps": [] 的空壳，同样不该生成 tour。
    // （编号用的是 chapter.index，与这条过滤无关——见 ChapterTour 的注释。）
    .filter((chapter) => chapter.commitIndex !== null)
    .map((chapter) => {
      const steps: CodeTourStep[] = []
      const seen = new Set<string>()

      for (const id of chapter.hunkIds) {
        const path = hunkPath(id)
        const change = byPath.get(path)
        if (change === undefined) continue
        seen.add(path)
        if (change.kind === 'delete') continue
        const hunk = change.hunks.find((h) => h.id === id)
        if (hunk === undefined) continue
        steps.push({
          file: path,
          line: Math.max(1, hunk.newStart),
          description: `${chapter.title} — ${path}`,
        })
      }

      for (const path of chapter.filePaths) {
        if (seen.has(path)) continue
        if (byPath.get(path)?.kind === 'delete') continue
        steps.push({ file: path, line: 1, description: `${chapter.title} — ${path}` })
      }

      return {
        index: chapter.index,
        tour: {
          $schema: SCHEMA,
          title: `${chapter.index}. ${chapter.title}`,
          description: chapter.intro,
          ref,
          steps,
        },
      }
    })
    .filter((entry) => entry.tour.steps.length > 0)
}
