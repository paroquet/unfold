/**
 * 依赖扫描器的版本号。它进 `rulesFingerprint`——换了扫描规则就是换了排序依据，
 * 必须算作「规则变了」，否则上一轮的章节顺序会被当成仍然有效。
 */
export const SCANNER_VERSION = 1

export type SourceLang = 'ts' | 'kotlin'

const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const KOTLIN_EXT = new Set(['.kt', '.kts', '.java'])

function extOf(path: string): string {
  const slash = path.lastIndexOf('/')
  const name = slash < 0 ? path : path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot)
}

export function languageOf(path: string): SourceLang | null {
  const ext = extOf(path)
  if (TS_EXT.has(ext)) return 'ts'
  if (KOTLIN_EXT.has(ext)) return 'kotlin'
  return null
}

const TS_PATTERNS = [
  // 字符类里**不能**排除 \n：跨行的具名 import 是最常见的 TS 写法之一，
  // 排除换行会让这类 import 一条都扫不到，而文件仍被记进 scanned——
  // 依赖图缺边却看起来一切正常。排除引号就足以保证匹配不会跨过任何字符串
  // 字面量，所以 import 与它的 from 之间最多只能隔着这条语句自己的内容。
  /\bimport\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /\bexport\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
  // 副作用 import 没有 from，但它同样是一条真实的依赖边
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
]
const KOTLIN_PATTERN = /^\s*import\s+([A-Za-z_][\w.]*)/gm

/**
 * 抽出一份源码里的 import 目标。
 *
 * TS 只收相对路径（`./` `../`）——包名不可能指向本轮改动的文件，收进来只会
 * 制造永远匹配不上的噪音。按出现顺序返回并去重，保证确定性。
 */
export function scanImports(content: string, lang: SourceLang): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const push = (spec: string): void => {
    if (seen.has(spec)) return
    seen.add(spec)
    found.push(spec)
  }

  if (lang === 'ts') {
    const hits: Array<{ at: number; spec: string }> = []
    for (const pattern of TS_PATTERNS) {
      pattern.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = pattern.exec(content)) !== null) {
        const spec = m[1] as string
        if (spec.startsWith('./') || spec.startsWith('../')) hits.push({ at: m.index, spec })
      }
    }
    // 四条正则各扫一遍全文，命中顺序是按正则而非按源码位置——按位置重排，
    // 让输出只取决于源码本身
    hits.sort((a, b) => a.at - b.at)
    for (const hit of hits) push(hit.spec)
    return found
  }

  KOTLIN_PATTERN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = KOTLIN_PATTERN.exec(content)) !== null) push(m[1] as string)
  return found
}

export interface DepGraph {
  /** 文件 → 它依赖的文件（都是本轮改动集里的路径） */
  edges: Map<string, Set<string>>
  scanned: string[]
  skipped: Array<{ path: string; reason: string }>
}

/** `a/b/../c` → `a/c`，并去掉开头的 `./` */
function normalize(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/**
 * 把一条 TS 相对 import 解析成改动集里的某个文件。
 *
 * ESM 下源码里写的是 `./a.js`，实际文件却是 `./a.ts`，所以要做扩展名换算；
 * 目录 import 还要补 `index`。逐个候选去改动集里查，查不到就没有边。
 */
function resolveTs(from: string, spec: string, present: Set<string>): string | null {
  const joined = normalize(`${dirOf(from)}/${spec}`)
  const stem = joined.replace(/\.(js|jsx|mjs|cjs)$/, '')
  const candidates = [
    joined,
    ...['.ts', '.tsx', '.mts', '.cts'].map((e) => `${stem}${e}`),
    ...['.ts', '.tsx', '.js', '.jsx'].map((e) => `${joined}/index${e}`),
  ]
  for (const candidate of candidates) {
    if (present.has(candidate)) return candidate
  }
  return null
}

/**
 * 把一条 Kotlin/Java 的包路径 import 解析成改动集里的某个文件。
 *
 * 用**路径后缀匹配**而不是去算源码根：`src/main/kotlin` 这层前缀每个项目
 * 都不一样，猜错就全盘无边；而 `com/acme/pay/Pay` 作为后缀是稳定的。
 */
function resolveKotlin(spec: string, present: Set<string>): string | null {
  const suffix = spec.replace(/\./g, '/')
  const matches: string[] = []
  for (const candidate of present) {
    const stem = candidate.replace(/\.(kt|kts|java)$/, '')
    if (stem === suffix || stem.endsWith(`/${suffix}`)) matches.push(candidate)
  }
  if (matches.length === 0) return null
  // 多模块仓库里两个文件可能带同样的包路径后缀。谁赢不重要，重要的是同样的
  // 输入永远给同样的答案——靠 present 的插入顺序定夺，等于把调用方的文件
  // 排序渗进章节顺序里。最短优先（最贴近的匹配），同长按字典序。
  matches.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
  return matches[0] as string
}

/**
 * 建依赖图。**只在 `files` 内部连边**——本轮改动之外的文件不是这次叙事的
 * 一部分，指向它们的 import 不影响章节顺序。
 *
 * `contents` 的值为 `null` 表示内容不可读（文件已删除、或是二进制）。
 */
export function buildDepGraph(
  files: string[],
  contents: Map<string, string | null>,
): DepGraph {
  const present = new Set(files)
  const edges = new Map<string, Set<string>>(files.map((f) => [f, new Set<string>()]))
  const scanned: string[] = []
  const skipped: Array<{ path: string; reason: string }> = []

  for (const file of files) {
    const lang = languageOf(file)
    if (lang === null) {
      skipped.push({ path: file, reason: '未支持依赖扫描的文件类型' })
      continue
    }
    const content = contents.get(file) ?? null
    if (content === null) {
      skipped.push({ path: file, reason: '内容不可读（已删除或二进制）' })
      continue
    }
    scanned.push(file)

    for (const spec of scanImports(content, lang)) {
      const target =
        lang === 'ts' ? resolveTs(file, spec, present) : resolveKotlin(spec, present)
      // 自环无意义（同一文件内的 re-export），且会让 Tarjan 把单个文件报成环
      if (target !== null && target !== file) edges.get(file)?.add(target)
    }
  }

  return { edges, scanned, skipped }
}
