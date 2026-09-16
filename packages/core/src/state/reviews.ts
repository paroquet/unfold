import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Plan } from '../narrate/plan.js'
import { repoStateDir } from './paths.js'

export interface ReviewEntry {
  reviewId: string
  /** review 状态目录的绝对路径 */
  root: string
  mtimeMs: number
}

/**
 * 列出该仓库已有的 review，**最新的在前**。
 *
 * 按目录 mtime 排序而不是按 reviewId 字典序：reviewId 以分支 slug 开头，
 * 不同分支之间字典序与时间顺序无关。状态目录不存在时返回空数组——
 * 「还没跑过」不是错误。
 */
export async function listReviews(repo: string): Promise<ReviewEntry[]> {
  const dir = await repoStateDir(repo)
  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const entries = await Promise.all(
    names.map(async (reviewId) => {
      const root = join(dir, reviewId)
      return { reviewId, root, mtimeMs: (await stat(root)).mtimeMs }
    }),
  )
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** 最近一次 review；没有则返回 null。 */
export async function latestReview(repo: string): Promise<ReviewEntry | null> {
  const [newest] = await listReviews(repo)
  return newest ?? null
}

/**
 * 读某一次 review 落盘的 `plan.json`。`reviewId` 传 `'latest'` 表示最近一次。
 *
 * 找不到时抛错而不是返回空 plan：调用方多半要拿它做对比，静默给一个
 * 空 plan 会让「章节全变了」这种结论凭空出现。
 */
export async function readPlan(repo: string, reviewId: string): Promise<Plan> {
  let root: string
  if (reviewId === 'latest') {
    const newest = await latestReview(repo)
    if (newest === null) throw new Error(`该仓库还没有任何 review 可供读取：${repo}`)
    root = newest.root
  } else {
    root = join(await repoStateDir(repo), reviewId)
  }

  try {
    return JSON.parse(await readFile(join(root, 'plan.json'), 'utf8')) as Plan
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`找不到 review 的 plan.json：${join(root, 'plan.json')}`)
    }
    throw err
  }
}
