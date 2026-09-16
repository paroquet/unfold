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

  it('拼错的字段直接报错，而不是静默回落到默认值', () => {
    expect(() => validateRules({ version: 2, maxFile: 10 })).toThrow(/无法识别的字段：maxFile/)
  })

  it('放行 $schema——编辑器补全会往 JSON 里塞它，它不是配置项', () => {
    expect(() => validateRules({ $schema: './x.json', version: 2 })).not.toThrow()
  })

  it('titles 的条目值也要校验，不能等到下游消费时才炸', () => {
    expect(() => validateRules({ version: 2, titles: { 'a.ts': { title: 123 } } }))
      .toThrow(/titles\["a\.ts"\]\.title/)
    expect(() => validateRules({ version: 2, titles: { 'a.ts': { heading: 'x' } } }))
      .toThrow(/无法识别的字段：heading/)
  })

  it('pair 的形状错了要报错', () => {
    expect(() => validateRules({ version: 2, pair: { dirs: ['tests'] } })).toThrow(/pair\.dirs/)
    expect(() => validateRules({ version: 2, pair: { suffixes: [1] } })).toThrow(/pair\.suffixes/)
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

  it('内置默认规则的指纹是一个固定值——配方本身也要有回归网', () => {
    // 这条测试刻意"脆"：少算一个字段、多算一个字段、换掉 SCANNER_VERSION，
    // 它都会红。那正是它的价值——改配方意味着所有历史轮次的指纹从此不可比，
    // 必须是一次有意识的决定，而不是顺手改掉。改配方时同步更新这个常量即可。
    expect(rulesFingerprint(DEFAULT_RULES)).toBe('149b90cc464c')
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
