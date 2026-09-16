import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { git, GitError } from '../git/exec.js'
import { snapshot, pinSnapshot, nextRound } from '../git/snapshot.js'
import { resolveBase } from '../git/range.js'
import { addWorktree, attachWorktree } from '../git/worktree.js'
import { newReviewId, repoStateDir, reviewRoot } from '../state/paths.js'
import { latestReview, readPlan } from '../state/reviews.js'
import { computeChanges } from './diff.js'
import { canonicalPath } from './pair.js'
import { buildDepGraph } from './deps.js'
import { topoOrder } from './order.js'
import { segment } from './segment.js'
import { RulePlanner } from './rule-planner.js'
import { buildPlan } from './build-plan.js'
import { loadRules } from './rules.js'
import { validatePlan } from './validate.js'
import { EMPTY_REGISTRY, readRegistry, updateRegistry, writeRegistry } from './registry.js'
import { migrateAnchors, pinnedByAnnotations, readAnnotations, writeAnnotations } from './anchors.js'
import { replay } from './replay.js'
import { verify } from './verify.js'
import { toCodeTours } from '../tour/codetour.js'
import type { ChapterPlanner, Plan, PlanContext } from './plan.js'
import type { FileChange } from './diff.js'
import type { NarrativeRules } from './rules.js'
import type { DepGraph } from './deps.js'
import type { Segment } from './segment.js'
import type { Registry } from './registry.js'
import type { Annotation } from './anchors.js'
import type { ValidationIssue } from './validate.js'

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
  /**
   * 丢掉章节册重新按本轮规则切段，而不是沿用历轮归属。
   * 批注不删——只解除它们与旧章的绑定（chapterKey: null，state: 'unanchored'），
   * 下一轮会按批注锚点所在的文件重新归入新章。
   */
  resetChapters?: true
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
  /** 章节体检：可读性提示，不拦截出货（error 已在 assemble 内部拒绝） */
  warnings: ValidationIssue[]
  /** 更新后的章节册总章数（含 empty / deleted） */
  registryChapters: number
  depGraph: DepGraph
  cycles: string[][]
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
  | {
      hasChanges: true
      branch: string
      base: string
      snapshot: string
      plan: Plan
      warnings: ValidationIssue[]
      registryChapters: number
      depGraph: DepGraph
      cycles: string[][]
    }

interface Prepared {
  branch: string
  base: string
  baseSource: string
  snapshotCommit: string
  changes: FileChange[]
  rules: NarrativeRules
  /** 真实路径 → canonical path */
  canonical: Map<string, string>
  /** 去重后的 canonical 单元，供依赖图与切段使用 */
  units: string[]
  /**
   * 供**册**（registry）判断成员存续用：快照树里的全部路径，
   * 再并上本轮未删除文件的 canonical 单元——即便那个单元本身并不对应
   * 任何真实文件（配对规约不到实现时会退回一个虚构路径），只要配对它的
   * 测试文件本身没被删，这个单元就该继续被册认领，不能因为它不是一个
   * 真实文件就被当成「已删除」清出册。**不要**拿它去判断「这个路径真的
   * 存在吗」——那件事要用下面的 `tree`。
   */
  present: Set<string>
  /**
   * 快照树里**字面存在**的全部路径（一次 `ls-tree` 的原始结果）。
   * 供体检判断「测试配对到的实现是否真的能找到」——`present` 不能用在这里，
   * 它按设计会把配对规约不到实现时虚构出的路径也算进去，那样每一个纯测试
   * 目录（e2e、测试 helper）都会被判成「实现存在」，体检提示就白加了。
   */
  tree: Set<string>
  graph: DepGraph
  order: string[]
  cycles: string[][]
  segments: Segment[]
}

