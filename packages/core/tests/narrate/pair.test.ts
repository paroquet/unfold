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
