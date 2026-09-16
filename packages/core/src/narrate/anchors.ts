import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileChange } from './diff.js'

export type AnnotationState = 'live' | 'stale' | 'orphaned' | 'unanchored'

export interface Annotation {
  id: string
  /** 批注所在的章；`--reset-chapters` 之后为 null */
  chapterKey: string | null
  path: string
  /** 1 起，闭区间 */
  startLine: number
  endLine: number
  /** 锚定内容的 sha256，供上层判断是否还对得上 */
  anchorHash: string
  body: string
  state: AnnotationState
  /** 产生这条批注的轮次 */
  round: number
}

export interface AnnotationFile {
  version: 1
  annotations: Annotation[]
}

export const ANNOTATIONS_FILE = 'annotations.json'

/**
 * 把批注锚点从上一轮的行号推到本轮。
 *
 * **重叠的锚点标 stale 但绝不丢弃**——「你批注的这段代码被改了」正是 review
 * 最该看见的信号，丢掉它等于把最重要的一条反馈静默吞了。
 */
export function migrateAnchors(
  annotations: Annotation[],
  changes: FileChange[],
): Annotation[] {
  const byPath = new Map(changes.map((c) => [c.path, c]))

  return annotations.map((note) => {
    if (note.state === 'orphaned') return note
    const change = byPath.get(note.path)
    if (change === undefined) return note
    if (change.kind === 'delete') return { ...note, state: 'orphaned' as const }

    const hunks = [...change.hunks].sort((a, b) => a.oldStart - b.oldStart)
    let offset = 0
    for (const h of hunks) {
      // 纯插入（oldLines === 0）的 oldStart 是**插入点之前那一行**的行号：
      // 在 L2 与 L3 之间插两行，git 实测给的是 `@@ -2,0 +3,2 @@`。所以它占的
      // 不是某几行，而是 oldStart 与 oldStart+1 之间的那道缝，判据必须跟着变。
      //
      // 用同一套 `oldEnd <= startLine` 会把「插在批注第一行之后」误判成「整段
      // 都在批注之前」，于是批注被整体下移、却完全没提示——新插进来的代码就这样
      // 悄悄落进了「已 review」的范围里。这是最坏的一种错：不崩、不报警、结论错。
      const insertion = h.oldLines === 0
      const oldEnd = h.oldStart + h.oldLines
      const before = insertion ? h.oldStart < note.startLine : oldEnd <= note.startLine
      if (before) {
        offset += h.newLines - h.oldLines
        continue
      }
      const overlaps = insertion ? h.oldStart < note.endLine : h.oldStart <= note.endLine
      if (overlaps) {
        // 重叠：锚点范围重算成这个 hunk 的新范围
        return {
          ...note,
          startLine: h.newStart,
          endLine: h.newStart + Math.max(h.newLines, 1) - 1,
          state: 'stale' as const,
        }
      }
      break
    }

    return { ...note, startLine: note.startLine + offset, endLine: note.endLine + offset }
  })
}

/**
 * 归属阶梯的第一级：本轮哪些 hunk 应该回到某条批注所在的章。
 *
 * 传入的 annotations 必须是**迁移之后**的——判据用的是新行号。
 * 多条批注争同一个 hunk 时取 id 字典序最小的那条：谁赢不重要，重要的是
 * 同样的输入永远给同样的答案，否则章节归属会在两轮之间来回跳。
 *
 * 定夺只靠下面那一处 `note.id < held.id`，**不预先排序 annotations**——
 * 取最小值本来就与遍历顺序无关，先排一遍是多余的一层，还会让人误以为
 * 确定性来自排序、删掉那处比较也无妨。
 */
export function pinnedByAnnotations(
  annotations: Annotation[],
  changes: FileChange[],
): Map<string, string> {
  const byPath = new Map(changes.map((c) => [c.path, c]))
  const winner = new Map<string, { id: string; chapterKey: string }>()

  for (const note of annotations) {
    if (note.state === 'orphaned' || note.chapterKey === null) continue
    const change = byPath.get(note.path)
    if (change === undefined) continue

    for (const h of change.hunks) {
      const newEnd = h.newStart + Math.max(h.newLines, 1) - 1
      if (h.newStart > note.endLine || newEnd < note.startLine) continue
      const held = winner.get(h.id)
      if (held === undefined || note.id < held.id) {
        winner.set(h.id, { id: note.id, chapterKey: note.chapterKey })
      }
    }
  }

  return new Map([...winner].map(([hunkId, held]) => [hunkId, held.chapterKey]))
}

/** 读批注。文件不存在表示还没有任何批注，返回空表而不是报错。 */
export async function readAnnotations(reviewRoot: string): Promise<AnnotationFile> {
  try {
    const text = await readFile(join(reviewRoot, ANNOTATIONS_FILE), 'utf8')
    return JSON.parse(text) as AnnotationFile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, annotations: [] }
    throw err
  }
}

export async function writeAnnotations(
  reviewRoot: string,
  file: AnnotationFile,
): Promise<void> {
  await writeFile(
    join(reviewRoot, ANNOTATIONS_FILE),
    `${JSON.stringify(file, null, 2)}\n`,
    'utf8',
  )
}
