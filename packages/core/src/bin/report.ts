import type { Plan } from '../narrate/plan.js'
import type { PlanDiff } from '../narrate/compare.js'

/**
 * 打开叙事 worktree 的命令。返回数组而不是自己去 spawn——
 * 这样 CLI 既能直接执行它，也能把它原样打印给用户粘。
 */
export function editorCommand(worktree: string): string[] {
  return ['code', worktree]
}

export interface ReviewCommandsInput {
  worktree: string
  branch: string
  base: string
  chapterTitles: string[]
}

/**
 * 一组可直接粘的命令，让人不装插件也能读这条叙事。
 *
 * 第 k 章的 commit 是 `<branch>~(N-k)`——叙事分支是一条线性链，
 * 最后一章就是分支 tip。所有 git 命令都带 `-C <worktree>`，
 * 在任意目录下粘贴都成立。
 */
export function reviewCommands(input: ReviewCommandsInput): string[] {
  const { worktree, branch, base, chapterTitles } = input
  const n = chapterTitles.length

  const entries: Array<[command: string, comment: string]> = [
    [editorCommand(worktree).join(' '), '用 VS Code 打开，内置 Source Control 逐章看'],
    [
      `git -C ${worktree} log --oneline ${base.slice(0, 12)}..${branch}`,
      '章节一览',
    ],
  ]
  for (const [i, title] of chapterTitles.entries()) {
    const back = n - 1 - i
    const rev = back === 0 ? branch : `${branch}~${back}`
    entries.push([`git -C ${worktree} show ${rev}`, `第 ${i + 1} 章 ${title}`])
  }

  // 对齐用 padEnd，但**至少留两个空格**：真实的状态目录路径动辄上百字符，
  // 光靠 padEnd 到固定宽度会让注释直接粘在命令末尾，粘出去的命令是坏的。
  const width = Math.max(...entries.map(([command]) => command.length))
  return entries.map(([command, comment]) => `  ${command.padEnd(width)}  # ${comment}`)
}

/** dry-run 的输出：逐章列出标题、文件数、hunk 数与具体文件。 */
export function formatPlanSummary(plan: Plan): string[] {
  const lines: string[] = []
  for (const chapter of plan.chapters) {
    lines.push(
      `  第 ${chapter.index} 章 ${chapter.title}` +
        `（${chapter.filePaths.length} 文件 / ${chapter.hunkIds.length} hunk）`,
    )
    for (const path of chapter.filePaths) lines.push(`      ${path}`)
  }
  return lines
}

/** `--compare` 的输出。无差异时明确说出来，而不是打印一片空白让人以为没跑。 */
export function formatPlanDiff(diff: PlanDiff): string[] {
  const lines = [`  章节数  ${diff.chaptersBefore} → ${diff.chaptersAfter}`]

  if (diff.moved.length === 0 && diff.added.length === 0 && diff.removed.length === 0) {
    lines.push('  文件归属没有变化')
    return lines
  }

  for (const m of diff.moved) lines.push(`  换章    ${m.path}  ${m.from} → ${m.to}`)
  for (const p of diff.added) lines.push(`  新增    ${p}`)
  for (const p of diff.removed) lines.push(`  消失    ${p}`)
  return lines
}