/**
 * `narrate()` 与 `planOnly()` 的共用前缀：从「拿到改动集」到「切出本轮段」
 * 全部算完。抽出来是因为这一整条推导必须两边保持一致——各写一遍迟早会漂。
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

  // 快照树的全量文件清单。一次 ls-tree 换掉「逐个候选 cat-file -e」，
  // 配对规约要查成百上千次「这个候选存在吗」。
  const treeList = await git(repo, ['ls-tree', '-r', '--name-only', '-z', snap.commit])
  const tree = new Set(treeList.split('\0').filter((p) => p !== ''))

  const canonical = new Map<string, string>()
  for (const change of changes) {
    canonical.set(change.path, canonicalPath(change.path, rules.pair, (p) => tree.has(p)))
  }

  const units = [...new Set(canonical.values())].sort()
  const fileCountOf = new Map<string, number>()
  for (const unit of canonical.values()) {
    fileCountOf.set(unit, (fileCountOf.get(unit) ?? 0) + 1)
  }

  // 单元的内容从**快照**里取，不碰工作区。删除的、二进制的、树里没有的取 null
  const changeOf = new Map(changes.map((c) => [c.path, c]))
  const contents = new Map<string, string | null>()
  for (const unit of units) {
    const own = changeOf.get(unit)
    if (own?.binary === true || own?.kind === 'delete' || !tree.has(unit)) {
      contents.set(unit, null)
      continue
    }
    contents.set(
      unit,
      await git(repo, ['cat-file', 'blob', `${snap.commit}:${unit}`], { trim: false })
        // 子模块指针会被 ls-tree 列出却不是 blob。读不到内容只影响依赖排序，
        // 不影响字节一致——记为「内容不可读」让它进 skipped，比抛一个
        // 看不出因果的 GitError 好。
        .catch(() => null),
    )
  }

  const graph = buildDepGraph(units, contents)
  const { order, cycles } = topoOrder(units, graph.edges, rules.order)
  const segments = segment({
    order,
    cycles,
    maxFiles: rules.maxFiles,
    fileCount: (unit) => fileCountOf.get(unit) ?? 1,
  })

  const present = new Set<string>(tree)
  for (const [path, unit] of canonical) {
    if (changeOf.get(path)?.kind !== 'delete') present.add(unit)
  }

  return {
    branch,
    base: baseResolution.base,
    baseSource: baseResolution.source,
    snapshotCommit: snap.commit,
    changes,
    rules,
    canonical,
    units,
    present,
    tree,
    graph,
    order,
    cycles,
    segments,
  }
}

interface Assembled {
  plan: Plan
  warnings: ValidationIssue[]
  registry: Registry
  annotations: Annotation[]
}

/**
 * 装配一轮叙事：读册与批注 → 迁锚 → 问 planner → 更新册 → 装配 → 校验。
 * **只算不落盘**，写文件是调用方的事——dry-run 与正式路径靠这一点共用同一段逻辑，
 * 而不是各写一遍然后慢慢漂成两种行为。
 *
 * `previousPlan` 由调用方决定要不要传：`--reset-chapters` 时调用方传 `null`，
 * 否则跨轮漂移校验（validatePlan 的 cross-round-drift）会把「刻意重新分组」
 * 当成事故拦下来——那条校验守的是「同样的规则不该无声换章」，而 reset 恰恰
 * 是显式要求换一次，两者不能互相拦。
 */
