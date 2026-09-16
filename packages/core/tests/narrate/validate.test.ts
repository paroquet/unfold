import { describe, it, expect } from 'vitest'
import { validatePlan } from '../../src/narrate/validate.js'
import type { Chapter, Plan, PlanContext } from '../../src/narrate/plan.js'
import type { FileChange } from '../../src/narrate/diff.js'
import { DEFAULT_RULES, rulesFingerprint } from '../../src/narrate/rules.js'
import { EMPTY_REGISTRY } from '../../src/narrate/registry.js'

function change(path: string, hunkCount: number): FileChange {
  return {
    path, kind: 'modify', binary: false, mode: '100644',
    blob: 'b'.repeat(40), oldMode: '100644', oldBlob: 'a'.repeat(40),
    hunks: Array.from({ length: hunkCount }, (_, i) => ({
      id: `${path}#${i}`, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'],
    })),
  }
}

function ctx(changes: FileChange[], previous?: Plan): PlanContext {
  return {
    base: 'a'.repeat(40),
    snapshot: 'b'.repeat(40),
    changes,
    rules: DEFAULT_RULES,
    canonical: new Map(),
    registry: EMPTY_REGISTRY,
    pinned: new Map(),
    deps: new Map(),
    present: new Set(),
    ...(previous ? { previous } : {}),
  }
}

// 这批用例测的是 hunk/file 覆盖与跨轮漂移，不碰 commitIndex/status/
// keyRenamedFrom——统一补成「有内容」的形态，只为了让类型过得去
type ChapterInput = Omit<Chapter, 'commitIndex' | 'status' | 'keyRenamedFrom'>

function plan(chapters: ChapterInput[]): Plan {
  return {
    version: 1,
    base: 'a'.repeat(40),
    snapshot: 'b'.repeat(40),
    plannerId: 'test',
    rulesFingerprint: rulesFingerprint(DEFAULT_RULES),
    chapters: chapters.map((c) => ({
      ...c,
      commitIndex: c.index,
      status: 'active' as const,
      keyRenamedFrom: null,
    })),
  }
}

