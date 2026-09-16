import { rulesFingerprint } from './rules.js'
import { hunkPath } from './diff.js'
import { isPairable } from './pair.js'
import type { Plan, PlanContext } from './plan.js'

export type ValidationCode =
  | 'hunk-missing'
  | 'hunk-duplicated'
  | 'hunk-unknown'
  | 'file-missing'
  | 'file-duplicated'
  | 'file-unknown'
  | 'chapter-index'
  | 'chapter-commit-gap'
  | 'cross-round-drift'
  | 'chapter-key-duplicated'
  | 'chapter-no-test'
  | 'chapter-test-only'
  | 'chapter-oversized'
  | 'chapter-backward-dep'

export interface ValidationIssue {
  code: ValidationCode
  /** error 一票否决（字节一致/章节锚点），warn 只提示可读性，不拦截 */
  severity: 'error' | 'warn'
  message: string
}

/**
 * schema 管不到、但错了会毁掉字节一致或跨轮稳定的语义规则（spec §7.3）。
 * 返回空数组表示通过。
 */
export function validatePlan(plan: Plan, ctx: PlanContext): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const [i, ch] of plan.chapters.entries()) {
    if (ch.index !== i + 1) {
      issues.push({
        code: 'chapter-index',
        severity: 'error',
        message: `第 ${i + 1} 个章节的 index 是 ${ch.index}，章号必须从 1 起连续`,
      })
    }
  }

  const knownHunks = new Set(ctx.changes.flatMap((c) => c.hunks.map((h) => h.id)))
  const knownFiles = new Set(ctx.changes.map((c) => c.path))

  const seenHunks = new Map<string, number>()
  const seenFiles = new Map<string, number>()
  for (const ch of plan.chapters) {
    for (const id of ch.hunkIds) seenHunks.set(id, (seenHunks.get(id) ?? 0) + 1)
    for (const p of ch.filePaths) seenFiles.set(p, (seenFiles.get(p) ?? 0) + 1)
  }

  for (const id of knownHunks) {
    if (!seenHunks.has(id)) {
      issues.push({ code: 'hunk-missing', severity: 'error', message: `hunk ${id} 没有被分配到任何章节` })
    }
  }
  for (const [id, n] of seenHunks) {
    if (!knownHunks.has(id)) {
      issues.push({ code: 'hunk-unknown', severity: 'error', message: `hunk ${id} 不存在于本轮改动中` })
    } else if (n > 1) {
      issues.push({ code: 'hunk-duplicated', severity: 'error', message: `hunk ${id} 被分配了 ${n} 次` })
    }
  }
  for (const p of knownFiles) {
    if (!seenFiles.has(p)) {
      issues.push({ code: 'file-missing', severity: 'error', message: `文件 ${p} 没有被分配到任何章节` })
    }
  }
  for (const [p, n] of seenFiles) {
    if (!knownFiles.has(p)) {
      issues.push({ code: 'file-unknown', severity: 'error', message: `文件 ${p} 不存在于本轮改动中` })
    } else if (n > 1) {
      issues.push({ code: 'file-duplicated', severity: 'error', message: `文件 ${p} 被分配了 ${n} 次` })
    }
  }

  // 跨轮漂移只在**同一套规则**的两轮之间才有意义：规则变了就是故意要换
  // 一种讲法，这时候报漂移会把「调规则」这件事本身变成不可能。
  const sameRules =
    ctx.previous !== undefined && ctx.previous.rulesFingerprint === rulesFingerprint(ctx.rules)

  if (ctx.previous !== undefined && sameRules) {
    // 按 key 而非 index 比对：index 是位置序号，会随「本轮哪些类非空」
    // 合法变动，拿它判漂移会大量误报
    const before = new Map<string, string>()
    for (const ch of ctx.previous.chapters) {
      for (const p of ch.filePaths) before.set(p, ch.key)
    }
    const after = new Map<string, string>()
    for (const ch of plan.chapters) {
      for (const p of ch.filePaths) after.set(p, ch.key)
    }
    // 册在 key 文件被删时会把 key 顺延给剩余成员（registry.ts 的 keyRenamedFrom）。
    // 那是**有意的改名**，不是漂移——成员没有换章，只是这一章换了名字。
    // 不认这条，任何「删掉某章的 key 文件、同时继续改它的兄弟文件」的普通第二轮
    // 都会被判成漂移而拒绝出货，而跨轮沿用正是这套册存在的理由。
    const renamedFrom = new Map<string, string>()
    for (const ch of plan.chapters) {
      if (ch.keyRenamedFrom !== null) renamedFrom.set(ch.key, ch.keyRenamedFrom)
    }
    for (const [p, wasKey] of before) {
      const nowKey = after.get(p)
      if (nowKey !== undefined && nowKey !== wasKey && renamedFrom.get(nowKey) !== wasKey) {
        issues.push({
          code: 'cross-round-drift',
          severity: 'error',
          message: `文件 ${p} 上一轮在「${wasKey}」章，本轮变成「${nowKey}」章；批注会漂移`,
        })
      }
    }
  }

  // —— 以下是章节体检，一律 warn：它们守的是可读性，不是正确性。
  // 做成硬闸会让纯文档改动、纯重构、来不及补测试的 hotfix 直接叙不出来。

  const seenKeys = new Set<string>()
  for (const ch of plan.chapters) {
    if (seenKeys.has(ch.key)) {
      issues.push({
        code: 'chapter-key-duplicated',
        severity: 'error',
        message: `章节 key 重复：${ch.key}；批注会钉到错误的章上`,
      })
    }
    seenKeys.add(ch.key)
  }

  let expectedCommit = 0
  for (const ch of plan.chapters) {
    if (ch.commitIndex === null) continue
    expectedCommit += 1
    if (ch.commitIndex !== expectedCommit) {
      issues.push({
        code: 'chapter-commit-gap',
        severity: 'error',
        message: `章「${ch.key}」的 commitIndex 是 ${ch.commitIndex}，应为 ${expectedCommit}`,
      })
    }
  }

  /**
   * 本章实际承载的文件：filePaths 再并上贡献了 hunk 的文件。
   * 与 replay 的 touched 同义（replay.ts:45-46）——只看 filePaths 会漏掉
   * 「hunk 在本章、文件却记在后面某章」的情形，那种章照样在讲代码。
   * 排序是为了让体检 issue 的顺序只取决于 plan，不受 Set 迭代顺序影响。
   */
  const filesOf = (ch: Plan['chapters'][number]): string[] => {
    const set = new Set(ch.filePaths)
    for (const id of ch.hunkIds) set.add(hunkPath(id))
    return [...set].sort()
  }

  /** 真实路径被规约到了别的路径 ⇒ 它是测试 */
  const isTest = (path: string): boolean => (ctx.canonical.get(path) ?? path) !== path

  const chapterOfUnit = new Map<string, number>()
  for (const ch of plan.chapters) {
    for (const p of ch.filePaths) chapterOfUnit.set(ctx.canonical.get(p) ?? p, ch.index)
  }

  for (const ch of plan.chapters) {
    if (ch.status !== 'active') continue
    const files = filesOf(ch)
    if (files.length === 0) continue

    const tests = files.filter(isTest)
    const impls = files.filter((p) => !isTest(p) && isPairable(p))

    if (impls.length > 0 && tests.length === 0) {
      issues.push({
        code: 'chapter-no-test',
        severity: 'warn',
        message: `第 ${ch.index} 章「${ch.title}」有 ${impls.length} 个实现文件、0 个测试`,
      })
    } else if (tests.length > 0 && impls.length === 0) {
      // 只有当它所测的实现**确实存在于仓库里**时，这条才有行动价值——读的人
      // 能去看那份没被改动的实现。若 canonical 目标根本不存在（e2e、测试
      // helper、纯测试目录），这条提示无处可去，纯粹是噪音。
      const reachable = tests.some((p) => {
        const unit = ctx.canonical.get(p)
        return unit !== undefined && unit !== p && ctx.present.has(unit)
      })
      if (reachable) {
        issues.push({
          code: 'chapter-test-only',
          severity: 'warn',
          message: `第 ${ch.index} 章「${ch.title}」只有测试，对应实现不在本轮改动里`,
        })
      }
    }

    if (files.length > ctx.rules.maxFiles) {
      issues.push({
        code: 'chapter-oversized',
        severity: 'warn',
        message:
          `第 ${ch.index} 章「${ch.title}」有 ${files.length} 个文件，` +
          `超过 maxFiles=${ctx.rules.maxFiles}`,
      })
    }

    for (const p of files) {
      const unit = ctx.canonical.get(p) ?? p
      for (const target of [...(ctx.deps.get(unit) ?? [])].sort()) {
        const targetChapter = chapterOfUnit.get(target)
        if (targetChapter !== undefined && targetChapter > ch.index) {
          issues.push({
            code: 'chapter-backward-dep',
            severity: 'warn',
            message:
              `第 ${ch.index} 章的 ${unit} 依赖第 ${targetChapter} 章的 ${target}；` +
              '读到这里时被依赖的代码还没出现',
          })
        }
      }
    }
  }

  return issues
}