async function assemble(
  repo: string,
  root: string,
  p: Prepared,
  round: number,
  opts: NarrateOptions,
  previousPlan: Plan | null,
): Promise<Assembled> {
  // --reset-chapters：册退回空册。不在这里删文件——assemble 只算不落盘，
  // 落地与否（也就是「是否真的丢掉旧册」）由调用方写不写 writeRegistry 决定，
  // dry-run 因此天然不会碰到真实状态目录。
  const registryBefore = opts.resetChapters === true ? EMPTY_REGISTRY : await readRegistry(root)

  const annotationFile = await readAnnotations(root)
  // 锚点存的是上一轮快照的行号。要推到本轮，必须用**两轮快照之间**的 diff；
  // 拿 base→本轮 的 diff 会把上一轮已施加的偏移重复施加一遍。
  // 上一轮快照由 refs/unfold/<reviewId>/round-NNN 钉住，gc 不会回收它。
  const anchorChanges =
    annotationFile.snapshot === undefined || annotationFile.snapshot === p.snapshotCommit
      ? []
      : await computeChanges(repo, annotationFile.snapshot, p.snapshotCommit)
  const migrated = migrateAnchors(annotationFile.annotations, anchorChanges)
  // reset 必须在 migrateAnchors 之后覆盖：迁移会按本轮 hunk 与批注的重叠情况
  // 把 state 判成 'stale'，而 reset 要的是「解除归属」这一个更强的结论，
  // 顺序反了会让 reset 的批注看起来还跟旧章有关系。
  const annotations: Annotation[] =
    opts.resetChapters === true
      ? migrated.map((a) => ({ ...a, chapterKey: null, state: 'unanchored' as const }))
      : migrated
  // pinnedByAnnotations 钉的是本轮 plan 里的 hunk id，必须用 base→本轮 的 p.changes——
  // 与上面迁移锚点用的 diff 不是同一件事，不能共用 anchorChanges。
  const pinned = pinnedByAnnotations(annotations, p.changes)

  const planner = opts.planner ?? new RulePlanner(p.segments)

  const draftCtx: PlanContext = {
    base: p.base,
    snapshot: p.snapshotCommit,
    changes: p.changes,
    rules: p.rules,
    canonical: p.canonical,
    registry: registryBefore,
    pinned,
    deps: p.graph.edges,
    // 体检要判断的是「这个路径字面上存在吗」，用 p.tree（原始 ls-tree
    // 结果）；p.present 是给册用的另一个更宽的集合，见 Prepared.present 上的注释。
    present: p.tree,
  }
  const assignment = await planner.assign(draftCtx)

  // 把 planner 的归属还原成「段」的形状交给册；
  // 册不关心归属是规则算的还是 AI 给的，只认这一种输入
  const grouped = new Map<string, string[]>()
  for (const unit of p.order) {
    const key = assignment.byChapter.get(unit)
    if (key === undefined) continue
    grouped.set(key, [...(grouped.get(key) ?? []), unit])
  }
  const segments: Segment[] = [...grouped].map(([key, members]) => {
    const meta = assignment.proposed?.get(key)
    return {
      key,
      members,
      title: meta?.title ?? key,
      intro: meta?.intro ?? '',
    }
  })

  const registry = updateRegistry({
    registry: registryBefore,
    segments,
    round,
    present: p.present,
    activeUnits: new Set(p.units),
    order: p.order,
  })

  // 册可能刚刚把某章的 key 顺延给了剩余成员（registry.ts 的 keyRenamedFrom）。
  // 批注记的是旧 key，册改名后不跟着改，下一轮 buildPlan 会因为
  // 「批注把 hunk 钉到了册里不存在的章」而抛错。所以改名一发生就把批注迁过去，
  // 并用迁移后的批注重算 pinned —— draftCtx 里那份是改名之前算的，还指着旧 key。
  //
  // 只迁「旧 key 已经不是任何一章的 key」的那些：keyRenamedFrom 是粘着的历史
  // 记录，若日后恰好又有新章用回那个路径当 key，照着它迁会把新章的批注抢走。
  const currentKeys = new Set(registry.chapters.map((c) => c.key))
  const renamedTo = new Map<string, string>()
  for (const chapter of registry.chapters) {
    if (chapter.keyRenamedFrom !== null && !currentKeys.has(chapter.keyRenamedFrom)) {
      renamedTo.set(chapter.keyRenamedFrom, chapter.key)
    }
  }
  const remapped =
    renamedTo.size === 0
      ? annotations
      : annotations.map((a) => {
          const moved = a.chapterKey === null ? undefined : renamedTo.get(a.chapterKey)
          return moved === undefined ? a : { ...a, chapterKey: moved }
        })
  const pinnedAfterRename =
    renamedTo.size === 0 ? pinned : pinnedByAnnotations(remapped, p.changes)

  const ctx: PlanContext = {
    ...draftCtx,
    registry,
    pinned: pinnedAfterRename,
    ...(previousPlan !== null ? { previous: previousPlan } : {}),
  }

  const plan = buildPlan(ctx, assignment, planner.id)
  const issues = validatePlan(plan, ctx)
  const errors = issues.filter((i) => i.severity === 'error')
  if (errors.length > 0) {
    throw new Error(
      `plan 未通过语义校验：\n${errors.map((i) => `  [${i.code}] ${i.message}`).join('\n')}`,
    )
  }
  const warnings = issues.filter((i) => i.severity === 'warn')

  return { plan, warnings, registry, annotations: remapped }
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
 * 只算 plan，不产出任何东西：不钉快照 ref、不建 worktree、不 replay、
 * 不写状态目录。用于反复调参时秒级看「章节会怎么分」。
 *
 * dry-run 预览的是「真跑一次会发生什么」：带 `--reuse` 时那意味着在**现有**册
 * 上继续，必须读真实的 review 目录（只读，不写——`assemble` 本身不落盘）；
 * 不带 `--reuse` 时意味着开一次全新 review，空册本来就是正确的预览。此前用
 * 带随机后缀的 `newReviewId` 现编一个必然不存在的目录，会让任何跑过一轮以上
 * 的仓库拿到一份与实际不符的预览（章节从零重新切段，`cross-round-drift` 也
 * 永远不会在预览里触发）。
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

  const previous = opts.reuse === true ? await latestReview(repo) : null
  const root =
    previous?.root ?? join(await repoStateDir(repo), newReviewId(p.branch, opts.now))
  const round = previous === null ? 1 : await nextRound(repo, previous.reviewId)
  const previousPlan =
    previous === null ? null : await readPlan(repo, previous.reviewId).catch(() => null)

  const assembled = await assemble(repo, root, p, round, opts, previousPlan)

  return {
    hasChanges: true,
    branch: p.branch,
    base: p.base,
    snapshot: p.snapshotCommit,
    plan: assembled.plan,
    warnings: assembled.warnings,
    registryChapters: assembled.registry.chapters.length,
    depGraph: p.graph,
    cycles: p.cycles,
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
  const { branch, changes } = p
  const reviewId = previous?.reviewId ?? newReviewId(branch, opts.now)

  if (changes.length === 0) {
    return { hasChanges: false, branch, base: p.base }
  }

  // 复用时把上一轮的 plan 带进来，跨轮钉回才真正生效（仅当规则指纹相同）
  const previousPlan =
    previous === null ? null : await readPlan(repo, previous.reviewId).catch(() => null)

  const root = await reviewRoot(repo, reviewId)
  await mkdir(join(root, 'tours'), { recursive: true })
  const round = await nextRound(repo, reviewId)

  // 快照钉 ref，扛得过 gc（spec §4.3）。复用时轮次递增，不覆盖历轮。
  await pinSnapshot(repo, reviewId, round, p.snapshotCommit)

  // 轨道 A：worktree 直接停在终态。复用时它已经注册过了，重复 add 会报错。
  const worktree = join(root, 'worktree')
  if (!existsSync(worktree)) {
    await addWorktree(repo, worktree, p.snapshotCommit)
  }

  // 轨道 B：读册与批注 → 迁锚 → 问 planner → 更新册 → 装配 → 校验。
  // --reset-chapters 时不把上一轮 plan 传进校验——那条跨轮漂移检查守的是
  // 「同样规则下不该无声换章」，reset 恰恰是显式要求换一次，两者不能互拦。
  const assembled = await assemble(
    repo,
    root,
    p,
    round,
    opts,
    opts.resetChapters === true ? null : previousPlan,
  )
  const { plan, warnings, registry, annotations } = assembled

  const replayed = await replay(repo, plan, changes)
  await verify(repo, replayed.tip, p.snapshotCommit)

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
        base: p.base,
        baseSource: p.baseSource,
        narrativeBranch,
        createdAt: (opts.now ?? new Date()).toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await writeFile(join(root, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  await writeRegistry(root, registry)
  await writeAnnotations(root, { version: 1, snapshot: p.snapshotCommit, annotations })

  // 文件名跟着**册内章号**（Chapter.index）走，不跟数组下标、也不跟 commitIndex：
  // 下标会因为「纯删除章没有 step」留下的空洞而错位；commitIndex 则会在册里
  // 有 empty / deleted 章时与 CLI 打印的章号分叉（CLI 说第 7 章、tour 面板说 3.）。
  // 编号出现空洞是诚实的——它在说「第 2 章这一轮没有内容」。
  for (const { index, tour } of toCodeTours(plan, changes, narrativeBranch)) {
    const name = `chapter-${String(index).padStart(3, '0')}.tour`
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
    base: p.base,
    snapshot: p.snapshotCommit,
    tip: replayed.tip,
    chapters: plan.chapters.length,
    worktree,
    warnings,
    registryChapters: registry.chapters.length,
    depGraph: p.graph,
    cycles: p.cycles,
  }
}
