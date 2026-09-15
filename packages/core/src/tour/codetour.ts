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
export function toCodeTours(plan: Plan, changes: FileChange[], ref: string): CodeTour[] {
  const byPath = new Map(changes.map((c) => [c.path, c]))

  return plan.chapters.map((chapter) => {
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
      $schema: SCHEMA,
      title: `${chapter.index}. ${chapter.title}`,
      description: chapter.intro,
      ref,
      steps,
    }
  })
}
