# 章节册 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把章节从「每轮按文件种类重算的产物」改成「按数据流划分、跨轮持久、批注驱动归属的册」。

**Architecture:** 新增六个单一职责模块构成一条数据流——配对（`pair`）→ 连边（`deps`）→ 定序（`order`）→ 切段（`segment`）→ 归册（`registry`）→ 迁锚（`anchors`）。`buildPlan` 改为按「批注锚定 > 上一轮在册 > 依赖序切段」三级优先装配；`replay` 只对有 hunk 的章产 commit；章节质量做成警告而非硬闸。

**Tech Stack:** TypeScript 7.0.2（ESM，`module: Node16`，**所有相对 import 必须带 `.js` 后缀**）、Node 24.21.0（`.nvmrc`）、pnpm 10.12.4、vitest 5.0.0。零新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-09-16-narrative-registry-design.md`

## Global Constraints

- **字节一致是唯一硬闸**：`tree(commit_N) == tree(SNAP)`。任何新增校验都不得放宽它，章节质量类问题一律 `severity: 'warn'`。
- **零扰动**：不得读写用户工作区。文件内容一律经 `git cat-file blob <sha>` 从对象库取。
- **确定性**：同样的输入必须产出同样的章节 key 与顺序。拓扑排序用 Kahn + 同层字典序；任何 `Set`/`Map` 迭代顺序不得影响输出。
- **不静默降级**：配置错误、`version: 1` 的旧配置、planner 漏分配文件，一律抛错并指名问题所在。
- **语言覆盖诚实标注**：依赖扫描只支持 TS/JS 与 Kotlin/Java，其余语言必须出现在 `--dry-run` 的「跳过」统计里。
- **提交纪律**：只用 `git add <显式文件路径>`，**禁止** `git add -A` 或 `git add <目录>`。禁止提交 `.superpowers/` 下任何东西。禁止碰 `docs/2026-09-15-product-vision-and-implementation.md`（用户的文件）。
- **禁止 `git stash` / `git stash pop`**：stash 栈跨 worktree 共享。
- **测试必须可被变异证伪**：写完一个测试，改一处生产代码让它失败，确认它真的挂了再改回来。
- 中文注释解释**为什么**，不解释**是什么**。

---

## 文件结构

**新建（`packages/core/src/narrate/`）**

| 文件 | 职责 | 任务 |
|---|---|---|
| `pair.ts` | 测试路径 → 实现路径的 canonical 规约 | 1 |
| `deps.ts` | 按语言扫 import，只在本轮改动文件之间连边 | 2 |
| `order.ts` | Tarjan 缩点 + Kahn 确定性拓扑 + `order` 前缀覆盖 | 3 |
| `segment.ts` | 沿拓扑序贪心切段，生成章节骨架 | 4 |
| `registry.ts` | 章节册的读写与状态迁移 | 5 |
| `anchors.ts` | 批注锚点迁移与归属钉定 | 6 |

**改造**：`rules.ts`(7)、`plan.ts`(8)、`build-plan.ts`(8)、`rule-planner.ts`(8)、`validate.ts`(9)、`replay.ts`(10)、`run.ts`(10)、`bin/report.ts`(11)、`bin/args.ts`(11)、`bin/unfold.ts`(11)、`index.ts`(7/8/11)。

---

### Task 1: `pair.ts` —— 测试路径规约成实现路径

**Files:**
- Create: `packages/core/src/narrate/pair.ts`
- Test: `packages/core/tests/narrate/pair.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface PairRules { dirs: Array<[string, string]>; suffixes: string[] }`
  - `const DEFAULT_PAIR_RULES: PairRules`
  - `function canonicalCandidates(path: string, rules: PairRules): string[]`
  - `function canonicalPath(path: string, rules: PairRules, exists: (p: string) => boolean): string`

- [ ] **Step 1: 写失败的测试**

```ts
// packages/core/tests/narrate/pair.test.ts
import { describe, it, expect } from 'vitest'
import { DEFAULT_PAIR_RULES, canonicalCandidates, canonicalPath } from '../../src/narrate/pair.js'

describe('canonicalCandidates', () => {
  it('把 tests 目录段与 .test 后缀一起剥掉', () => {
    expect(canonicalCandidates('packages/core/tests/narrate/rules.test.ts', DEFAULT_PAIR_RULES))
      .toContain('packages/core/src/narrate/rules.ts')
  })

  it('JVM 布局同时给出 test→src 与 test→main 两个候选', () => {
    const got = canonicalCandidates('app/src/test/kotlin/com/acme/OrderTest.kt', DEFAULT_PAIR_RULES)
    expect(got).toContain('app/src/main/kotlin/com/acme/Order.kt')
    expect(got).toContain('app/src/src/kotlin/com/acme/Order.kt')
  })

  it('实现文件本身没有候选，规约结果就是它自己', () => {
    expect(canonicalCandidates('packages/core/src/narrate/rules.ts', DEFAULT_PAIR_RULES)).toEqual([])
  })

  it('只替换第一个命中的目录段——src/test/... 里的 src 不能被当成待替换目标', () => {
    const got = canonicalCandidates('app/src/test/kotlin/Foo.kt', DEFAULT_PAIR_RULES)
    expect(got.every((p) => p.startsWith('app/src/'))).toBe(true)
  })
})

