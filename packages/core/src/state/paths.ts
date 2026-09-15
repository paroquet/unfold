import { createHash, randomBytes } from 'node:crypto'
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

/**
 * `<分支 slug>-<YYYYMMDD-HHMMSS>-<毫秒>-<6 位随机 hex>`（spec §8.1）。
 *
 * 毫秒 + 随机后缀是 reviewId 唯一性的来源，而不是单靠秒级时间戳：
 * reviewId 直接决定 `refs/unfold/<reviewId>/round-NNN` 这个 ref 名字
 * （snapshot.ts 的 pinSnapshot），只精确到秒的话，同一秒内重跑
 * `narrate`（例如脚本里连续两次调用、或用户手速够快）会撞上同一个
 * reviewId：第二次跑先 `update-ref` 覆盖掉第一次钉住的快照 ref，
 * 再在 `addWorktree` 上因为 worktree 目录已存在而报错——覆盖发生在
 * 报错之前，所以第一轮快照已经丢失了唯一的可达 ref，下次 gc 即被清除，
 * 破坏 spec §4.3 的可达性保证。毫秒仍可能撞（多进程恰好同一毫秒），
 * 随机后缀兜底把碰撞概率压到可忽略。
 */
export function newReviewId(branch: string, now: Date = new Date()): string {
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'detached'
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  const ms = String(now.getUTCMilliseconds()).padStart(3, '0')
  const rand = randomBytes(3).toString('hex')
  return `${slug}-${stamp}-${ms}-${rand}`
}

/** `~/.local/state/unfold/<repo-id>/<review-id>`（spec §8.1，状态一律在仓库外） */
export async function reviewRoot(repo: string, reviewId: string): Promise<string> {
  const base = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state')
  return join(base, 'unfold', await repoId(repo), reviewId)
}
