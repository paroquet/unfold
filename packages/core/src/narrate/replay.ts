import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from '../git/exec.js'
import { composeContent } from './compose.js'
import { hunkPath } from './diff.js'
import type { FileChange, Hunk } from './diff.js'
import type { Plan } from './plan.js'

export interface ReplayResult {
  /** 逐个**有内容**的章的 commit sha，按 plan.chapters 顺序；空章不产 commit，不占位 */
  commits: string[]
  /** 最后一章的 commit，即叙事分支 tip */
  tip: string
}

const REPLAY_INDEX = 'unfold-replay-index'

/**
 * 按章重提交（spec §6.2）。纯 plumbing：不 checkout、不 apply patch。
 *
 * 快路径：一个文件的全部 hunk 都落在同一章时，直接复用终态 blob sha，
 * 天然逐字节一致。慢路径（文件内分章，v2）才走 composeContent。
 */
export async function replay(
  repo: string,
  plan: Plan,
  changes: FileChange[],
): Promise<ReplayResult> {
  const byPath = new Map(changes.map((c) => [c.path, c]))
  const gitDir = await git(repo, ['rev-parse', '--absolute-git-dir'])
  const indexPath = join(gitDir, REPLAY_INDEX)
  await rm(indexPath, { force: true })
  const env = { GIT_INDEX_FILE: indexPath }

  try {
    await git(repo, ['read-tree', plan.base], { env })

    // 累计每个文件到目前为止已应用的 hunk
    const applied = new Map<string, Hunk[]>()
    const commits: string[] = []
    let parent = plan.base

    for (const chapter of plan.chapters) {
      // 册里可能有 20 章而本轮只动了 3 章。没有任何内容的章不产 commit——
      // 否则叙事分支上会挂一长串空 commit，把真正要读的东西淹掉。
      if (chapter.hunkIds.length === 0 && chapter.filePaths.length === 0) continue

      const chapterHunkIds = new Set(chapter.hunkIds)
      const touched = new Set<string>(chapter.filePaths)
      for (const id of chapter.hunkIds) touched.add(hunkPath(id))

      for (const path of touched) {
        const change = byPath.get(path)
        if (change === undefined) continue

        const chapterHunks = change.hunks.filter((h) => chapterHunkIds.has(h.id))
        const soFar = [...(applied.get(path) ?? []), ...chapterHunks]
        applied.set(path, soFar)

        const isComplete = soFar.length === change.hunks.length

        if (change.kind === 'delete') {
          // 删除在「第一个涉及它的章节」落地。终态正确性不受影响；
          // 若将来要让删除也分章呈现，改这里。
          await git(repo, ['update-index', '--force-remove', '--', path], { env })
          continue
        }

        if (change.binary || isComplete) {
          // 快路径：直接用终态 blob，逐字节一致
          await git(repo, [
            'update-index', '--add', '--cacheinfo',
            `${change.mode},${change.blob!},${path}`,
          ], { env })
          continue
        }

        // 慢路径：合成中间态内容（文件内分章，v2 才会走到）
        // trim: false —— 结尾换行是内容的一部分，不能被吃掉
        const baseContent =
          change.oldBlob === null
            ? ''
            : await git(repo, ['cat-file', 'blob', change.oldBlob], { trim: false })
        const composed = composeContent(baseContent, soFar)
        const blob = await git(repo, ['hash-object', '-w', '--stdin'], { input: composed })
        await git(repo, [
          'update-index', '--add', '--cacheinfo', `${change.mode},${blob},${path}`,
        ], { env })
      }

      const tree = await git(repo, ['write-tree'], { env })
      const message = `${chapter.title}\n\n${chapter.intro}\n`
      const commit = await git(repo, ['commit-tree', tree, '-p', parent, '-m', message])
      commits.push(commit)
      parent = commit
    }

    // 防御性断言：replay 依赖上游 validatePlan 已保证「每个文件的 hunk 都被
    // 某一章收齐」。若调用方跳过了校验，这里静默产出的 tree 会是错的，而
    // 错误要等到下游 verify 才暴露、错误信息也指不到这里的真正病灶。就地
    // 报出来，让失败信息直接指向没被收齐的文件。
    for (const change of changes) {
      const appliedCount = applied.get(change.path)?.length ?? 0
      if (appliedCount !== change.hunks.length) {
        throw new Error(
          `replay 内部不一致：文件 ${change.path} 只有 ${appliedCount}/${change.hunks.length} `
            + '个 hunk 被分配到章节中——plan 未能让该文件在某一章达到终态，'
            + '请先用 validatePlan 校验 plan',
        )
      }
    }

    return { commits, tip: parent }
  } finally {
    await rm(indexPath, { force: true })
    await rm(`${indexPath}.lock`, { force: true })
  }
}
