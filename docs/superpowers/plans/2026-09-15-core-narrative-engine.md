# Unfold Plan 1：core 叙事引擎 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出可端到端运行的 `unfold narrate`：吃一个脏工作区，产出一条叙事分支 + `plan.json` + `.tours/`，并通过 tree 字节一致校验。

**Architecture:** monorepo 的 `packages/core`，纯 TypeScript、零 `vscode` import、零网络。全部 git 操作走 plumbing 子进程（`read-tree` / `update-index` / `write-tree` / `commit-tree`），不 checkout、不 apply patch。章节规划在本 plan 里只实现确定性的规则版（AI 版是 Plan 2），但 `plan.json` 与 `replay` 一次按 hunk 粒度做对。

**Tech Stack:** Node 24.21.0 (LTS Krypton) · pnpm 10.12.4（经 corepack）· TypeScript 7.0.2 · vitest 5.0.0 · ESM

**Spec:** `docs/superpowers/specs/2026-09-15-unfold-design.md`

## Global Constraints

- **Node 用 24.21.0（LTS Krypton）**，仓库根放 `.nvmrc`，开工前 `nvm use`。`engines` 写 `>=22.12.0`——这是 `vitest@5` 的实际下限（其 engines 为 `^22.12.0||^24.0.0||>=26.0.0`）。**本机默认 node 仍是 v20.20.2，那个版本装不了 vitest 5**，所以每个新终端都要先 `nvm use`。不要改 nvm 的 default，别的项目还在用 20。
- **pnpm 经 corepack 激活**：node 24 下没有全局 pnpm（nvm 的全局包按版本隔离），但有 corepack 0.36.0。`corepack enable pnpm` 后由根 `package.json` 的 `packageManager: "pnpm@10.12.4"` 决定版本——已实测可用。
- **TypeScript 用 7.0.2（latest，原生重写版）**，`vitest` 用 `5.0.0`。已在 node 24.21.0 上实测：`tsc --noEmit` 与构建（产出 `.d.ts` + sourcemap）均通过，vitest 5 跑通。并且**反向验证过下面三个严格选项确实在报错、不是被静默忽略**：
  - `noUncheckedIndexedAccess` → `TS2322: Type 'string | undefined' is not assignable to type 'string'`
  - `exactOptionalPropertyTypes` → `TS2375: ... with 'exactOptionalPropertyTypes: true'`
  - `moduleResolution: Node16` 缺 `.js` 后缀 → `TS2835: Relative import paths need explicit file extensions`
- **ESM + `module: Node16`**：所有相对 import **必须带 `.js` 后缀**（源码里写 `./exec.js` 指向 `exec.ts`）。这是 Node16 解析规则，不是笔误。
- **`packages/core` 不得出现 `import ... from 'vscode'`**，也不得有任何网络调用。这是 spec §2 的分界线规则，由编译器守。
- **许可证**：根 `package.json` 与每个子包 `package.json` 均写 `"license": "AGPL-3.0-only"`；README 增加 License 节，原文 `Licensed under the GNU AGPL v3.0 only (SPDX: AGPL-3.0-only).`
- **契约测试**（真调本机 CLI 的那类）放 `packages/*/tests/contract/`，用 `process.env.UNFOLD_CONTRACT` 守门，常规 `pnpm test` 不跑。本 plan 不产契约测试，但目录与守门机制要就位（Plan 2/3 要用）。
- **所有 git 子进程调用必须显式传 `cwd`**，不得依赖 `process.cwd()`。
- **diff 一律加 `--no-renames`**：重命名按「删除 + 新增」处理。rename 检测只是显示层的便利，进入 tree 构造会平白增加一类边界。

---

### Task 1: monorepo 骨架、许可证、测试基建

**Files:**
- Create: `.nvmrc`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/tests/helpers/repo.ts`
- Create: `packages/core/tests/helpers/repo.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: 无
- Produces: `TempRepo` 测试夹具——`createTempRepo(): Promise<TempRepo>`，其中
  `TempRepo = { dir: string; git(...args: string[]): Promise<string>; write(rel: string, content: string): Promise<void>; rm(rel: string): Promise<void>; commit(msg: string): Promise<string>; cleanup(): Promise<void> }`。后续每个 Task 的测试都用它。

- [ ] **Step 1: 切 Node、启用 pnpm、建工作区骨架文件**

先把运行环境切对（本机默认还是 node 20，在那上面 `pnpm install` 会因为 vitest 5 的 engines 直接失败）：

```bash
echo '24.21.0' > .nvmrc
nvm use          # 读 .nvmrc
corepack enable pnpm
node --version   # 期望 v24.21.0
pnpm --version   # 期望 10.12.4（由 packageManager 字段决定）
```

`package.json`：

```json
{
  "name": "unfold-monorepo",
  "private": true,
  "license": "AGPL-3.0-only",
  "engines": { "node": ">=22.12.0" },
  "packageManager": "pnpm@10.12.4",
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run",
    "test:contract": "UNFOLD_CONTRACT=1 vitest run"
  },
  "devDependencies": {
    "@types/node": "24.13.4",
    "typescript": "7.0.2",
    "vitest": "5.0.0"
  }
}
```

`pnpm-workspace.yaml`：

```yaml
packages:
  - 'packages/*'
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "Node16",
    "moduleResolution": "Node16",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  }
}
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
```

`.gitignore`：

```
node_modules/
dist/
*.tsbuildinfo
.unfold/
```

`.nvmrc`：

```
24.21.0
```

- [ ] **Step 2: 建 core 包**

`packages/core/package.json`：

```json
{
  "name": "@unfold/core",
  "version": "0.0.0",
  "private": true,
  "license": "AGPL-3.0-only",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": { "unfold": "./dist/bin/unfold.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

`packages/core/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

`packages/core/src/index.ts`：

```ts
export const VERSION = '0.0.0'
```

- [ ] **Step 3: 落实许可证**

在 `README.md` 末尾追加：

```markdown

## License

Licensed under the GNU AGPL v3.0 only (SPDX: AGPL-3.0-only).
```

- [ ] **Step 4: 写测试夹具的失败测试**

`packages/core/tests/helpers/repo.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { createTempRepo } from './repo.js'

describe('createTempRepo', () => {
  it('建出一个可用的 git 仓库，且 cleanup 后目录消失', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'hello\n')
    const sha = await repo.commit('init')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(await repo.git('rev-parse', 'HEAD')).toBe(sha)
    expect(await repo.git('status', '--porcelain')).toBe('')

    const { existsSync } = await import('node:fs')
    expect(existsSync(repo.dir)).toBe(true)
    await repo.cleanup()
    expect(existsSync(repo.dir)).toBe(false)
  })

  it('write 会自动建父目录，rm 能删文件', async () => {
    const repo = await createTempRepo()
    await repo.write('src/deep/x.ts', 'export const x = 1\n')
    await repo.commit('add x')
    expect(await repo.git('ls-files')).toContain('src/deep/x.ts')
    await repo.rm('src/deep/x.ts')
    expect(await repo.git('status', '--porcelain')).toContain('src/deep/x.ts')
    await repo.cleanup()
  })
})
```

- [ ] **Step 5: 运行测试，确认失败**

Run: `pnpm install && pnpm vitest run packages/core/tests/helpers/repo.test.ts`
Expected: FAIL，报 `Failed to resolve import "./repo.js"`

- [ ] **Step 6: 实现测试夹具**

`packages/core/tests/helpers/repo.ts`：

```ts
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm as fsRm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface TempRepo {
  dir: string
  git(...args: string[]): Promise<string>
  write(rel: string, content: string): Promise<void>
  rm(rel: string): Promise<void>
  commit(msg: string): Promise<string>
  cleanup(): Promise<void>
}

export async function createTempRepo(): Promise<TempRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'unfold-test-'))

  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, {
      cwd: dir,
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout.replace(/\n$/, '')
  }

  await git('init', '-q', '-b', 'main', '.')
  await git('config', 'user.email', 'test@unfold.local')
  await git('config', 'user.name', 'Unfold Test')
  await git('config', 'commit.gpgsign', 'false')

  return {
    dir,
    git,
    async write(rel, content) {
      const abs = join(dir, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
    },
    async rm(rel) {
      await fsRm(join(dir, rel), { force: true })
    },
    async commit(msg) {
      await git('add', '-A')
      await git('commit', '-q', '-m', msg)
      return git('rev-parse', 'HEAD')
    },
    async cleanup() {
      await fsRm(dir, { recursive: true, force: true })
    },
  }
}
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `pnpm vitest run packages/core/tests/helpers/repo.test.ts`
Expected: PASS（2 passed）

- [ ] **Step 8: 确认类型检查通过**

Run: `pnpm typecheck`
Expected: 无输出、退出码 0

- [ ] **Step 9: 提交**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts .gitignore README.md packages/
git commit -m 'feat: monorepo 骨架、AGPL-3.0-only 声明与测试夹具'
```

---

### Task 2: git 执行器、脏工作区快照与 ref 钉住

**Files:**
- Create: `packages/core/src/git/exec.ts`
- Create: `packages/core/src/git/snapshot.ts`
- Create: `packages/core/tests/git/snapshot.test.ts`

**Interfaces:**
- Consumes: `createTempRepo` (Task 1)
- Produces:
  - `git(cwd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; input?: string; trim?: boolean }): Promise<string>` —— 非零退出抛 `GitError`；`trim` 缺省 true（去掉末尾单个换行），读 blob 内容时必须传 `false`
  - `class GitError extends Error { readonly code: number; readonly stderr: string; readonly args: string[] }`
  - `interface Snapshot { commit: string; tree: string; parent: string }`
  - `snapshot(repo: string): Promise<Snapshot>`
  - `pinSnapshot(repo: string, reviewId: string, round: number, commit: string): Promise<string>` —— 返回 ref 全名
  - `unpinReview(repo: string, reviewId: string): Promise<void>`

- [ ] **Step 1: 写失败测试**

