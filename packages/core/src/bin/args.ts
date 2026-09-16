export interface ParsedArgs {
  repo: string
  explicit?: string
  defaultBranch?: string
  /** 只算到 plan 为止就打印退出：不钉 ref、不建 worktree、不 replay、不写状态目录 */
  dryRun?: true
  /** 复用该仓库最近一次 review 目录（轮次递增），而不是每次新建 */
  reuse?: true
  /** 清理该仓库的全部 review 目录、worktree 与 refs/unfold/*，然后退出 */
  clean?: true
  /** 跑完用编辑器打开叙事 worktree */
  open?: true
  /** 与某一次历史 plan 并排比较章节划分；'latest' 表示最近一次 */
  compare?: string
  /** `--rules <file>`：临时覆盖仓库内与内置的叙事规则 */
  rulesPath?: string
  /** 丢弃章节册重新推导；批注保留但解除归属 */
  resetChapters?: true
}

export type ParseResult = { ok: true; args: ParsedArgs } | { ok: false }

/** 一个 value 位置上如果是 `--` 开头，视为下一个 flag 而非本 flag 的值。 */
function isFlagValue(value: string | undefined): value is string {
  return value !== undefined && !value.startsWith('--')
}

/**
 * 纯函数：解析 `unfold` 的命令行参数，不做任何 I/O 或 process.exit。
 * 唯一支持的命令是 `narrate`。
 *
 * 取值 flag：`--base`、`--default-branch`、`--repo`、`--compare`、`--rules`
 * 布尔 flag：`--dry-run`、`--reuse`、`--clean`、`--open`
 *
 * 每个取值 flag 的值都必须真的是一个值，而不是紧跟着的下一个 flag——
 * 否则 `unfold narrate --base --default-branch` 会把 `'--default-branch'`
 * 当成 base revision 吞下去，一路跑到 git 深处才炸出一坨原始用法 dump。
 */
export function parseArgs(argv: string[], cwd: string): ParseResult {
  const [command, ...rest] = argv
  if (command !== 'narrate') return { ok: false }

  let repo = cwd
  let explicit: string | undefined
  let defaultBranch: string | undefined
  let compare: string | undefined
  let rulesPath: string | undefined
  let dryRun = false
  let reuse = false
  let clean = false
  let open = false
  let resetChapters = false

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    const value = rest[i + 1]
    if (flag === '--base') {
      if (!isFlagValue(value)) return { ok: false }
      explicit = value
      i += 1
    } else if (flag === '--default-branch') {
      if (!isFlagValue(value)) return { ok: false }
      defaultBranch = value
      i += 1
    } else if (flag === '--repo') {
      if (!isFlagValue(value)) return { ok: false }
      repo = value
      i += 1
    } else if (flag === '--compare') {
      if (!isFlagValue(value)) return { ok: false }
      compare = value
      i += 1
    } else if (flag === '--rules') {
      if (!isFlagValue(value)) return { ok: false }
      rulesPath = value
      i += 1
    } else if (flag === '--dry-run') {
      dryRun = true
    } else if (flag === '--reuse') {
      reuse = true
    } else if (flag === '--clean') {
      clean = true
    } else if (flag === '--open') {
      open = true
    } else if (flag === '--reset-chapters') {
      resetChapters = true
    } else {
      return { ok: false }
    }
  }

  return {
    ok: true,
    args: {
      repo,
      ...(explicit !== undefined ? { explicit } : {}),
      ...(defaultBranch !== undefined ? { defaultBranch } : {}),
      ...(compare !== undefined ? { compare } : {}),
      ...(rulesPath !== undefined ? { rulesPath } : {}),
      ...(dryRun ? { dryRun: true as const } : {}),
      ...(reuse ? { reuse: true as const } : {}),
      ...(clean ? { clean: true as const } : {}),
      ...(open ? { open: true as const } : {}),
      ...(resetChapters ? { resetChapters: true as const } : {}),
    },
  }
}
