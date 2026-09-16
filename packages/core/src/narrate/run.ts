import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { git, GitError } from '../git/exec.js'
import { snapshot, pinSnapshot, nextRound } from '../git/snapshot.js'
import { resolveBase } from '../git/range.js'
import { addWorktree, attachWorktree } from '../git/worktree.js'
import { newReviewId, reviewRoot } from '../state/paths.js'
import { latestReview, readPlan } from '../state/reviews.js'
import { computeChanges } from './diff.js'
import { RulePlanner } from './rule-planner.js'
import { buildPlan } from './build-plan.js'
import { loadRules } from './rules.js'
import { validatePlan } from './validate.js'
import { replay } from './replay.js'
import { verify } from './verify.js'
import { toCodeTours } from '../tour/codetour.js'
import type { ChapterPlanner, Plan, PlanContext } from './plan.js'
import type { FileChange } from './diff.js'
import type { NarrativeRules } from './rules.js'

export interface NarrateOptions {
  explicit?: string
  defaultBranch?: string
  now?: Date
  /** `--rules <file>`：临时覆盖仓库内与内置的叙事规则 */
  rulesPath?: string
  /** 注入 planner；缺省用确定性的 RulePlanner（Plan 2 从这里接 AiPlanner） */
  planner?: ChapterPlanner
  /**
   * 复用该仓库最近一次 review 的目录与叙事分支，而不是每次新建。
   * 轮次自动递增，历轮快照的 ref 各自保留、互不覆盖。
   *
   * 反复调参时用它：review 目录路径稳定，VS Code 开着那个窗口不用重开。
   * 该仓库还没有任何 review 时，等同于新建一次。
   */
  reuse?: true
}

/** 正常情况：工作区相对 base 有改动，产出了叙事分支与全部产物。 */
export interface NarrateChanges {
  hasChanges: true
  /** 本轮所用规则的指纹 */
  rulesFingerprint: string
  /** 规则相对上一轮是否变了；没有上一轮时为 false */
  rulesChanged: boolean
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

/**
 * `planOnly()` 的产出：算出了 plan，但什么都没落地。
 *
 * 刻意**不复用** `NarrateResult`：那条 union 的判别式是 `hasChanges`，
 * 若让 dry-run 也带 `hasChanges: true`，所有既有「只靠 hasChanges 收窄」
 * 的调用点都会静默拿到一个没有 reviewRoot / tip / worktree 的对象。
 * 两个函数、两种返回类型，各自只做一件事。
 */
export type PlanOnlyResult =
  | { hasChanges: false; branch: string; base: string }
  | { hasChanges: true; branch: string; base: string; snapshot: string; plan: Plan }

/**
 * 规划并校验：planner 只回答归属，buildPlan 负责装配，validatePlan 是最后一道闸。
 * 校验不过即抛错，绝不降级——dry-run 与正式路径共用这一条。
 */
async function planAndValidate(ctx: PlanContext, planner: ChapterPlanner): Promise<Plan> {
  const plan = buildPlan(ctx, await planner.assign(ctx), planner.id)
  const issues = validatePlan(plan, ctx)
  if (issues.length > 0) {
    throw new Error(
      `plan 未通过语义校验：\n${issues.map((i) => `  [${i.code}] ${i.message}`).join('\n')}`,
    )
  }
  return plan
}

interface Prepared {
  branch: string
  base: string
  baseSource: string
  snapshotCommit: string
  changes: FileChange[]
  rules: NarrativeRules
}

/**
 * `narrate()` 与 `planOnly()` 的共用前缀：拿到分支名、快照、base 与改动集。
 * 抽出来是因为这四步必须保持一致——两边各写一遍迟早会漂。
 */
async function prepare(repo: string, opts: NarrateOptions): Promise<Prepared> {
  const branch = await currentBranch(repo)
  const rules = await loadRules({
    repo,
    ...(opts.rulesPath !== undefined ? { explicitPath: opts.rulesPath } : {}),
  })
  const snap = await snapshot(repo)
  const baseResolution = await resolveBase(repo, {
    ...(opts.explicit !== undefined ? { explicit: opts.explicit } : {}),
    ...(opts.defaultBranch !== undefined ? { defaultBranch: opts.defaultBranch } : {}),
  })
  const changes = await computeChanges(repo, baseResolution.base, snap.commit)
  return {
    branch,
    base: baseResolution.base,
    baseSource: baseResolution.source,
    snapshotCommit: snap.commit,
    changes,
    rules,
  }
}

/**
 * 只算 plan，不产出任何东西：不钉快照 ref、不建 worktree、不 replay、
 * 不写状态目录。用于反复调参时秒级看「章节会怎么分」。
 *
 * 注意它仍会在对象库里留下一个未被引用的快照 commit（与干净工作区
 * 早退同源），`git gc --prune=now` 可回收。
 */
export async function planOnly(
  repo: string,
  opts: NarrateOptions = {},
): Promise<PlanOnlyResult> {
  const p = await prepare(repo, opts)
  if (p.changes.length === 0) {
    return { hasChanges: false, branch: p.branch, base: p.base }
  }
  const ctx: PlanContext = {
    base: p.base,
    snapshot: p.snapshotCommit,
    changes: p.changes,
    rules: p.rules,
  }
  return {
    hasChanges: true,
    branch: p.branch,
    base: p.base,
    snapshot: p.snapshotCommit,
    plan: await planAndValidate(ctx, opts.planner ?? new RulePlanner()),
  }
}

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
  const previous = opts.reuse === true ? await latestReview(repo) : null
  const p = await prepare(repo, opts)
  const { branch, rules, changes } = p
  const reviewId = previous?.reviewId ?? newReviewId(branch, opts.now)
  const snap = { commit: p.snapshotCommit }
  const baseResolution = { base: p.base, source: p.baseSource }

  if (changes.length === 0) {
    return { hasChanges: false, branch, base: baseResolution.base }
  }

  // 复用时把上一轮的 plan 带进来，跨轮钉回才真正生效（仅当规则指纹相同）
  const previousPlan =
    previous === null ? null : await readPlan(repo, previous.reviewId).catch(() => null)

  const ctx: PlanContext = {
    base: baseResolution.base,
    snapshot: snap.commit,
    changes,
    rules,
    ...(previousPlan !== null ? { previous: previousPlan } : {}),
  }

  const root = await reviewRoot(repo, reviewId)
  await mkdir(join(root, 'tours'), { recursive: true })

  // 快照钉 ref，扛得过 gc（spec §4.3）。复用时轮次递增，不覆盖历轮。
  await pinSnapshot(repo, reviewId, await nextRound(repo, reviewId), snap.commit)

  // 轨道 A：worktree 直接停在终态。复用时它已经注册过了，重复 add 会报错。
  const worktree = join(root, 'worktree')
  if (!existsSync(worktree)) {
    await addWorktree(repo, worktree, snap.commit)
  }

  // 轨道 B：规划 → 重提交 → 校验
  const plan = await planAndValidate(ctx, opts.planner ?? new RulePlanner())

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
    rulesFingerprint: plan.rulesFingerprint,
    rulesChanged:
      previousPlan !== null && previousPlan.rulesFingerprint !== plan.rulesFingerprint,
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