`packages/core/tests/git/snapshot.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { createTempRepo } from '../helpers/repo.js'
import { snapshot, pinSnapshot, unpinReview } from '../../src/git/snapshot.js'

describe('snapshot', () => {
  it('抓到已跟踪文件的改动', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'base\n')
    await repo.commit('base')
    await repo.write('a.txt', 'changed\n')

    const snap = await snapshot(repo.dir)
    const content = await repo.git('cat-file', 'blob', `${snap.commit}:a.txt`)
    expect(content).toBe('changed')
    await repo.cleanup()
  })

  it('抓到未跟踪的新文件', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'base\n')
    await repo.commit('base')
    await repo.write('new.txt', 'brand new\n')

    const snap = await snapshot(repo.dir)
    const files = await repo.git('ls-tree', '-r', '--name-only', snap.commit)
    expect(files.split('\n')).toContain('new.txt')
    await repo.cleanup()
  })

  it('排除 gitignore 命中的文件', async () => {
    const repo = await createTempRepo()
    await repo.write('.gitignore', 'ignored.txt\n')
    await repo.commit('gitignore')
    await repo.write('ignored.txt', 'nope\n')

    const snap = await snapshot(repo.dir)
    const files = await repo.git('ls-tree', '-r', '--name-only', snap.commit)
    expect(files.split('\n')).not.toContain('ignored.txt')
    await repo.cleanup()
  })

  it('零干扰：工作区、index、stash 栈都不变，临时 index 不进 tree 也不残留', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'base\n')
    await repo.commit('base')
    await repo.write('a.txt', 'dirty\n')
    await repo.write('untracked.txt', 'u\n')

    const statusBefore = await repo.git('status', '--porcelain')
    const stashBefore = await repo.git('stash', 'list')

    const snap = await snapshot(repo.dir)

    expect(await repo.git('status', '--porcelain')).toBe(statusBefore)
    expect(await repo.git('stash', 'list')).toBe(stashBefore)
    expect(await repo.git('diff', '--cached', '--name-only')).toBe('')

    const files = (await repo.git('ls-tree', '-r', '--name-only', snap.commit)).split('\n')
    expect(files.some((f) => f.includes('unfold-snapshot-index'))).toBe(false)

    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const gitDir = await repo.git('rev-parse', '--absolute-git-dir')
    expect(existsSync(join(gitDir, 'unfold-snapshot-index'))).toBe(false)
    await repo.cleanup()
  })

  it('parent 是 HEAD，tree 是快照 tree', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'base\n')
    const head = await repo.commit('base')
    await repo.write('a.txt', 'dirty\n')

    const snap = await snapshot(repo.dir)
    expect(snap.parent).toBe(head)
    expect(await repo.git('rev-parse', `${snap.commit}^{tree}`)).toBe(snap.tree)
    await repo.cleanup()
  })
})

describe('pinSnapshot', () => {
  it('钉住之后快照能扛过激进 gc，unpin 之后不再可达', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'base\n')
    await repo.commit('base')
    await repo.write('a.txt', 'dirty\n')

    const snap = await snapshot(repo.dir)
    const ref = await pinSnapshot(repo.dir, 'rev-1', 1, snap.commit)
    expect(ref).toBe('refs/unfold/rev-1/round-001')

    await repo.git('reflog', 'expire', '--expire=now', '--all')
    await repo.git('gc', '--prune=now', '-q')
    expect(await repo.git('cat-file', '-t', snap.commit)).toBe('commit')

    await unpinReview(repo.dir, 'rev-1')
    expect(await repo.git('for-each-ref', 'refs/unfold/rev-1')).toBe('')
    await repo.cleanup()
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run packages/core/tests/git/snapshot.test.ts`
Expected: FAIL，报 `Failed to resolve import "../../src/git/snapshot.js"`

- [ ] **Step 3: 实现 git 执行器**

`packages/core/src/git/exec.ts`：

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class GitError extends Error {
  constructor(
    readonly code: number,
    readonly stderr: string,
    readonly args: string[],
  ) {
    super(`git ${args.join(' ')} 退出码 ${code}: ${stderr.trim()}`)
    this.name = 'GitError'
  }
}

export interface GitOptions {
  env?: NodeJS.ProcessEnv
  input?: string
  /**
   * 默认 true，去掉 stdout 末尾的单个换行（绝大多数 plumbing 输出都需要）。
   * 读 blob 内容时必须传 false——否则「有无结尾换行」这个信息会被吃掉，
   * 破坏字节一致。
   */
  trim?: boolean
}

/** 跑一条 git 命令。非零退出抛 GitError。 */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  try {
    const child = execFileAsync('git', args, {
      cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      maxBuffer: 256 * 1024 * 1024,
    })
    if (opts.input !== undefined) {
      child.child.stdin?.end(opts.input)
    }
    const { stdout } = await child
    return opts.trim === false ? stdout : stdout.replace(/\n$/, '')
  } catch (err: unknown) {
    const e = err as { code?: number; stderr?: string }
    throw new GitError(e.code ?? -1, e.stderr ?? String(err), args)
  }
}
```

- [ ] **Step 4: 实现快照与钉 ref**

`packages/core/src/git/snapshot.ts`：

```ts
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from './exec.js'

export interface Snapshot {
  /** 快照 commit 的 sha */
  commit: string
  /** 快照 tree 的 sha */
  tree: string
  /** 快照的 parent，即当时的 HEAD */
  parent: string
}

const SNAPSHOT_INDEX = 'unfold-snapshot-index'

/**
 * 给脏工作区照一张快照，产出一个 commit 对象。
 *
 * 零干扰：不动工作区、不动真实 index、不碰 stash 栈（spec §4）。
 * 临时 index 必须落在 git dir 里而不是 worktree 里，否则会被自己的
 * `git add -A` 抓进 tree。
 */
export async function snapshot(repo: string): Promise<Snapshot> {
  const gitDir = await git(repo, ['rev-parse', '--absolute-git-dir'])
  const indexPath = join(gitDir, SNAPSHOT_INDEX)
  await rm(indexPath, { force: true })

  const env = { GIT_INDEX_FILE: indexPath }
  try {
    await git(repo, ['read-tree', 'HEAD'], { env })
    await git(repo, ['add', '-A'], { env })
    const tree = await git(repo, ['write-tree'], { env })
    const parent = await git(repo, ['rev-parse', 'HEAD'])
    const commit = await git(repo, [
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      'unfold: snapshot',
    ])
    return { commit, tree, parent }
  } finally {
    await rm(indexPath, { force: true })
    await rm(`${indexPath}.lock`, { force: true })
  }
}

function roundRef(reviewId: string, round: number): string {
  return `refs/unfold/${reviewId}/round-${String(round).padStart(3, '0')}`
}

/**
 * 把快照钉在一个 ref 上。
 *
 * 必须做：SNAP 不是叙事分支 tip 的祖先，worktree 一旦切到叙事分支它就
 * 不可达，`git gc --prune=now` 会清掉它；而增量重看依赖历轮快照（spec §4.3）。
 */
export async function pinSnapshot(
  repo: string,
  reviewId: string,
  round: number,
  commit: string,
): Promise<string> {
  const ref = roundRef(reviewId, round)
  await git(repo, ['update-ref', ref, commit])
  return ref
}

