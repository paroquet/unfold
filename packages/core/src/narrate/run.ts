import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { git, GitError } from '../git/exec.js'
import { snapshot, pinSnapshot } from '../git/snapshot.js'
import { resolveBase } from '../git/range.js'
import { addWorktree, attachWorktree } from '../git/worktree.js'
import { newReviewId, reviewRoot } from '../state/paths.js'
import { computeChanges } from './diff.js'
import { RulePlanner } from './rule-planner.js'
import { validatePlan } from './validate.js'
import { replay } from './replay.js'
import { verify } from './verify.js'
import { toCodeTours } from '../tour/codetour.js'

export interface NarrateOptions {
  explicit?: string
  defaultBranch?: string
  now?: Date
}

/** 正常情况：工作区相对 base 有改动，产出了叙事分支与全部产物。 */
export interface NarrateChanges {
  hasChanges: true
  reviewId: string
  reviewRoot: string
  branch: string
  base: string
  snapshot: string
  tip: string
  chapters: number
  worktree: string
}

/**
 * 干净工作区：相对 base 没有任何改动，无事可叙。这不是错误——narrate()
 * 不抛错，调用方（CLI）据此打印一条提示而不是当成失败处理。没有创建
 * review 状态目录 / 叙事分支 / worktree，避免留下一个「0 章」的空产物。
 */
export interface NarrateNoChanges {
  hasChanges: false
  branch: string
  base: string
}

export type NarrateResult = NarrateChanges | NarrateNoChanges

async function currentBranch(repo: string): Promise<string> {
  try {
    return await git(repo, ['symbolic-ref', '--short', 'HEAD'])
  } catch (err) {
    if (err instanceof GitError) return 'detached'
    throw err
  }
}

/**
 * v1 闭环的第 2–3 步（spec §3）。本 plan 里两条轨道还是顺序执行——
 * 轨道 A 的 prepare 属于 VS Code 包，Plan 4 才接上，那时把 A1/A2 挪到
 * Promise 里与轨道 B 并发即可，这里的顺序已按并行拆好。
 *
 * 判断「有没有改动可叙」必须先拿到 snapshot 与 base，所以 changes 的计算
 * 提前到了 reviewRoot / worktree / pinSnapshot 之前：只有确认真有改动，
 * 才落地 review 状态目录、钉快照 ref、开 worktree——干净工作区上跑不会
 * 留下一个「0 章」的空产物。
 */
export async function narrate(
  repo: string,
  opts: NarrateOptions = {},
): Promise<NarrateResult> {
  const branch = await currentBranch(repo)
  const reviewId = newReviewId(branch, opts.now)

  const snap = await snapshot(repo)

  const baseResolution = await resolveBase(repo, {
    ...(opts.explicit !== undefined ? { explicit: opts.explicit } : {}),
    ...(opts.defaultBranch !== undefined ? { defaultBranch: opts.defaultBranch } : {}),
  })
  const changes = await computeChanges(repo, baseResolution.base, snap.commit)

  if (changes.length === 0) {
    return { hasChanges: false, branch, base: baseResolution.base }
  }

  const root = await reviewRoot(repo, reviewId)
  await mkdir(join(root, 'tours'), { recursive: true })

  // 快照钉 ref，扛得过 gc（spec §4.3）
  await pinSnapshot(repo, reviewId, 1, snap.commit)

  // 轨道 A：worktree 直接停在终态
  const worktree = join(root, 'worktree')
  await addWorktree(repo, worktree, snap.commit)

  // 轨道 B：规划 → 重提交 → 校验
  const ctx = { base: baseResolution.base, snapshot: snap.commit, changes }
  const plan = await new RulePlanner().plan(ctx)

  const issues = validatePlan(plan, ctx)
  if (issues.length > 0) {
    throw new Error(
      `plan 未通过语义校验：\n${issues.map((i) => `  [${i.code}] ${i.message}`).join('\n')}`,
    )
  }

  const replayed = await replay(repo, plan, changes)
  await verify(repo, replayed.tip, snap.commit)

  // 汇合：tree 一致 ⇒ 零文件改动
  const narrativeBranch = `unfold/${reviewId}`
  await attachWorktree(worktree, narrativeBranch, replayed.tip)

  // 落盘产物
  await writeFile(
    join(root, 'meta.json'),
    `${JSON.stringify(
      {
        version: 1,
        repo,
        branch,
        base: baseResolution.base,
        baseSource: baseResolution.source,
        narrativeBranch,
        createdAt: (opts.now ?? new Date()).toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await writeFile(join(root, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8')

  const tours = toCodeTours(plan, changes, narrativeBranch)
  for (const [i, tour] of tours.entries()) {
    const name = `chapter-${String(i + 1).padStart(3, '0')}.tour`
    await writeFile(join(root, 'tours', name), `${JSON.stringify(tour, null, 2)}\n`, 'utf8')
  }

  return {
    hasChanges: true,
    reviewId,
    reviewRoot: root,
    branch: narrativeBranch,
    base: baseResolution.base,
    snapshot: snap.commit,
    tip: replayed.tip,
    chapters: plan.chapters.length,
    worktree,
  }
}
