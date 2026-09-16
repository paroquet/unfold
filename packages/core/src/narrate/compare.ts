import type { Plan } from './plan.js'

export interface FileMove {
  path: string
  /** 上一次所在章节的 key */
  from: string
  /** 本次所在章节的 key */
  to: string
}

export interface PlanDiff {
  chaptersBefore: number
  chaptersAfter: number
  /** 两轮都存在、但换了章的文件 */
  moved: FileMove[]
  /** 只在 after 里出现的文件 */
  added: string[]
  /** 只在 before 里出现的文件 */
  removed: string[]
}

/** 把 plan 摊平成 `文件路径 → 章节 key` */
function keyByPath(plan: Plan): Map<string, string> {
  const map = new Map<string, string>()
  for (const chapter of plan.chapters) {
    for (const path of chapter.filePaths) map.set(path, chapter.key)
  }
  return map
}

/**
 * 并排比较两个 plan 的章节划分。
 *
 * 比的是 `Chapter.key` 而不是 `index`：index 是位置序号，会随「本轮哪些
 * 类非空」合法变动，拿它比会把大量无变化的情况报成 moved。
 *
 * 三个列表都按路径升序，便于两次运行的输出直接对比。
 */
export function comparePlans(before: Plan, after: Plan): PlanDiff {
  const b = keyByPath(before)
  const a = keyByPath(after)

  const moved: FileMove[] = []
  const added: string[] = []
  const removed: string[] = []

  for (const [path, toKey] of a) {
    const fromKey = b.get(path)
    if (fromKey === undefined) added.push(path)
    else if (fromKey !== toKey) moved.push({ path, from: fromKey, to: toKey })
  }
  for (const path of b.keys()) {
    if (!a.has(path)) removed.push(path)
  }

  const byPath = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0)
  moved.sort((x, y) => byPath(x.path, y.path))
  added.sort(byPath)
  removed.sort(byPath)

  return {
    chaptersBefore: before.chapters.length,
    chaptersAfter: after.chapters.length,
    moved,
    added,
    removed,
  }
}
