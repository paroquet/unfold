import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_RULES,
  classifyPath,
  loadRules,
  rulesFingerprint,
  validateRules,
} from '../../src/narrate/rules.js'
import type { NarrativeRules } from '../../src/narrate/rules.js'

const RULES: NarrativeRules = {
  version: 1,
  fallback: 'core',
  layers: [
    { key: 'contract', title: '契约', intro: 'i', match: ['**/schema{,s}/**', '**/*.d.ts'] },
    { key: 'core', title: '核心逻辑', intro: 'i' },
    { key: 'test-doc', title: '测试与文档', intro: 'i', priority: 0, match: ['**/test{,s}/**', '**/*.{test,spec}.*'] },
  ],
}

describe('classifyPath', () => {
  it('命中某层的 match 就归入该层', () => {
    expect(classifyPath('src/schema/user.ts', RULES)).toBe('contract')
    expect(classifyPath('src/a.d.ts', RULES)).toBe('contract')
  })

  it('谁都不命中时落到 fallback', () => {
    expect(classifyPath('src/engine.ts', RULES)).toBe('core')
  })

  it('priority 让 test-doc 插队：tests/schema/ 归测试而不是契约', () => {
    // 两层都能匹配上，靠 priority 0 决定归属
    expect(classifyPath('tests/schema/user.ts', RULES)).toBe('test-doc')
  })

  it('没有 priority 的层按它在 layers 里的位置排匹配次序（缺省 = 位置 + 1）', () => {
    const rules: NarrativeRules = {
      version: 1,
      fallback: 'z',
      layers: [
        { key: 'a', title: 'A', intro: 'i', match: ['src/**'] },
        { key: 'b', title: 'B', intro: 'i', match: ['src/**'] },
        { key: 'z', title: 'Z', intro: 'i' },
      ],
    }
    expect(classifyPath('src/x.ts', rules)).toBe('a')
  })
})

describe('DEFAULT_RULES', () => {
  it('与改造前写死的四层行为等价', () => {
    const cases: Array<[string, string]> = [
      ['src/types.ts', 'contract'],
      ['src/types/index.ts', 'contract'],
      ['api/schema.json', 'contract'],
      ['src/a.d.ts', 'contract'],
      ['src/engine/replay.ts', 'core'],
      ['src/apiClient.ts', 'core'],
      ['src/index.ts', 'wiring'],
      ['package.json', 'wiring'],
      ['tests/replay.test.ts', 'test-doc'],
      ['tests/types.ts', 'test-doc'],
      ['README.md', 'test-doc'],
      ['src/schema.test.ts', 'test-doc'],
    ]
    for (const [path, expected] of cases) {
      expect(classifyPath(path, DEFAULT_RULES), `${path} 应归 ${expected}`).toBe(expected)
    }
  })

  it('自身通过校验', () => {
    expect(() => validateRules(DEFAULT_RULES)).not.toThrow()
  })
})

describe('validateRules', () => {
  const ok = (): unknown => JSON.parse(JSON.stringify(RULES))

  it('version 不是 1 就报错', () => {
    const r = ok() as NarrativeRules
    ;(r as { version: number }).version = 2
    expect(() => validateRules(r)).toThrow(/version/)
  })

  it('layers 为空就报错', () => {
    expect(() => validateRules({ version: 1, fallback: 'a', layers: [] })).toThrow(/layers/)
  })

  it('key 重复就报错，并指名是哪个 key', () => {
    const r = {
      version: 1,
      fallback: 'a',
      layers: [
        { key: 'a', title: 'A', intro: 'i' },
        { key: 'a', title: 'A2', intro: 'i' },
      ],
    }
    expect(() => validateRules(r)).toThrow(/a/)
  })

  it('fallback 指向不存在的层就报错', () => {
    const r = { version: 1, fallback: 'nope', layers: [{ key: 'a', title: 'A', intro: 'i' }] }
    expect(() => validateRules(r)).toThrow(/nope/)
  })

  it('match 里混进非字符串就报错', () => {
    const r = {
      version: 1,
      fallback: 'a',
      layers: [{ key: 'a', title: 'A', intro: 'i', match: ['src/**', 42] }],
    }
    expect(() => validateRules(r)).toThrow(/match\[1\]/)
  })

  it('写坏的 glob 不报错——picomatch 很宽容，它只是匹配不到东西', () => {
    const r: NarrativeRules = {
      version: 1,
      fallback: 'a',
      layers: [{ key: 'a', title: 'A', intro: 'i', match: ['src/[unclosed'] }],
    }
    expect(() => validateRules(r)).not.toThrow()
    // 后果不是报错，而是这一层一个文件都接不到 —— 靠 --dry-run 的每章文件数发现
    expect(classifyPath('src/anything.ts', r)).toBe('a')
  })

  it('缺 title 或 intro 就报错', () => {
    expect(() =>
      validateRules({ version: 1, fallback: 'a', layers: [{ key: 'a', intro: 'i' }] }),
    ).toThrow(/title/)
  })
})

