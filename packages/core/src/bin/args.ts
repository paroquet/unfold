export interface ParsedArgs {
  repo: string
  explicit?: string
  defaultBranch?: string
}

export type ParseResult = { ok: true; args: ParsedArgs } | { ok: false }

/** 一个 value 位置上如果是 `--` 开头，视为下一个 flag 而非本 flag 的值。 */
function isFlagValue(value: string | undefined): value is string {
  return value !== undefined && !value.startsWith('--')
}

/**
 * 纯函数：解析 `unfold` 的命令行参数，不做任何 I/O 或 process.exit。
 * 唯一支持的命令是 `narrate`，可选 flag：`--base`、`--default-branch`、`--repo`。
 *
 * 每个 flag 的取值都必须真的是一个值，而不是紧跟着的下一个 flag——
 * 否则 `unfold narrate --base --default-branch` 会把 `'--default-branch'`
 * 当成 base revision 吞下去，一路跑到 git 深处才炸出一坨原始用法 dump。
 */
export function parseArgs(argv: string[], cwd: string): ParseResult {
  const [command, ...rest] = argv
  if (command !== 'narrate') return { ok: false }

  let repo = cwd
  let explicit: string | undefined
  let defaultBranch: string | undefined

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
    },
  }
}