describe('validatePlan', () => {
  it('完全覆盖且不重复时通过', () => {
    const c = ctx([change('a.ts', 2)])
    const p = plan([{ key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0', 'a.ts#1'], filePaths: ['a.ts'] }])
    // 这条 fixture 没配 canonical，天然会触发 chapter-no-test（warn）——
    // 本用例只关心硬闸类问题（error），不是"零 issue"
    expect(validatePlan(p, c).filter((i) => i.severity === 'error')).toEqual([])
  })

  it('漏掉 hunk 会报 hunk-missing', () => {
    const c = ctx([change('a.ts', 2)])
    const p = plan([{ key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] }])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('hunk-missing')
  })

  it('同一 hunk 分到两章会报 hunk-duplicated', () => {
    const c = ctx([change('a.ts', 1)])
    const p = plan([
      { key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
      { key: 'k2', index: 2, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: [] },
    ])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('hunk-duplicated')
  })

  it('引用不存在的 hunk 会报 hunk-unknown', () => {
    const c = ctx([change('a.ts', 1)])
    const p = plan([{ key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0', 'ghost.ts#0'], filePaths: ['a.ts'] }])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('hunk-unknown')
  })

  it('章号不连续会报 chapter-index', () => {
    const c = ctx([change('a.ts', 1)])
    const p = plan([{ key: 'k1', index: 2, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] }])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('chapter-index')
  })

  it('规则指纹不同时不报漂移——规则变了就是故意换一种讲法', () => {
    const c0 = change('a.ts', 1)
    const previous = plan([
      { key: 'contract', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
    ])
    // 上一轮是在另一套规则下产出的
    previous.rulesFingerprint = 'someOtherFingerprint'
    const moved = plan([
      { key: 'core', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
    ])
    expect(validatePlan(moved, ctx([c0], previous)).map((i) => i.code)).not.toContain(
      'cross-round-drift',
    )
  })

  it('index 变了但 key 没变不算漂移（位置序号会随本轮非空的类合法变动）', () => {
    const c0 = change('a.ts', 1)
    const previous = plan([
      { key: 'contract', index: 1, title: 't', intro: 'i', hunkIds: [], filePaths: [] },
      { key: 'core', index: 2, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
    ])
    // 本轮 contract 类为空、未产出章节，core 章的 index 因此从 2 变成 1
    const shifted = plan([
      { key: 'core', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
    ])
    expect(validatePlan(shifted, ctx([c0], previous)).map((i) => i.code)).not.toContain(
      'cross-round-drift',
    )
  })

  it('已分配文件换了章（key 变化）会报 cross-round-drift', () => {
    const c0 = change('a.ts', 1)
    const c1 = change('b.ts', 1)
    const previous = plan([
      { key: 'contract', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
      { key: 'core', index: 2, title: 't', intro: 'i', hunkIds: ['b.ts#0'], filePaths: ['b.ts'] },
    ])
    // a.ts 从 contract 章挪到了 core 章 —— 这才是真漂移
    const drifted = plan([
      { key: 'core', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0', 'b.ts#0'], filePaths: ['a.ts', 'b.ts'] },
    ])
    const issues = validatePlan(drifted, ctx([c0, c1], previous))
    expect(issues.map((i) => i.code)).toContain('cross-round-drift')
  })

  it('无 hunk 的文件漏掉会报 file-missing', () => {
    // 模拟二进制文件或纯 mode 变更（无 hunk）
    const binary = { path: 'lib.a', kind: 'modify' as const, binary: true, mode: '100644', blob: 'b'.repeat(40), oldMode: '100644', oldBlob: 'a'.repeat(40), hunks: [] as any }
    const c = ctx([binary])
    const p = plan([{ key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: [], filePaths: [] }])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('file-missing')
  })

  it('同一文件分到两章会报 file-duplicated', () => {
    const c = ctx([change('a.ts', 0)])
    const p = plan([
      { key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: [], filePaths: ['a.ts'] },
      { key: 'k2', index: 2, title: 't', intro: 'i', hunkIds: [], filePaths: ['a.ts'] },
    ])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('file-duplicated')
  })

  it('引用不存在的文件会报 file-unknown', () => {
    const c = ctx([change('a.ts', 0)])
    const p = plan([{ key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: [], filePaths: ['a.ts', 'ghost.ts'] }])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('file-unknown')
  })

  it('ctx.previous 为 undefined 时不报 cross-round-drift', () => {
    const c = ctx([change('a.ts', 1)])
    const p = plan([{ key: 'k1', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] }])
    expect(validatePlan(p, c).map((i) => i.code)).not.toContain('cross-round-drift')
  })

  it('上一轮有、本轮消失的文件不报漂移', () => {
    // 上一轮 a.ts 在 contract 章
    const previous = plan([
      { key: 'contract', index: 1, title: 't', intro: 'i', hunkIds: [], filePaths: ['a.ts'] },
    ])
    // 本轮 a.ts 完全消失（不在 changes 中）
    const changes = [change('b.ts', 1)]
    const p = plan([{ key: 'core', index: 1, title: 't', intro: 'i', hunkIds: ['b.ts#0'], filePaths: ['b.ts'] }])
    expect(validatePlan(p, ctx(changes, previous)).map((i) => i.code)).not.toContain('cross-round-drift')
  })

  it('本轮新增、上一轮没有的文件不报漂移', () => {
    // 上一轮只有 a.ts
    const previous = plan([
      { key: 'core', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
    ])
    // 本轮 a.ts 保留，b.ts 新增
    const c0 = change('a.ts', 1)
    const c1 = change('b.ts', 1)
    const p = plan([{ key: 'core', index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0', 'b.ts#0'], filePaths: ['a.ts', 'b.ts'] }])
    expect(validatePlan(p, ctx([c0, c1], previous)).map((i) => i.code)).not.toContain('cross-round-drift')
  })
})

// 本 describe 自带的 mkChange/ctx 与上面已有的 change/ctx 签名不同（这里的 ctx
// 接收一个 Partial<PlanContext>），故意声明在这个 block 作用域内、不提到模块顶层，
// 避免和上面的同名 `ctx` 撞标识符
describe('章节体检', () => {
  const mkChange = (path: string): FileChange => ({
    path, kind: 'modify', binary: false, mode: '100644', blob: 'b',
    oldMode: '100644', oldBlob: 'o', hunks: [],
  })

  const ctx = (over: Partial<PlanContext>): PlanContext => ({
    base: 'b', snapshot: 's', changes: [], rules: DEFAULT_RULES,
    canonical: new Map(), registry: EMPTY_REGISTRY, pinned: new Map(), deps: new Map(),
    present: new Set(), ...over,
  })

  const base = { version: 1 as const, rulesFingerprint: 'f', base: 'b', snapshot: 's', plannerId: 'test' }
  const chapter = (over: Partial<Chapter>): Chapter => ({
    index: 1, commitIndex: 1, key: 'k', title: 'T', intro: 'I',
    status: 'active', keyRenamedFrom: null, hunkIds: [], filePaths: [], ...over,
  })

  it('硬闸类问题的 severity 是 error', () => {
    const issues = validatePlan(
      { ...base, chapters: [chapter({ index: 7 })] },
      ctx({ changes: [] }),
    )
    expect(issues.find((i) => i.code === 'chapter-index')?.severity).toBe('error')
  })

  it('章节 key 重复是硬闸', () => {
    const issues = validatePlan(
      { ...base, chapters: [chapter({ index: 1, key: 'k' }), chapter({ index: 2, key: 'k' })] },
      ctx({ changes: [] }),
    )
    expect(issues.find((i) => i.code === 'chapter-key-duplicated')?.severity).toBe('error')
  })

  it('有实现没测试只是警告，不是错误', () => {
    const issues = validatePlan(
      { ...base, chapters: [chapter({ filePaths: ['src/a.ts'] })] },
      ctx({
        changes: [mkChange('src/a.ts')],
        canonical: new Map([['src/a.ts', 'src/a.ts']]),
      }),
    )
    const issue = issues.find((i) => i.code === 'chapter-no-test')
    expect(issue?.severity).toBe('warn')
    expect(issues.some((i) => i.severity === 'error')).toBe(false)
  })

  it('只有测试没有实现时报 chapter-test-only（被测实现确实存在于快照里）', () => {
    const issues = validatePlan(
      { ...base, chapters: [chapter({ filePaths: ['tests/a.test.ts'] })] },
      ctx({
        changes: [mkChange('tests/a.test.ts')],
        canonical: new Map([['tests/a.test.ts', 'src/a.ts']]),
        present: new Set(['src/a.ts']),
      }),
    )
    expect(issues.find((i) => i.code === 'chapter-test-only')?.severity).toBe('warn')
  })

  it('被测实现在快照里根本不存在（e2e / 测试 helper / 纯测试目录）时不报 chapter-test-only——无处可去的提示是噪音', () => {
    const issues = validatePlan(
      { ...base, chapters: [chapter({ filePaths: ['tests/e2e/cli.test.ts'] })] },
      ctx({
        changes: [mkChange('tests/e2e/cli.test.ts')],
        // canonical 把它规约到了 src/e2e/cli.ts，但那个路径并不存在（present 里没有）
        canonical: new Map([['tests/e2e/cli.test.ts', 'src/e2e/cli.ts']]),
        present: new Set(),
      }),
    )
    expect(issues.some((i) => i.code === 'chapter-test-only')).toBe(false)
  })

  it('超过 maxFiles 报 chapter-oversized', () => {
    const paths = ['a', 'b', 'c'].map((n) => `src/${n}.ts`)
    const issues = validatePlan(
      { ...base, chapters: [chapter({ filePaths: paths })] },
      ctx({
        changes: paths.map(mkChange),
        canonical: new Map(paths.map((p) => [p, p])),
        rules: { ...DEFAULT_RULES, maxFiles: 2 },
      }),
    )
    expect(issues.find((i) => i.code === 'chapter-oversized')?.severity).toBe('warn')
  })

  it('第 N 章依赖第 M 章且 M > N 时报 chapter-backward-dep', () => {
    const issues = validatePlan(
      {
        ...base,
        chapters: [
          chapter({ index: 1, key: 'src/a.ts', filePaths: ['src/a.ts'] }),
          chapter({ index: 2, commitIndex: 2, key: 'src/b.ts', filePaths: ['src/b.ts'] }),
        ],
      },
      ctx({
        changes: [mkChange('src/a.ts'), mkChange('src/b.ts')],
        canonical: new Map([['src/a.ts', 'src/a.ts'], ['src/b.ts', 'src/b.ts']]),
        deps: new Map([['src/a.ts', new Set(['src/b.ts'])], ['src/b.ts', new Set()]]),
      }),
    )
    expect(issues.find((i) => i.code === 'chapter-backward-dep')?.severity).toBe('warn')
  })

  it('同一章内部的依赖不算反向依赖——章本来就是依赖序上的一段', () => {
    // 同章内有依赖是常态而非异常。判据若写成 >=，几乎每一章都会冒出
    // 一条虚假警告，把「order 覆盖造成了真实反向依赖」这个真信号淹掉。
    const issues = validatePlan(
      {
        ...base,
        chapters: [chapter({ index: 1, key: 'src/a.ts', filePaths: ['src/a.ts', 'src/b.ts'] })],
      },
      ctx({
        changes: [mkChange('src/a.ts'), mkChange('src/b.ts')],
        canonical: new Map([['src/a.ts', 'src/a.ts'], ['src/b.ts', 'src/b.ts']]),
        deps: new Map([['src/b.ts', new Set(['src/a.ts'])], ['src/a.ts', new Set()]]),
      }),
    )
    expect(issues.some((i) => i.code === 'chapter-backward-dep')).toBe(false)
  })

  it('纯文档的章不按测试覆盖率评判——那只会变成噪音', () => {
    const issues = validatePlan(
      { ...base, chapters: [chapter({ filePaths: ['docs/x.md'] })] },
      ctx({ changes: [mkChange('docs/x.md')], canonical: new Map([['docs/x.md', 'docs/x.md']]) }),
    )
    expect(issues.some((i) => i.code === 'chapter-no-test')).toBe(false)
    expect(issues.some((i) => i.code === 'chapter-test-only')).toBe(false)
  })

  it('hunk 在本章、文件却记在后面某章时，本章仍要体检', () => {
    const h = { id: 'src/a.ts#0', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] }
    const issues = validatePlan(
      {
        ...base,
        chapters: [
          chapter({ index: 1, commitIndex: 1, key: 'c1', hunkIds: ['src/a.ts#0'], filePaths: [] }),
          chapter({ index: 2, commitIndex: 2, key: 'c2', hunkIds: [], filePaths: ['src/a.ts'] }),
        ],
      },
      ctx({
        changes: [{ ...mkChange('src/a.ts'), hunks: [h] }],
        canonical: new Map([['src/a.ts', 'src/a.ts']]),
      }),
    )
    // 两章都承载了 src/a.ts（一章经 hunk、一章经 filePaths），两章都该报
    expect(issues.filter((i) => i.code === 'chapter-no-test')).toHaveLength(2)
  })

  it('commitIndex 不连续用独立的 code，便于与位置错乱区分', () => {
    const issues = validatePlan(
      { ...base, chapters: [chapter({ index: 1, commitIndex: 3 })] },
      ctx({ changes: [] }),
    )
    expect(issues.find((i) => i.code === 'chapter-commit-gap')?.severity).toBe('error')
    expect(issues.some((i) => i.code === 'chapter-index')).toBe(false)
  })
})
