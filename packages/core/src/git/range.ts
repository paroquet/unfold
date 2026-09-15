import { git, GitError } from './exec.js'

export type BaseSource = 'explicit' | 'upstream' | 'default-branch' | 'head'

export interface BaseResolution {
  base: string
  source: BaseSource
}

export interface ResolveBaseOptions {
  /** 用户显式指定的 base（任何 git revision 写法） */
  explicit?: string
  /** 默认分支名，缺省 'main' */
  defaultBranch?: string
}

/**
 * 尝试解析 ref，任何失败都返回 null（良性）。
 * 用于 upstream 和 defaultBranch 的 sha 门控探测。
 */
async function tryParseRef(repo: string, ref: string): Promise<string | null> {
  try {
    return await git(repo, ['rev-parse', '--verify', '--quiet', ref])
  } catch {
    // 任何解析失败都是良性的——ref 不存在、stale tracking 等都落到下一档
    return null
  }
}

/**
 * 调用 merge-base，允许的唯一良性错误是"无共同祖先"（exit 1 且 stdout/stderr 都空）。
 * 其他所有错误都被认为是真故障，抛出。
 */
async function mergeBases(repo: string, sha: string): Promise<string | null> {
  try {
    return await git(repo, ['merge-base', sha, 'HEAD'])
  } catch (err) {
    if (err instanceof GitError) {
      // 唯一允许的良性错误：无共同祖先（exit 1 且 stderr 都空）
      if (err.code === 1 && err.stderr === '') {
        return null
      }
    }
    // 所有其他错误（包括 stdout/stderr 非空、code 不是 1 等）都是真错误
    throw err
  }
}

/**
 * 推导 review 的 base（spec §6.4）。
 * 优先级：显式 → 与 upstream 的 merge-base → 与默认分支的 merge-base → HEAD。
 *
 * 注意第 2 轮起调用方不该走这里：base 就是上一轮的 snapshot（spec §7.1）。
 */
export async function resolveBase(
  repo: string,
  opts: ResolveBaseOptions = {},
): Promise<BaseResolution> {
  const head = await git(repo, ['rev-parse', 'HEAD'])

  if (opts.explicit !== undefined) {
    const base = await git(repo, ['rev-parse', `${opts.explicit}^{commit}`])
    return { base, source: 'explicit' }
  }

  // 尝试 upstream：sha 门控探测
  const upstreamSha = await tryParseRef(repo, '@{upstream}')
  if (upstreamSha !== null) {
    // upstream ref 可解析，用其 sha 调 merge-base
    const mb = await mergeBases(repo, upstreamSha)
    if (mb !== null && mb !== head) return { base: mb, source: 'upstream' }
  }

  // 尝试默认分支：sha 门控探测
  const defaultBranch = opts.defaultBranch ?? 'main'
  const defaultSha = await tryParseRef(repo, defaultBranch)
  if (defaultSha !== null) {
    // defaultBranch ref 可解析，用其 sha 调 merge-base
    const mb = await mergeBases(repo, defaultSha)
    if (mb !== null && mb !== head) return { base: mb, source: 'default-branch' }
  }

  return { base: head, source: 'head' }
}
