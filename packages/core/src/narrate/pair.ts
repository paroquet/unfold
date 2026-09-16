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