describe('rulesFingerprint', () => {
  const base = (): NarrativeRules => JSON.parse(JSON.stringify(RULES)) as NarrativeRules

  it('同一份规则指纹稳定', () => {
    expect(rulesFingerprint(base())).toBe(rulesFingerprint(base()))
  })

  it('改 title 或 intro 指纹不变——纯文案不该让批注失效', () => {
    const r = base()
    r.layers[0]!.title = '接口约定'
    r.layers[0]!.intro = '换个说法'
    expect(rulesFingerprint(r)).toBe(rulesFingerprint(base()))
  })

  it('改 match 指纹变', () => {
    const r = base()
    r.layers[0]!.match = ['**/different/**']
    expect(rulesFingerprint(r)).not.toBe(rulesFingerprint(base()))
  })

  it('改 fallback 指纹变', () => {
    const r = base()
    r.fallback = 'contract'
    expect(rulesFingerprint(r)).not.toBe(rulesFingerprint(base()))
  })

  it('改 priority 指纹变', () => {
    const r = base()
    r.layers[2]!.priority = 9
    expect(rulesFingerprint(r)).not.toBe(rulesFingerprint(base()))
  })

  it('调整 layers 顺序指纹变——顺序会改变缺省的匹配次序', () => {
    const r = base()
    const [a, b] = [r.layers[0]!, r.layers[1]!]
    r.layers[0] = b
    r.layers[1] = a
    expect(rulesFingerprint(r)).not.toBe(rulesFingerprint(base()))
  })
})

describe('loadRules', () => {
  it('都没给就用内置默认', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unfold-rules-'))
    expect(await loadRules({ repo: dir })).toEqual(DEFAULT_RULES)
    await rm(dir, { recursive: true, force: true })
  })

  it('仓库里有 .unfold/narrative.json 就用它', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unfold-rules-'))
    await mkdir(join(dir, '.unfold'), { recursive: true })
    await writeFile(join(dir, '.unfold', 'narrative.json'), JSON.stringify(RULES), 'utf8')
    const loaded = await loadRules({ repo: dir })
    expect(loaded.layers.map((l) => l.key)).toEqual(['contract', 'core', 'test-doc'])
    await rm(dir, { recursive: true, force: true })
  })

  it('--rules 覆盖仓库内的配置', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unfold-rules-'))
    await mkdir(join(dir, '.unfold'), { recursive: true })
    await writeFile(join(dir, '.unfold', 'narrative.json'), JSON.stringify(RULES), 'utf8')
    const other = join(dir, 'other.json')
    await writeFile(
      other,
      JSON.stringify({ version: 1, fallback: 'only', layers: [{ key: 'only', title: 'O', intro: 'i' }] }),
      'utf8',
    )
    const loaded = await loadRules({ repo: dir, explicitPath: other })
    expect(loaded.layers.map((l) => l.key)).toEqual(['only'])
    await rm(dir, { recursive: true, force: true })
  })

  it('配置有错时抛错退出，绝不静默退回默认', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unfold-rules-'))
    await mkdir(join(dir, '.unfold'), { recursive: true })
    await writeFile(
      join(dir, '.unfold', 'narrative.json'),
      JSON.stringify({ version: 1, fallback: 'nope', layers: [{ key: 'a', title: 'A', intro: 'i' }] }),
      'utf8',
    )
    await expect(loadRules({ repo: dir })).rejects.toThrow(/nope/)
    await rm(dir, { recursive: true, force: true })
  })

  it('--rules 指向的文件不存在时抛错，不静默退回', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unfold-rules-'))
    await expect(loadRules({ repo: dir, explicitPath: join(dir, 'missing.json') })).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
  })
})
