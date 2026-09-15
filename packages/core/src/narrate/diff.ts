import { git } from '../git/exec.js'

export interface Hunk {
  /** 一次计算内唯一，形如 `src/a.ts#0` */
  id: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** 原始 diff 正文行，保留前导 ' ' / '-' / '+' */
  lines: string[]
}

export type ChangeKind = 'add' | 'modify' | 'delete'

export interface FileChange {
  path: string
  kind: ChangeKind
  binary: boolean
  /** 终态 mode；delete 时为 '' */
  mode: string
  /** 终态 blob；delete 时为 null */
  blob: string | null
  /** base 态 mode；add 时为 null */
  oldMode: string | null
  /** base 态 blob；add 时为 null */
  oldBlob: string | null
  hunks: Hunk[]
}

/**
 * 从 hunk id（形如 `src/a.ts#0`）中取出所属文件路径。
 *
 * 必须用 `lastIndexOf('#')` 而非 `startsWith(\`${path}#\`)` 之类的前缀匹配——
 * 路径本身可以含 `#`（例如文件真的叫 `a#0.ts`），前缀匹配会把 `a#0.ts` 的
 * hunk 误判成属于文件 `a`，导致钉住 `a` 时把 `a#0.ts` 的 hunk 一并过滤掉。
 * `lastIndexOf('#')` 找不到分隔符时说明 id 格式本身就不对，直接抛错而不是
 * 静默产出一个错误的路径。
 */
export function hunkPath(id: string): string {
  const idx = id.lastIndexOf('#')
  if (idx < 0) throw new Error(`非法 hunk id（缺少 '#' 分隔符): ${JSON.stringify(id)}`)
  return id.slice(0, idx)
}

const NULL_SHA = '0000000000000000000000000000000000000000'

interface RawEntry {
  path: string
  kind: ChangeKind
  mode: string
  blob: string | null
  oldMode: string | null
  oldBlob: string | null
}

/** 解析 `git diff --raw -z` 的输出 */
function parseRaw(raw: string): RawEntry[] {
  if (raw === '') return []
  // -z 下记录形如 ":<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0"
  const parts = raw.split('\0').filter((p) => p !== '')
  const out: RawEntry[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const meta = parts[i]!
    const path = parts[i + 1]!
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) (.)$/.exec(meta)
    if (m === null) throw new Error(`无法解析 diff --raw 记录: ${JSON.stringify(meta)}`)
    const [, oldMode, newMode, oldSha, newSha, status] = m as unknown as [
      string, string, string, string, string, string,
    ]
    const kind: ChangeKind = status === 'A' ? 'add' : status === 'D' ? 'delete' : 'modify'
    out.push({
      path,
      kind,
      mode: kind === 'delete' ? '' : newMode,
      blob: newSha === NULL_SHA ? null : newSha,
      oldMode: kind === 'add' ? null : oldMode,
      oldBlob: oldSha === NULL_SHA ? null : oldSha,
    })
  }
  return out
}

/** 从 unified diff 正文里切出每个文件的 hunk */
function parseHunks(patch: string): Map<string, Hunk[]> {
  const byPath = new Map<string, Hunk[]>()
  if (patch === '') return byPath

  let path: string | null = null
  let hunks: Hunk[] = []
  let current: Hunk | null = null

  const flushFile = (): void => {
    if (path !== null) byPath.set(path, hunks)
    path = null
    hunks = []
    current = null
  }

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flushFile()
      continue
    }
    // 顺序是 --- 在前、+++ 在后。两边都「非 /dev/null 才覆盖」：
    // 新增文件靠 +++ 拿到路径，删除文件靠 --- 拿到路径，修改文件两次都对。
    if (line.startsWith('--- ')) {
      const src = line.slice(4)
      if (src !== '/dev/null') path = src.replace(/^a\//, '')
      continue
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4)
      if (target !== '/dev/null') path = target.replace(/^b\//, '')
      continue
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (m === null) continue
      current = {
        id: '',
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    // 反斜杠要收进来：`\ No newline at end of file` 是 composeContent 判断
    // 结尾换行的依据
    if (current !== null && /^[ +\-\\]/.test(line)) {
      current.lines.push(line)
    }
  }
  flushFile()
  return byPath
}

/**
 * 算出 base..head 的结构化改动（spec §6.5 要求 hunk 粒度）。
 * 一律 --no-renames：重命名按删除 + 新增处理。
 */
export async function computeChanges(
  repo: string,
  base: string,
  head: string,
): Promise<FileChange[]> {
  const raw = await git(repo, [
    'diff', '--raw', '--no-renames', '-z', '--abbrev=40', base, head,
  ])
  const entries = parseRaw(raw)

  const patch = await git(repo, [
    'diff', '--no-renames', '--unified=3', '--no-color', '--no-ext-diff', base, head,
  ])
  const hunksByPath = parseHunks(patch)

  const numstat = await git(repo, ['diff', '--numstat', '--no-renames', '-z', base, head])
  const binaryPaths = new Set<string>()
  {
    const parts = numstat.split('\0').filter((p) => p !== '')
    for (const rec of parts) {
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(rec)
      if (m !== null && m[1] === '-' && m[2] === '-' && m[3] !== undefined && m[3] !== '') {
        binaryPaths.add(m[3])
      }
    }
  }

  const changes: FileChange[] = entries.map((e) => {
    const binary = binaryPaths.has(e.path)
    const hunks = binary ? [] : (hunksByPath.get(e.path) ?? [])
    return {
      path: e.path,
      kind: e.kind,
      binary,
      mode: e.mode,
      blob: e.blob,
      oldMode: e.oldMode,
      oldBlob: e.oldBlob,
      hunks: hunks.map((h, i) => ({ ...h, id: `${e.path}#${i}` })),
    }
  })

  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return changes
}
