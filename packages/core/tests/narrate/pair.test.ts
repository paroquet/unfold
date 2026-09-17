import { describe, it, expect } from 'vitest'
import { DEFAULT_PAIR_RULES, canonicalCandidates, canonicalPath, isPairable, roleOf } from '../../src/narrate/pair.js'
import type { FileRole } from '../../src/narrate/pair.js'

// 覆盖 roleOf 分类规则里编号的每一条，顺序对应 spec 里的判定顺序。
// 不再有「.github/ 整目录」规则——那条规则会把 .github/ 下的真代码
// （比如 release 脚本）连同它的测试一起从代码叙事里抽走，已删除，
// 交给下面的扩展名规则自己判（见 pair.ts 的 roleOf 注释）。
const ROLE_CASES: Array<[string, FileRole]> = [
  // 1. 精确文件名 → doc
  ['LICENSE', 'doc'],
  ['NOTICE', 'doc'],
  ['COPYING', 'doc'],
  ['CHANGELOG', 'doc'],
  ['AUTHORS', 'doc'],
  // 2. 精确文件名 → build。只有这三个「少了这条规则会被扩展名判错」：
  // requirements.txt 会被后面「.txt → doc」先接住；go.mod/go.sum 的扩展名
  // （.mod/.sum）不在任何清单里，落到「其余 → source」。
  ['requirements.txt', 'build'],
  ['go.mod', 'build'],
  ['go.sum', 'build'],
  // 3. 无真实扩展名 → build。Dockerfile/Makefile/Justfile/Procfile/Gemfile
  // 走的都是这条（没有精确文件名规则，也用不着——dot<=0 已经接住了它们）。
  ['Dockerfile', 'build'],
  ['Makefile', 'build'],
  ['Justfile', 'build'],
  ['Procfile', 'build'],
  ['Gemfile', 'build'],
  ['.gitignore', 'build'],
  ['.nvmrc', 'build'],
  ['a/.gitkeep', 'build'],
  // 4. 文件名含 .config. → build（大小写敏感，是已知且刻意搁置的缺口）
  ['a/vitest.config.ts', 'build'],
  ['a/b.CONFIG.ts', 'source'],
  // 5. 文档扩展名 → doc
  ['README.md', 'doc'],
  ['docs/getting-started.md', 'doc'],
  ['a/b.mdx', 'doc'],
  ['a/b.txt', 'doc'],
  ['a/b.rst', 'doc'],
  ['a/b.adoc', 'doc'],
  // 6. 文档资产扩展名 → doc
  ['a/logo.png', 'doc'],
  ['a/logo.svg', 'doc'],
  ['a/logo.webp', 'doc'],
  ['a/font.woff', 'doc'],
  ['a/font.woff2', 'doc'],
  ['a/font.ttf', 'doc'],
  ['a/manual.pdf', 'doc'],
  // 7. 构建/配置数据扩展名 → build。Gemfile.lock（.lock）与 .gitlab-ci.yml
  // （.yml）也走这条，不需要精确文件名规则。
  ['package.json', 'build'],
  ['pnpm-lock.yaml', 'build'],
  ['a/tsconfig.test.json', 'build'],
  ['a/config.toml', 'build'],
  ['a/settings.ini', 'build'],
  ['a/app.properties', 'build'],
  ['Gemfile.lock', 'build'],
  ['.gitlab-ci.yml', 'build'],
  // 8. 其余 → source
  ['a/b.ts', 'source'],
  ['a/b.test.ts', 'source'],
  ['run.sh', 'source'],
  ['a/b.min.js', 'source'],
  // .github/ 不再整目录判 build：里面的文件各按自己的扩展名走上面的规则。
  ['.github/workflows/ci.yml', 'build'],
  ['.github/ISSUE_TEMPLATE/bug.md', 'doc'],
  ['.github/CONTRIBUTING.md', 'doc'],
  ['.github/scripts/release.ts', 'source'],
  ['.github/scripts/label.py', 'source'],
]

describe('roleOf', () => {
  it.each(ROLE_CASES)('%s → %s', (path, role) => {
    expect(roleOf(path)).toBe(role)
  })

  it('isPairable 是 roleOf 的薄别名：只有 source 才可配对', () => {
    for (const [path] of ROLE_CASES) {
      expect(isPairable(path)).toBe(roleOf(path) === 'source')
    }
  })
})

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

  it('同一个目录段出现两次时，替换的是第一个——它才是源码集标记', () => {
    // dirs = ['app','test','kotlin','test']：indexOf 取 1，lastIndexOf 会取 3，
    // 两者产出不同的候选，这条测试才真的钉得住「替换第一个」
    const got = canonicalCandidates('app/test/kotlin/test/FooTest.kt', DEFAULT_PAIR_RULES)
    expect(got).toContain('app/src/kotlin/test/Foo.kt')
    expect(got).not.toContain('app/test/kotlin/src/Foo.kt')
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
