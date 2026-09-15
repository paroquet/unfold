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

async function tryGit(repo: string, args: string[]): Promise<string | null> {
  try {
    return await git(repo, args)
  } catch (err) {
    if (err instanceof GitError) return null
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

  const upstream = await tryGit(repo, ['rev-parse', '--abbrev-ref', '@{upstream}'])
  if (upstream !== null) {
    const mb = await tryGit(repo, ['merge-base', upstream, 'HEAD'])
    if (mb !== null && mb !== head) return { base: mb, source: 'upstream' }
  }

  const defaultBranch = opts.defaultBranch ?? 'main'
  const mb = await tryGit(repo, ['merge-base', defaultBranch, 'HEAD'])
  if (mb !== null && mb !== head) return { base: mb, source: 'default-branch' }

  return { base: head, source: 'head' }
}
