import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { git } from '../git/exec.js'

/**
 * `<仓库根目录名>-<git-common-dir 绝对路径的 sha256 前 8 位>`（spec §8.1）。
 * 取 common dir 而非 worktree 路径，使同一仓库的多个 worktree 落在同一个 repo-id 下。
 */
export async function repoId(repo: string): Promise<string> {
  const commonDir = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const root = basename(commonDir.replace(/\/\.git$/, '')) || 'repo'
  const hash = createHash('sha256').update(commonDir).digest('hex').slice(0, 8)
  return `${root}-${hash}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `<分支 slug>-<YYYYMMDD-HHMMSS>`（spec §8.1） */
export function newReviewId(branch: string, now: Date = new Date()): string {
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'detached'
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `${slug}-${stamp}`
}

/** `~/.local/state/unfold/<repo-id>/<review-id>`（spec §8.1，状态一律在仓库外） */
export async function reviewRoot(repo: string, reviewId: string): Promise<string> {
  const base = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state')
  return join(base, 'unfold', await repoId(repo), reviewId)
}
