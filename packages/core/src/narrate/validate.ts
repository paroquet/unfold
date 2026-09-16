import { rulesFingerprint } from './rules.js'
import type { Plan, PlanContext } from './plan.js'

export type ValidationCode =
  | 'hunk-missing'
  | 'hunk-duplicated'
  | 'hunk-unknown'
  | 'file-missing'
  | 'file-duplicated'
  | 'file-unknown'
  | 'chapter-index'
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
    for (const [p, wasKey] of before) {
      const nowKey = after.get(p)
      if (nowKey !== undefined && nowKey !== wasKey) {
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
        code: 'chapter-index',
        severity: 'error',
        message: `章「${ch.key}」的 commitIndex 是 ${ch.commitIndex}，应为 ${expectedCommit}`,
      })
    }
  }

  /** 真实路径被规约到了别的路径 ⇒ 它是测试 */
  const isTest = (path: string): boolean => (ctx.canonical.get(path) ?? path) !== path

  const chapterOfUnit = new Map<string, number>()
  for (const ch of plan.chapters) {
    for (const p of ch.filePaths) chapterOfUnit.set(ctx.canonical.get(p) ?? p, ch.index)
  }

  for (const ch of plan.chapters) {
    if (ch.status !== 'active' || ch.filePaths.length === 0) continue

    const tests = ch.filePaths.filter(isTest)
    if (tests.length === 0) {
      issues.push({
        code: 'chapter-no-test',
        severity: 'warn',
        message: `第 ${ch.index} 章「${ch.title}」有 ${ch.filePaths.length} 个实现文件、0 个测试`,
      })
    } else if (tests.length === ch.filePaths.length) {
      issues.push({
        code: 'chapter-test-only',
        severity: 'warn',
        message: `第 ${ch.index} 章「${ch.title}」只有测试，对应实现不在本轮改动里`,
      })
    }

    if (ch.filePaths.length > ctx.rules.maxFiles) {
      issues.push({
        code: 'chapter-oversized',
        severity: 'warn',
        message:
          `第 ${ch.index} 章「${ch.title}」有 ${ch.filePaths.length} 个文件，` +
          `超过 maxFiles=${ctx.rules.maxFiles}`,
      })
    }

    for (const p of ch.filePaths) {
      const unit = ctx.canonical.get(p) ?? p
      for (const target of ctx.deps.get(unit) ?? []) {
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
