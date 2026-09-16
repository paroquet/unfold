#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { narrate, planOnly } from '../narrate/run.js'
import { comparePlans } from '../narrate/compare.js'
import { cleanReviews } from '../state/cleanup.js'
import { readPlan } from '../state/reviews.js'
import { parseArgs } from './args.js'
import {
  editorCommand,
  formatDepEvidence,
  formatPlanDiff,
  formatPlanSummary,
  formatWarnings,
  reviewCommands,
  suggestOrder,
} from './report.js'

function usage(): never {
  process.stderr.write(
    [
      'usage: unfold narrate [options]',
      '',
      '  对当前工作区（含未提交改动）生成叙事分支。',
      '',
      '  --repo <path>            指定仓库，缺省为当前目录',
      '  --base <rev>             显式指定 base，缺省自动推导',
      '  --default-branch <name>  推导 base 时用的默认分支，缺省 main',
      '  --rules <file>           叙事规则配置；缺省读 <repo>/.unfold/narrative.json，再缺省用内置四层',
      '',
      '  --dry-run                只算 plan 并打印，不建分支、不建 worktree、不留任何产物',
      '  --reuse                  复用该仓库最近一次 review 的目录与分支，轮次递增',
      '  --clean                  清掉该仓库全部 review 目录、worktree 与 refs/unfold/*，然后退出',
      '  --compare <id|latest>    与某次历史 plan 并排比较章节划分',
      '  --open                   跑完用 VS Code 打开叙事 worktree',
      '  --reset-chapters         丢弃章节册重新推导；批注保留但解除归属',
      '',
    ].join('\n'),
  )
  process.exit(2)
}

function out(lines: string[]): void {
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, process.cwd())
  if (!parsed.ok) usage()

  const {
    repo,
    explicit,
    defaultBranch,
    dryRun,
    reuse,
    clean,
    open,
    compare,
    rulesPath,
    resetChapters,
  } = parsed.args

  if (clean === true) {
    const result = await cleanReviews(repo)
    out([
      `已清理 ${result.removedReviews.length} 个 review 目录、${result.removedRefs.length} 个快照 ref。`,
      ...result.removedReviews.map((id) => `  ${id}`),
      '（叙事分支 refs/heads/unfold/* 未动——它是可推送的产物，删不删由你决定）',
    ])
    return
  }

  // 对比基线必须在 narrate 之前取：narrate 写完新的 review 之后，
  // 它自己就成了 latest，再解析 'latest' 等于拿新 plan 跟自己比。
  const baseline = compare === undefined ? null : await readPlan(repo, compare)

  const baseOpts = {
    ...(explicit !== undefined ? { explicit } : {}),
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
    ...(rulesPath !== undefined ? { rulesPath } : {}),
    ...(resetChapters === true ? { resetChapters: true as const } : {}),
    // --dry-run 也要认 --reuse：否则 --dry-run --reuse 会静默地每次都新建一个
    // 从未落盘、也不会再被用到的 reviewId，读到的册永远是空的——调参时最想要的
    // 「在现有册上继续预览」反而是唯一做不到的事。这条线以前只接在 narrate() 上，
    // planOnly() 漏了，是发现 C 项 e2e 时抓出来的既有缺口，顺手一并修掉。
    ...(reuse === true ? { reuse: true as const } : {}),
  }

  if (dryRun === true) {
    const result = await planOnly(repo, baseOpts)
    if (!result.hasChanges) {
      out([`没有可讲的改动：${result.branch} 相对 base（${result.base.slice(0, 12)}）没有任何改动。`])
      return
    }
    const warnLines = formatWarnings(result.warnings)
    out([
      `dry-run（什么都没落地）`,
      `base       ${result.base.slice(0, 12)}`,
      `快照       ${result.snapshot.slice(0, 12)}`,
      `章节       ${result.plan.chapters.length}`,
      '',
      ...formatPlanSummary(result.plan),
      '',
      ...formatDepEvidence({
        graph: result.depGraph,
        cycles: result.cycles,
        suggestion: suggestOrder(result.plan),
      }),
      ...(warnLines.length > 0 ? ['', ...warnLines] : []),
    ])
    if (baseline !== null) {
      out(['', `与 ${compare} 对比：`, ...formatPlanDiff(comparePlans(baseline, result.plan))])
    }
    return
  }

  const result = await narrate(repo, baseOpts)

  if (!result.hasChanges) {
    out([`没有可讲的改动：${result.branch} 相对 base（${result.base.slice(0, 12)}）没有任何改动。`])
    return
  }

  const plan = await readPlan(repo, result.reviewId)

  if (result.rulesChanged) {
    out([
      `规则已变更（指纹 ${result.rulesFingerprint}），本轮重新划分章节，不沿用上一轮的归属。`,
      '',
    ])
  }

  const warnLines = formatWarnings(result.warnings)
  out([
    `叙事分支   ${result.branch}（${result.chapters} 章）`,
    `base       ${result.base.slice(0, 12)}`,
    `快照       ${result.snapshot.slice(0, 12)}`,
    `tip        ${result.tip.slice(0, 12)}  ✅ tree 与快照字节一致`,
    `worktree   ${result.worktree}`,
    `状态目录   ${result.reviewRoot}`,
    '',
    ...formatPlanSummary(plan),
    '',
    ...formatDepEvidence({
      graph: result.depGraph,
      cycles: result.cycles,
      suggestion: suggestOrder(plan),
    }),
    ...(warnLines.length > 0 ? ['', ...warnLines] : []),
    '',
    '怎么看：',
    ...reviewCommands({
      worktree: result.worktree,
      branch: result.branch,
      base: result.base,
      chapters: plan.chapters.map((c) => ({ title: c.title, commitIndex: c.commitIndex })),
    }),
  ])

  if (baseline !== null) {
    out(['', `与 ${compare} 对比：`, ...formatPlanDiff(comparePlans(baseline, plan))])
  }

  if (open === true) {
    const [cmd, ...cmdArgs] = editorCommand(result.worktree)
    const spawned = spawnSync(cmd as string, cmdArgs, { stdio: 'ignore' })
    if (spawned.error !== undefined) {
      process.stderr.write(
        `打不开编辑器（${spawned.error.message}）。手动跑：${editorCommand(result.worktree).join(' ')}\n`,
      )
    }
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
