import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import picomatch from 'picomatch'

/** 叙事里的一层，也就是最终的一个章节。 */
export interface LayerRule {
  /** 稳定标识，成为 Chapter.key，是跨轮锚点与 AI 输出的取值域 */
  key: string
  title: string
  /** 「为什么先看这个」 */
  intro: string
  /** picomatch glob；任一命中即归入本层。省略表示本层只靠 fallback 接收文件 */
  match?: string[]
  /**
   * 匹配次序，数字小的先匹配；**缺省取「数组位置 + 1」**，所以不写 priority
   * 的层从 1 开始排，`priority: 0` 天然表示「最先匹配」。同值时按数组顺序。
   *
   * 存在的理由：匹配优先级与阅读顺序**不是同一件事**。测试文件要最先匹配
   * （否则 `tests/schema/foo.ts` 会被「契约」层抢走），却要最后读。
   */
  priority?: number
}

export interface NarrativeRules {
  version: 1
  /** 谁都不命中时落到哪一层；必须是某个 layer 的 key */
  fallback: string
  /** 数组顺序即章节顺序，也就是读的顺序 */
  layers: LayerRule[]
}

/** 内置默认：与改造前写死在 rule-planner 里的四层行为等价。 */
export const DEFAULT_RULES: NarrativeRules = {
  version: 1,
  fallback: 'core',
  layers: [
    {
      key: 'contract',
      title: '契约',
      intro: '先看类型、schema 与接口——它们定义了后面所有代码要满足的形状。',
      match: [
        '**/type{,s}/**',
        '**/schema{,s}/**',
        '**/proto/**',
        '**/api/**',
        '**/contract{,s}/**',
        '**/types.*',
        '**/schema.*',
        '**/*.d.ts',
        '**/*.{proto,graphql,avsc}',
      ],
    },
    {
      key: 'core',
      title: '核心逻辑',
      intro: '再看核心逻辑：真正实现行为的地方，前面的契约在这里被兑现。',
    },
    {
      key: 'wiring',
      title: '接线与调用方',
      intro: '然后看接线：谁调用了上面这些东西，改动如何被接进系统。',
      match: [
        '**/{index,main,app,bootstrap,cli,bin}.{js,jsx,ts,tsx,cjs,mjs,cts,mts}',
        '**/*.{json,yaml,yml,toml,ini,cfg}',
      ],
    },
    {
      key: 'test-doc',
      title: '测试与文档',
      intro: '最后看测试与文档：它们说明作者认为哪些行为值得保证。',
      priority: 0,
      match: [
        '**/test{,s}/**',
        '**/__tests__/**',
        '**/spec/**',
        '**/*.{test,spec}.*',
        '**/*.{md,mdx,txt,rst,adoc}',
      ],
    },
  ],
}

function fail(message: string): never {
  throw new Error(`叙事规则配置有误：${message}`)
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${what} 必须是一个对象`)
  }
  return value as Record<string, unknown>
}

/**
 * 校验并归一化一份规则。**任何一条不满足都抛错**，绝不静默退回默认——
 * 静默退回会让人以为在测新规则、实际跑的是旧的。
 */
export function validateRules(raw: unknown): NarrativeRules {
  const root = asRecord(raw, '配置根')

  if (root['version'] !== 1) {
    fail(`version 必须是 1，收到 ${JSON.stringify(root['version'])}`)
  }
  const fallback = root['fallback']
  if (typeof fallback !== 'string' || fallback === '') fail('fallback 必须是非空字符串')

  const rawLayers = root['layers']
  if (!Array.isArray(rawLayers) || rawLayers.length === 0) fail('layers 必须是非空数组')

  const seen = new Set<string>()
  const layers: LayerRule[] = rawLayers.map((item, i) => {
    const layer = asRecord(item, `layers[${i}]`)
    const key = layer['key']
    if (typeof key !== 'string' || key === '') fail(`layers[${i}].key 必须是非空字符串`)
    if (seen.has(key)) fail(`key 重复：${key}`)
    seen.add(key)

    const title = layer['title']
    if (typeof title !== 'string' || title === '') fail(`层「${key}」缺少 title`)
    const intro = layer['intro']
    if (typeof intro !== 'string' || intro === '') fail(`层「${key}」缺少 intro`)

    const rawMatch = layer['match']
    let match: string[] | undefined
    if (rawMatch !== undefined) {
      if (!Array.isArray(rawMatch) || rawMatch.length === 0) {
        fail(`层「${key}」的 match 必须是非空数组（不需要匹配就整个省略）`)
      }
      // 只校验类型与非空。picomatch 对写坏的 glob **不抛错**——它很宽容，
      // `src/[unclosed` 只是匹配不到任何东西。所以「语法非法」在加载期检测
      // 不出来，会表现为「这一层一个文件都没匹配上」。`--dry-run` 打印的
      // 每章文件数就是发现它的地方。
      match = rawMatch.map((p, j) => {
        if (typeof p !== 'string' || p === '') fail(`层「${key}」的 match[${j}] 必须是非空字符串`)
        return p
      })
    }

    const rawPriority = layer['priority']
    let priority: number | undefined
    if (rawPriority !== undefined) {
      if (typeof rawPriority !== 'number' || !Number.isFinite(rawPriority)) {
        fail(`层「${key}」的 priority 必须是数字`)
      }
      priority = rawPriority
    }

    return {
      key,
      title,
      intro,
      ...(match !== undefined ? { match } : {}),
      ...(priority !== undefined ? { priority } : {}),
    }
  })

  if (!seen.has(fallback)) {
    fail(`fallback 指向不存在的层：${fallback}（已声明的层：${[...seen].join(', ')}）`)
  }

  return { version: 1, fallback, layers }
}

interface Matcher {
  key: string
  priority: number
  isMatch: (path: string) => boolean
}

/** 按解析后的 priority 排序的匹配器；priority 缺省取数组位置。 */
function matchers(rules: NarrativeRules): Matcher[] {
  return rules.layers
    .map((layer, i) => ({
      key: layer.key,
      priority: layer.priority ?? i + 1,
      isMatch:
        layer.match === undefined
          ? (): boolean => false
          : picomatch(layer.match, { dot: true, nocase: true }),
    }))
    .sort((a, b) => a.priority - b.priority)
}

/** 把一个文件路径归到某一层，返回层的 key。谁都不命中时返回 `rules.fallback`。 */
export function classifyPath(path: string, rules: NarrativeRules): string {
  for (const m of matchers(rules)) {
    if (m.isMatch(path)) return m.key
  }
  return rules.fallback
}

/**
 * 规则指纹：**只覆盖能改变归属的部分**，不覆盖 title / intro。
 *
 * 改文案是最常见的微调，没有任何文件换层，不该让上一轮的批注失效。
 * 但 layers 的顺序进指纹——priority 缺省取数组位置，换顺序就换了匹配次序，
 * 可能让同时命中两层的文件改变归属。这里宁可保守：误判「变了」只是多划分
 * 一次，误判「没变」会把批注钉到错误的章上。
 */
export function rulesFingerprint(rules: NarrativeRules): string {
  const semantic = {
    fallback: rules.fallback,
    layers: rules.layers
      .map((layer, i) => ({
        key: layer.key,
        priority: layer.priority ?? i + 1,
        match: [...(layer.match ?? [])].sort(),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
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

/**
 * 优先级：`--rules <file>` → `<repo>/.unfold/narrative.json` → 内置默认。
 * **整份替换，不做合并**——key 空间是一个整体，半份默认半份自定义会让
 * fallback 指向哪、match 引不引用得到都难以推理。
 */
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
