import type { Hunk } from './diff.js'

/** 把内容切成行数组；保留「有无结尾换行」的信息 */
function splitLines(content: string): { lines: string[]; trailingNewline: boolean } {
  if (content === '') return { lines: [], trailingNewline: true }
  const trailingNewline = content.endsWith('\n')
  const body = trailingNewline ? content.slice(0, -1) : content
  return { lines: body.split('\n'), trailingNewline }
}

/**
 * 把 base 内容按选中的 hunk 子集合成新内容。
 *
 * 全部 hunk 来自同一 base 的同一份 diff，所以取任意子集应用都是确定且
 * 唯一的——不存在三方合并、不可能冲突（spec §6.5）。
 */
export function composeContent(baseContent: string, hunks: Hunk[]): string {
  const { lines, trailingNewline } = splitLines(baseContent)
  const ordered = [...hunks].sort((a, b) => a.oldStart - b.oldStart)

  const out: string[] = []
  let cursor = 0 // 已消费到 base 的第几行（0-based）
  // 结尾换行状态由「实际消费到 base 最后一行」的那个 hunk 权威给出；
  // null 表示还没有任何 hunk 触及过 base 的末尾，此时沿用 base 自己的状态。
  // 这是个三态覆盖式判定，不是单向降级——触及末尾的 hunk 两个方向都能定：
  // 可以把「有换行」改判成「无」，也可以把「无换行」改判成「有」。
  let newEol: boolean | null = null

  for (const hunk of ordered) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1
    for (let i = cursor; i < start; i += 1) out.push(lines[i]!)
    cursor = start

    let prevMarker = ''
    // 本 hunk 的新侧是否带有「无结尾换行」标记；只有当本 hunk 确实触及
    // base 末尾时才会被采纳为最终判定，避免中间 hunk 的标记误伤结论。
    let newSideNoNewline = false
    for (const raw of hunk.lines) {
      const marker = raw[0]
      const text = raw.slice(1)
      // `\ No newline` 描述的是它上一行所属的那一侧。只有跟在 '+' 或 ' '
      // 后面时才说明「新内容」没有结尾换行；跟在 '-' 后面说的是旧内容。
      if (raw.startsWith('\\ No newline at end of file')) {
        if (prevMarker === '+' || prevMarker === ' ') newSideNoNewline = true
        continue
      }
      prevMarker = marker ?? ''
      if (marker === ' ') {
        out.push(text)
        cursor += 1
      } else if (marker === '-') {
        cursor += 1
      } else if (marker === '+') {
        out.push(text)
      }
    }

    // 本 hunk 消费到了 base 的最后一行——由它权威决定结尾换行状态。
    if (cursor === lines.length) newEol = !newSideNoNewline
  }

  for (let i = cursor; i < lines.length; i += 1) out.push(lines[i]!)

  if (out.length === 0) return ''
  const joined = out.join('\n')
  const keepNewline = newEol === null ? trailingNewline : newEol
  return keepNewline ? `${joined}\n` : joined
}
