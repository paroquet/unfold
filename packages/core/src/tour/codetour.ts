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
      const hunk = change.hunks.find((h) => h.id === id)
      if (hunk === undefined) continue
      steps.push({
        file: path,
        line: Math.max(1, hunk.newStart),
        description: `${chapter.title} — ${path}`,
      })
      seen.add(path)
    }

    for (const path of chapter.filePaths) {
      if (seen.has(path)) continue
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
