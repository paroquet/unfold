import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { git, GitError } from '../git/exec.js'
import { listReviews } from './reviews.js'

export interface CleanupResult {
  /** 被删除的 reviewId */
  removedReviews: string[]
  /** 被删除的 ref 全名 */
  removedRefs: string[]
}

/**
 * 清掉该仓库的全部 review 痕迹：状态目录、注册在本仓上的叙事 worktree、
 * 以及 `refs/unfold/*` 下钉住的快照 ref。
 *
 * 不碰叙事分支本身（`refs/heads/unfold/*`）——那是可推送的产物，
 * 删不删由用户决定；这里只清「本该随 review 生命周期消失」的东西。
 */
export async function cleanReviews(repo: string): Promise<CleanupResult> {
  const reviews = await listReviews(repo)

  const removedReviews: string[] = []
  for (const review of reviews) {
    const worktree = join(review.root, 'worktree')
    if (existsSync(worktree)) {
      try {
        await git(repo, ['worktree', 'remove', '--force', worktree])
      } catch (err) {
        // worktree 未注册 / 已失效都不算错——下面的 prune 会收尾
        if (!(err instanceof GitError)) throw err
      }
    }
    await rm(review.root, { recursive: true, force: true })
    removedReviews.push(review.reviewId)
  }

  const listed = await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/unfold'])
  const removedRefs = listed === '' ? [] : listed.split('\n')
  for (const ref of removedRefs) {
    await git(repo, ['update-ref', '-d', ref])
  }

  await git(repo, ['worktree', 'prune'])

  return { removedReviews, removedRefs }
}
