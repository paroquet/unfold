import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { git, GitError } from './exec.js'

/** 在 path 处开一个 detached worktree，检出 commit。 */
export async function addWorktree(
  repo: string,
  path: string,
  commit: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  try {
    await git(repo, ['worktree', 'add', '-q', '--detach', path, commit])
  } catch (err) {
    if (err instanceof GitError && /already exists/.test(err.stderr)) {
      throw new Error(
        `worktree 目标路径已存在：${path}。这通常意味着同一个 reviewId 被重复用了` +
          `（例如同一秒内重跑 narrate 撞了车），或者该路径被手工占用——请换一个路径，` +
          `或先清掉旧的 worktree（git worktree remove）。原始错误：${err.stderr.trim()}`,
      )
    }
    throw err
  }
}

/**
 * 把已存在的 worktree 挂到叙事分支上。
 *
 * 当 commit 的 tree 与 worktree 当前内容一致时（这正是 spec §6.3 的不变量），
 * git 比对两棵树发现无差异，一个文件都不写——轨道 A 建好的 LSP 索引不会
 * 被冲掉（spec §3）。
 */
export async function attachWorktree(
  worktreePath: string,
  branch: string,
  commit: string,
): Promise<void> {
  await git(worktreePath, ['checkout', '-q', '-B', branch, commit])
}

/** 拆掉 worktree 并清理管理信息。 */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', path])
  await git(repo, ['worktree', 'prune'])
}
