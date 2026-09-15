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
 * 尝试执行 git 命令，区分良性错误（ref 不存在、无共同祖先）和真错误。
 * 良性错误：exit 非 0 且 stderr 为空 → 返回 null
 * 真错误：stderr 非空 → 抛出
 * 成功：返回 stdout
 */
async function tryGit(repo: string, args: string[]): Promise<string | null> {
  try {
    return await git(repo, args)
  } catch (err) {
    if (err instanceof GitError) {
      // 如果 stderr 非空，说明是真错误（如对象库损坏、权限问题）
      if (err.stderr !== '') {
        throw err
      }
      // stderr 为空的错误是良性的（如 ref 不存在、无共同祖先）
      return null
    }
    // spawn 错误（如 git 二进制不存在）也要抛出
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

  // 尝试 upstream：先探测 upstream 是否配置（避免调用 merge-base 时 @{upstream} 不存在的 stderr）
  const currentBranch = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const upstreamBranch = await tryGit(repo, ['config', `branch.${currentBranch}.merge`])
  if (upstreamBranch !== null) {
    // upstream 已配置，调用 merge-base
    const mb = await tryGit(repo, ['merge-base', '@{upstream}', 'HEAD'])
    if (mb !== null && mb !== head) return { base: mb, source: 'upstream' }
  }

  // 尝试默认分支：先探测 ref 是否可解析
  const defaultBranch = opts.defaultBranch ?? 'main'
  const defaultExists = await tryGit(repo, ['rev-parse', '--verify', '--quiet', defaultBranch])
  if (defaultExists !== null) {
    // 默认分支存在，调用 merge-base
    const mb = await tryGit(repo, ['merge-base', defaultBranch, 'HEAD'])
    if (mb !== null && mb !== head) return { base: mb, source: 'default-branch' }
  }

  return { base: head, source: 'head' }
}
