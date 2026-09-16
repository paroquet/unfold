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
