import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from './exec.js'

export interface Snapshot {
  /** 快照 commit 的 sha */
  commit: string
  /** 快照 tree 的 sha */
  tree: string
  /** 快照的 parent，即当时的 HEAD */
  parent: string
}

const SNAPSHOT_INDEX = 'unfold-snapshot-index'

/**
 * 给脏工作区照一张快照，产出一个 commit 对象。
 *
 * 零干扰：不动工作区、不动真实 index、不碰 stash 栈（spec §4）。
 * 临时 index 必须落在 git dir 里而不是 worktree 里，否则会被自己的
 * `git add -A` 抓进 tree。
 *
 * **前置条件（未强制校验，调用方必须自己保证）：同一个 repo 上不得并发
 * 调用 `snapshot()`。** 原因：临时 index 用固定文件名
 * `<git-dir>/unfold-snapshot-index`，两次并发调用会共用同一个临时
 * index、互相踩踏彼此的 read-tree / add / write-tree，产出的快照可能
 * 是两次调用状态的混合体，且 `finally` 里的 `rm` 还可能把另一次调用
 * 尚未读完的 index 删掉。Plan 4 的 VS Code 包会从事件回调里调用
 * `narrate()`（因而调用 `snapshot()`）——回调可能连续触发，调用方必须
 * 自己序列化（例如一个仓库同时只允许一次 in-flight 的 narrate）。
 *
 * 另见 `newReviewId`（state/paths.ts）：reviewId 的唯一性来源是「时间戳
 * （含毫秒）+ 随机后缀」而不是单纯的秒级时间戳，避免同一秒内两次
 * *不*并发但先后调用的 narrate 撞上同一个 `refs/unfold/<reviewId>/…`
 * ref，导致 `pinSnapshot` 覆盖掉上一轮快照的唯一可达 ref。
 */
export async function snapshot(repo: string): Promise<Snapshot> {
  const gitDir = await git(repo, ['rev-parse', '--absolute-git-dir'])
  const indexPath = join(gitDir, SNAPSHOT_INDEX)
  await rm(indexPath, { force: true })

  const env = { GIT_INDEX_FILE: indexPath }
  try {
    await git(repo, ['read-tree', 'HEAD'], { env })
    await git(repo, ['add', '-A'], { env })
    const tree = await git(repo, ['write-tree'], { env })
    const parent = await git(repo, ['rev-parse', 'HEAD'])
    const commit = await git(repo, [
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      'unfold: snapshot',
    ])
    return { commit, tree, parent }
  } finally {
    await rm(indexPath, { force: true })
    await rm(`${indexPath}.lock`, { force: true })
  }
}

function roundRef(reviewId: string, round: number): string {
  return `refs/unfold/${reviewId}/round-${String(round).padStart(3, '0')}`
}

/**
 * 把快照钉在一个 ref 上。
 *
 * 必须做：SNAP 不是叙事分支 tip 的祖先，worktree 一旦切到叙事分支它就
 * 不可达，`git gc --prune=now` 会清掉它；而增量重看依赖历轮快照（spec §4.3）。
 */
export async function pinSnapshot(
  repo: string,
  reviewId: string,
  round: number,
  commit: string,
): Promise<string> {
  const ref = roundRef(reviewId, round)
  await git(repo, ['update-ref', ref, commit])
  return ref
}

/** 清掉某次 review 钉住的全部快照 ref。 */
export async function unpinReview(repo: string, reviewId: string): Promise<void> {
  const listed = await git(repo, [
    'for-each-ref',
    '--format=%(refname)',
    `refs/unfold/${reviewId}`,
  ])
  if (listed === '') return
  for (const ref of listed.split('\n')) {
    await git(repo, ['update-ref', '-d', ref])
  }
}
