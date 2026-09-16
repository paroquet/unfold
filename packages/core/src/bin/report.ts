import type { Plan } from '../narrate/plan.js'
import type { PlanDiff } from '../narrate/compare.js'
import type { DepGraph } from '../narrate/deps.js'
import type { ValidationIssue } from '../narrate/validate.js'

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
  /** `index` 是册内章号，打印给人看；`commitIndex` 只用来算 revision */
  chapters: Array<{ index: number; title: string; commitIndex: number | null }>
}

/**
 * 一组可直接粘的命令，让人不装插件也能读这条叙事。
 *
 * 第 k 个 commit（1 起）对应的 revision 是 `<branch>~(total-k)`——叙事分支
 * 是一条线性链，最后一个 commit 就是分支 tip。所有 git 命令都带 `-C <worktree>`，
 * 在任意目录下粘贴都成立。
 *
 * 空章与删除章没有对应的 commit（`commitIndex` 为 `null`），不生成 `git show`
 * 行——生成出来是粘贴即报错的命令。
 */
export function reviewCommands(input: ReviewCommandsInput): string[] {
  const { worktree, branch, base, chapters } = input
  const total = chapters.reduce((n, c) => (c.commitIndex === null ? n : n + 1), 0)

  const entries: Array<[command: string, comment: string]> = [
    [editorCommand(worktree).join(' '), '用 VS Code 打开，内置 Source Control 逐章看'],
    [
      `git -C ${worktree} log --oneline ${base.slice(0, 12)}..${branch}`,
      '章节一览',
    ],
  ]
  for (const { index, title, commitIndex } of chapters) {
    if (commitIndex === null) continue
    const back = total - commitIndex
    const rev = back === 0 ? branch : `${branch}~${back}`
    // 章号打册内 index，不打 commitIndex、也不打数组下标：一切给人看的章号
    // 统一用 index，否则册里一有 empty / deleted 章，这里、dry-run 摘要与
    // tour 面板就会各说一个数
    entries.push([`git -C ${worktree} show ${rev}`, `第 ${index} 章 ${title}`])
  }

  // 对齐用 padEnd，但**至少留两个空格**：真实的状态目录路径动辄上百字符，
  // 光靠 padEnd 到固定宽度会让注释直接粘在命令末尾，粘出去的命令是坏的。
  const width = Math.max(...entries.map(([command]) => command.length))
  return entries.map(([command, comment]) => `  ${command.padEnd(width)}  # ${comment}`)
}

/**
 * 规则指纹变了时的提示（spec §5.6）。
 *
 * 有了章节册之后，**规则变化不再自动重排**——指纹的用途从「要不要沿用」
 * 降级成「要不要提示」。所以这行既要说清变化（旧指纹 → 新指纹），也要指出
 * 真正能重排的那条路。此前它写的是「本轮重新划分章节，不沿用上一轮的归属」，
 * 与 updateRegistry 的实际行为**正好相反**：册照沿用不误。
 */
export function formatRulesChanged(previous: string | null, current: string): string[] {
  const from = previous ?? '（上一轮的 plan 读不到）'
  return [
    `规则已变更（指纹 ${from} → ${current}）。要按新规则重排章节请跑 --reset-chapters。`,
    '',
  ]
}

/**
 * dry-run 的输出：逐章列出标题、文件数、hunk 数与具体文件。
 *
 * 空章（本轮无改动）与删除章（模块已删除）也列出来——它们仍在册里占着位置，
 * 不列会让人以为册「变短」了，其实只是这轮没动它。
 */
export function formatPlanSummary(plan: Plan): string[] {
  const lines: string[] = []
  for (const chapter of plan.chapters) {
    if (chapter.commitIndex === null) {
      const note = chapter.status === 'deleted' ? '模块已删除' : '本轮无改动'
      lines.push(`  第 ${chapter.index} 章 ${chapter.title}（${note}）`)
      continue
    }
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

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/**
 * 从本轮的章节顺序反推出一行可粘贴的 `order`。
 *
 * 给的是**目录前缀**而不是章节 key：key 是切段之后才产生的，
 * 人预先写不出来，而目录是稳定的、可读的、下一轮仍然认得的。
 */
export function suggestOrder(plan: Plan): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const chapter of plan.chapters) {
    if (chapter.commitIndex === null) continue
    // 用真实文件路径而不是 chapter.key：key 是 canonical 路径，纯测试目录的
    // canonical 指向一个并不存在的实现路径，拿它当目录前缀建议给用户，
    // 粘进配置就是一条永远匹配不到东西的死规则。
    const dir = dirOf(chapter.filePaths[0] ?? chapter.key)
    if (dir === '' || seen.has(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out
}

export interface DepEvidenceInput {
  graph: DepGraph
  cycles: string[][]
  suggestion: string[]
}

/** 依赖扫描的证据：扫了多少、跳过哪些、在哪破的环、建议的顺序。 */
export function formatDepEvidence(input: DepEvidenceInput): string[] {
  const { graph, cycles, suggestion } = input
  let edges = 0
  for (const targets of graph.edges.values()) edges += targets.size

  const byReason = new Map<string, number>()
  for (const item of graph.skipped) {
    byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1)
  }
  const skippedNote =
    graph.skipped.length === 0
      ? '无'
      : `${graph.skipped.length}（` +
        [...byReason].map(([reason, n]) => `${reason} ${n}`).join('、') +
        '）'

  return [
    '依赖证据',
    `  扫描   ${graph.scanned.length} 个源码文件｜跳过 ${skippedNote}`,
    `  连边   ${edges} 条跨文件依赖`,
    `  破环   ${
      cycles.length === 0
        ? '无强连通分量'
        : cycles.map((c) => `[${c.join(' ↔ ')}]`).join('、')
    }`,
    `  建议   "order": ${JSON.stringify(suggestion)}`,
  ]
}

/**
 * 章节体检的提示。只打 `warn`——`error` 已经让整轮抛掉了，
 * 走到打印这一步的 plan 里不可能还有 error。
 */
export function formatWarnings(issues: ValidationIssue[]): string[] {
  const warnings = issues.filter((i) => i.severity === 'warn')
  if (warnings.length === 0) return []
  return ['提示', ...warnings.map((i) => `  ${i.message}`)]
}
