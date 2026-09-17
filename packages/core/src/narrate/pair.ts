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

/** 一个文件在叙事里扮演的角色：代码、构建配置，还是文档。 */
export type FileRole = 'source' | 'build' | 'doc'

// 精确文件名（不看扩展名）——先于扩展名判断，否则 requirements.txt
// 会被「.txt → doc」的规则先接住，变成一篇文档。
const DOC_EXACT_NAMES = new Set(['LICENSE', 'NOTICE', 'COPYING', 'CHANGELOG', 'AUTHORS'])
const BUILD_EXACT_NAMES = new Set([
  'Dockerfile', 'Makefile', 'Justfile', 'Procfile',
  'go.mod', 'go.sum', 'Gemfile', 'Gemfile.lock',
  'requirements.txt', '.gitlab-ci.yml',
])

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc'])
const DOC_ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.pdf', '.woff', '.woff2', '.ttf',
])
const BUILD_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.lock', '.properties'])

/**
 * 给一个路径判角色：source / build / doc。判定顺序本身是规则的一部分——
 * `requirements.txt` 必须在「精确文件名→build」这一步就被接住，否则会被
 * 后面「.txt→doc」的扩展名规则先命中，变成一篇文档；`.github/` 下的 `.yml`
 * 同理必须先按路径归为 build——不是靠扩展名巧合对上，是因为它就是 CI 配置。
 *
 * 文档、构建配置、占位文件没有对应的实现，`isPairable`（下面的薄别名）靠
 * 这个函数把它们排除在「谈得上有没有配套测试」之外：给它们规约出
 * canonical path 只会凭空造出不存在的路径——`tests/contract/.gitkeep`
 * 规约成 `src/contract/.gitkeep`，那个目录根本不存在。
 */
export function roleOf(path: string): FileRole {
  if (path === '.github' || path.startsWith('.github/')) return 'build'

  const slash = path.lastIndexOf('/')
  const name = slash < 0 ? path : path.slice(slash + 1)
  if (DOC_EXACT_NAMES.has(name)) return 'doc'
  if (BUILD_EXACT_NAMES.has(name)) return 'build'

  const dot = name.lastIndexOf('.')
  // 无真实扩展名：既包括 Makefile 形的名字，也包括 .gitignore / .nvmrc /
  // .gitkeep 这类纯点文件（此时 dot === 0）——两者都是仓库元数据。
  if (dot <= 0) return 'build'
  if (name.includes('.config.')) return 'build'

  const ext = name.slice(dot)
  if (DOC_EXTENSIONS.has(ext)) return 'doc'
  if (DOC_ASSET_EXTENSIONS.has(ext)) return 'doc'
  if (BUILD_EXTENSIONS.has(ext)) return 'build'
  return 'source'
}

/**
 * 这个路径是否「看起来是代码」，也就是谈得上有没有配套测试。
 * 薄别名：真正的判断在 `roleOf` 里，这里只是把 `isPairable` 的老调用点
 * 接到新的角色判断上，行为保持不变。
 */
export function isPairable(path: string): boolean {
  return roleOf(path) === 'source'
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
  if (!isPairable(path)) return []

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
