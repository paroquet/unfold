#!/usr/bin/env node
import { narrate } from '../narrate/run.js'
import { parseArgs } from './args.js'

function usage(): never {
  process.stderr.write(
    [
      'usage: unfold narrate [--base <rev>] [--default-branch <name>] [--repo <path>]',
      '',
      '  对当前工作区（含未提交改动）生成叙事分支。',
      '',
    ].join('\n'),
  )
  process.exit(2)
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, process.cwd())
  if (!parsed.ok) usage()

  const { repo, explicit, defaultBranch } = parsed.args

  const result = await narrate(repo, {
    ...(explicit !== undefined ? { explicit } : {}),
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
  })

  process.stdout.write(
    [
      `叙事分支   ${result.branch}（${result.chapters} 章）`,
      `base       ${result.base.slice(0, 12)}`,
      `快照       ${result.snapshot.slice(0, 12)}`,
      `tip        ${result.tip.slice(0, 12)}  ✅ tree 与快照字节一致`,
      `worktree   ${result.worktree}`,
      `状态目录   ${result.reviewRoot}`,
      '',
    ].join('\n'),
  )
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