/** 清掉某次 review 钉住的全部快照 ref。 */
export async function unpinReview(repo: string, reviewId: string): Promise<void> {
  const listed = await git(repo, [
    'for-each-ref',
    '--format=%(refname)',
    `refs/unfold/${reviewId}`,
  ])
  if (listed === '') return
  for (const ref of listed.split('\n')) {
    await git(repo, ['update-ref', '-d', ref])
  }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm vitest run packages/core/tests/git/snapshot.test.ts`
Expected: PASS（6 passed）

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/git packages/core/tests/git
git commit -m 'feat(core): 脏工作区快照与 ref 钉住'
```

---

### Task 3: base 推导

**Files:**
- Create: `packages/core/src/git/range.ts`
- Create: `packages/core/tests/git/range.test.ts`

**Interfaces:**
- Consumes: `git` (Task 2)
- Produces:
  - `type BaseSource = 'explicit' | 'upstream' | 'default-branch' | 'head'`
  - `interface BaseResolution { base: string; source: BaseSource }`
  - `resolveBase(repo: string, opts?: { explicit?: string; defaultBranch?: string }): Promise<BaseResolution>`

- [ ] **Step 1: 写失败测试**

`packages/core/tests/git/range.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { createTempRepo } from '../helpers/repo.js'
import { resolveBase } from '../../src/git/range.js'

describe('resolveBase', () => {
  it('显式指定时原样解析成 sha', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', '1\n')
    const first = await repo.commit('first')
    await repo.write('a.txt', '2\n')
    await repo.commit('second')

    const r = await resolveBase(repo.dir, { explicit: first })
    expect(r).toEqual({ base: first, source: 'explicit' })
    await repo.cleanup()
  })

  it('有 upstream 时取与 upstream 的 merge-base', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', '1\n')
    const forkPoint = await repo.commit('base')
    await repo.git('branch', 'origin-main')
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.git('config', 'branch.feature.remote', '.')
    await repo.git('config', 'branch.feature.merge', 'refs/heads/origin-main')
    await repo.write('a.txt', '2\n')
    await repo.commit('work')

    const r = await resolveBase(repo.dir)
    expect(r).toEqual({ base: forkPoint, source: 'upstream' })
    await repo.cleanup()
  })

  it('无 upstream 时退到与默认分支的 merge-base', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', '1\n')
    const forkPoint = await repo.commit('base')
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.write('a.txt', '2\n')
    await repo.commit('work')

    const r = await resolveBase(repo.dir, { defaultBranch: 'main' })
    expect(r).toEqual({ base: forkPoint, source: 'default-branch' })
    await repo.cleanup()
  })

  it('默认分支不存在或就在当前分支上时退到 HEAD', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', '1\n')
    const head = await repo.commit('only')

    const r = await resolveBase(repo.dir, { defaultBranch: 'nonexistent' })
    expect(r).toEqual({ base: head, source: 'head' })
    await repo.cleanup()
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run packages/core/tests/git/range.test.ts`
Expected: FAIL，报无法解析 `../../src/git/range.js`

- [ ] **Step 3: 实现**

`packages/core/src/git/range.ts`：

```ts
import { git, GitError } from './exec.js'

export type BaseSource = 'explicit' | 'upstream' | 'default-branch' | 'head'

export interface BaseResolution {
  base: string
  source: BaseSource
}

export interface ResolveBaseOptions {
  /** 用户显式指定的 base（任何 git revision 写法） */
  explicit?: string
  /** 默认分支名，缺省 'main' */
  defaultBranch?: string
}

async function tryGit(repo: string, args: string[]): Promise<string | null> {
  try {
    return await git(repo, args)
  } catch (err) {
    if (err instanceof GitError) return null
    throw err
  }
}

/**
 * 推导 review 的 base（spec §6.4）。
 * 优先级：显式 → 与 upstream 的 merge-base → 与默认分支的 merge-base → HEAD。
 *
 * 注意第 2 轮起调用方不该走这里：base 就是上一轮的 snapshot（spec §7.1）。
 */
export async function resolveBase(
  repo: string,
  opts: ResolveBaseOptions = {},
): Promise<BaseResolution> {
  const head = await git(repo, ['rev-parse', 'HEAD'])

  if (opts.explicit !== undefined) {
    const base = await git(repo, ['rev-parse', `${opts.explicit}^{commit}`])
    return { base, source: 'explicit' }
  }

  const upstream = await tryGit(repo, ['rev-parse', '--abbrev-ref', '@{upstream}'])
  if (upstream !== null) {
    const mb = await tryGit(repo, ['merge-base', upstream, 'HEAD'])
    if (mb !== null && mb !== head) return { base: mb, source: 'upstream' }
  }

  const defaultBranch = opts.defaultBranch ?? 'main'
  const mb = await tryGit(repo, ['merge-base', defaultBranch, 'HEAD'])
  if (mb !== null && mb !== head) return { base: mb, source: 'default-branch' }

  return { base: head, source: 'head' }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run packages/core/tests/git/range.test.ts`
Expected: PASS（4 passed）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/git/range.ts packages/core/tests/git/range.test.ts
git commit -m 'feat(core): base 推导'
```

---

### Task 4: diff 与 hunk 模型

**Files:**
- Create: `packages/core/src/narrate/diff.ts`
- Create: `packages/core/tests/narrate/diff.test.ts`

**Interfaces:**
- Consumes: `git` (Task 2)
- Produces:
  - `interface Hunk { id: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }` —— `lines` 是原始 diff 正文行，含前导 `' '` / `'-'` / `'+'`
  - `type ChangeKind = 'add' | 'modify' | 'delete'`
  - `interface FileChange { path: string; kind: ChangeKind; binary: boolean; mode: string; blob: string | null; oldMode: string | null; oldBlob: string | null; hunks: Hunk[] }`
    - `blob` / `mode` 为终态；`kind === 'delete'` 时为 `null` / `''`
    - `oldBlob` / `oldMode` 为 base 态；`kind === 'add'` 时为 `null`
  - `computeChanges(repo: string, base: string, head: string): Promise<FileChange[]>` —— 按 `path` 升序

- [ ] **Step 1: 写失败测试**

`packages/core/tests/narrate/diff.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { createTempRepo } from '../helpers/repo.js'
import { computeChanges } from '../../src/narrate/diff.js'

describe('computeChanges', () => {
  it('区分新增、修改、删除，并给出终态与 base 态的 blob', async () => {
    const repo = await createTempRepo()
    await repo.write('keep.txt', 'a\nb\nc\n')
    await repo.write('gone.txt', 'bye\n')
    const base = await repo.commit('base')

    await repo.write('keep.txt', 'a\nB\nc\n')
    await repo.rm('gone.txt')
    await repo.write('fresh.txt', 'new\n')
    const head = await repo.commit('work')

    const changes = await computeChanges(repo.dir, base, head)
    expect(changes.map((c) => c.path)).toEqual(['fresh.txt', 'gone.txt', 'keep.txt'])

    const fresh = changes[0]!
    expect(fresh.kind).toBe('add')
    expect(fresh.oldBlob).toBeNull()
    expect(fresh.blob).toMatch(/^[0-9a-f]{40}$/)

    const gone = changes[1]!
    expect(gone.kind).toBe('delete')
    expect(gone.blob).toBeNull()
    expect(gone.oldBlob).toMatch(/^[0-9a-f]{40}$/)

    const keep = changes[2]!
    expect(keep.kind).toBe('modify')
    expect(keep.mode).toBe('100644')
    await repo.cleanup()
  })

  it('hunk 带行号与原始正文，id 在一次计算内唯一', async () => {
    const repo = await createTempRepo()
    await repo.write('f.txt', ['l1','l2','l3','l4','l5','l6','l7','l8','l9','l10','l11','l12'].join('\n') + '\n')
    const base = await repo.commit('base')
    await repo.write('f.txt', ['L1','l2','l3','l4','l5','l6','l7','l8','l9','l10','l11','L12'].join('\n') + '\n')
    const head = await repo.commit('work')

    const changes = await computeChanges(repo.dir, base, head)
    const f = changes[0]!
    expect(f.hunks.length).toBe(2)
    expect(f.hunks[0]!.oldStart).toBe(1)
    expect(f.hunks[0]!.lines.some((l) => l === '-l1')).toBe(true)
    expect(f.hunks[0]!.lines.some((l) => l === '+L1')).toBe(true)
    expect(new Set(f.hunks.map((h) => h.id)).size).toBe(2)
    await repo.cleanup()
  })

  it('二进制文件标记 binary 且没有 hunk', async () => {
    const repo = await createTempRepo()
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFile(join(repo.dir, 'b.bin'), Buffer.from([0, 1, 2, 0, 3]))
    const base = await repo.commit('base')
    await writeFile(join(repo.dir, 'b.bin'), Buffer.from([0, 9, 9, 0, 9]))
    const head = await repo.commit('work')

    const changes = await computeChanges(repo.dir, base, head)
    expect(changes[0]!.binary).toBe(true)
    expect(changes[0]!.hunks).toEqual([])
    await repo.cleanup()
  })

  it('重命名按删除加新增处理（--no-renames）', async () => {
    const repo = await createTempRepo()
    await repo.write('old.txt', 'same content\n')
    const base = await repo.commit('base')
    await repo.git('mv', 'old.txt', 'new.txt')
    const head = await repo.commit('rename')

    const changes = await computeChanges(repo.dir, base, head)
    expect(changes.map((c) => `${c.path}:${c.kind}`)).toEqual(['new.txt:add', 'old.txt:delete'])
    await repo.cleanup()
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run packages/core/tests/narrate/diff.test.ts`
Expected: FAIL，无法解析 `../../src/narrate/diff.js`

- [ ] **Step 3: 实现**

`packages/core/src/narrate/diff.ts`：

```ts
import { git } from '../git/exec.js'

export interface Hunk {
  /** 一次计算内唯一，形如 `src/a.ts#0` */
  id: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** 原始 diff 正文行，保留前导 ' ' / '-' / '+' */
  lines: string[]
}

export type ChangeKind = 'add' | 'modify' | 'delete'

export interface FileChange {
  path: string
  kind: ChangeKind
  binary: boolean
  /** 终态 mode；delete 时为 '' */
  mode: string
  /** 终态 blob；delete 时为 null */
  blob: string | null
  /** base 态 mode；add 时为 null */
  oldMode: string | null
  /** base 态 blob；add 时为 null */
  oldBlob: string | null
  hunks: Hunk[]
}

const NULL_SHA = '0000000000000000000000000000000000000000'

interface RawEntry {
  path: string
  kind: ChangeKind
  mode: string
  blob: string | null
  oldMode: string | null
  oldBlob: string | null
}

/** 解析 `git diff --raw -z` 的输出 */
function parseRaw(raw: string): RawEntry[] {
  if (raw === '') return []
  // -z 下记录形如 ":<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0"
  const parts = raw.split('\0').filter((p) => p !== '')
  const out: RawEntry[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const meta = parts[i]!
    const path = parts[i + 1]!
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) (.)$/.exec(meta)
    if (m === null) throw new Error(`无法解析 diff --raw 记录: ${JSON.stringify(meta)}`)
    const [, oldMode, newMode, oldSha, newSha, status] = m as unknown as [
      string, string, string, string, string, string,
    ]
    const kind: ChangeKind = status === 'A' ? 'add' : status === 'D' ? 'delete' : 'modify'
    out.push({
      path,
      kind,
      mode: kind === 'delete' ? '' : newMode,
      blob: newSha === NULL_SHA ? null : newSha,
      oldMode: kind === 'add' ? null : oldMode,
      oldBlob: oldSha === NULL_SHA ? null : oldSha,
    })
  }
  return out
}

/** 从 unified diff 正文里切出每个文件的 hunk */
function parseHunks(patch: string): Map<string, Hunk[]> {
  const byPath = new Map<string, Hunk[]>()
  if (patch === '') return byPath

  let path: string | null = null
  let hunks: Hunk[] = []
  let current: Hunk | null = null

  const flushFile = (): void => {
    if (path !== null) byPath.set(path, hunks)
    path = null
    hunks = []
    current = null
  }

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flushFile()
      continue
    }
    // 顺序是 --- 在前、+++ 在后。两边都「非 /dev/null 才覆盖」：
    // 新增文件靠 +++ 拿到路径，删除文件靠 --- 拿到路径，修改文件两次都对。
    if (line.startsWith('--- ')) {
      const src = line.slice(4)
      if (src !== '/dev/null') path = src.replace(/^a\//, '')
      continue
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4)
      if (target !== '/dev/null') path = target.replace(/^b\//, '')
      continue
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (m === null) continue
      current = {
        id: '',
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    // 反斜杠要收进来：`\ No newline at end of file` 是 composeContent 判断
    // 结尾换行的依据
    if (current !== null && /^[ +\-\\]/.test(line)) {
      current.lines.push(line)
    }
  }
  flushFile()
  return byPath
}

/**
 * 算出 base..head 的结构化改动（spec §6.5 要求 hunk 粒度）。
 * 一律 --no-renames：重命名按删除 + 新增处理。
 */
export async function computeChanges(
  repo: string,
  base: string,
  head: string,
): Promise<FileChange[]> {
  const raw = await git(repo, [
    'diff', '--raw', '--no-renames', '-z', '--abbrev=40', base, head,
  ])
  const entries = parseRaw(raw)

  const patch = await git(repo, [
    'diff', '--no-renames', '--unified=3', '--no-color', '--no-ext-diff', base, head,
  ])
  const hunksByPath = parseHunks(patch)

  const numstat = await git(repo, ['diff', '--numstat', '--no-renames', '-z', base, head])
  const binaryPaths = new Set<string>()
  {
    const parts = numstat.split('\0').filter((p) => p !== '')
    for (const rec of parts) {
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(rec)
      if (m !== null && m[1] === '-' && m[2] === '-' && m[3] !== '') {
        binaryPaths.add(m[3])
      }
    }
  }

  const changes: FileChange[] = entries.map((e) => {
    const binary = binaryPaths.has(e.path)
    const hunks = binary ? [] : (hunksByPath.get(e.path) ?? [])
    return {
      path: e.path,
      kind: e.kind,
      binary,
      mode: e.mode,
      blob: e.blob,
      oldMode: e.oldMode,
      oldBlob: e.oldBlob,
      hunks: hunks.map((h, i) => ({ ...h, id: `${e.path}#${i}` })),
    }
  })

  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return changes
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run packages/core/tests/narrate/diff.test.ts`
Expected: PASS（4 passed）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/narrate/diff.ts packages/core/tests/narrate/diff.test.ts
git commit -m 'feat(core): diff 与 hunk 模型'
```

---

### Task 5: Plan 类型与规则版 ChapterPlanner

**Files:**
- Create: `packages/core/src/narrate/plan.ts`
- Create: `packages/core/src/narrate/planner.ts`
- Create: `packages/core/src/narrate/rule-planner.ts`
- Create: `packages/core/tests/narrate/rule-planner.test.ts`

**Interfaces:**
- Consumes: `FileChange`, `Hunk` (Task 4)
- Produces:
  - `interface Chapter { index: number; title: string; intro: string; hunkIds: string[]; filePaths: string[] }`（`index` 从 1 起；`filePaths` 是「该文件最终落地的章节」，无 hunk 的文件也在此声明）
  - `interface Plan { version: 1; base: string; snapshot: string; plannerId: string; chapters: Chapter[] }`
  - `interface PlanContext { base: string; snapshot: string; changes: FileChange[]; previous?: Plan }`
  - `interface ChapterPlanner { readonly id: string; plan(ctx: PlanContext): Promise<Plan> }`
  - `class RulePlanner implements ChapterPlanner`（`id = 'rule'`）
  - `classifyPath(path: string): 'contract' | 'core' | 'wiring' | 'test-doc'`

- [ ] **Step 1: 写失败测试**

`packages/core/tests/narrate/rule-planner.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { createTempRepo } from '../helpers/repo.js'
import { computeChanges } from '../../src/narrate/diff.js'
import { RulePlanner, classifyPath } from '../../src/narrate/rule-planner.js'
import type { Plan, PlanContext } from '../../src/narrate/plan.js'

async function ctxFor(files: Record<string, string>): Promise<PlanContext> {
  const repo = await createTempRepo()
  await repo.write('.keep', '')
  const base = await repo.commit('base')
  for (const [p, c] of Object.entries(files)) await repo.write(p, c)
  const head = await repo.commit('work')
  const changes = await computeChanges(repo.dir, base, head)
  await repo.cleanup()
  return { base, snapshot: head, changes }
}

describe('classifyPath', () => {
  it('按契约 / 核心 / 接线 / 测试文档归类', () => {
    expect(classifyPath('src/types.ts')).toBe('contract')
    expect(classifyPath('api/schema.json')).toBe('contract')
    expect(classifyPath('src/engine/replay.ts')).toBe('core')
    expect(classifyPath('src/index.ts')).toBe('wiring')
    expect(classifyPath('tests/replay.test.ts')).toBe('test-doc')
    expect(classifyPath('README.md')).toBe('test-doc')
  })
})

describe('RulePlanner', () => {
  it('按契约→核心→接线→测试文档排章，每个 hunk 恰好出现一次', async () => {
    const ctx = await ctxFor({
      'README.md': 'doc\n',
      'src/index.ts': 'export * from "./engine.js"\n',
      'src/types.ts': 'export type T = 1\n',
      'src/engine.ts': 'export const run = () => 1\n',
    })
    const plan = await new RulePlanner().plan(ctx)

    const titles = plan.chapters.map((c) => c.title)
    expect(titles[0]).toContain('契约')
    expect(titles[1]).toContain('核心')
    expect(titles[2]).toContain('接线')
    expect(titles[3]).toContain('测试与文档')

    const all = plan.chapters.flatMap((c) => c.hunkIds)
    const expected = ctx.changes.flatMap((c) => c.hunks.map((h) => h.id))
    expect(all.slice().sort()).toEqual(expected.slice().sort())
    expect(new Set(all).size).toBe(all.length)
  })

  it('章号从 1 连续，且每章都有非空导语', async () => {
    const ctx = await ctxFor({ 'src/a.ts': 'a\n', 'src/types.ts': 'b\n' })
    const plan = await new RulePlanner().plan(ctx)
    expect(plan.chapters.map((c) => c.index)).toEqual(
      plan.chapters.map((_, i) => i + 1),
    )
    for (const ch of plan.chapters) expect(ch.intro.length).toBeGreaterThan(0)
  })

  it('二进制文件也要被分进某一章（走整文件）', async () => {
    const repo = await createTempRepo()
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await repo.write('.keep', '')
    const base = await repo.commit('base')
    await writeFile(join(repo.dir, 'img.bin'), Buffer.from([0, 1, 0, 2]))
    const head = await repo.commit('bin')
    const changes = await computeChanges(repo.dir, base, head)

    const plan = await new RulePlanner().plan({ base, snapshot: head, changes })
    const covered = plan.chapters.flatMap((c) => c.hunkIds)
    // 二进制无 hunk，靠「其余」章兜底覆盖文件本身
    expect(covered).toEqual([])
    expect(plan.chapters.at(-1)!.title).toContain('其余')
    await repo.cleanup()
  })

  it('跨轮稳定：上一轮已分配过的文件保持原章号', async () => {
    const ctx = await ctxFor({ 'src/types.ts': 'a\n', 'src/engine.ts': 'b\n' })
    const first = await new RulePlanner().plan(ctx)
    const engineChapter = first.chapters.find((c) =>
      c.hunkIds.some((id) => id.startsWith('src/engine.ts#')),
    )!

    const previous: Plan = first
    const second = await new RulePlanner().plan({ ...ctx, previous })
    const engineChapter2 = second.chapters.find((c) =>
      c.hunkIds.some((id) => id.startsWith('src/engine.ts#')),
    )!
    expect(engineChapter2.index).toBe(engineChapter.index)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run packages/core/tests/narrate/rule-planner.test.ts`
Expected: FAIL，无法解析 `../../src/narrate/plan.js`

- [ ] **Step 3: 实现类型与接口**

`packages/core/src/narrate/plan.ts`：

```ts
import type { FileChange } from './diff.js'

export interface Chapter {
  /** 从 1 起，连续 */
  index: number
  title: string
  /** 「为什么先看这个」 */
  intro: string
  /** 本章包含的 hunk id */
  hunkIds: string[]
  /**
   * 在本章「最终落地」的文件。语义：该文件的最后一个 hunk 所在章；
   * 无 hunk 的文件（二进制）也在此声明。每个文件在全局恰好出现一次，
   * 这条由 validatePlan 的 file-duplicated / file-missing 守住。
   */
  filePaths: string[]
}

export interface Plan {
  version: 1
  base: string
  snapshot: string
  /** 产出该 plan 的 planner id，便于复现（spec §7.5） */
  plannerId: string
  chapters: Chapter[]
}

export interface PlanContext {
  base: string
  snapshot: string
  changes: FileChange[]
  /** 上一轮的 plan，用于跨轮稳定（spec §7.3） */
  previous?: Plan
}

export interface ChapterPlanner {
  readonly id: string
  plan(ctx: PlanContext): Promise<Plan>
}
```

`packages/core/src/narrate/planner.ts`：

```ts
export type { ChapterPlanner, Plan, PlanContext, Chapter } from './plan.js'
```

- [ ] **Step 4: 实现规则版 planner**

`packages/core/src/narrate/rule-planner.ts`：

```ts
import type { FileChange } from './diff.js'
import type { Chapter, ChapterPlanner, Plan, PlanContext } from './plan.js'

export type PathClass = 'contract' | 'core' | 'wiring' | 'test-doc'

const ORDER: PathClass[] = ['contract', 'core', 'wiring', 'test-doc']

const TITLES: Record<PathClass, string> = {
  contract: '第 1 层：契约',
  core: '第 2 层：核心逻辑',
  wiring: '第 3 层：接线与调用方',
  'test-doc': '第 4 层：测试与文档',
}

const INTROS: Record<PathClass, string> = {
  contract: '先看类型、schema 与接口——它们定义了后面所有代码要满足的形状。',
  core: '再看核心逻辑：真正实现行为的地方，前面的契约在这里被兑现。',
  wiring: '然后看接线：谁调用了上面这些东西，改动如何被接进系统。',
  'test-doc': '最后看测试与文档：它们说明作者认为哪些行为值得保证。',
}

/** 按路径把文件归到叙事的四层（spec §6.4 的默认顺序） */
export function classifyPath(path: string): PathClass {
  const lower = path.toLowerCase()
  if (/(^|\/)(tests?|__tests__|spec)\//.test(lower) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)) {
    return 'test-doc'
  }
  if (/\.(md|mdx|txt|rst|adoc)$/.test(lower)) return 'test-doc'
  if (/(^|\/)(types?|schema|schemas|proto|api|contracts?)(\/|\.)/.test(lower)) return 'contract'
  if (/\.(d\.ts|proto|graphql|avsc)$/.test(lower)) return 'contract'
  if (/(^|\/)(index|main|app|bootstrap|cli|bin)\.[cm]?[jt]sx?$/.test(lower)) return 'wiring'
  if (/\.(json|ya?ml|toml|ini|cfg)$/.test(lower)) return 'wiring'
  return 'core'
}

function emptyChapter(index: number, cls: PathClass): Chapter {
  return { index, title: TITLES[cls], intro: INTROS[cls], hunkIds: [], filePaths: [] }
}

/**
 * v1 的确定性 planner（spec §9.2 的兜底，也是 AI 不可用时的保底路径）。
 * 只产「整文件同章」的分配——文件内分章是 v2（spec §6.5）。
 */
export class RulePlanner implements ChapterPlanner {
  readonly id = 'rule'

  async plan(ctx: PlanContext): Promise<Plan> {
    const previousChapterOf = new Map<string, number>()
    if (ctx.previous !== undefined) {
      for (const ch of ctx.previous.chapters) {
        for (const p of ch.filePaths) previousChapterOf.set(p, ch.index)
        for (const id of ch.hunkIds) {
          previousChapterOf.set(id.slice(0, id.lastIndexOf('#')), ch.index)
        }
      }
    }

    const buckets = new Map<PathClass, FileChange[]>(ORDER.map((c) => [c, []]))
    for (const change of ctx.changes) {
      buckets.get(classifyPath(change.path))!.push(change)
    }

    const chapters: Chapter[] = []
    for (const cls of ORDER) {
      const files = buckets.get(cls)!
      if (files.length === 0) continue
      const ch = emptyChapter(chapters.length + 1, cls)
      for (const f of files) {
        ch.filePaths.push(f.path)
        for (const h of f.hunks) ch.hunkIds.push(h.id)
      }
      chapters.push(ch)
    }

    // 「其余」章：兜住一切没被上面覆盖的文件，保证 verify 恒真（spec §6.3）
    const covered = new Set(chapters.flatMap((c) => c.filePaths))
    const rest = ctx.changes.filter((c) => !covered.has(c.path))
    const restChapter: Chapter = {
      index: chapters.length + 1,
      title: '其余',
      intro: '前面各章未覆盖的改动，一并在此落地，确保终态与原分支逐字节一致。',
      hunkIds: rest.flatMap((c) => c.hunks.map((h) => h.id)),
      filePaths: rest.map((c) => c.path),
    }
    chapters.push(restChapter)

    // 跨轮稳定：已分配过的文件回到原章号（spec §7.3）
    if (previousChapterOf.size > 0) {
      applyPreviousAssignment(chapters, ctx, previousChapterOf)
    }

    return {
      version: 1,
      base: ctx.base,
      snapshot: ctx.snapshot,
      plannerId: this.id,
      chapters,
    }
  }
}

function applyPreviousAssignment(
  chapters: Chapter[],
  ctx: PlanContext,
  previousChapterOf: Map<string, number>,
): void {
  const byIndex = new Map(chapters.map((c) => [c.index, c]))
  for (const change of ctx.changes) {
    const want = previousChapterOf.get(change.path)
    if (want === undefined) continue
    const target = byIndex.get(want)
    if (target === undefined) continue
    for (const ch of chapters) {
      if (ch.index === want) continue
      ch.filePaths = ch.filePaths.filter((p) => p !== change.path)
      ch.hunkIds = ch.hunkIds.filter((id) => !id.startsWith(`${change.path}#`))
    }
    if (!target.filePaths.includes(change.path)) target.filePaths.push(change.path)
    for (const h of change.hunks) {
      if (!target.hunkIds.includes(h.id)) target.hunkIds.push(h.id)
    }
  }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm vitest run packages/core/tests/narrate/rule-planner.test.ts`
Expected: PASS（5 passed）

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/narrate/plan.ts packages/core/src/narrate/planner.ts packages/core/src/narrate/rule-planner.ts packages/core/tests/narrate/rule-planner.test.ts
git commit -m 'feat(core): Plan 类型与规则版 ChapterPlanner'
```

---

### Task 6: plan 的语义校验

**Files:**
- Create: `packages/core/src/narrate/validate.ts`
- Create: `packages/core/tests/narrate/validate.test.ts`

**Interfaces:**
- Consumes: `Plan`, `PlanContext` (Task 5), `FileChange` (Task 4)
- Produces:
  - `interface ValidationIssue { code: 'hunk-missing' | 'hunk-duplicated' | 'hunk-unknown' | 'file-missing' | 'file-duplicated' | 'file-unknown' | 'chapter-index' | 'cross-round-drift'; message: string }`
  - `validatePlan(plan: Plan, ctx: PlanContext): ValidationIssue[]` —— 空数组表示通过

- [ ] **Step 1: 写失败测试**

`packages/core/tests/narrate/validate.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { validatePlan } from '../../src/narrate/validate.js'
import type { Plan, PlanContext } from '../../src/narrate/plan.js'
import type { FileChange } from '../../src/narrate/diff.js'

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
  return { base: 'a'.repeat(40), snapshot: 'b'.repeat(40), changes, ...(previous ? { previous } : {}) }
}

function plan(chapters: Plan['chapters']): Plan {
  return { version: 1, base: 'a'.repeat(40), snapshot: 'b'.repeat(40), plannerId: 'test', chapters }
}

describe('validatePlan', () => {
  it('完全覆盖且不重复时通过', () => {
    const c = ctx([change('a.ts', 2)])
    const p = plan([{ index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0', 'a.ts#1'], filePaths: ['a.ts'] }])
    expect(validatePlan(p, c)).toEqual([])
  })

  it('漏掉 hunk 会报 hunk-missing', () => {
    const c = ctx([change('a.ts', 2)])
    const p = plan([{ index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] }])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('hunk-missing')
  })

  it('同一 hunk 分到两章会报 hunk-duplicated', () => {
    const c = ctx([change('a.ts', 1)])
    const p = plan([
      { index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
      { index: 2, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: [] },
    ])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('hunk-duplicated')
  })

  it('引用不存在的 hunk 会报 hunk-unknown', () => {
    const c = ctx([change('a.ts', 1)])
    const p = plan([{ index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0', 'ghost.ts#0'], filePaths: ['a.ts'] }])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('hunk-unknown')
  })

  it('章号不连续会报 chapter-index', () => {
    const c = ctx([change('a.ts', 1)])
    const p = plan([{ index: 2, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] }])
    expect(validatePlan(p, c).map((i) => i.code)).toContain('chapter-index')
  })

  it('已分配文件换了章号会报 cross-round-drift', () => {
    const c0 = change('a.ts', 1)
    const c1 = change('b.ts', 1)
    const previous = plan([
      { index: 1, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
      { index: 2, title: 't', intro: 'i', hunkIds: ['b.ts#0'], filePaths: ['b.ts'] },
    ])
    const drifted = plan([
      { index: 1, title: 't', intro: 'i', hunkIds: ['b.ts#0'], filePaths: ['b.ts'] },
      { index: 2, title: 't', intro: 'i', hunkIds: ['a.ts#0'], filePaths: ['a.ts'] },
    ])
    const issues = validatePlan(drifted, ctx([c0, c1], previous))
    expect(issues.map((i) => i.code)).toContain('cross-round-drift')
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run packages/core/tests/narrate/validate.test.ts`
Expected: FAIL，无法解析 `../../src/narrate/validate.js`

- [ ] **Step 3: 实现**

`packages/core/src/narrate/validate.ts`：

```ts
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

export interface ValidationIssue {
  code: ValidationCode
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
      issues.push({ code: 'hunk-missing', message: `hunk ${id} 没有被分配到任何章节` })
    }
  }
  for (const [id, n] of seenHunks) {
    if (!knownHunks.has(id)) {
      issues.push({ code: 'hunk-unknown', message: `hunk ${id} 不存在于本轮改动中` })
    } else if (n > 1) {
      issues.push({ code: 'hunk-duplicated', message: `hunk ${id} 被分配了 ${n} 次` })
    }
  }
  for (const p of knownFiles) {
    if (!seenFiles.has(p)) {
      issues.push({ code: 'file-missing', message: `文件 ${p} 没有被分配到任何章节` })
    }
  }
  for (const [p, n] of seenFiles) {
    if (!knownFiles.has(p)) {
      issues.push({ code: 'file-unknown', message: `文件 ${p} 不存在于本轮改动中` })
    } else if (n > 1) {
      issues.push({ code: 'file-duplicated', message: `文件 ${p} 被分配了 ${n} 次` })
    }
  }

  if (ctx.previous !== undefined) {
    const before = new Map<string, number>()
    for (const ch of ctx.previous.chapters) {
      for (const p of ch.filePaths) before.set(p, ch.index)
    }
    const after = new Map<string, number>()
    for (const ch of plan.chapters) {
      for (const p of ch.filePaths) after.set(p, ch.index)
    }
    for (const [p, wasIndex] of before) {
      const nowIndex = after.get(p)
      if (nowIndex !== undefined && nowIndex !== wasIndex) {
        issues.push({
          code: 'cross-round-drift',
          message: `文件 ${p} 上一轮在第 ${wasIndex} 章，本轮变成第 ${nowIndex} 章；批注会漂移`,
        })
      }
    }
  }

  return issues
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run packages/core/tests/narrate/validate.test.ts`
Expected: PASS（6 passed）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/narrate/validate.ts packages/core/tests/narrate/validate.test.ts
git commit -m 'feat(core): plan 的语义校验'
```

---

### Task 7: replay —— 按章重提交

**Files:**
- Create: `packages/core/src/narrate/compose.ts`
- Create: `packages/core/src/narrate/replay.ts`
- Create: `packages/core/tests/narrate/compose.test.ts`
- Create: `packages/core/tests/narrate/replay.test.ts`

**Interfaces:**
- Consumes: `git` (Task 2)、`FileChange`/`Hunk` (Task 4)、`Plan` (Task 5)
- Produces:
  - `composeContent(baseContent: string, hunks: Hunk[]): string` —— 把 base 内容按选中的 hunk 子集合成
  - `interface ReplayResult { commits: string[]; tip: string }`
  - `replay(repo: string, plan: Plan, changes: FileChange[]): Promise<ReplayResult>`

- [ ] **Step 1: 写 composeContent 的失败测试**

`packages/core/tests/narrate/compose.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { composeContent } from '../../src/narrate/compose.js'
import type { Hunk } from '../../src/narrate/diff.js'

const h = (p: Partial<Hunk> & Pick<Hunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines' | 'lines'>): Hunk =>
  ({ id: 'x#0', ...p })

describe('composeContent', () => {
  it('空 hunk 集合时原样返回 base 内容', () => {
    expect(composeContent('a\nb\nc\n', [])).toBe('a\nb\nc\n')
  })

  it('应用单个替换 hunk', () => {
    const hunk = h({ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-b', '+B'] })
    expect(composeContent('a\nb\nc\n', [hunk])).toBe('a\nB\nc\n')
  })

  it('应用两个不相邻 hunk，行号偏移正确', () => {
    const h1 = h({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+A1', '+A2'] })
    const h2 = h({ oldStart: 3, oldLines: 1, newStart: 4, newLines: 1, lines: ['-c', '+C'] })
    expect(composeContent('a\nb\nc\n', [h1, h2])).toBe('A1\nA2\nb\nC\n')
  })

  it('只应用子集时，未选中的 hunk 保持 base 态', () => {
    const h1 = h({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] })
    const h2 = h({ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-c', '+C'] })
    expect(composeContent('a\nb\nc\n', [h2])).toBe('a\nb\nC\n')
    expect(composeContent('a\nb\nc\n', [h1])).toBe('A\nb\nc\n')
  })

  it('保留没有结尾换行的文件形态', () => {
    const hunk = h({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '\\ No newline at end of file', '+A', '\\ No newline at end of file'] })
    expect(composeContent('a', [hunk])).toBe('A')
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run packages/core/tests/narrate/compose.test.ts`
Expected: FAIL，无法解析 `../../src/narrate/compose.js`

- [ ] **Step 3: 实现 composeContent**

`packages/core/src/narrate/compose.ts`：

```ts
import type { Hunk } from './diff.js'

/** 把内容切成行数组；保留「有无结尾换行」的信息 */
function splitLines(content: string): { lines: string[]; trailingNewline: boolean } {
  if (content === '') return { lines: [], trailingNewline: true }
  const trailingNewline = content.endsWith('\n')
  const body = trailingNewline ? content.slice(0, -1) : content
  return { lines: body.split('\n'), trailingNewline }
}

/**
 * 把 base 内容按选中的 hunk 子集合成新内容。
 *
 * 全部 hunk 来自同一 base 的同一份 diff，所以取任意子集应用都是确定且
 * 唯一的——不存在三方合并、不可能冲突（spec §6.5）。
 */
export function composeContent(baseContent: string, hunks: Hunk[]): string {
  const { lines, trailingNewline } = splitLines(baseContent)
  const ordered = [...hunks].sort((a, b) => a.oldStart - b.oldStart)

  const out: string[] = []
  let cursor = 0 // 已消费到 base 的第几行（0-based）
  let endsWithoutNewline = false

  for (const hunk of ordered) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1
    for (let i = cursor; i < start; i += 1) out.push(lines[i]!)
    cursor = start

    let prevMarker = ''
    for (const raw of hunk.lines) {
      const marker = raw[0]
      const text = raw.slice(1)
      // `\ No newline` 描述的是它上一行所属的那一侧。只有跟在 '+' 或 ' '
      // 后面时才说明「新内容」没有结尾换行；跟在 '-' 后面说的是旧内容。
      if (raw.startsWith('\\ No newline at end of file')) {
        if (prevMarker === '+' || prevMarker === ' ') endsWithoutNewline = true
        continue
      }
      prevMarker = marker ?? ''
      if (marker === ' ') {
        out.push(text)
        cursor += 1
      } else if (marker === '-') {
        cursor += 1
      } else if (marker === '+') {
        out.push(text)
      }
    }
  }

  for (let i = cursor; i < lines.length; i += 1) out.push(lines[i]!)

  if (out.length === 0) return ''
  const joined = out.join('\n')
  const keepNewline = endsWithoutNewline ? false : trailingNewline
  return keepNewline ? `${joined}\n` : joined
}
```

- [ ] **Step 4: 运行 compose 测试，确认通过**

Run: `pnpm vitest run packages/core/tests/narrate/compose.test.ts`
Expected: PASS（5 passed）

- [ ] **Step 5: 写 replay 的失败测试**

`packages/core/tests/narrate/replay.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { createTempRepo } from '../helpers/repo.js'
import { computeChanges } from '../../src/narrate/diff.js'
import { RulePlanner } from '../../src/narrate/rule-planner.js'
import { replay } from '../../src/narrate/replay.js'

describe('replay', () => {
  it('终态 tree 与 snapshot tree 逐字节一致', async () => {
    const repo = await createTempRepo()
    await repo.write('src/types.ts', 'export type T = 1\n')
    await repo.write('src/engine.ts', 'export const run = () => 1\n')
    await repo.write('README.md', 'old\n')
    const base = await repo.commit('base')

    await repo.write('src/types.ts', 'export type T = 2\n')
    await repo.write('src/engine.ts', 'export const run = () => 2\n')
    await repo.write('README.md', 'new\n')
    await repo.write('src/added.ts', 'export const added = true\n')
    const head = await repo.commit('work')

    const changes = await computeChanges(repo.dir, base, head)
    const plan = await new RulePlanner().plan({ base, snapshot: head, changes })
    const result = await replay(repo.dir, plan, changes)

    expect(await repo.git('rev-parse', `${result.tip}^{tree}`)).toBe(
      await repo.git('rev-parse', `${head}^{tree}`),
    )
    expect(result.commits.length).toBe(plan.chapters.length)
    await repo.cleanup()
  })

  it('中间 commit 只含到本章为止的改动', async () => {
    const repo = await createTempRepo()
    await repo.write('src/types.ts', 'A\n')
    await repo.write('src/engine.ts', 'B\n')
    const base = await repo.commit('base')
    await repo.write('src/types.ts', 'A2\n')
    await repo.write('src/engine.ts', 'B2\n')
    const head = await repo.commit('work')

    const changes = await computeChanges(repo.dir, base, head)
    const plan = await new RulePlanner().plan({ base, snapshot: head, changes })
    const result = await replay(repo.dir, plan, changes)

    const first = result.commits[0]!
    expect(await repo.git('cat-file', 'blob', `${first}:src/types.ts`)).toBe('A2')
    expect(await repo.git('cat-file', 'blob', `${first}:src/engine.ts`)).toBe('B')
    await repo.cleanup()
  })

  it('删除的文件在其所属章节被移除', async () => {
    const repo = await createTempRepo()
    await repo.write('src/engine.ts', 'keep\n')
    await repo.write('src/gone.ts', 'bye\n')
    const base = await repo.commit('base')
    await repo.rm('src/gone.ts')
    const head = await repo.commit('delete')

    const changes = await computeChanges(repo.dir, base, head)
    const plan = await new RulePlanner().plan({ base, snapshot: head, changes })
    const result = await replay(repo.dir, plan, changes)

    const files = await repo.git('ls-tree', '-r', '--name-only', result.tip)
    expect(files.split('\n')).not.toContain('src/gone.ts')
    expect(await repo.git('rev-parse', `${result.tip}^{tree}`)).toBe(
      await repo.git('rev-parse', `${head}^{tree}`),
    )
    await repo.cleanup()
  })

  it('文件内分章：同一文件的 hunk 拆到两章时，中间态只含前一章的改动', async () => {
    const repo = await createTempRepo()
    const base12 = `${Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join('\n')}\n`
    await repo.write('src/engine.ts', base12)
    const base = await repo.commit('base')
    await repo.write('src/engine.ts', base12.replace('l1\n', 'L1\n').replace('l12\n', 'L12\n'))
    const head = await repo.commit('work')

    const changes = await computeChanges(repo.dir, base, head)
    const file = changes[0]!
    expect(file.hunks.length).toBe(2)

    // 手工造一个把两个 hunk 拆到两章的 plan。v1 的 RulePlanner 不会这么排，
    // 但 replay 必须已经支持——这正是 spec §6.5 说的「接口 v1 就定死」。
    const plan = {
      version: 1 as const,
      base,
      snapshot: head,
      plannerId: 'manual',
      chapters: [
        { index: 1, title: '前半', intro: 'i', hunkIds: [file.hunks[0]!.id], filePaths: [] },
        { index: 2, title: '后半', intro: 'i', hunkIds: [file.hunks[1]!.id], filePaths: ['src/engine.ts'] },
      ],
    }

    const result = await replay(repo.dir, plan, changes)
    const mid = (await repo.git('cat-file', 'blob', `${result.commits[0]!}:src/engine.ts`)).split('\n')
    expect(mid[0]).toBe('L1')   // 第 1 章的改动已落地
    expect(mid[11]).toBe('l12') // 第 2 章的改动还没落地

    expect(await repo.git('rev-parse', `${result.tip}^{tree}`)).toBe(
      await repo.git('rev-parse', `${head}^{tree}`),
    )
    await repo.cleanup()
  })

  it('二进制文件整体替换且不破坏字节一致', async () => {
    const repo = await createTempRepo()
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFile(join(repo.dir, 'img.bin'), Buffer.from([0, 1, 2, 0]))
    await repo.write('src/engine.ts', 'x\n')
    const base = await repo.commit('base')
    await writeFile(join(repo.dir, 'img.bin'), Buffer.from([0, 9, 8, 0]))
    const head = await repo.commit('work')

    const changes = await computeChanges(repo.dir, base, head)
    const plan = await new RulePlanner().plan({ base, snapshot: head, changes })
    const result = await replay(repo.dir, plan, changes)

    expect(await repo.git('rev-parse', `${result.tip}^{tree}`)).toBe(
      await repo.git('rev-parse', `${head}^{tree}`),
    )
    await repo.cleanup()
  })
})
```

- [ ] **Step 6: 运行，确认失败**

Run: `pnpm vitest run packages/core/tests/narrate/replay.test.ts`
Expected: FAIL，无法解析 `../../src/narrate/replay.js`

- [ ] **Step 7: 实现 replay**

`packages/core/src/narrate/replay.ts`：

```ts
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from '../git/exec.js'
import { composeContent } from './compose.js'
import type { FileChange, Hunk } from './diff.js'
import type { Plan } from './plan.js'

export interface ReplayResult {
  /** 逐章的 commit sha，顺序与 plan.chapters 一致 */
  commits: string[]
  /** 最后一章的 commit，即叙事分支 tip */
  tip: string
}

const REPLAY_INDEX = 'unfold-replay-index'

/**
 * 按章重提交（spec §6.2）。纯 plumbing：不 checkout、不 apply patch。
 *
 * 快路径：一个文件的全部 hunk 都落在同一章时，直接复用终态 blob sha，
 * 天然逐字节一致。慢路径（文件内分章，v2）才走 composeContent。
 */
export async function replay(
  repo: string,
  plan: Plan,
  changes: FileChange[],
): Promise<ReplayResult> {
  const byPath = new Map(changes.map((c) => [c.path, c]))
  const gitDir = await git(repo, ['rev-parse', '--absolute-git-dir'])
  const indexPath = join(gitDir, REPLAY_INDEX)
  await rm(indexPath, { force: true })
  const env = { GIT_INDEX_FILE: indexPath }

  try {
    await git(repo, ['read-tree', plan.base], { env })

    // 累计每个文件到目前为止已应用的 hunk
    const applied = new Map<string, Hunk[]>()
    const commits: string[] = []
    let parent = plan.base

    for (const chapter of plan.chapters) {
      const chapterHunkIds = new Set(chapter.hunkIds)
      const touched = new Set<string>(chapter.filePaths)
      for (const id of chapter.hunkIds) touched.add(id.slice(0, id.lastIndexOf('#')))

      for (const path of touched) {
        const change = byPath.get(path)
        if (change === undefined) continue

        const chapterHunks = change.hunks.filter((h) => chapterHunkIds.has(h.id))
        const soFar = [...(applied.get(path) ?? []), ...chapterHunks]
        applied.set(path, soFar)

        const isComplete = soFar.length === change.hunks.length

        if (change.kind === 'delete') {
          // 删除在「第一个涉及它的章节」落地。终态正确性不受影响；
          // 若将来要让删除也分章呈现，改这里。
          await git(repo, ['update-index', '--force-remove', '--', path], { env })
          continue
        }

        if (change.binary || isComplete) {
          // 快路径：直接用终态 blob，逐字节一致
          await git(repo, [
            'update-index', '--add', '--cacheinfo',
            `${change.mode},${change.blob!},${path}`,
          ], { env })
          continue
        }

        // 慢路径：合成中间态内容（文件内分章，v2 才会走到）
        // trim: false —— 结尾换行是内容的一部分，不能被吃掉
        const baseContent =
          change.oldBlob === null
            ? ''
            : await git(repo, ['cat-file', 'blob', change.oldBlob], { trim: false })
        const composed = composeContent(baseContent, soFar)
        const blob = await git(repo, ['hash-object', '-w', '--stdin'], { input: composed })
        await git(repo, [
          'update-index', '--add', '--cacheinfo', `${change.mode},${blob},${path}`,
        ], { env })
      }

      const tree = await git(repo, ['write-tree'], { env })
      const message = `${chapter.title}\n\n${chapter.intro}\n`
      const commit = await git(repo, ['commit-tree', tree, '-p', parent, '-m', message])
      commits.push(commit)
      parent = commit
    }

    return { commits, tip: parent }
  } finally {
    await rm(indexPath, { force: true })
    await rm(`${indexPath}.lock`, { force: true })
  }
}
```

- [ ] **Step 8: 运行 replay 测试，确认通过**

Run: `pnpm vitest run packages/core/tests/narrate/replay.test.ts`
Expected: PASS（5 passed）

- [ ] **Step 9: 提交**

```bash
git add packages/core/src/narrate/compose.ts packages/core/src/narrate/replay.ts packages/core/tests/narrate/compose.test.ts packages/core/tests/narrate/replay.test.ts
git commit -m 'feat(core): replay 按章重提交'
```

---

### Task 8: verify 与叙事 worktree

**Files:**
- Create: `packages/core/src/narrate/verify.ts`
- Create: `packages/core/src/git/worktree.ts`
- Create: `packages/core/tests/narrate/verify.test.ts`
- Create: `packages/core/tests/git/worktree.test.ts`

**Interfaces:**
- Consumes: `git` (Task 2)
- Produces:
  - `class VerifyError extends Error { readonly expectedTree: string; readonly actualTree: string }`
  - `verify(repo: string, tip: string, snapshotCommit: string): Promise<void>` —— 不等即抛 `VerifyError`
  - `addWorktree(repo: string, path: string, commit: string): Promise<void>` —— detached
  - `attachWorktree(worktreePath: string, branch: string, commit: string): Promise<void>`
  - `removeWorktree(repo: string, path: string): Promise<void>`

- [ ] **Step 1: 写失败测试**

`packages/core/tests/narrate/verify.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { createTempRepo } from '../helpers/repo.js'
import { verify, VerifyError } from '../../src/narrate/verify.js'

describe('verify', () => {
  it('tree 相同时通过', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'x\n')
    const head = await repo.commit('base')
    const tree = await repo.git('rev-parse', `${head}^{tree}`)
    const other = await repo.git('commit-tree', tree, '-m', 'same tree')
    await expect(verify(repo.dir, other, head)).resolves.toBeUndefined()
    await repo.cleanup()
  })

  it('tree 不同时抛 VerifyError 且带上两个 tree sha', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'x\n')
    const first = await repo.commit('base')
    await repo.write('a.txt', 'y\n')
    const second = await repo.commit('changed')
    await expect(verify(repo.dir, second, first)).rejects.toBeInstanceOf(VerifyError)
    await repo.cleanup()
  })
})
```

`packages/core/tests/git/worktree.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTempRepo } from '../helpers/repo.js'
import { addWorktree, attachWorktree, removeWorktree } from '../../src/git/worktree.js'

async function fingerprint(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const abs = join(d, entry.name)
      const rel = `${prefix}${entry.name}`
      if (entry.isDirectory()) await walk(abs, `${rel}/`)
      else {
        const s = await stat(abs)
        out.push(`${rel} ${s.mtimeMs} ${s.ino}`)
      }
    }
  }
  await walk(dir, '')
  return out.sort()
}

describe('worktree', () => {
  it('挂到 tree 一致的叙事分支时，一个文件都不写', async () => {
    const repo = await createTempRepo()
    await repo.write('src/a.ts', 'a\n')
    await repo.write('src/b.ts', 'b\n')
    const head = await repo.commit('base')
    const tree = await repo.git('rev-parse', `${head}^{tree}`)

    const wtDir = join(await mkdtemp(join(tmpdir(), 'unfold-wt-')), 'work')
    await addWorktree(repo.dir, wtDir, head)
    const before = await fingerprint(wtDir)
    expect(before.length).toBe(2)

    // 造一个 tree 相同、历史不同的 tip
    const mid = await repo.git('commit-tree', tree, '-p', head, '-m', 'ch1')
    await attachWorktree(wtDir, 'unfold/test', mid)

    expect(await fingerprint(wtDir)).toEqual(before)
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: wtDir })
    expect(stdout).toBe('')

    await removeWorktree(repo.dir, wtDir)
    await repo.cleanup()
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run packages/core/tests/narrate/verify.test.ts packages/core/tests/git/worktree.test.ts`
Expected: FAIL，无法解析 `verify.js` 与 `worktree.js`

- [ ] **Step 3: 实现 verify**

`packages/core/src/narrate/verify.ts`：

```ts
import { git } from '../git/exec.js'

export class VerifyError extends Error {
  constructor(
    readonly expectedTree: string,
    readonly actualTree: string,
  ) {
    super(
      `叙事分支的终态 tree 与快照不一致：期望 ${expectedTree}，实际 ${actualTree}。` +
        `拒绝出货——有改动没有被分进任何章节。`,
    )
    this.name = 'VerifyError'
  }
}

/**
 * 字节一致校验（spec §6.3）。这是产品承诺，不降级：不等就中止。
 */
export async function verify(
  repo: string,
  tip: string,
  snapshotCommit: string,
): Promise<void> {
  const expected = await git(repo, ['rev-parse', `${snapshotCommit}^{tree}`])
  const actual = await git(repo, ['rev-parse', `${tip}^{tree}`])
  if (expected !== actual) throw new VerifyError(expected, actual)
}
```

- [ ] **Step 4: 实现 worktree 管理**

`packages/core/src/git/worktree.ts`：

```ts
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { git } from './exec.js'

/** 在 path 处开一个 detached worktree，检出 commit。 */
export async function addWorktree(
  repo: string,
  path: string,
  commit: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await git(repo, ['worktree', 'add', '-q', '--detach', path, commit])
}

/**
 * 把已存在的 worktree 挂到叙事分支上。
 *
 * 当 commit 的 tree 与 worktree 当前内容一致时（这正是 spec §6.3 的不变量），
 * git 比对两棵树发现无差异，一个文件都不写——轨道 A 建好的 LSP 索引不会
 * 被冲掉（spec §3）。
 */
export async function attachWorktree(
  worktreePath: string,
  branch: string,
  commit: string,
): Promise<void> {
  await git(worktreePath, ['checkout', '-q', '-B', branch, commit])
}

/** 拆掉 worktree 并清理管理信息。 */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', path])
  await git(repo, ['worktree', 'prune'])
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm vitest run packages/core/tests/narrate/verify.test.ts packages/core/tests/git/worktree.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/narrate/verify.ts packages/core/src/git/worktree.ts packages/core/tests/narrate/verify.test.ts packages/core/tests/git/worktree.test.ts
git commit -m 'feat(core): 字节一致校验与叙事 worktree'
```

---

### Task 9: CodeTour 导出

**Files:**
- Create: `packages/core/src/tour/codetour.ts`
- Create: `packages/core/tests/tour/codetour.test.ts`

**Interfaces:**
- Consumes: `Plan` (Task 5)、`FileChange` (Task 4)
- Produces:
  - `interface CodeTourStep { file: string; line: number; description: string }`
  - `interface CodeTour { $schema: string; title: string; description: string; ref: string; steps: CodeTourStep[] }`
  - `toCodeTours(plan: Plan, changes: FileChange[], ref: string): CodeTour[]` —— 一章一个 tour

- [ ] **Step 1: 写失败测试**

`packages/core/tests/tour/codetour.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { toCodeTours } from '../../src/tour/codetour.js'
import type { Plan } from '../../src/narrate/plan.js'
import type { FileChange } from '../../src/narrate/diff.js'

const change = (path: string, newStart: number): FileChange => ({
  path, kind: 'modify', binary: false, mode: '100644',
  blob: 'b'.repeat(40), oldMode: '100644', oldBlob: 'a'.repeat(40),
  hunks: [{ id: `${path}#0`, oldStart: newStart, oldLines: 1, newStart, newLines: 1, lines: ['-x', '+y'] }],
})

const plan: Plan = {
  version: 1, base: 'a'.repeat(40), snapshot: 'b'.repeat(40), plannerId: 'rule',
  chapters: [
    { index: 1, title: '第 1 层：契约', intro: '先看类型。', hunkIds: ['src/types.ts#0'], filePaths: ['src/types.ts'] },
    { index: 2, title: '其余', intro: '兜底。', hunkIds: ['src/engine.ts#0'], filePaths: ['src/engine.ts'] },
  ],
}

describe('toCodeTours', () => {
  it('一章一个 tour，step 指向该章 hunk 的新行号', () => {
    const tours = toCodeTours(plan, [change('src/types.ts', 12), change('src/engine.ts', 40)], 'unfold/rev-1')
    expect(tours.length).toBe(2)
    expect(tours[0]!.title).toBe('1. 第 1 层：契约')
    expect(tours[0]!.description).toBe('先看类型。')
    expect(tours[0]!.ref).toBe('unfold/rev-1')
    expect(tours[0]!.steps).toEqual([
      { file: 'src/types.ts', line: 12, description: '第 1 层：契约 — src/types.ts' },
    ])
    expect(tours[1]!.steps[0]!.line).toBe(40)
  })

  it('无 hunk 的文件（二进制）也产一个指向第 1 行的 step', () => {
    const binary: FileChange = {
      path: 'img.bin', kind: 'modify', binary: true, mode: '100644',
      blob: 'b'.repeat(40), oldMode: '100644', oldBlob: 'a'.repeat(40), hunks: [],
    }
    const p: Plan = { ...plan, chapters: [{ index: 1, title: '其余', intro: 'x', hunkIds: [], filePaths: ['img.bin'] }] }
    const tours = toCodeTours(p, [binary], 'unfold/rev-1')
    expect(tours[0]!.steps).toEqual([
      { file: 'img.bin', line: 1, description: '其余 — img.bin' },
    ])
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run packages/core/tests/tour/codetour.test.ts`
Expected: FAIL，无法解析 `../../src/tour/codetour.js`

- [ ] **Step 3: 实现**

`packages/core/src/tour/codetour.ts`：

```ts
import type { FileChange } from '../narrate/diff.js'
import type { Plan } from '../narrate/plan.js'

export interface CodeTourStep {
  file: string
  line: number
  description: string
}

export interface CodeTour {
  $schema: string
  title: string
  description: string
  ref: string
  steps: CodeTourStep[]
}

const SCHEMA = 'https://aka.ms/codetour-schema'

/**
 * 章节导出成 CodeTour（spec §6.6）：一章 = 一个 tour，指路锚点 = step。
 * 借现成格式而不自己发明，且与 CodeTour 扩展互操作。
 */
export function toCodeTours(plan: Plan, changes: FileChange[], ref: string): CodeTour[] {
  const byPath = new Map(changes.map((c) => [c.path, c]))

  return plan.chapters.map((chapter) => {
    const steps: CodeTourStep[] = []
    const seen = new Set<string>()

    for (const id of chapter.hunkIds) {
      const path = id.slice(0, id.lastIndexOf('#'))
      const change = byPath.get(path)
      if (change === undefined) continue
      const hunk = change.hunks.find((h) => h.id === id)
      if (hunk === undefined) continue
      steps.push({
        file: path,
        line: Math.max(1, hunk.newStart),
        description: `${chapter.title} — ${path}`,
      })
      seen.add(path)
    }

    for (const path of chapter.filePaths) {
      if (seen.has(path)) continue
      steps.push({ file: path, line: 1, description: `${chapter.title} — ${path}` })
    }

    return {
      $schema: SCHEMA,
      title: `${chapter.index}. ${chapter.title}`,
      description: chapter.intro,
      ref,
      steps,
    }
  })
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run packages/core/tests/tour/codetour.test.ts`
Expected: PASS（2 passed）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/tour packages/core/tests/tour
git commit -m 'feat(core): CodeTour 导出'
```

---

### Task 10: `unfold narrate` CLI 与端到端集成

**Files:**
- Create: `packages/core/src/state/paths.ts`
- Create: `packages/core/src/narrate/run.ts`
- Create: `packages/core/src/bin/unfold.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/tests/narrate/run.test.ts`

**Interfaces:**
- Consumes: 前九个 Task 的全部导出
- Produces:
  - `repoId(repo: string): Promise<string>` —— `<仓库根目录名>-<git-common-dir 绝对路径 sha256 前 8 位>`
  - `newReviewId(branch: string, now?: Date): string` —— `<分支 slug>-<YYYYMMDD-HHMMSS>`
  - `reviewRoot(repo: string, reviewId: string): Promise<string>` —— `~/.local/state/unfold/<repo-id>/<review-id>`
  - `interface NarrateResult { reviewId: string; reviewRoot: string; branch: string; base: string; snapshot: string; tip: string; chapters: number; worktree: string }`
  - `narrate(repo: string, opts?: { explicit?: string; defaultBranch?: string; now?: Date }): Promise<NarrateResult>`

- [ ] **Step 1: 写失败的端到端测试**

`packages/core/tests/narrate/run.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempRepo } from '../helpers/repo.js'
import { narrate } from '../../src/narrate/run.js'
import { newReviewId } from '../../src/state/paths.js'

describe('newReviewId', () => {
  it('由分支 slug 与时间戳组成', () => {
    const id = newReviewId('feat/charybdis', new Date(Date.UTC(2026, 8, 15, 6, 7, 8)))
    expect(id).toMatch(/^feat-charybdis-20260915-\d{6}$/)
  })
})

describe('narrate 端到端', () => {
  it('从脏工作区产出叙事分支，字节一致，且原工作区零改动', async () => {
    const repo = await createTempRepo()
    await repo.write('src/types.ts', 'export type T = 1\n')
    await repo.write('src/engine.ts', 'export const run = () => 1\n')
    await repo.commit('base')
    await repo.git('checkout', '-q', '-b', 'feature')

    // agent 干完活但没 commit
    await repo.write('src/types.ts', 'export type T = 2\n')
    await repo.write('src/engine.ts', 'export const run = () => 2\n')
    await repo.write('src/added.ts', 'export const added = true\n')

    const statusBefore = await repo.git('status', '--porcelain')
    const headBefore = await repo.git('rev-parse', 'HEAD')

    const result = await narrate(repo.dir, { defaultBranch: 'main' })

    // 字节一致
    expect(await repo.git('rev-parse', `${result.tip}^{tree}`)).toBe(
      await repo.git('rev-parse', `${result.snapshot}^{tree}`),
    )
    // 原工作区零改动
    expect(await repo.git('status', '--porcelain')).toBe(statusBefore)
    expect(await repo.git('rev-parse', 'HEAD')).toBe(headBefore)
    expect(await repo.git('stash', 'list')).toBe('')

    // 产物齐全
    const planJson = JSON.parse(await readFile(join(result.reviewRoot, 'plan.json'), 'utf8')) as {
      version: number
      chapters: unknown[]
    }
    expect(planJson.version).toBe(1)
    expect(planJson.chapters.length).toBe(result.chapters)

    const meta = JSON.parse(await readFile(join(result.reviewRoot, 'meta.json'), 'utf8')) as {
      base: string
      branch: string
    }
    expect(meta.base).toBe(result.base)

    const tour = JSON.parse(
      await readFile(join(result.reviewRoot, 'tours', 'chapter-001.tour'), 'utf8'),
    ) as { steps: unknown[] }
    expect(tour.steps.length).toBeGreaterThan(0)

    // 快照被钉住，扛得过 gc
    await repo.git('reflog', 'expire', '--expire=now', '--all')
    await repo.git('gc', '--prune=now', '-q')
    expect(await repo.git('cat-file', '-t', result.snapshot)).toBe('commit')

    // worktree 挂在叙事分支上
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: result.worktree,
    })
    expect(stdout.trim()).toBe(result.branch)

    await rm(result.reviewRoot, { recursive: true, force: true })
    await repo.cleanup()
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run packages/core/tests/narrate/run.test.ts`
Expected: FAIL，无法解析 `../../src/narrate/run.js`

- [ ] **Step 3: 实现路径与标识符**

`packages/core/src/state/paths.ts`：

```ts
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { git } from '../git/exec.js'

/**
 * `<仓库根目录名>-<git-common-dir 绝对路径的 sha256 前 8 位>`（spec §8.1）。
 * 取 common dir 而非 worktree 路径，使同一仓库的多个 worktree 落在同一个 repo-id 下。
 */
export async function repoId(repo: string): Promise<string> {
  const commonDir = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const root = basename(commonDir.replace(/\/\.git$/, '')) || 'repo'
  const hash = createHash('sha256').update(commonDir).digest('hex').slice(0, 8)
  return `${root}-${hash}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `<分支 slug>-<YYYYMMDD-HHMMSS>`（spec §8.1） */
export function newReviewId(branch: string, now: Date = new Date()): string {
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'detached'
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `${slug}-${stamp}`
}

/** `~/.local/state/unfold/<repo-id>/<review-id>`（spec §8.1，状态一律在仓库外） */
export async function reviewRoot(repo: string, reviewId: string): Promise<string> {
  const base = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state')
  return join(base, 'unfold', await repoId(repo), reviewId)
}
```

- [ ] **Step 4: 实现 narrate 编排**

`packages/core/src/narrate/run.ts`：

```ts
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

export interface NarrateResult {
  reviewId: string
  reviewRoot: string
  branch: string
  base: string
  snapshot: string
  tip: string
  chapters: number
  worktree: string
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
 */
export async function narrate(
  repo: string,
  opts: NarrateOptions = {},
): Promise<NarrateResult> {
  const branch = await currentBranch(repo)
  const reviewId = newReviewId(branch, opts.now)
  const root = await reviewRoot(repo, reviewId)
  await mkdir(join(root, 'tours'), { recursive: true })

  // 2. 快照 + 钉 ref
  const snap = await snapshot(repo)
  await pinSnapshot(repo, reviewId, 1, snap.commit)

  // 轨道 A：worktree 直接停在终态
  const worktree = join(root, 'worktree')
  await addWorktree(repo, worktree, snap.commit)

  // 轨道 B：base → 规划 → 重提交 → 校验
  const baseResolution = await resolveBase(repo, {
    ...(opts.explicit !== undefined ? { explicit: opts.explicit } : {}),
    ...(opts.defaultBranch !== undefined ? { defaultBranch: opts.defaultBranch } : {}),
  })
  const changes = await computeChanges(repo, baseResolution.base, snap.commit)
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
```

- [ ] **Step 5: 运行端到端测试，确认通过**

Run: `pnpm vitest run packages/core/tests/narrate/run.test.ts`
Expected: PASS（2 passed）

- [ ] **Step 6: 实现 CLI 入口**

`packages/core/src/bin/unfold.ts`：

```ts
#!/usr/bin/env node
import { narrate } from '../narrate/run.js'

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
  const [command, ...rest] = argv
  if (command !== 'narrate') usage()

  let repo = process.cwd()
  let explicit: string | undefined
  let defaultBranch: string | undefined

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    const value = rest[i + 1]
    if (flag === '--base' && value !== undefined) { explicit = value; i += 1 }
    else if (flag === '--default-branch' && value !== undefined) { defaultBranch = value; i += 1 }
    else if (flag === '--repo' && value !== undefined) { repo = value; i += 1 }
    else usage()
  }

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
```

`packages/core/src/index.ts` 改为：

```ts
export { git, GitError } from './git/exec.js'
export { snapshot, pinSnapshot, unpinReview } from './git/snapshot.js'
export type { Snapshot } from './git/snapshot.js'
export { resolveBase } from './git/range.js'
export type { BaseResolution, BaseSource } from './git/range.js'
export { addWorktree, attachWorktree, removeWorktree } from './git/worktree.js'
export { computeChanges } from './narrate/diff.js'
export type { FileChange, Hunk, ChangeKind } from './narrate/diff.js'
export type { Chapter, ChapterPlanner, Plan, PlanContext } from './narrate/plan.js'
export { RulePlanner, classifyPath } from './narrate/rule-planner.js'
export { validatePlan } from './narrate/validate.js'
export type { ValidationIssue, ValidationCode } from './narrate/validate.js'
export { composeContent } from './narrate/compose.js'
export { replay } from './narrate/replay.js'
export type { ReplayResult } from './narrate/replay.js'
export { verify, VerifyError } from './narrate/verify.js'
export { narrate } from './narrate/run.js'
export type { NarrateOptions, NarrateResult } from './narrate/run.js'
export { toCodeTours } from './tour/codetour.js'
export type { CodeTour, CodeTourStep } from './tour/codetour.js'
export { repoId, newReviewId, reviewRoot } from './state/paths.js'
```

- [ ] **Step 7: 构建并在真实仓库上手工验证一次**

```bash
pnpm build
cd /tmp && rm -rf unfold-smoke && mkdir unfold-smoke && cd unfold-smoke
git init -q -b main . && git config user.email t@t && git config user.name t
mkdir -p src && printf 'export type T = 1\n' > src/types.ts && printf 'export const run = () => 1\n' > src/engine.ts
git add -A && git commit -qm base && git checkout -q -b feature
printf 'export type T = 2\n' > src/types.ts && printf 'export const added = true\n' > src/added.ts
node <仓库路径>/packages/core/dist/bin/unfold.js narrate --default-branch main
git log --oneline --graph --all
git status --porcelain   # 必须仍然是脏的、且与运行前一致
```

Expected: 打印叙事分支与「tree 与快照字节一致」；`git log` 能看到逐章 commit；`git status` 显示原改动仍未提交。

- [ ] **Step 8: 全量测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS，typecheck 无输出

- [ ] **Step 9: 提交**

```bash
git add packages/core/src packages/core/tests
git commit -m 'feat(core): unfold narrate CLI 与端到端编排'
```

---

## 完成标准

Plan 1 做完时下面每条都应成立：

1. `pnpm test` 全绿，`pnpm typecheck` 无错
2. `unfold narrate` 在真实脏工作区上跑通，打印出叙事分支与章节数
3. `git status --porcelain` 在 narrate 前后逐字节相同——**零干扰**
4. `git stash list` 条数不变
5. `tree(叙事 tip) == tree(快照)`——**字节一致**
6. 快照 ref 扛得过 `git reflog expire --expire=now --all && git gc --prune=now`
7. `~/.local/state/unfold/<repo-id>/<review-id>/` 下有 `meta.json`、`plan.json`、`tours/chapter-*.tour`、`worktree/`
8. 仓库工作区里没有多出任何 Unfold 自己的文件