describe('canonicalPath', () => {
  it('取第一个真实存在的候选', () => {
    const exists = (p: string): boolean => p === 'app/src/main/kotlin/com/acme/Order.kt'
    expect(canonicalPath('app/src/test/kotlin/com/acme/OrderTest.kt', DEFAULT_PAIR_RULES, exists))
      .toBe('app/src/main/kotlin/com/acme/Order.kt')
  })

  it('候选都不存在时退回第一个候选，而不是退回原路径', () => {
    expect(canonicalPath('a/tests/b.test.ts', DEFAULT_PAIR_RULES, () => false))
      .toBe('a/src/b.ts')
  })

  it('没有候选时返回原路径', () => {
    expect(canonicalPath('a/src/b.ts', DEFAULT_PAIR_RULES, () => false)).toBe('a/src/b.ts')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/tests/narrate/pair.test.ts`
Expected: FAIL，`Cannot find module '../../src/narrate/pair.js'`

- [ ] **Step 3: 写实现**

```ts
// packages/core/src/narrate/pair.ts

/**
 * 测试路径 → 实现路径的规约规则。
 *
 * `dirs` 是**有序**的目录段替换对，`suffixes` 是文件名里要剥掉的标记。
 * 顺序有意义：同一条路径可能命中多条规则，产出的候选按这里的顺序排，
 * 由 canonicalPath 用「哪个真实存在」来定夺。
 */
export interface PairRules {
  dirs: Array<[string, string]>
  suffixes: string[]
}

export const DEFAULT_PAIR_RULES: PairRules = {
  dirs: [
    ['tests', 'src'],
    ['test', 'src'],
    ['__tests__', 'src'],
    ['spec', 'src'],
    ['test', 'main'],
  ],
  suffixes: ['.test', '.spec', '_test', 'Test'],
}

/** 从文件名里剥掉测试标记；`rules.suffixes` 里第一个命中的生效。 */
function stripSuffix(fileName: string, suffixes: string[]): string | null {
  const dot = fileName.lastIndexOf('.')
  const stem = dot < 0 ? fileName : fileName.slice(0, dot)
  const ext = dot < 0 ? '' : fileName.slice(dot)
  for (const suffix of suffixes) {
    if (suffix.startsWith('.')) {
      // `.test` 这类是「次级扩展名」：foo.test.ts → foo.ts
      if (stem.endsWith(suffix)) return `${stem.slice(0, -suffix.length)}${ext}`
    } else if (stem.endsWith(suffix) && stem.length > suffix.length) {
      // `Test` / `_test` 这类是词尾：OrderTest.kt → Order.kt
      return `${stem.slice(0, -suffix.length)}${ext}`
    }
  }
  return null
}

/**
 * 一条路径可能对应的全部实现路径候选。实现文件本身返回空数组。
 *
 * 目录段替换**只替换第一个命中的段**：`app/src/test/kotlin/Foo.kt` 里
 * 如果从右往左或全局替换 `src`，会把 `app/src` 也换掉，产出
 * `app/main/test/kotlin/Foo.kt` 这种根本不存在的路径。
 */
export function canonicalCandidates(path: string, rules: PairRules): string[] {
  const segments = path.split('/')
  const fileName = segments[segments.length - 1] as string
  const dirs = segments.slice(0, -1)

  const stripped = stripSuffix(fileName, rules.suffixes)
  const candidates: string[] = []
  const seen = new Set<string>()

  for (const [from, to] of rules.dirs) {
    const at = dirs.indexOf(from)
    if (at < 0) continue
    const replaced = [...dirs]
    replaced[at] = to
    const candidate = [...replaced, stripped ?? fileName].join('/')
    if (candidate !== path && !seen.has(candidate)) {
      seen.add(candidate)
      candidates.push(candidate)
    }
  }

  // 目录段没命中、但文件名带测试标记（同目录放测试的风格）
  if (candidates.length === 0 && stripped !== null) {
    candidates.push([...dirs, stripped].join('/'))
  }

  return candidates
}

/**
 * 规约出唯一的 canonical path。**取第一个在快照树里真实存在的候选**——
 * `src/test/kotlin/FooTest.kt` 既可能对 `src/main/kotlin/Foo.kt` 也可能对
 * `src/src/kotlin/Foo.kt`，靠猜会一半仓库分错组，靠 `exists` 查是证据。
 *
 * 都不存在时取第一个候选而不是退回原路径：退回原路径会让测试文件自成一个
 * 单元，正是这次要消灭的行为。
 */
export function canonicalPath(
  path: string,
  rules: PairRules,
  exists: (p: string) => boolean,
): string {
  const candidates = canonicalCandidates(path, rules)
  if (candidates.length === 0) return path
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return candidates[0] as string
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/core/tests/narrate/pair.test.ts`
Expected: PASS（7 个）

- [ ] **Step 5: 变异验证**

把 `canonicalCandidates` 里的 `dirs.indexOf(from)` 改成 `dirs.lastIndexOf(from)`，
确认「只替换第一个命中的目录段」那条测试变红，再改回来。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/narrate/pair.ts packages/core/tests/narrate/pair.test.ts
git commit -m 'feat(core): 测试路径规约成实现路径，候选靠快照树定夺'
```

---

### Task 2: `deps.ts` —— 按语言扫 import，只在改动文件间连边

**Files:**
- Create: `packages/core/src/narrate/deps.ts`
- Test: `packages/core/tests/narrate/deps.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type SourceLang = 'ts' | 'kotlin'`
  - `const SCANNER_VERSION = 1`
  - `function languageOf(path: string): SourceLang | null`
  - `function scanImports(content: string, lang: SourceLang): string[]`
  - `interface DepGraph { edges: Map<string, Set<string>>; scanned: string[]; skipped: Array<{ path: string; reason: string }> }`
  - `function buildDepGraph(files: string[], contents: Map<string, string | null>): DepGraph`

- [ ] **Step 1: 写失败的测试**

```ts
// packages/core/tests/narrate/deps.test.ts
import { describe, it, expect } from 'vitest'
import { buildDepGraph, languageOf, scanImports } from '../../src/narrate/deps.js'

describe('languageOf', () => {
  it('认识 TS/JS 与 Kotlin/Java，其余返回 null', () => {
    expect(languageOf('a/b.ts')).toBe('ts')
    expect(languageOf('a/b.mjs')).toBe('ts')
    expect(languageOf('a/B.kt')).toBe('kotlin')
    expect(languageOf('a/B.java')).toBe('kotlin')
    expect(languageOf('a/b.md')).toBeNull()
    expect(languageOf('a/b.rs')).toBeNull()
  })
})

describe('scanImports', () => {
  it('抓 TS 的四种形态', () => {
    const src = [
      "import { a } from './a.js'",
      "export { b } from '../b/index.js'",
      "const c = require('./c.js')",
      "await import('./d.js')",
    ].join('\n')
    expect(scanImports(src, 'ts')).toEqual(['./a.js', '../b/index.js', './c.js', './d.js'])
  })

  it('不抓包名——只有相对路径才可能指向本轮改动的文件', () => {
    expect(scanImports("import x from 'node:fs'\nimport y from 'picomatch'", 'ts')).toEqual([])
  })

  it('抓 Kotlin 的包路径 import', () => {
    expect(scanImports('package com.acme\n\nimport com.acme.order.Order\n', 'kotlin'))
      .toEqual(['com.acme.order.Order'])
  })
})

describe('buildDepGraph', () => {
  it('把 TS 相对 import 解析成仓库相对路径，含 .js → .ts 换算', () => {
    const files = ['src/a.ts', 'src/sub/b.ts']
    const contents = new Map([
      ['src/a.ts', "import { b } from './sub/b.js'\n"],
      ['src/sub/b.ts', 'export const b = 1\n'],
    ])
    const graph = buildDepGraph(files, contents)
    expect([...(graph.edges.get('src/a.ts') ?? [])]).toEqual(['src/sub/b.ts'])
    expect(graph.edges.get('src/sub/b.ts')?.size ?? 0).toBe(0)
  })

  it('指向本轮改动之外的文件不连边', () => {
    const files = ['src/a.ts']
    const contents = new Map([['src/a.ts', "import x from './not-changed.js'\n"]])
    expect(buildDepGraph(files, contents).edges.get('src/a.ts')?.size ?? 0).toBe(0)
  })

  it('Kotlin 靠包路径后缀匹配，不需要知道源码根在哪', () => {
    const files = ['app/src/main/kotlin/com/acme/Order.kt', 'app/src/main/kotlin/com/acme/pay/Pay.kt']
    const contents = new Map([
      ['app/src/main/kotlin/com/acme/Order.kt', 'import com.acme.pay.Pay\n'],
      ['app/src/main/kotlin/com/acme/pay/Pay.kt', 'class Pay\n'],
    ])
    const graph = buildDepGraph(files, contents)
    expect([...(graph.edges.get('app/src/main/kotlin/com/acme/Order.kt') ?? [])])
      .toEqual(['app/src/main/kotlin/com/acme/pay/Pay.kt'])
  })

  it('未支持的语言与读不到内容的文件进 skipped，并说明原因', () => {
    const files = ['a.md', 'src/gone.ts']
    const contents = new Map<string, string | null>([['a.md', '# hi'], ['src/gone.ts', null]])
    const graph = buildDepGraph(files, contents)
    expect(graph.scanned).toEqual([])
    expect(graph.skipped).toEqual([
      { path: 'a.md', reason: '未支持依赖扫描的文件类型' },
      { path: 'src/gone.ts', reason: '内容不可读（已删除或二进制）' },
    ])
  })

  it('不产生自环', () => {
    const files = ['src/a.ts']
    const contents = new Map([['src/a.ts', "import { x } from './a.js'\n"]])
    expect(buildDepGraph(files, contents).edges.get('src/a.ts')?.size ?? 0).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/tests/narrate/deps.test.ts`
Expected: FAIL，`Cannot find module '../../src/narrate/deps.js'`

- [ ] **Step 3: 写实现**

```ts
// packages/core/src/narrate/deps.ts

/**
 * 依赖扫描器的版本号。它进 `rulesFingerprint`——换了扫描规则就是换了排序依据，
 * 必须算作「规则变了」，否则上一轮的章节顺序会被当成仍然有效。
 */
export const SCANNER_VERSION = 1

export type SourceLang = 'ts' | 'kotlin'

const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const KOTLIN_EXT = new Set(['.kt', '.kts', '.java'])

function extOf(path: string): string {
  const slash = path.lastIndexOf('/')
  const name = slash < 0 ? path : path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot)
}

export function languageOf(path: string): SourceLang | null {
  const ext = extOf(path)
  if (TS_EXT.has(ext)) return 'ts'
  if (KOTLIN_EXT.has(ext)) return 'kotlin'
  return null
}

const TS_PATTERNS = [
  /\bimport\s[^'"\n]*?from\s*['"]([^'"]+)['"]/g,
  /\bexport\s[^'"\n]*?from\s*['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
]
const KOTLIN_PATTERN = /^\s*import\s+([A-Za-z_][\w.]*)/gm

/**
 * 抽出一份源码里的 import 目标。
 *
 * TS 只收相对路径（`./` `../`）——包名不可能指向本轮改动的文件，收进来只会
 * 制造永远匹配不上的噪音。按出现顺序返回并去重，保证确定性。
 */
export function scanImports(content: string, lang: SourceLang): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const push = (spec: string): void => {
    if (seen.has(spec)) return
    seen.add(spec)
    found.push(spec)
  }

  if (lang === 'ts') {
    const hits: Array<{ at: number; spec: string }> = []
    for (const pattern of TS_PATTERNS) {
      pattern.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = pattern.exec(content)) !== null) {
        const spec = m[1] as string
        if (spec.startsWith('./') || spec.startsWith('../')) hits.push({ at: m.index, spec })
      }
    }
    // 四条正则各扫一遍全文，命中顺序是按正则而非按源码位置——按位置重排，
    // 让输出只取决于源码本身
    hits.sort((a, b) => a.at - b.at)
    for (const hit of hits) push(hit.spec)
    return found
  }

  KOTLIN_PATTERN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = KOTLIN_PATTERN.exec(content)) !== null) push(m[1] as string)
  return found
}

export interface DepGraph {
  /** 文件 → 它依赖的文件（都是本轮改动集里的路径） */
  edges: Map<string, Set<string>>
  scanned: string[]
  skipped: Array<{ path: string; reason: string }>
}

/** `a/b/../c` → `a/c`，并去掉开头的 `./` */
function normalize(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/**
 * 把一条 TS 相对 import 解析成改动集里的某个文件。
 *
 * ESM 下源码里写的是 `./a.js`，实际文件却是 `./a.ts`，所以要做扩展名换算；
 * 目录 import 还要补 `index`。逐个候选去改动集里查，查不到就没有边。
 */
function resolveTs(from: string, spec: string, present: Set<string>): string | null {
  const joined = normalize(`${dirOf(from)}/${spec}`)
  const stem = joined.replace(/\.(js|jsx|mjs|cjs)$/, '')
  const candidates = [
    joined,
    ...['.ts', '.tsx', '.mts', '.cts'].map((e) => `${stem}${e}`),
    ...['.ts', '.tsx', '.js', '.jsx'].map((e) => `${joined}/index${e}`),
  ]
  for (const candidate of candidates) {
    if (present.has(candidate)) return candidate
  }
  return null
}

/**
 * 把一条 Kotlin/Java 的包路径 import 解析成改动集里的某个文件。
 *
 * 用**路径后缀匹配**而不是去算源码根：`src/main/kotlin` 这层前缀每个项目
 * 都不一样，猜错就全盘无边；而 `com/acme/pay/Pay` 作为后缀是稳定的。
 */
function resolveKotlin(spec: string, present: Set<string>): string | null {
  const suffix = spec.replace(/\./g, '/')
  for (const candidate of present) {
    const stem = candidate.replace(/\.(kt|kts|java)$/, '')
    if (stem === suffix || stem.endsWith(`/${suffix}`)) return candidate
  }
  return null
}

/**
 * 建依赖图。**只在 `files` 内部连边**——本轮改动之外的文件不是这次叙事的
 * 一部分，指向它们的 import 不影响章节顺序。
 *
 * `contents` 的值为 `null` 表示内容不可读（文件已删除、或是二进制）。
 */
export function buildDepGraph(
  files: string[],
  contents: Map<string, string | null>,
): DepGraph {
  const present = new Set(files)
  const edges = new Map<string, Set<string>>(files.map((f) => [f, new Set<string>()]))
  const scanned: string[] = []
  const skipped: Array<{ path: string; reason: string }> = []

  for (const file of files) {
    const lang = languageOf(file)
    if (lang === null) {
      skipped.push({ path: file, reason: '未支持依赖扫描的文件类型' })
      continue
    }
    const content = contents.get(file) ?? null
    if (content === null) {
      skipped.push({ path: file, reason: '内容不可读（已删除或二进制）' })
      continue
    }
    scanned.push(file)

    for (const spec of scanImports(content, lang)) {
      const target =
        lang === 'ts' ? resolveTs(file, spec, present) : resolveKotlin(spec, present)
      // 自环无意义（同一文件内的 re-export），且会让 Tarjan 把单个文件报成环
      if (target !== null && target !== file) edges.get(file)?.add(target)
    }
  }

  return { edges, scanned, skipped }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/core/tests/narrate/deps.test.ts`
Expected: PASS（9 个）

- [ ] **Step 5: 变异验证**

删掉 `resolveTs` 里的扩展名换算（只保留 `joined` 一个候选），确认
「含 .js → .ts 换算」那条变红；再删掉 `target !== file` 的判断，确认
「不产生自环」变红。都改回来。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/narrate/deps.ts packages/core/tests/narrate/deps.test.ts
git commit -m 'feat(core): 依赖扫描——只在本轮改动文件之间连边'
```

---

### Task 3: `order.ts` —— Tarjan 缩点 + Kahn 确定性拓扑 + `order` 前缀覆盖

**Files:**
- Create: `packages/core/src/narrate/order.ts`
- Test: `packages/core/tests/narrate/order.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `DepGraph['edges']`（`Map<string, Set<string>>`，`edges.get(a)` 是 a **依赖**的节点）
- Produces:
  - `interface OrderResult { order: string[]; cycles: string[][] }`
  - `function topoOrder(nodes: string[], edges: Map<string, Set<string>>, prefixes?: string[]): OrderResult`

- [ ] **Step 1: 写失败的测试**

```ts
// packages/core/tests/narrate/order.test.ts
import { describe, it, expect } from 'vitest'
import { topoOrder } from '../../src/narrate/order.js'

const graph = (spec: Record<string, string[]>): Map<string, Set<string>> =>
  new Map(Object.entries(spec).map(([k, v]) => [k, new Set(v)]))

describe('topoOrder', () => {
  it('被依赖的排在前面', () => {
    const { order } = topoOrder(['run', 'diff', 'plan'], graph({
      run: ['plan'], plan: ['diff'], diff: [],
    }))
    expect(order).toEqual(['diff', 'plan', 'run'])
  })

  it('同层按字典序，且与输入顺序无关', () => {
    const nodes = ['c', 'a', 'b']
    const e = graph({ a: [], b: [], c: [] })
    expect(topoOrder(nodes, e).order).toEqual(['a', 'b', 'c'])
    expect(topoOrder([...nodes].reverse(), e).order).toEqual(['a', 'b', 'c'])
  })

  it('环被缩成一个分量，整体参与排序，内部按字典序', () => {
    const { order, cycles } = topoOrder(['tour', 'narrate', 'bin'], graph({
      narrate: ['tour'], tour: ['narrate'], bin: ['narrate'],
    }))
    expect(cycles).toEqual([['narrate', 'tour']])
    expect(order).toEqual(['narrate', 'tour', 'bin'])
  })

  it('单点自成分量不算环', () => {
    expect(topoOrder(['a', 'b'], graph({ a: ['b'], b: [] })).cycles).toEqual([])
  })

  it('order 前缀命中的节点按给定顺序排到最前，桶内仍走依赖序', () => {
    const { order } = topoOrder(
      ['src/bin/x.ts', 'src/git/a.ts', 'src/git/b.ts'],
      graph({ 'src/git/b.ts': ['src/git/a.ts'], 'src/git/a.ts': [], 'src/bin/x.ts': [] }),
      ['src/bin', 'src/git'],
    )
    expect(order).toEqual(['src/bin/x.ts', 'src/git/a.ts', 'src/git/b.ts'])
  })

  it('未被任何前缀命中的节点排在命中者之后', () => {
    const { order } = topoOrder(
      ['z/other.ts', 'src/git/a.ts'],
      graph({ 'z/other.ts': [], 'src/git/a.ts': [] }),
      ['src/git'],
    )
    expect(order).toEqual(['src/git/a.ts', 'z/other.ts'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/tests/narrate/order.test.ts`
Expected: FAIL，`Cannot find module '../../src/narrate/order.js'`

- [ ] **Step 3: 写实现**

```ts
// packages/core/src/narrate/order.ts

export interface OrderResult {
  /** 全序：被依赖的在前。同样的输入永远产出同样的顺序 */
  order: string[]
  /** 元素数 > 1 的强连通分量，内部按字典序 */
  cycles: string[][]
}

/**
 * 字符串比较**不用 `localeCompare`**：它的结果依赖 ICU 版本与 locale，
 * 换台机器就可能换顺序，而章节 key 的稳定性全靠这个顺序。
 * 裸比较走 UTF-16 码元序，跨机器恒定。
 */
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 迭代版 Tarjan。递归版在超大改动集上会爆栈，而改动集大小不由我们控制。 */
function stronglyConnected(
  nodes: string[],
  edges: Map<string, Set<string>>,
): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  for (const root of nodes) {
    if (index.has(root)) continue
    // 手工栈：每帧记住「这个节点的邻居遍历到第几个了」
    const work: Array<{ node: string; neighbors: string[]; at: number }> = [
      { node: root, neighbors: [...(edges.get(root) ?? [])].sort(byName), at: 0 },
    ]
    index.set(root, counter)
    low.set(root, counter)
    counter += 1
    stack.push(root)
    onStack.add(root)

    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: string; neighbors: string[]; at: number }
      if (frame.at < frame.neighbors.length) {
        const next = frame.neighbors[frame.at] as string
        frame.at += 1
        if (!index.has(next)) {
          index.set(next, counter)
          low.set(next, counter)
          counter += 1
          stack.push(next)
          onStack.add(next)
          work.push({ node: next, neighbors: [...(edges.get(next) ?? [])].sort(byName), at: 0 })
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(next) as number))
        }
        continue
      }

      work.pop()
      const parent = work[work.length - 1]
      if (parent !== undefined) {
        low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(frame.node) as number))
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = []
        for (;;) {
          const popped = stack.pop() as string
          onStack.delete(popped)
          component.push(popped)
          if (popped === frame.node) break
        }
        components.push(component.sort(byName))
      }
    }
  }

  return components
}

/**
 * 确定性拓扑排序。
 *
 * 三条保证，缺一条跨轮 key 就会漂：
 * 1. 强连通分量整体作为一个节点参与排序，内部按字典序——环里没有真正的先后
 * 2. 同时可选的分量按「桶号 + 分量内字典序最小的成员」排，而不是按入队顺序
 * 3. `prefixes` 命中的节点整体提前，但桶内仍走依赖序
 */
export function topoOrder(
  nodes: string[],
  edges: Map<string, Set<string>>,
  prefixes: string[] = [],
): OrderResult {
  const components = stronglyConnected(nodes, edges)
  const componentOf = new Map<string, number>()
  for (const [i, component] of components.entries()) {
    for (const node of component) componentOf.set(node, i)
  }

  // 缩点后的 DAG：分量 → 它依赖的分量
  const deps = components.map(() => new Set<number>())
  const dependents = components.map(() => new Set<number>())
  for (const node of nodes) {
    const from = componentOf.get(node) as number
    for (const target of edges.get(node) ?? []) {
      const to = componentOf.get(target)
      if (to === undefined || to === from) continue
      deps[from]?.add(to)
      dependents[to]?.add(from)
    }
  }

  /** 该分量落在第几个 order 前缀桶里；没命中的落在最后一个桶 */
  const bucketOf = (component: string[]): number => {
    let best = prefixes.length
    for (const member of component) {
      for (const [i, prefix] of prefixes.entries()) {
        if (i < best && (member === prefix || member.startsWith(`${prefix}/`))) best = i
      }
    }
    return best
  }
  const bucket = components.map(bucketOf)
  const head = components.map((component) => component[0] as string)

  const remaining = components.map((_, i) => (deps[i] as Set<number>).size)
  const ready: number[] = components.map((_, i) => i).filter((i) => remaining[i] === 0)
  const order: string[] = []

  while (ready.length > 0) {
    // 每轮取排序键最小的：用排序取代优先队列，分量数不会大到需要堆
    ready.sort(
      (a, b) =>
        (bucket[a] as number) - (bucket[b] as number) ||
        byName(head[a] as string, head[b] as string),
    )
    const current = ready.shift() as number
    order.push(...(components[current] as string[]))
    for (const dependent of dependents[current] ?? []) {
      remaining[dependent] = (remaining[dependent] as number) - 1
      if (remaining[dependent] === 0) ready.push(dependent)
    }
  }

  return {
    order,
    cycles: components
      .filter((c) => c.length > 1)
      .sort((a, b) => byName(a[0] as string, b[0] as string)),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/core/tests/narrate/order.test.ts`
Expected: PASS（6 个）

- [ ] **Step 5: 变异验证**

把 `ready.sort(...)` 整个调用删掉（退化成先进先出），确认「同层按字典序，且与输入顺序无关」变红。
再把 `components.push(component.sort(byName))` 的 `.sort(byName)` 去掉，确认环那条变红。都改回来。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/narrate/order.ts packages/core/tests/narrate/order.test.ts
git commit -m 'feat(core): 确定性拓扑排序，强连通分量缩点破环'
```

---

### Task 4: `segment.ts` —— 沿拓扑序贪心切段

**Files:**
- Create: `packages/core/src/narrate/segment.ts`
- Test: `packages/core/tests/narrate/segment.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `OrderResult`
- Produces:
  - `interface Segment { key: string; title: string; intro: string; members: string[] }`
  - `interface SegmentInput { order: string[]; cycles: string[][]; maxFiles: number; fileCount: (canonical: string) => number }`
  - `function segment(input: SegmentInput): Segment[]`

- [ ] **Step 1: 写失败的测试**

```ts
// packages/core/tests/narrate/segment.test.ts
import { describe, it, expect } from 'vitest'
import { segment } from '../../src/narrate/segment.js'

const one = (): number => 1

describe('segment', () => {
  it('章节 key 是段首文件，插到段中间不改 key', () => {
    const before = segment({ order: ['s/a.ts', 's/c.ts'], cycles: [], maxFiles: 8, fileCount: one })
    const after = segment({ order: ['s/a.ts', 's/b.ts', 's/c.ts'], cycles: [], maxFiles: 8, fileCount: one })
    expect(before[0]?.key).toBe('s/a.ts')
    expect(after[0]?.key).toBe('s/a.ts')
    expect(after[0]?.members).toEqual(['s/a.ts', 's/b.ts', 's/c.ts'])
  })

  it('跨目录必断，哪怕远没到 maxFiles', () => {
    const got = segment({
      order: ['s/git/a.ts', 's/git/b.ts', 's/bin/c.ts'],
      cycles: [], maxFiles: 8, fileCount: one,
    })
    expect(got.map((s) => s.members)).toEqual([['s/git/a.ts', 's/git/b.ts'], ['s/bin/c.ts']])
  })

  it('超过 maxFiles 必断，且按真实文件数算而不是单元数', () => {
    // 每个单元含 3 个真实文件（实现 + 两个测试），maxFiles 4 ⇒ 每章只装得下一个
    const got = segment({
      order: ['s/a.ts', 's/b.ts'], cycles: [], maxFiles: 4, fileCount: () => 3,
    })
    expect(got).toHaveLength(2)
  })

  it('单个单元自己就超 maxFiles 时仍然成章，不会被丢掉', () => {
    const got = segment({ order: ['s/a.ts'], cycles: [], maxFiles: 1, fileCount: () => 9 })
    expect(got.map((s) => s.members)).toEqual([['s/a.ts']])
  })

  it('标题带上目录名与首尾文件，导语说明这是依赖顺序', () => {
    const [chapter] = segment({
      order: ['s/git/a.ts', 's/git/b.ts'], cycles: [], maxFiles: 8, fileCount: one,
    })
    expect(chapter?.title).toBe('git：a.ts → b.ts')
    expect(chapter?.intro).toContain('依赖顺序')
  })

  it('段内含环时，导语明说先后不代表调用方向', () => {
    const [chapter] = segment({
      order: ['s/x/a.ts', 's/x/b.ts'],
      cycles: [['s/x/a.ts', 's/x/b.ts']],
      maxFiles: 8, fileCount: one,
    })
    expect(chapter?.intro).toContain('先后不代表调用方向')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/tests/narrate/segment.test.ts`
Expected: FAIL，`Cannot find module '../../src/narrate/segment.js'`

- [ ] **Step 3: 写实现**

```ts
// packages/core/src/narrate/segment.ts

export interface Segment {
  /** 段首文件的 canonical path。往段中间插文件不会改它，批注因此不漂 */
  key: string
  title: string
  intro: string
  /** canonical path，按依赖序 */
  members: string[]
}

export interface SegmentInput {
  order: string[]
  cycles: string[][]
  maxFiles: number
  /** 该单元含几个真实文件（实现 + 它的测试）。切段按真实文件数封顶 */
  fileCount: (canonical: string) => number
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function baseOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

function labelOf(dir: string): string {
  if (dir === '') return '仓库根'
  return baseOf(dir)
}

/**
 * 沿拓扑序贪心切段。两条断章规则：
 *
 * - **跨目录必断**：同一目录里连续的数据流阶段合成一章，跨模块一定分开
 * - **超 `maxFiles` 必断**：按真实文件数算，因为读的人面对的是文件不是单元
 *
 * 单个单元自己就超标时仍然成章——章可以过大（会由 `chapter-oversized`
 * 警告出来），但绝不能因为装不下就把文件丢了。
 */
export function segment(input: SegmentInput): Segment[] {
  const { order, cycles, maxFiles, fileCount } = input
  const cycleOf = new Map<string, string[]>()
  for (const cycle of cycles) {
    for (const member of cycle) cycleOf.set(member, cycle)
  }

  const groups: string[][] = []
  let current: string[] = []
  let currentFiles = 0

  for (const node of order) {
    const files = fileCount(node)
    const sameDir = current.length > 0 && dirOf(current[0] as string) === dirOf(node)
    const fits = currentFiles + files <= maxFiles
    if (current.length > 0 && (!sameDir || !fits)) {
      groups.push(current)
      current = []
      currentFiles = 0
    }
    current.push(node)
    currentFiles += files
  }
  if (current.length > 0) groups.push(current)

  return groups.map((members) => {
    const head = members[0] as string
    const tail = members[members.length - 1] as string
    const label = labelOf(dirOf(head))
    const names = members.length === 1 ? baseOf(head) : `${baseOf(head)} → ${baseOf(tail)}`

    const inCycle = members.filter((m) => cycleOf.has(m))
    const cycleNote =
      inCycle.length > 0
        ? `其中 ${inCycle.map(baseOf).join('、')} 互相依赖，先后不代表调用方向。`
        : ''

    return {
      key: head,
      title: `${label}：${names}`,
      intro: `按依赖顺序，这一章从 ${baseOf(head)} 讲到 ${baseOf(tail)}。${cycleNote}`,
      members,
    }
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/core/tests/narrate/segment.test.ts`
Expected: PASS（6 个）

- [ ] **Step 5: 变异验证**

把 `fits` 改成 `currentFiles + 1 <= maxFiles`（按单元数而非文件数封顶），
确认「按真实文件数算」那条变红。再把 `!sameDir ||` 去掉，确认「跨目录必断」变红。都改回来。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/narrate/segment.ts packages/core/tests/narrate/segment.test.ts
git commit -m 'feat(core): 沿依赖序贪心切段，跨目录与超额必断'
```

---

### Task 5: `registry.ts` —— 章节册的读写与状态迁移

**Files:**
- Create: `packages/core/src/narrate/registry.ts`
- Test: `packages/core/tests/narrate/registry.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `Segment`
- Produces:
  - `type ChapterStatus = 'active' | 'empty' | 'deleted'`
  - `interface ChapterRecord { key: string; index: number; title: string; intro: string; status: ChapterStatus; members: string[]; keyRenamedFrom: string | null; createdRound: number; lastActiveRound: number }`
  - `interface Registry { version: 1; chapters: ChapterRecord[] }`
  - `const EMPTY_REGISTRY: Registry`
  - `interface UpdateInput { registry: Registry; segments: Segment[]; round: number; present: Set<string>; activeUnits: Set<string>; order: string[] }`
  - `function updateRegistry(input: UpdateInput): Registry`
  - `function readRegistry(reviewRoot: string): Promise<Registry>`
  - `function writeRegistry(reviewRoot: string, registry: Registry): Promise<void>`
  - `const REGISTRY_FILE = 'registry.json'`

- [ ] **Step 1: 写失败的测试**

```ts
// packages/core/tests/narrate/registry.test.ts
import { describe, it, expect } from 'vitest'
import { EMPTY_REGISTRY, updateRegistry } from '../../src/narrate/registry.js'
import type { Segment } from '../../src/narrate/segment.js'

const seg = (key: string, members: string[]): Segment => ({
  key, members, title: `T ${key}`, intro: `I ${key}`,
})

describe('updateRegistry', () => {
  it('空册时 segments 原样成章，轮次记在 createdRound', () => {
    const got = updateRegistry({
      registry: EMPTY_REGISTRY,
      segments: [seg('a.ts', ['a.ts', 'b.ts'])],
      round: 1,
      present: new Set(['a.ts', 'b.ts']),
      activeUnits: new Set(['a.ts']),
      order: ['a.ts', 'b.ts'],
    })
    expect(got.chapters).toHaveLength(1)
    expect(got.chapters[0]).toMatchObject({
      key: 'a.ts', index: 1, status: 'active', members: ['a.ts', 'b.ts'], createdRound: 1,
    })
  })

  it('本轮没动的章标 empty 而不是消失', () => {
    const before = updateRegistry({
      registry: EMPTY_REGISTRY, segments: [seg('a.ts', ['a.ts'])], round: 1,
      present: new Set(['a.ts']), activeUnits: new Set(['a.ts']), order: ['a.ts'],
    })
    const after = updateRegistry({
      registry: before, segments: [], round: 2,
      present: new Set(['a.ts']), activeUnits: new Set(), order: [],
    })
    expect(after.chapters).toHaveLength(1)
    expect(after.chapters[0]?.status).toBe('empty')
    expect(after.chapters[0]?.lastActiveRound).toBe(1)
  })

  it('成员全被删除时章标 deleted，仍留在册里', () => {
    const before = updateRegistry({
      registry: EMPTY_REGISTRY, segments: [seg('a.ts', ['a.ts'])], round: 1,
      present: new Set(['a.ts']), activeUnits: new Set(['a.ts']), order: ['a.ts'],
    })
    const after = updateRegistry({
      registry: before, segments: [], round: 2,
      present: new Set(), activeUnits: new Set(), order: [],
    })
    expect(after.chapters).toHaveLength(1)
    expect(after.chapters[0]?.status).toBe('deleted')
  })

  it('段首文件被删时 key 顺延，并记下 keyRenamedFrom', () => {
    const before = updateRegistry({
      registry: EMPTY_REGISTRY, segments: [seg('a.ts', ['a.ts', 'b.ts'])], round: 1,
      present: new Set(['a.ts', 'b.ts']), activeUnits: new Set(['a.ts']), order: ['a.ts', 'b.ts'],
    })
    const after = updateRegistry({
      registry: before, segments: [], round: 2,
      present: new Set(['b.ts']), activeUnits: new Set(), order: ['b.ts'],
    })
    expect(after.chapters[0]?.key).toBe('b.ts')
    expect(after.chapters[0]?.keyRenamedFrom).toBe('a.ts')
  })

  it('已在册的文件不会被本轮的 segment 拉到别的章去', () => {
    const before = updateRegistry({
      registry: EMPTY_REGISTRY, segments: [seg('a.ts', ['a.ts', 'b.ts'])], round: 1,
      present: new Set(['a.ts', 'b.ts']), activeUnits: new Set(['a.ts']), order: ['a.ts', 'b.ts'],
    })
    // 第 2 轮算出来的段把 b.ts 划到了另一章——册优先，b.ts 必须留在原章
    const after = updateRegistry({
      registry: before, segments: [seg('a.ts', ['a.ts']), seg('b.ts', ['b.ts'])], round: 2,
      present: new Set(['a.ts', 'b.ts']), activeUnits: new Set(['a.ts']), order: ['a.ts', 'b.ts'],
    })
    expect(after.chapters).toHaveLength(1)
    expect(after.chapters[0]?.members).toEqual(['a.ts', 'b.ts'])
  })

  it('新章按依赖序插到该去的位置，已有章不重排', () => {
    const before = updateRegistry({
      registry: EMPTY_REGISTRY,
      segments: [seg('x/a.ts', ['x/a.ts']), seg('z/c.ts', ['z/c.ts'])],
      round: 1,
      present: new Set(['x/a.ts', 'z/c.ts']),
      activeUnits: new Set(['x/a.ts', 'z/c.ts']),
      order: ['x/a.ts', 'z/c.ts'],
    })
    const after = updateRegistry({
      registry: before,
      segments: [seg('y/b.ts', ['y/b.ts'])],
      round: 2,
      present: new Set(['x/a.ts', 'y/b.ts', 'z/c.ts']),
      activeUnits: new Set(['y/b.ts']),
      order: ['x/a.ts', 'y/b.ts', 'z/c.ts'],
    })
    expect(after.chapters.map((c) => c.key)).toEqual(['x/a.ts', 'y/b.ts', 'z/c.ts'])
    expect(after.chapters.map((c) => c.index)).toEqual([1, 2, 3])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/tests/narrate/registry.test.ts`
Expected: FAIL，`Cannot find module '../../src/narrate/registry.js'`

- [ ] **Step 3: 写实现**

```ts
// packages/core/src/narrate/registry.ts
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Segment } from './segment.js'

export type ChapterStatus = 'active' | 'empty' | 'deleted'

export interface ChapterRecord {
  /** 段首文件的 canonical path */
  key: string
  /** 册内序号，从 1 连续。与 commit 序号不是一回事 */
  index: number
  title: string
  intro: string
  status: ChapterStatus
  /** 累积的成员（canonical path），按依赖序 */
  members: string[]
  /** 段首被删导致 key 顺延时，记下旧 key，好让上层把批注迁过去 */
  keyRenamedFrom: string | null
  createdRound: number
  lastActiveRound: number
}

export interface Registry {
  version: 1
  chapters: ChapterRecord[]
}

export const EMPTY_REGISTRY: Registry = { version: 1, chapters: [] }
export const REGISTRY_FILE = 'registry.json'

export interface UpdateInput {
  registry: Registry
  /** 本轮按依赖序切出来的段。只有**未被册认领**的成员会从这里取 */
  segments: Segment[]
  round: number
  /** 快照里仍然存在的 canonical path */
  present: Set<string>
  /** 本轮真有改动的 canonical 单元。章是否 active 由它的成员是否在这里决定 */
  activeUnits: Set<string>
  /** 本轮的依赖序，用来给新章定位 */
  order: string[]
}

/**
 * 把本轮的切段结果并进册里。**册优先于本轮的重新计算**——
 * 已经在册的文件留在原章，哪怕这一轮算出来该去别处；否则每加一个文件
 * 就可能把一批文件拽到新章，人写的批注全部漂走。
 */
export function updateRegistry(input: UpdateInput): Registry {
  const { registry, segments, round, present, activeUnits, order } = input
  const orderPos = new Map(order.map((path, i) => [path, i]))

  // 1) 已有章：剔掉已删成员，决定状态，必要时顺延 key
  const claimed = new Set<string>()
  const kept: ChapterRecord[] = []
  for (const chapter of registry.chapters) {
    const members = chapter.members.filter((m) => present.has(m))
    for (const m of members) claimed.add(m)

    if (members.length === 0) {
      kept.push({ ...chapter, members: [], status: 'deleted' })
      continue
    }

    const active = members.some((m) => activeUnits.has(m))
    const renamed = !members.includes(chapter.key)
    kept.push({
      ...chapter,
      key: renamed ? (members[0] as string) : chapter.key,
      keyRenamedFrom: renamed ? chapter.key : chapter.keyRenamedFrom,
      members,
      status: active ? 'active' : 'empty',
      lastActiveRound: active ? round : chapter.lastActiveRound,
    })
  }

  // 2) 本轮段里没被册认领的成员 —— 并入同 key 的已有章，否则开新章
  const byKey = new Map(kept.map((c) => [c.key, c]))
  const fresh: ChapterRecord[] = []
  for (const s of segments) {
    const members = s.members.filter((m) => !claimed.has(m))
    if (members.length === 0) continue

    const existing = byKey.get(s.key)
    if (existing !== undefined) {
      // 并入已有章可能让它超过 maxFiles —— 由 chapter-oversized 警告，不在这里拦
      existing.members = [...existing.members, ...members]
      existing.status = 'active'
      existing.lastActiveRound = round
      continue
    }

    fresh.push({
      key: s.key,
      index: 0,
      title: s.title,
      intro: s.intro,
      status: 'active',
      members,
      keyRenamedFrom: null,
      createdRound: round,
      lastActiveRound: round,
    })
  }

  // 3) 新章按依赖序插位；已有章保持相对顺序
  const posOf = (chapter: ChapterRecord): number => {
    let best = Number.POSITIVE_INFINITY
    for (const m of chapter.members) {
      const at = orderPos.get(m)
      if (at !== undefined && at < best) best = at
    }
    return best
  }

  const chapters = [...kept]
  for (const candidate of fresh.sort((a, b) => posOf(a) - posOf(b))) {
    const at = posOf(candidate)
    // 插到第一个「依赖序更靠后」的已有章之前；都更靠前就追加到末尾
    const index = chapters.findIndex((c) => posOf(c) > at)
    if (index < 0) chapters.push(candidate)
    else chapters.splice(index, 0, candidate)
  }

  return {
    version: 1,
    chapters: chapters.map((c, i) => ({ ...c, index: i + 1 })),
  }
}

/** 读册。文件不存在表示这是第一轮，返回空册而不是报错。 */
export async function readRegistry(reviewRoot: string): Promise<Registry> {
  try {
    const text = await readFile(join(reviewRoot, REGISTRY_FILE), 'utf8')
    return JSON.parse(text) as Registry
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_REGISTRY
    throw err
  }
}

export async function writeRegistry(reviewRoot: string, registry: Registry): Promise<void> {
  await writeFile(
    join(reviewRoot, REGISTRY_FILE),
    `${JSON.stringify(registry, null, 2)}\n`,
    'utf8',
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/core/tests/narrate/registry.test.ts`
Expected: PASS（6 个）

- [ ] **Step 5: 变异验证**

把第 2 步里的 `.filter((m) => !claimed.has(m))` 去掉，确认「已在册的文件不会被本轮的
segment 拉到别的章去」变红。再把第 1 步 `members.length === 0` 分支改成 `continue`
（即把空章丢掉），确认「成员全被删除时章标 deleted」变红。都改回来。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/narrate/registry.ts packages/core/tests/narrate/registry.test.ts
git commit -m 'feat(core): 章节册——跨轮持久，删除的模块标 deleted 不消失'
```

---

### Task 6: `anchors.ts` —— 批注锚点迁移与归属钉定

**Files:**
- Create: `packages/core/src/narrate/anchors.ts`
- Test: `packages/core/tests/narrate/anchors.test.ts`

**Interfaces:**
- Consumes: `FileChange`、`Hunk`（`packages/core/src/narrate/diff.ts`，字段见下）
- Produces:
  - `type AnnotationState = 'live' | 'stale' | 'orphaned' | 'unanchored'`
  - `interface Annotation { id: string; chapterKey: string | null; path: string; startLine: number; endLine: number; anchorHash: string; body: string; state: AnnotationState; round: number }`
  - `interface AnnotationFile { version: 1; annotations: Annotation[] }`
  - `const ANNOTATIONS_FILE = 'annotations.json'`
  - `function migrateAnchors(annotations: Annotation[], changes: FileChange[]): Annotation[]`
  - `function pinnedByAnnotations(annotations: Annotation[], changes: FileChange[]): Map<string, string>`
  - `function readAnnotations(reviewRoot: string): Promise<AnnotationFile>`
  - `function writeAnnotations(reviewRoot: string, file: AnnotationFile): Promise<void>`

`Hunk` 的字段：`{ id: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }`。
`FileChange` 的字段：`{ path: string; kind: 'add' | 'modify' | 'delete'; binary: boolean; mode: string; blob: string | null; oldMode: string | null; oldBlob: string | null; hunks: Hunk[] }`。

- [ ] **Step 1: 写失败的测试**

```ts
// packages/core/tests/narrate/anchors.test.ts
import { describe, it, expect } from 'vitest'
import { migrateAnchors, pinnedByAnnotations } from '../../src/narrate/anchors.js'
import type { Annotation } from '../../src/narrate/anchors.js'
import type { FileChange, Hunk } from '../../src/narrate/diff.js'

const hunk = (id: string, oldStart: number, oldLines: number, newStart: number, newLines: number): Hunk =>
  ({ id, oldStart, oldLines, newStart, newLines, lines: [] })

const change = (path: string, hunks: Hunk[], kind: FileChange['kind'] = 'modify'): FileChange => ({
  path, kind, binary: false, mode: '100644', blob: 'b', oldMode: '100644', oldBlob: 'o', hunks,
})

const note = (over: Partial<Annotation> = {}): Annotation => ({
  id: 'n1', chapterKey: 'c1', path: 'a.ts', startLine: 20, endLine: 24,
  anchorHash: 'sha256:x', body: '看这里', state: 'live', round: 1, ...over,
})

describe('migrateAnchors', () => {
  it('文件本轮没动时行号不变', () => {
    const [got] = migrateAnchors([note()], [change('other.ts', [])])
    expect(got).toMatchObject({ startLine: 20, endLine: 24, state: 'live' })
  })

  it('批注之前的 hunk 净增行时，锚点整体下移', () => {
    // 第 1-3 行被换成 6 行 ⇒ 净增 3
    const [got] = migrateAnchors([note()], [change('a.ts', [hunk('a.ts#0', 1, 3, 1, 6)])])
    expect(got).toMatchObject({ startLine: 23, endLine: 27, state: 'live' })
  })

  it('与批注重叠的 hunk 让它变 stale，范围重算成 hunk 的新范围', () => {
    const [got] = migrateAnchors([note()], [change('a.ts', [hunk('a.ts#0', 22, 2, 22, 5)])])
    expect(got).toMatchObject({ startLine: 22, endLine: 26, state: 'stale' })
  })

  it('批注之后的 hunk 不影响锚点', () => {
    const [got] = migrateAnchors([note()], [change('a.ts', [hunk('a.ts#0', 90, 1, 90, 9)])])
    expect(got).toMatchObject({ startLine: 20, endLine: 24, state: 'live' })
  })

  it('文件被删除时批注标 orphaned，但不丢弃', () => {
    const [got] = migrateAnchors([note()], [change('a.ts', [], 'delete')])
    expect(got).toMatchObject({ state: 'orphaned' })
    expect(got?.body).toBe('看这里')
  })

  it('已经 stale 的批注不会因为这一轮没碰它就变回 live', () => {
    const [got] = migrateAnchors([note({ state: 'stale' })], [change('other.ts', [])])
    expect(got?.state).toBe('stale')
  })
})

describe('pinnedByAnnotations', () => {
  it('与批注新范围重叠的 hunk 被钉到批注所在章', () => {
    const got = pinnedByAnnotations([note()], [change('a.ts', [hunk('a.ts#0', 22, 2, 22, 2)])])
    expect(got.get('a.ts#0')).toBe('c1')
  })

  it('不重叠的 hunk 不被钉住', () => {
    const got = pinnedByAnnotations([note()], [change('a.ts', [hunk('a.ts#0', 90, 1, 90, 1)])])
    expect(got.size).toBe(0)
  })

  it('orphaned 的批注不钉任何东西', () => {
    const got = pinnedByAnnotations(
      [note({ state: 'orphaned' })],
      [change('a.ts', [hunk('a.ts#0', 22, 2, 22, 2)])],
    )
    expect(got.size).toBe(0)
  })

  it('两条批注争同一个 hunk 时，按 id 字典序定夺，保证确定性', () => {
    const changes = [change('a.ts', [hunk('a.ts#0', 20, 4, 20, 4)])]
    const a = note({ id: 'b', chapterKey: 'cb' })
    const b = note({ id: 'a', chapterKey: 'ca' })
    expect(pinnedByAnnotations([a, b], changes).get('a.ts#0')).toBe('ca')
    expect(pinnedByAnnotations([b, a], changes).get('a.ts#0')).toBe('ca')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/tests/narrate/anchors.test.ts`
Expected: FAIL，`Cannot find module '../../src/narrate/anchors.js'`

- [ ] **Step 3: 写实现**

```ts
// packages/core/src/narrate/anchors.ts
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileChange } from './diff.js'

export type AnnotationState = 'live' | 'stale' | 'orphaned' | 'unanchored'

export interface Annotation {
  id: string
  /** 批注所在的章；`--reset-chapters` 之后为 null */
  chapterKey: string | null
  path: string
  /** 1 起，闭区间 */
  startLine: number
  endLine: number
  /** 锚定内容的 sha256，供上层判断是否还对得上 */
  anchorHash: string
  body: string
  state: AnnotationState
  /** 产生这条批注的轮次 */
  round: number
}

export interface AnnotationFile {
  version: 1
  annotations: Annotation[]
}

export const ANNOTATIONS_FILE = 'annotations.json'

/**
 * 把批注锚点从上一轮的行号推到本轮。
 *
 * **重叠的锚点标 stale 但绝不丢弃**——「你批注的这段代码被改了」正是 review
 * 最该看见的信号，丢掉它等于把最重要的一条反馈静默吞了。
 */
export function migrateAnchors(
  annotations: Annotation[],
  changes: FileChange[],
): Annotation[] {
  const byPath = new Map(changes.map((c) => [c.path, c]))

  return annotations.map((note) => {
    if (note.state === 'orphaned') return note
    const change = byPath.get(note.path)
    if (change === undefined) return note
    if (change.kind === 'delete') return { ...note, state: 'orphaned' as const }

    const hunks = [...change.hunks].sort((a, b) => a.oldStart - b.oldStart)
    let offset = 0
    for (const h of hunks) {
      const oldEnd = h.oldStart + h.oldLines
      if (oldEnd <= note.startLine) {
        offset += h.newLines - h.oldLines
        continue
      }
      if (h.oldStart <= note.endLine) {
        // 重叠：锚点范围重算成这个 hunk 的新范围
        return {
          ...note,
          startLine: h.newStart,
          endLine: h.newStart + Math.max(h.newLines, 1) - 1,
          state: 'stale' as const,
        }
      }
      break
    }

    return { ...note, startLine: note.startLine + offset, endLine: note.endLine + offset }
  })
}

/**
 * 归属阶梯的第一级：本轮哪些 hunk 应该回到某条批注所在的章。
 *
 * 传入的 annotations 必须是**迁移之后**的——判据用的是新行号。
 * 多条批注争同一个 hunk 时按 id 字典序定夺：谁赢不重要，
 * 重要的是同样的输入永远给同样的答案，否则章节归属会在两轮之间来回跳。
 */
export function pinnedByAnnotations(
  annotations: Annotation[],
  changes: FileChange[],
): Map<string, string> {
  const byPath = new Map(changes.map((c) => [c.path, c]))
  const winner = new Map<string, { id: string; chapterKey: string }>()

  for (const note of [...annotations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (note.state === 'orphaned' || note.chapterKey === null) continue
    const change = byPath.get(note.path)
    if (change === undefined) continue

    for (const h of change.hunks) {
      const newEnd = h.newStart + Math.max(h.newLines, 1) - 1
      if (h.newStart > note.endLine || newEnd < note.startLine) continue
      const held = winner.get(h.id)
      if (held === undefined || note.id < held.id) {
        winner.set(h.id, { id: note.id, chapterKey: note.chapterKey })
      }
    }
  }

  return new Map([...winner].map(([hunkId, held]) => [hunkId, held.chapterKey]))
}

/** 读批注。文件不存在表示还没有任何批注，返回空表而不是报错。 */
export async function readAnnotations(reviewRoot: string): Promise<AnnotationFile> {
  try {
    const text = await readFile(join(reviewRoot, ANNOTATIONS_FILE), 'utf8')
    return JSON.parse(text) as AnnotationFile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, annotations: [] }
    throw err
  }
}

export async function writeAnnotations(
  reviewRoot: string,
  file: AnnotationFile,
): Promise<void> {
  await writeFile(
    join(reviewRoot, ANNOTATIONS_FILE),
    `${JSON.stringify(file, null, 2)}\n`,
    'utf8',
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/core/tests/narrate/anchors.test.ts`
Expected: PASS（10 个）

- [ ] **Step 5: 变异验证**

把 `migrateAnchors` 里重叠分支的 `state: 'stale'` 改成 `'live'`，确认对应测试变红。
再把 `pinnedByAnnotations` 里的 `.sort(...)` 去掉，确认「两条批注争同一个 hunk」变红
（它正反两种输入顺序各跑一次，正是为了逼出这个）。都改回来。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/narrate/anchors.ts packages/core/tests/narrate/anchors.test.ts
git commit -m 'feat(core): 批注锚点迁移，被改动的锚点标 stale 不丢弃'
```

---

### Task 7: `rules.ts` 换成 v2，删掉枚举层

**Files:**
- Modify: `packages/core/src/narrate/rules.ts`（整体重写）
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/package.json`（若 picomatch 已无人使用则移除）
- Test: `packages/core/tests/narrate/rules.test.ts`（整体重写）

**Interfaces:**
- Consumes: Task 1 的 `PairRules`、`DEFAULT_PAIR_RULES`；Task 2 的 `SCANNER_VERSION`
- Produces:
  - `interface NarrativeRules { version: 2; maxFiles: number; pair: PairRules; order: string[]; titles: Record<string, { title?: string; intro?: string }> }`
  - `const DEFAULT_RULES: NarrativeRules`
  - `function validateRules(raw: unknown): NarrativeRules`
  - `function rulesFingerprint(rules: NarrativeRules): string`
  - `function loadRules(opts: { repo: string; explicitPath?: string }): Promise<NarrativeRules>`
  - `const REPO_RULES_PATH: string`
- **删除**：`LayerRule`、`classifyPath`、旧的四层 `DEFAULT_RULES`

- [ ] **Step 1: 写失败的测试**

把 `packages/core/tests/narrate/rules.test.ts` 整个替换成：

```ts
import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_RULES, REPO_RULES_PATH, loadRules, rulesFingerprint, validateRules,
} from '../../src/narrate/rules.js'

describe('validateRules', () => {
  it('接受一份最小配置，缺省项补成默认', () => {
    const got = validateRules({ version: 2 })
    expect(got.maxFiles).toBe(DEFAULT_RULES.maxFiles)
    expect(got.order).toEqual([])
    expect(got.pair.dirs.length).toBeGreaterThan(0)
  })

  it('v1 配置明确报错并给迁移指引，不做静默转换', () => {
    expect(() => validateRules({ version: 1, fallback: 'core', layers: [] }))
      .toThrow(/version 1 的叙事规则已不再支持/)
  })

  it('maxFiles 必须是正整数', () => {
    expect(() => validateRules({ version: 2, maxFiles: 0 })).toThrow(/maxFiles/)
    expect(() => validateRules({ version: 2, maxFiles: 1.5 })).toThrow(/maxFiles/)
  })

  it('order 必须是字符串数组', () => {
    expect(() => validateRules({ version: 2, order: 'src' })).toThrow(/order/)
  })
})

describe('rulesFingerprint', () => {
  it('改 maxFiles 会换指纹', () => {
    expect(rulesFingerprint({ ...DEFAULT_RULES, maxFiles: 9 }))
      .not.toBe(rulesFingerprint(DEFAULT_RULES))
  })

  it('改 order 会换指纹', () => {
    expect(rulesFingerprint({ ...DEFAULT_RULES, order: ['src'] }))
      .not.toBe(rulesFingerprint(DEFAULT_RULES))
  })

  it('改 titles 不换指纹——改文案不该让上一轮的批注失效', () => {
    expect(rulesFingerprint({ ...DEFAULT_RULES, titles: { 'a.ts': { title: '新标题' } } }))
      .toBe(rulesFingerprint(DEFAULT_RULES))
  })
})

describe('loadRules', () => {
  it('仓库内没有配置时用内置默认', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unfold-rules-'))
    expect(await loadRules({ repo: dir })).toEqual(DEFAULT_RULES)
  })

  it('读仓库内的配置', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unfold-rules-'))
    await mkdir(join(dir, '.unfold'), { recursive: true })
    await writeFile(join(dir, REPO_RULES_PATH), JSON.stringify({ version: 2, maxFiles: 3 }))
    expect((await loadRules({ repo: dir })).maxFiles).toBe(3)
  })

  it('--rules 指定的文件找不到时抛错，不静默退回默认', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unfold-rules-'))
    await expect(loadRules({ repo: dir, explicitPath: join(dir, 'nope.json') }))
      .rejects.toThrow(/读不到叙事规则文件/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/tests/narrate/rules.test.ts`
Expected: FAIL，多条——`validateRules({version: 2})` 抛「version 必须是 1」。

- [ ] **Step 3: 写实现**

把 `packages/core/src/narrate/rules.ts` 整个替换成：

```ts
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_PAIR_RULES } from './pair.js'
import { SCANNER_VERSION } from './deps.js'
import type { PairRules } from './pair.js'

/**
 * 叙事规则。**不再枚举章节**——章节由依赖序切段自动派生，配置只给三样东西：
 * 切段的粒度（maxFiles）、测试怎么配对（pair）、顺序怎么覆盖（order），
 * 外加纯文案的 titles。
 */
export interface NarrativeRules {
  version: 2
  /** 一章最多多少个真实文件，超了必断。默认 8 */
  maxFiles: number
  pair: PairRules
  /** 路径前缀，命中的整体排到最前，按给定顺序；桶内仍走依赖序 */
  order: string[]
  /** 按章节 key 覆盖自动生成的标题与导语 */
  titles: Record<string, { title?: string; intro?: string }>
}

export const DEFAULT_RULES: NarrativeRules = {
  version: 2,
  maxFiles: 8,
  pair: DEFAULT_PAIR_RULES,
  order: [],
  titles: {},
}

function fail(message: string): never {
  throw new Error(`叙事规则配置有误：${message}`)
}

/**
 * 校验并归一化。缺省项补成默认值，**但错误的项一律抛错**——静默退回默认
 * 会让人以为在测新配置、实际跑的是旧的。
 */
export function validateRules(raw: unknown): NarrativeRules {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('配置根必须是一个对象')
  }
  const root = raw as Record<string, unknown>

  if (root['version'] === 1) {
    fail(
      'version 1 的叙事规则已不再支持。v1 把章节按文件种类横切成预先枚举的层，' +
        'v2 改为按依赖序自动派生章节。迁移：删掉 layers/fallback，' +
        '改写成 { "version": 2, "maxFiles": 8 }，需要固定顺序时用 order 列目录前缀。',
    )
  }
  if (root['version'] !== 2) {
    fail(`version 必须是 2，收到 ${JSON.stringify(root['version'])}`)
  }

  let maxFiles = DEFAULT_RULES.maxFiles
  if (root['maxFiles'] !== undefined) {
    const value = root['maxFiles']
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      fail(`maxFiles 必须是正整数，收到 ${JSON.stringify(value)}`)
    }
    maxFiles = value
  }

  let order: string[] = []
  if (root['order'] !== undefined) {
    const value = root['order']
    if (!Array.isArray(value) || value.some((p) => typeof p !== 'string' || p === '')) {
      fail('order 必须是非空字符串组成的数组（路径前缀）')
    }
    order = value as string[]
  }

  let pair: PairRules = DEFAULT_PAIR_RULES
  if (root['pair'] !== undefined) {
    const value = root['pair'] as Record<string, unknown>
    if (typeof value !== 'object' || value === null) fail('pair 必须是一个对象')
    const dirs = value['dirs'] ?? DEFAULT_PAIR_RULES.dirs
    const suffixes = value['suffixes'] ?? DEFAULT_PAIR_RULES.suffixes
    if (
      !Array.isArray(dirs) ||
      dirs.some((d) => !Array.isArray(d) || d.length !== 2 || d.some((s) => typeof s !== 'string'))
    ) {
      fail('pair.dirs 必须是 [from, to] 字符串对组成的数组')
    }
    if (!Array.isArray(suffixes) || suffixes.some((s) => typeof s !== 'string')) {
      fail('pair.suffixes 必须是字符串数组')
    }
    pair = { dirs: dirs as Array<[string, string]>, suffixes: suffixes as string[] }
  }

  let titles: NarrativeRules['titles'] = {}
  if (root['titles'] !== undefined) {
    const value = root['titles']
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      fail('titles 必须是一个对象')
    }
    titles = value as NarrativeRules['titles']
  }

  return { version: 2, maxFiles, pair, order, titles }
}

/**
 * 规则指纹：**只覆盖能改变章节划分或顺序的部分**。
 *
 * 扫描器版本进指纹——换了 import 扫描规则就是换了排序依据，
 * 不进去的话上一轮的顺序会被当成仍然有效。
 * `titles` 不进：改文案是最常见的微调，没有任何文件换章，
 * 不该让上一轮的批注失效。
 */
export function rulesFingerprint(rules: NarrativeRules): string {
  const semantic = {
    scanner: SCANNER_VERSION,
    maxFiles: rules.maxFiles,
    order: rules.order,
    pair: { dirs: rules.pair.dirs, suffixes: rules.pair.suffixes },
  }
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex').slice(0, 12)
}

export interface LoadRulesOptions {
  repo: string
  /** `--rules <file>`；给了就用它，找不到直接抛错 */
  explicitPath?: string
}

/** 仓库内配置的固定位置。它**应该被提交**，所以不能进 .gitignore。 */
export const REPO_RULES_PATH = join('.unfold', 'narrative.json')

async function readRulesFile(path: string): Promise<NarrativeRules> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    throw new Error(`读不到叙事规则文件：${path}（${(err as Error).message}）`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`叙事规则文件不是合法 JSON：${path}（${(err as Error).message}）`)
  }
  return validateRules(parsed)
}

/** 优先级：`--rules <file>` → `<repo>/.unfold/narrative.json` → 内置默认。整份替换，不合并。 */
export async function loadRules(opts: LoadRulesOptions): Promise<NarrativeRules> {
  if (opts.explicitPath !== undefined) return readRulesFile(opts.explicitPath)

  const repoRules = join(opts.repo, REPO_RULES_PATH)
  try {
    await readFile(repoRules, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_RULES
    throw err
  }
  return readRulesFile(repoRules)
}
```

- [ ] **Step 4: 更新 `index.ts` 的导出**

把 `packages/core/src/index.ts:12-20` 那段改成：

```ts
export { DEFAULT_RULES, REPO_RULES_PATH, loadRules, rulesFingerprint, validateRules } from './narrate/rules.js'
export type { NarrativeRules, LoadRulesOptions } from './narrate/rules.js'
export { DEFAULT_PAIR_RULES, canonicalCandidates, canonicalPath } from './narrate/pair.js'
export type { PairRules } from './narrate/pair.js'
export { SCANNER_VERSION, buildDepGraph, languageOf, scanImports } from './narrate/deps.js'
export type { DepGraph, SourceLang } from './narrate/deps.js'
export { topoOrder } from './narrate/order.js'
export type { OrderResult } from './narrate/order.js'
export { segment } from './narrate/segment.js'
export type { Segment, SegmentInput } from './narrate/segment.js'
export { EMPTY_REGISTRY, REGISTRY_FILE, readRegistry, updateRegistry, writeRegistry } from './narrate/registry.js'
export type { ChapterRecord, ChapterStatus, Registry, UpdateInput } from './narrate/registry.js'
export { ANNOTATIONS_FILE, migrateAnchors, pinnedByAnnotations, readAnnotations, writeAnnotations } from './narrate/anchors.js'
export type { Annotation, AnnotationFile, AnnotationState } from './narrate/anchors.js'
```

- [ ] **Step 5: 清掉 picomatch**

```bash
grep -rn "picomatch" packages/core/src packages/core/tests
```

若没有任何命中，从 `packages/core/package.json` 的 `dependencies` 删掉 `picomatch`，
从 `devDependencies` 删掉 `@types/picomatch`，然后 `pnpm install`。
若仍有命中，保留依赖，不要动 package.json。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm exec vitest run packages/core/tests/narrate/rules.test.ts && pnpm -r typecheck`
Expected: rules 测试全绿。`typecheck` 会在 `rule-planner.ts` / `build-plan.ts` /
`validate.ts` 上报错（它们还在用已删除的 `classifyPath` 与 `LayerRule`）——
**这是预期的**，Task 8、9 负责修掉。把报错清单记进本任务的报告里。

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/narrate/rules.ts packages/core/src/index.ts packages/core/tests/narrate/rules.test.ts
git commit -m 'feat(core)!: 叙事规则换成 v2，删掉预先枚举的层'
```

若这一步改了 package.json / pnpm-lock.yaml，一并显式 `git add` 上去。

---

### Task 8: 归属阶梯与 `buildPlan` 重写

**Files:**
- Modify: `packages/core/src/narrate/plan.ts`
- Modify: `packages/core/src/narrate/build-plan.ts`（整体重写）
- Modify: `packages/core/src/narrate/rule-planner.ts`（整体重写）
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/narrate/build-plan.test.ts`（整体重写）、`packages/core/tests/narrate/rule-planner.test.ts`（整体重写）

**Interfaces:**
- Consumes: Task 4 `Segment`、Task 5 `Registry`/`ChapterRecord`/`ChapterStatus`、Task 7 `NarrativeRules`
- Produces:
  - `Chapter` 新增 `status: ChapterStatus`、`commitIndex: number | null`、`keyRenamedFrom: string | null`
  - `interface Assignment { byChapter: Map<string, string>; proposed?: Map<string, { title: string; intro: string }>; intros?: Map<string, string> }`
  - `PlanContext` 新增 `canonical: Map<string, string>`、`registry: Registry`、`pinned: Map<string, string>`、`deps: Map<string, Set<string>>`
  - `function buildPlan(ctx: PlanContext, assignment: Assignment, plannerId: string): Plan`
  - `class RulePlanner implements ChapterPlanner`，新增构造参数 `segments: Segment[]`

- [ ] **Step 1: 改类型**

`packages/core/src/narrate/plan.ts`：

```ts
import type { FileChange } from './diff.js'
import type { NarrativeRules } from './rules.js'
import type { ChapterStatus, Registry } from './registry.js'

export interface Chapter {
  /** 册内序号，从 1 起连续（含 empty 与 deleted 章） */
  index: number
  /**
   * 本轮 commit 序号，从 1 起连续。**没有任何改动的章为 null**——
   * 册里可能有 20 章而本轮只动了 3 章，不能产 17 个空 commit。
   */
  commitIndex: number | null
  /** 段首文件的 canonical path，跨轮锚点 */
  key: string
  title: string
  intro: string
  status: ChapterStatus
  /** 段首被删导致 key 顺延时的旧 key，供上层迁移批注 */
  keyRenamedFrom: string | null
  hunkIds: string[]
  filePaths: string[]
}

export interface Plan {
  version: 1
  rulesFingerprint: string
  base: string
  snapshot: string
  plannerId: string
  chapters: Chapter[]
}

export interface PlanContext {
  base: string
  snapshot: string
  changes: FileChange[]
  rules: NarrativeRules
  /** 真实路径 → canonical path（测试已规约到实现） */
  canonical: Map<string, string>
  /** 本轮更新后的章节册 */
  registry: Registry
  /** 归属阶梯第一级：hunkId → 批注所在的章 key */
  pinned: Map<string, string>
  /** canonical 单元之间的依赖边，供 chapter-backward-dep 检查 */
  deps: Map<string, Set<string>>
  previous?: Plan
}

/**
 * planner 的产出：**只回答增量归属**。
 *
 * 阶梯的前两级（批注钉定、册沿用）由 TS 先算完，直接从 planner 的取值域里
 * 拿掉——存量归属不容商量，planner 只对本轮新出现的单元表态。
 */
export interface Assignment {
  /** canonical 单元 → 章 key */
  byChapter: Map<string, string>
  /** 提议的新章。byChapter 里出现的、册中没有的 key 必须在这里声明 */
  proposed?: Map<string, { title: string; intro: string }>
  /** 本轮定制的导语，按章 key 覆盖 */
  intros?: Map<string, string>
}

export interface ChapterPlanner {
  readonly id: string
  assign(ctx: PlanContext): Promise<Assignment>
}
```

- [ ] **Step 2: 写失败的测试**

把 `packages/core/tests/narrate/build-plan.test.ts` 整个替换成：

```ts
import { describe, it, expect } from 'vitest'
import { buildPlan } from '../../src/narrate/build-plan.js'
import { DEFAULT_RULES } from '../../src/narrate/rules.js'
import type { PlanContext } from '../../src/narrate/plan.js'
import type { Registry } from '../../src/narrate/registry.js'
import type { FileChange, Hunk } from '../../src/narrate/diff.js'

const hunk = (id: string): Hunk => ({ id, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] })
const change = (path: string, hunkIds: string[]): FileChange => ({
  path, kind: 'modify', binary: false, mode: '100644', blob: 'b',
  oldMode: '100644', oldBlob: 'o', hunks: hunkIds.map(hunk),
})

const registry = (chapters: Array<Partial<Registry['chapters'][number]>>): Registry => ({
  version: 1,
  chapters: chapters.map((c, i) => ({
    key: `k${i}`, index: i + 1, title: `T${i}`, intro: `I${i}`, status: 'active',
    members: [], keyRenamedFrom: null, createdRound: 1, lastActiveRound: 1, ...c,
  })),
})

const ctx = (over: Partial<PlanContext>): PlanContext => ({
  base: 'b', snapshot: 's', changes: [], rules: DEFAULT_RULES,
  canonical: new Map(), registry: registry([]), pinned: new Map(), deps: new Map(), ...over,
})

describe('buildPlan', () => {
  it('章节顺序与册一致，index 含空章、commitIndex 只数有内容的章', () => {
    const plan = buildPlan(ctx({
      changes: [change('a.ts', ['a.ts#0'])],
      canonical: new Map([['a.ts', 'a.ts']]),
      registry: registry([
        { key: 'a.ts', members: ['a.ts'], status: 'active' },
        { key: 'gone.ts', members: [], status: 'deleted' },
      ]),
    }), { byChapter: new Map() }, 'test')

    expect(plan.chapters.map((c) => c.index)).toEqual([1, 2])
    expect(plan.chapters.map((c) => c.commitIndex)).toEqual([1, null])
    expect(plan.chapters[1]?.status).toBe('deleted')
  })

  it('批注钉住的 hunk 回到批注所在章，哪怕它的文件归别的章', () => {
    const plan = buildPlan(ctx({
      changes: [change('a.ts', ['a.ts#0', 'a.ts#1'])],
      canonical: new Map([['a.ts', 'a.ts']]),
      registry: registry([
        { key: 'note.ts', members: ['note.ts'] },
        { key: 'a.ts', members: ['a.ts'] },
      ]),
      pinned: new Map([['a.ts#0', 'note.ts']]),
    }), { byChapter: new Map() }, 'test')

    expect(plan.chapters[0]?.hunkIds).toEqual(['a.ts#0'])
    expect(plan.chapters[1]?.hunkIds).toEqual(['a.ts#1'])
  })

  it('文件落在「它最后一个 hunk 所在的章」，replay 靠这条达到终态', () => {
    const plan = buildPlan(ctx({
      changes: [change('a.ts', ['a.ts#0', 'a.ts#1'])],
      canonical: new Map([['a.ts', 'a.ts']]),
      registry: registry([
        { key: 'note.ts', members: ['note.ts'] },
        { key: 'a.ts', members: ['a.ts'] },
      ]),
      pinned: new Map([['a.ts#1', 'note.ts']]),
    }), { byChapter: new Map() }, 'test')

    // 最后一个 hunk 被钉到第 1 章 ⇒ 文件在第 1 章达到终态
    expect(plan.chapters[0]?.filePaths).toEqual(['a.ts'])
    expect(plan.chapters[1]?.filePaths).toEqual([])
  })

  it('测试文件跟着它的实现进同一章', () => {
    const plan = buildPlan(ctx({
      changes: [change('src/a.ts', ['src/a.ts#0']), change('tests/a.test.ts', ['tests/a.test.ts#0'])],
      canonical: new Map([['src/a.ts', 'src/a.ts'], ['tests/a.test.ts', 'src/a.ts']]),
      registry: registry([{ key: 'src/a.ts', members: ['src/a.ts'] }]),
    }), { byChapter: new Map() }, 'test')

    expect(plan.chapters[0]?.filePaths).toEqual(['src/a.ts', 'tests/a.test.ts'])
  })

  it('有文件没被任何章认领时抛错，指名是哪个', () => {
    expect(() => buildPlan(ctx({
      changes: [change('orphan.ts', ['orphan.ts#0'])],
      canonical: new Map([['orphan.ts', 'orphan.ts']]),
      registry: registry([{ key: 'a.ts', members: ['a.ts'] }]),
    }), { byChapter: new Map() }, 'test')).toThrow(/orphan\.ts/)
  })

  it('rules.titles 覆盖自动生成的标题', () => {
    const plan = buildPlan(ctx({
      changes: [change('a.ts', ['a.ts#0'])],
      canonical: new Map([['a.ts', 'a.ts']]),
      registry: registry([{ key: 'a.ts', members: ['a.ts'] }]),
      rules: { ...DEFAULT_RULES, titles: { 'a.ts': { title: '手写的标题' } } },
    }), { byChapter: new Map() }, 'test')

    expect(plan.chapters[0]?.title).toBe('手写的标题')
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/tests/narrate/build-plan.test.ts`
Expected: FAIL，类型/运行时错误——`buildPlan` 还是旧签名。

- [ ] **Step 4: 重写 `build-plan.ts`**

```ts
// packages/core/src/narrate/build-plan.ts
import { hunkPath } from './diff.js'
import { rulesFingerprint } from './rules.js'
import type { Assignment, Chapter, Plan, PlanContext } from './plan.js'

/**
 * 把册装配成完整的 Plan。
 *
 * 归属阶梯在这里落地：`ctx.pinned` 是第一级（批注钉定），`ctx.registry.members`
 * 是第二级（册沿用），`assignment.byChapter` 是第三级（planner 对增量的表态）。
 * 前两级已经由 run.ts 算完，这里只负责按册的顺序装配与校验。
 *
 * 漏分配的文件**抛错**而不是悄悄补进某一章——planner 漏了文件是它出错了，
 * 该被发现（spec §7.2）。
 */
export function buildPlan(
  ctx: PlanContext,
  assignment: Assignment,
  plannerId: string,
): Plan {
  // canonical 单元 → 章 key：册优先，其次是 planner 的表态
  const chapterOfUnit = new Map<string, string>()
  for (const chapter of ctx.registry.chapters) {
    for (const member of chapter.members) chapterOfUnit.set(member, chapter.key)
  }
  for (const [unit, key] of assignment.byChapter) {
    if (!chapterOfUnit.has(unit)) chapterOfUnit.set(unit, key)
  }

  const known = new Set(ctx.registry.chapters.map((c) => c.key))
  for (const [unit, key] of chapterOfUnit) {
    if (!known.has(key)) {
      throw new Error(
        `planner「${plannerId}」把 ${unit} 分到了册里不存在的章「${key}」` +
          `（册里的章：${[...known].join(', ')}）`,
      )
    }
  }

  // 每个 hunk 归哪一章：批注钉定优先，否则跟它的文件走
  const chapterOfPath = (path: string): string | undefined => {
    const unit = ctx.canonical.get(path) ?? path
    return chapterOfUnit.get(unit)
  }

  const missing = ctx.changes.map((c) => c.path).filter((p) => chapterOfPath(p) === undefined)
  if (missing.length > 0) {
    throw new Error(
      `有 ${missing.length} 个文件没有被任何章认领：${missing.join(', ')}`,
    )
  }

  const hunksByChapter = new Map<string, string[]>()
  const filesByChapter = new Map<string, string[]>()
  for (const key of known) {
    hunksByChapter.set(key, [])
    filesByChapter.set(key, [])
  }

  for (const change of ctx.changes) {
    const fallback = chapterOfPath(change.path) as string
    let lastChapter = fallback
    for (const h of change.hunks) {
      const key = ctx.pinned.get(h.id) ?? fallback
      if (!known.has(key)) {
        throw new Error(`批注把 hunk ${h.id} 钉到了册里不存在的章「${key}」`)
      }
      hunksByChapter.get(key)?.push(h.id)
      lastChapter = key
    }
    // 文件在「它最后一个 hunk 所在的章」达到终态；无 hunk 的文件（二进制、
    // 仅 mode 变更）落在它自己的章。replay 依赖这条，改动它会破坏字节一致。
    filesByChapter.get(lastChapter)?.push(change.path)
  }

  let commitIndex = 0
  const chapters: Chapter[] = ctx.registry.chapters.map((record, i) => {
    const hunkIds = hunksByChapter.get(record.key) ?? []
    const filePaths = filesByChapter.get(record.key) ?? []
    const hasContent = hunkIds.length > 0 || filePaths.length > 0
    if (hasContent) commitIndex += 1
    const override = ctx.rules.titles[record.key]
    return {
      index: i + 1,
      commitIndex: hasContent ? commitIndex : null,
      key: record.key,
      title: override?.title ?? record.title,
      intro: assignment.intros?.get(record.key) ?? override?.intro ?? record.intro,
      // 册里标 active、但本轮该章的 hunk 全被批注钉去了别处时，不能跟着册说
      // 'active'——那会产出 status: 'active' 却 commitIndex: null 的自相矛盾章节
      status: hasContent ? 'active' : record.status === 'deleted' ? 'deleted' : 'empty',
      keyRenamedFrom: record.keyRenamedFrom,
      hunkIds,
      filePaths,
    }
  })

  return {
    version: 1,
    base: ctx.base,
    snapshot: ctx.snapshot,
    plannerId,
    rulesFingerprint: rulesFingerprint(ctx.rules),
    chapters,
  }
}

/** 仅为可读性导出：从 hunk id 还原文件路径（与 replay / codetour 同一实现）。 */
export { hunkPath }
```

- [ ] **Step 5: 重写 `rule-planner.ts`**

```ts
// packages/core/src/narrate/rule-planner.ts
import type { Assignment, ChapterPlanner, PlanContext } from './plan.js'
import type { Segment } from './segment.js'

/**
 * 确定性的规则 planner：把切段结果原样交出去。
 *
 * 它不再自己做分类——分组、定序、切段都在 pipeline 里完成了，
 * planner 只负责把「这些新单元归哪一章」这个答案交出来。
 * spec §9.2 里它同时是 AI 不可用时的兜底；两者产出同一种 Assignment，
 * 从 AI 回落到规则不会让任何文件换章。
 */
export class RulePlanner implements ChapterPlanner {
  readonly id = 'rule'

  constructor(private readonly segments: Segment[]) {}

  async assign(_ctx: PlanContext): Promise<Assignment> {
    const byChapter = new Map<string, string>()
    const proposed = new Map<string, { title: string; intro: string }>()
    for (const s of this.segments) {
      proposed.set(s.key, { title: s.title, intro: s.intro })
      for (const member of s.members) byChapter.set(member, s.key)
    }
    return { byChapter, proposed }
  }
}
```

对应把 `packages/core/tests/narrate/rule-planner.test.ts` 整个替换成：

```ts
import { describe, it, expect } from 'vitest'
import { RulePlanner } from '../../src/narrate/rule-planner.js'
import { DEFAULT_RULES } from '../../src/narrate/rules.js'
import { EMPTY_REGISTRY } from '../../src/narrate/registry.js'
import type { PlanContext } from '../../src/narrate/plan.js'

const ctx: PlanContext = {
  base: 'b', snapshot: 's', changes: [], rules: DEFAULT_RULES,
  canonical: new Map(), registry: EMPTY_REGISTRY, pinned: new Map(), deps: new Map(),
}

describe('RulePlanner', () => {
  it('把每个段成员映射到段 key，并声明该段为提议的新章', async () => {
    const planner = new RulePlanner([
      { key: 'a.ts', members: ['a.ts', 'b.ts'], title: 'T', intro: 'I' },
    ])
    const got = await planner.assign(ctx)
    expect([...got.byChapter]).toEqual([['a.ts', 'a.ts'], ['b.ts', 'a.ts']])
    expect(got.proposed?.get('a.ts')).toEqual({ title: 'T', intro: 'I' })
  })

  it('没有段时给出空归属，而不是抛错', async () => {
    expect((await new RulePlanner([]).assign(ctx)).byChapter.size).toBe(0)
  })
})
```

- [ ] **Step 6: 补齐所有 `Chapter` 字面量**

`Chapter` 新增了三个必填字段（`commitIndex` / `status` / `keyRenamedFrom`），
所有构造 `Chapter` 字面量的地方都会 typecheck 失败。逐个补上：

```bash
pnpm -r typecheck 2>&1 | grep -E "commitIndex|status|keyRenamedFrom"
```

已知的点：`packages/core/tests/narrate/compare.test.ts`、
`packages/core/tests/narrate/replay.test.ts`、
`packages/core/tests/narrate/validate.test.ts`、
`packages/core/tests/tour/codetour.test.ts`、
`packages/core/tests/bin/report.test.ts`。

补的值一律用「这一章有内容」的形态：`commitIndex` 按它在该 fixture 里的位置从 1 起，
`status: 'active'`，`keyRenamedFrom: null`。**不要**顺手改这些测试的断言——
它们测的是各自模块的既有行为，这一步只是让类型过得去。

- [ ] **Step 7: 更新 `index.ts`**

把 `export type { Assignment, Chapter, ChapterPlanner, Plan, PlanContext }` 一行保留不动
（类型名没变），确认 `pnpm -r typecheck` 在 `validate.ts` 之外不再报错。

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm exec vitest run packages/core/tests/narrate/build-plan.test.ts packages/core/tests/narrate/rule-planner.test.ts`
Expected: PASS（8 个）

- [ ] **Step 9: 变异验证**

把 `buildPlan` 里 `const key = ctx.pinned.get(h.id) ?? fallback` 改成 `const key = fallback`，
确认「批注钉住的 hunk 回到批注所在章」变红。再把 `filesByChapter.get(lastChapter)` 改成
`filesByChapter.get(fallback)`，确认「文件落在它最后一个 hunk 所在的章」变红。都改回来。

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/narrate/plan.ts packages/core/src/narrate/build-plan.ts packages/core/src/narrate/rule-planner.ts packages/core/tests/narrate/build-plan.test.ts packages/core/tests/narrate/rule-planner.test.ts
git commit -m 'feat(core): 归属阶梯——批注钉定 > 册沿用 > 依赖序切段'
```

---

### Task 9: `validate.ts` 分级与章节体检

**Files:**
- Modify: `packages/core/src/narrate/validate.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/narrate/validate.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `Chapter`、`PlanContext`
- Produces:
  - `ValidationIssue` 新增 `severity: 'error' | 'warn'`
  - `ValidationCode` 新增 `'chapter-key-duplicated' | 'chapter-no-test' | 'chapter-test-only' | 'chapter-oversized' | 'chapter-backward-dep'`

- [ ] **Step 1: 写失败的测试（追加到现有文件末尾，并给已有断言补上 severity）**

```ts
// 追加到 packages/core/tests/narrate/validate.test.ts
describe('章节体检', () => {
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

  it('只有测试没有实现时报 chapter-test-only', () => {
    const issues = validatePlan(
      { ...base, chapters: [chapter({ filePaths: ['tests/a.test.ts'] })] },
      ctx({
        changes: [mkChange('tests/a.test.ts')],
        canonical: new Map([['tests/a.test.ts', 'src/a.ts']]),
      }),
    )
    expect(issues.find((i) => i.code === 'chapter-test-only')?.severity).toBe('warn')
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
})
```

测试文件顶部需要的 helper（若已有同名的就复用）：

```ts
import type { Chapter, PlanContext } from '../../src/narrate/plan.js'
import type { FileChange } from '../../src/narrate/diff.js'
import { DEFAULT_RULES } from '../../src/narrate/rules.js'
import { EMPTY_REGISTRY } from '../../src/narrate/registry.js'

const mkChange = (path: string): FileChange => ({
  path, kind: 'modify', binary: false, mode: '100644', blob: 'b',
  oldMode: '100644', oldBlob: 'o', hunks: [],
})

const ctx = (over: Partial<PlanContext>): PlanContext => ({
  base: 'b', snapshot: 's', changes: [], rules: DEFAULT_RULES,
  canonical: new Map(), registry: EMPTY_REGISTRY, pinned: new Map(), deps: new Map(), ...over,
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/tests/narrate/validate.test.ts`
Expected: FAIL——`severity` 不存在、新 code 一条都没有。

- [ ] **Step 3: 改实现**

在 `packages/core/src/narrate/validate.ts` 里：

1. `ValidationCode` 补上五个新码。
2. `ValidationIssue` 加 `severity: 'error' | 'warn'`，已有的 push 全部补 `severity: 'error'`。
3. `chapter-index` 的检查改成只看 `index`（`commitIndex` 另检：只在有内容的章上从 1 连续）。
4. 追加这段：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/core/tests/narrate/validate.test.ts`
Expected: PASS

- [ ] **Step 5: 变异验证**

把 `chapter-no-test` 的 `severity` 从 `'warn'` 改成 `'error'`，确认
「有实现没测试只是警告，不是错误」那条变红（它显式断言了没有任何 error）。改回来。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/narrate/validate.ts packages/core/src/index.ts packages/core/tests/narrate/validate.test.ts
git commit -m 'feat(core): 校验分级——章节体检是警告，字节一致仍是硬闸'
```

---

### Task 10: `run.ts` 接上整条 pipeline，`replay` 跳过无内容的章

**Files:**
- Modify: `packages/core/src/narrate/run.ts`（`prepare` 与 `narrate` 大改）
- Modify: `packages/core/src/narrate/replay.ts:43`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/narrate/run.test.ts`、`packages/core/tests/narrate/replay.test.ts`

**Interfaces:**
- Consumes: Task 1–9 的全部导出
- Produces:
  - `NarrateOptions` 新增 `resetChapters?: true`
  - `NarrateChanges` 新增 `warnings: ValidationIssue[]`、`registryChapters: number`、`depGraph: DepGraph`、`cycles: string[][]`
  - `PlanOnlyResult` 的 `hasChanges: true` 分支新增同样四个字段

- [ ] **Step 1: `replay` 跳过无内容的章**

`packages/core/src/narrate/replay.ts`，在 `for (const chapter of plan.chapters) {` 之后立刻插入：

```ts
      // 册里可能有 20 章而本轮只动了 3 章。没有任何内容的章不产 commit——
      // 否则叙事分支上会挂一长串空 commit，把真正要读的东西淹掉。
      if (chapter.hunkIds.length === 0 && chapter.filePaths.length === 0) continue
```

- [ ] **Step 2: 写失败的测试**

追加到 `packages/core/tests/narrate/replay.test.ts`：

```ts
it('没有内容的章不产 commit，但后面的章仍接在前一个 commit 上', async () => {
  const repo = await createTempRepo()
  await repo.write('a.ts', 'one\n')
  const base = await repo.commit('base')
  await repo.write('a.ts', 'two\n')

  const changes = await computeChanges(repo.dir, base, await snapshotCommit(repo))
  const plan: Plan = {
    version: 1, rulesFingerprint: 'f', base, snapshot: await snapshotCommit(repo), plannerId: 'test',
    chapters: [
      { index: 1, commitIndex: null, key: 'empty', title: '空章', intro: '', status: 'empty',
        keyRenamedFrom: null, hunkIds: [], filePaths: [] },
      { index: 2, commitIndex: 1, key: 'a.ts', title: 'a', intro: '', status: 'active',
        keyRenamedFrom: null, hunkIds: changes[0]!.hunks.map((h) => h.id), filePaths: ['a.ts'] },
    ],
  }

  const result = await replay(repo.dir, plan, changes)
  expect(result.commits).toHaveLength(1)
  expect(await repo.git('rev-parse', `${result.tip}^`)).toBe(base)
  await repo.cleanup()
})
```

`snapshotCommit` 用该文件里已有的建快照方式；若没有，用
`import { snapshot } from '../../src/git/snapshot.js'` 后取 `.commit`。

- [ ] **Step 3: 跑测试确认失败，再跑一次确认通过**

Run: `pnpm exec vitest run packages/core/tests/narrate/replay.test.ts`
先确认新用例红（`commits` 长度是 2），加上 Step 1 的 `continue` 后确认全绿。

- [ ] **Step 4: 重写 `run.ts` 的 `prepare`**

```ts
import { canonicalPath } from './pair.js'
import { buildDepGraph } from './deps.js'
import { topoOrder } from './order.js'
import { segment } from './segment.js'
import type { DepGraph } from './deps.js'
import type { Segment } from './segment.js'

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
  /** 快照树里仍然存在的 canonical 单元 */
  present: Set<string>
  graph: DepGraph
  order: string[]
  cycles: string[][]
  segments: Segment[]
}

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
    contents.set(unit, await git(repo, ['cat-file', 'blob', `${snap.commit}:${unit}`], {
      trim: false,
    }))
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
    graph,
    order,
    cycles,
    segments,
  }
}
```

- [ ] **Step 5: 重写 `narrate` 的主体**

在 `narrate()` 里，把「算 ctx → planAndValidate」那一段换成：

```ts
  const root = await reviewRoot(repo, reviewId)
  await mkdir(join(root, 'tours'), { recursive: true })
  const round = await nextRound(repo, reviewId)

  // --reset-chapters：丢册重推。批注不删，只解除归属——
  // 它们下一轮会按锚点所在的文件重新归入新章。
  if (opts.resetChapters === true) {
    await rm(join(root, REGISTRY_FILE), { force: true })
    const held = await readAnnotations(root)
    await writeAnnotations(root, {
      version: 1,
      annotations: held.annotations.map((a) => ({
        ...a, chapterKey: null, state: 'unanchored' as const,
      })),
    })
  }

  const registryBefore = await readRegistry(root)
  const annotationFile = await readAnnotations(root)
  const annotations = migrateAnchors(annotationFile.annotations, changes)
  const pinned = pinnedByAnnotations(annotations, changes)

  const planner = opts.planner ?? new RulePlanner(p.segments)

  const draftCtx: PlanContext = {
    base: baseResolution.base,
    snapshot: snap.commit,
    changes,
    rules,
    canonical: p.canonical,
    registry: registryBefore,
    pinned,
    deps: p.graph.edges,
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

  const ctx: PlanContext = { ...draftCtx, registry,
    ...(previousPlan !== null ? { previous: previousPlan } : {}) }

  const plan = buildPlan(ctx, assignment, planner.id)
  const issues = validatePlan(plan, ctx)
  const errors = issues.filter((i) => i.severity === 'error')
  if (errors.length > 0) {
    throw new Error(
      `plan 未通过语义校验：\n${errors.map((i) => `  [${i.code}] ${i.message}`).join('\n')}`,
    )
  }
  const warnings = issues.filter((i) => i.severity === 'warn')
```

replay / verify / attachWorktree 之后，产物多写两份：

```ts
  await writeRegistry(root, registry)
  await writeAnnotations(root, { version: 1, annotations })
```

返回值补上：

```ts
    warnings,
    registryChapters: registry.chapters.length,
    depGraph: p.graph,
    cycles: p.cycles,
```

`planAndValidate` 这个 helper 换成 `assemble`，**narrate 与 planOnly 共用同一份**——
「draftCtx → assignment → segments → updateRegistry → buildPlan → validatePlan」
这一整段逻辑绝不能在两处各写一遍，两份迟早会漂：

```ts
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
 */
async function assemble(
  repo: string,
  root: string,
  p: Prepared,
  round: number,
  opts: NarrateOptions,
  previousPlan: Plan | null,
): Promise<Assembled>
```

`planOnly` 传一个不存在的 `root`（该仓库尚无 review 目录时 `readRegistry` /
`readAnnotations` 都返回空值，正是 dry-run 想要的），或者传真实 root 但**不调用**
`writeRegistry` / `writeAnnotations`。`--reset-chapters` 在 dry-run 下只作用于
`assemble` 内存里的那份册，不落盘。

`NarrateOptions` 加 `resetChapters?: true`；文件顶部补上
`import { rm } from 'node:fs/promises'` 与 registry / anchors / pair / deps / order /
segment 的 import。

- [ ] **Step 5.5: `toCodeTours` 跳过无内容的章**

`packages/core/src/tour/codetour.ts:35` 现在对 `plan.chapters` 全量 map，
册里的 `empty` / `deleted` 章会生成一份没有任何 step 的空 tour。改成：

```ts
  return plan.chapters
    // 空章与删除章没有对应的 commit，生成 tour 只会在 CodeTour 面板里留一排空壳
    .filter((chapter) => chapter.commitIndex !== null)
    .map((chapter) => {
```

并把第 62 行的标题从 `chapter.index` 换成 `chapter.commitIndex`——tour 对应的是
commit，编号必须跟 `git log` 里看到的一致，而不是册内序号。

`run.ts` 里写 tour 文件的循环（`chapter-${i+1}.tour`）不用改：`toCodeTours` 过滤后
下标本来就与 commit 序号一致。

追加一条测试到 `packages/core/tests/tour/codetour.test.ts`：

```ts
it('空章不生成 tour', () => {
  const plan: Plan = {
    version: 1, rulesFingerprint: 'f', base: 'b', snapshot: 's', plannerId: 'test',
    chapters: [
      { index: 1, commitIndex: null, key: 'empty', title: '空章', intro: '',
        status: 'empty', keyRenamedFrom: null, hunkIds: [], filePaths: [] },
      { index: 2, commitIndex: 1, key: 'a.ts', title: 'a', intro: '',
        status: 'active', keyRenamedFrom: null, hunkIds: [], filePaths: ['a.ts'] },
    ],
  }
  const tours = toCodeTours(plan, [], 'unfold/x')
  expect(tours).toHaveLength(1)
  expect(tours[0]?.title).toContain('1.')
})
```

- [ ] **Step 6: 写集成测试**

追加到 `packages/core/tests/narrate/run.test.ts`：

```ts
it('实现与它的测试落在同一章，且按依赖序排在被依赖者之后', async () => {
  const repo = await createTempRepo()
  await repo.write('src/a.ts', 'export const a = 1\n')
  await repo.commit('base')
  await repo.write('src/b.ts', "import { a } from './a.js'\nexport const b = a\n")
  await repo.write('tests/b.test.ts', "import { b } from '../src/b.js'\n")

  const result = await narrate(repo.dir, {})
  if (!result.hasChanges) throw new Error('应该有改动')
  const plan = await readPlan(repo.dir, result.reviewId)
  const active = plan.chapters.filter((c) => c.commitIndex !== null)

  const withB = active.find((c) => c.filePaths.includes('src/b.ts'))
  expect(withB?.filePaths).toContain('tests/b.test.ts')
  await repo.cleanup()
})

it('第二轮复用时，已在册的文件不换章', async () => {
  const repo = await createTempRepo()
  await repo.write('src/a.ts', 'export const a = 1\n')
  await repo.commit('base')
  await repo.write('src/a.ts', 'export const a = 2\n')

  const first = await narrate(repo.dir, {})
  if (!first.hasChanges) throw new Error('应该有改动')
  const before = await readPlan(repo.dir, first.reviewId)

  await repo.write('src/z.ts', 'export const z = 1\n')
  const second = await narrate(repo.dir, { reuse: true })
  if (!second.hasChanges) throw new Error('应该有改动')
  const after = await readPlan(repo.dir, second.reviewId)

  const keyOf = (plan: typeof before, path: string): string | undefined =>
    plan.chapters.find((c) => c.filePaths.includes(path))?.key
  expect(keyOf(after, 'src/a.ts')).toBe(keyOf(before, 'src/a.ts'))
  await repo.cleanup()
})

it('--reset-chapters 丢册重推，并把批注标成 unanchored', async () => {
  const repo = await createTempRepo()
  await repo.write('src/a.ts', 'export const a = 1\n')
  await repo.commit('base')
  await repo.write('src/a.ts', 'export const a = 2\n')

  const first = await narrate(repo.dir, {})
  if (!first.hasChanges) throw new Error('应该有改动')
  await writeAnnotations(first.reviewRoot, {
    version: 1,
    annotations: [{
      id: 'n1', chapterKey: 'src/a.ts', path: 'src/a.ts', startLine: 1, endLine: 1,
      anchorHash: 'sha256:x', body: '看这里', state: 'live', round: 1,
    }],
  })

  await narrate(repo.dir, { reuse: true, resetChapters: true })
  const held = await readAnnotations(first.reviewRoot)
  expect(held.annotations[0]?.state).toBe('unanchored')
  expect(held.annotations[0]?.body).toBe('看这里')
  await repo.cleanup()
})
```

- [ ] **Step 7: 跑全量测试**

Run: `pnpm -r typecheck && pnpm exec vitest run`
Expected: 全绿。不绿就修，别改测试去迁就实现。

- [ ] **Step 8: 变异验证**

把 Step 1 那个 `continue` 删掉，确认 replay 的新用例变红。
把 `updateRegistry` 的调用改成传 `registry: EMPTY_REGISTRY`，确认
「第二轮复用时，已在册的文件不换章」变红。都改回来。

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/narrate/run.ts packages/core/src/narrate/replay.ts packages/core/src/index.ts packages/core/tests/narrate/run.test.ts packages/core/tests/narrate/replay.test.ts
git commit -m 'feat(core): 接上配对→连边→定序→切段→归册→迁锚的整条 pipeline'
```

---

### Task 11: CLI 的依赖证据、体检提示与 `--reset-chapters`

**Files:**
- Modify: `packages/core/src/bin/report.ts`
- Modify: `packages/core/src/bin/args.ts`
- Modify: `packages/core/src/bin/unfold.ts`
- Modify: `docs/reviewing-with-vscode.md`
- Test: `packages/core/tests/bin/report.test.ts`、`packages/core/tests/bin/args.test.ts`

**Interfaces:**
- Consumes: Task 2 `DepGraph`、Task 9 `ValidationIssue`、Task 10 的 `NarrateChanges` 新字段
- Produces:
  - `function suggestOrder(plan: Plan): string[]`
  - `function formatDepEvidence(input: { graph: DepGraph; cycles: string[][]; suggestion: string[] }): string[]`
  - `function formatWarnings(issues: ValidationIssue[]): string[]`
  - `ParsedArgs` 新增 `resetChapters?: true`

- [ ] **Step 1: 写失败的测试**

追加到 `packages/core/tests/bin/report.test.ts`：

```ts
describe('suggestOrder', () => {
  it('按章节顺序给出去重后的目录前缀', () => {
    const plan = {
      version: 1 as const, rulesFingerprint: 'f', base: 'b', snapshot: 's', plannerId: 'p',
      chapters: [
        { index: 1, commitIndex: 1, key: 'src/git/a.ts', title: 'T', intro: 'I',
          status: 'active' as const, keyRenamedFrom: null, hunkIds: [], filePaths: ['src/git/a.ts'] },
        { index: 2, commitIndex: 2, key: 'src/git/b.ts', title: 'T', intro: 'I',
          status: 'active' as const, keyRenamedFrom: null, hunkIds: [], filePaths: ['src/git/b.ts'] },
        { index: 3, commitIndex: 3, key: 'src/bin/c.ts', title: 'T', intro: 'I',
          status: 'active' as const, keyRenamedFrom: null, hunkIds: [], filePaths: ['src/bin/c.ts'] },
      ],
    }
    expect(suggestOrder(plan)).toEqual(['src/git', 'src/bin'])
  })
})

describe('formatDepEvidence', () => {
  it('把扫了多少、跳过哪些、在哪破的环都说出来', () => {
    const lines = formatDepEvidence({
      graph: {
        edges: new Map([['a.ts', new Set(['b.ts'])], ['b.ts', new Set()]]),
        scanned: ['a.ts', 'b.ts'],
        skipped: [{ path: 'r.md', reason: '未支持依赖扫描的文件类型' }],
      },
      cycles: [['x.ts', 'y.ts']],
      suggestion: ['src/git'],
    }).join('\n')

    expect(lines).toContain('扫描')
    expect(lines).toContain('跳过 1')
    expect(lines).toContain('未支持依赖扫描的文件类型')
    expect(lines).toContain('连边   1')
    expect(lines).toContain('x.ts')
    expect(lines).toContain('"order": ["src/git"]')
  })

  it('无环时明说「无强连通分量」，而不是留空', () => {
    const lines = formatDepEvidence({
      graph: { edges: new Map(), scanned: [], skipped: [] }, cycles: [], suggestion: [],
    }).join('\n')
    expect(lines).toContain('无强连通分量')
  })
})

describe('formatWarnings', () => {
  it('没有警告时返回空数组，不打印一个空标题', () => {
    expect(formatWarnings([])).toEqual([])
  })

  it('只打 warn，不打 error——error 已经让整轮抛掉了', () => {
    const lines = formatWarnings([
      { code: 'chapter-no-test', severity: 'warn', message: '第 3 章没有测试' },
      { code: 'file-missing', severity: 'error', message: '不该出现在这里' },
    ]).join('\n')
    expect(lines).toContain('第 3 章没有测试')
    expect(lines).not.toContain('不该出现在这里')
  })
})
```

追加到 `packages/core/tests/bin/args.test.ts`：

```ts
it('认识 --reset-chapters', () => {
  const got = parseArgs(['narrate', '--reset-chapters'], '/tmp/x')
  expect(got.ok && got.args.resetChapters).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/tests/bin`
Expected: FAIL，`suggestOrder is not defined` 等。

- [ ] **Step 3: 写实现**

在 `packages/core/src/bin/report.ts` 追加：

```ts
import type { DepGraph } from '../narrate/deps.js'
import type { ValidationIssue } from '../narrate/validate.js'

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
    const dir = dirOf(chapter.key)
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
```

`formatPlanSummary` 改成带上册的状态，空章与删除章也列出来：

```ts
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
```

`reviewCommands` 里逐章的 `git show` 只对有 commit 的章生成——
入参从 `chapterTitles: string[]` 改成 `chapters: Array<{ title: string; commitIndex: number | null }>`，
`back` 用 commit 总数减 `commitIndex` 算：`back = total - commitIndex`。
空章与删除章不生成 `git show` 行——它们没有对应的 commit，生成出来是粘贴即报错的命令。

这会打到 `packages/core/tests/bin/report.test.ts:40` 与 `:61` 两处既有用例
（它们传的是 `chapterTitles`）。把它们改成新形状，**断言保持原样**——
对齐与「至少两个空格」那条长路径回归测试必须继续有效，它是 Plan 1 里真实修过的 bug。
调用点在 `packages/core/src/bin/unfold.ts:118`。

`packages/core/src/bin/args.ts`：`ParsedArgs` 加 `resetChapters?: true`，
在布尔 flag 分支里加 `else if (flag === '--reset-chapters') { resetChapters = true }`，
并在返回对象里带上。

`packages/core/src/bin/unfold.ts`：
- usage 里加一行 `'  --reset-chapters         丢弃章节册重新推导；批注保留但解除归属'`
- 把 `resetChapters` 透传进 `narrate` 与 `planOnly` 的 opts
- 输出里在章节列表之后依次加：

```ts
    ...formatDepEvidence({ graph: result.depGraph, cycles: result.cycles, suggestion: suggestOrder(plan) }),
    '',
    ...formatWarnings(result.warnings),
```

（`formatWarnings` 返回空数组时不会多打空行——用 `.filter(l => l !== undefined)`
这类技巧不可靠，直接判断长度：`...(warnLines.length > 0 ? ['', ...warnLines] : [])`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -r typecheck && pnpm exec vitest run`
Expected: 全绿。

- [ ] **Step 5: 真实仓库冒烟**

```bash
pnpm -r build
node packages/core/dist/bin/unfold.js narrate --repo "$PWD" --dry-run
```

人工核对三件事，写进任务报告：
1. 章节是不是按模块分的，每章是不是实现和测试在一起
2. 「依赖证据」那块的扫描/跳过/破环数字对不对
3. `narrate/` 这些模块的先后是不是 `pair → deps → order → segment → registry → anchors`

- [ ] **Step 6: 更新文档**

`docs/reviewing-with-vscode.md` 里凡是提到「四层（契约/核心逻辑/接线/测试与文档）」
「`layers`」「`fallback`」「`match` glob」的段落全部重写，改成：
章节按依赖序自动派生、`maxFiles` 控制粒度、`order` 用目录前缀覆盖顺序、
`titles` 改文案、`--reset-chapters` 是唯一能让章节消失的操作。
把旧的「两个 glob 陷阱」那节删掉——glob 已经不参与分章了。

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/bin/report.ts packages/core/src/bin/args.ts packages/core/src/bin/unfold.ts packages/core/tests/bin/report.test.ts packages/core/tests/bin/args.test.ts docs/reviewing-with-vscode.md
git commit -m 'feat(cli): 打印依赖证据与章节体检，加 --reset-chapters'
```

---

## 自查

**Spec 覆盖**

| spec 小节 | 任务 |
|---|---|
| §3.1 单元 = 实现 + 测试 | 1 |
| §3.2 切段四步 | 1、2、3、4 |
| §3.3 key = 段首 canonical path | 4 |
| §4.1–4.3 依赖扫描与破环 | 2、3 |
| §4.4 拓扑序唯一 | 3 |
| §4.5 `order` 是路径前缀 | 3、7 |
| §4.6 依赖证据打印 | 11 |
| §5.1 册持久 + 三状态 | 5 |
| §5.2 册 ≠ commit 链 | 8、10 |
| §5.3 归属优先级阶梯 | 8、10 |
| §5.4 锚点迁移 | 6 |
| §5.5 `--reset-chapters` | 10、11 |
| §5.6 规则变化只提示 | 10（不再按指纹跳过沿用）、11（打印） |
| §6 验收分级 | 9 |
| §7.1 rules v2 | 7 |
| §7.2 registry.json | 5 |
| §7.3 annotations.json | 6 |
| §8 文件结构 | 全部 |
| §9 删 v1 枚举层 | 7 |
| §10 Plan 2 契约 | 8（`Assignment` 新形状） |

**已知的跨任务约定**

- `Segment` 的字段名（`key`/`title`/`intro`/`members`）在 Task 4 定义，Task 5、8、10 直接消费。
- `ChapterStatus` 在 Task 5 定义，Task 8 的 `Chapter.status` 与 Task 9 的体检都用它。
- `PlanContext` 在 Task 8 定稿，Task 9、10 按那份定义消费；Task 9 的测试 helper 必须与 Task 8 的字段完全一致。
- Task 7 结束时 `pnpm -r typecheck` **预期是红的**（`build-plan.ts` / `validate.ts` 还在用删掉的
  `classifyPath`），Task 8、9 修完才转绿。执行到 Task 7 时不要为了让 typecheck 变绿而临时改
  别的文件——那会和 Task 8 的重写撞车。

**推迟到后续 plan 的**

册的归档、跨语言符号级依赖、hunk 级归属的 UI、批注的采集与展示（见 spec §11）。
`docs/superpowers/plans/2026-09-15-plan-1-followups.md` 里的 I1/I5 等遗留项不在本 plan 范围内。
