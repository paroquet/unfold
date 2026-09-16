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
