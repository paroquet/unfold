import { describe, it, expect } from 'vitest'
import { mkdtemp, readdir, rm as fsRm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTempRepo } from '../helpers/repo.js'
import { addWorktree, attachWorktree, removeWorktree } from '../../src/git/worktree.js'

// 判别力不能依赖"两次操作之间的时钟粒度"——git checkout 子进程的 spawn
// 开销恰好把重写场景的 mtime 推过下一个 tick 只是环境偶然，换更快的机器 /
// CI / 进程内实现都可能让这条测试假通过。改用哨兵值：把 mtime 显式设成一个
// 与"现在"相去甚远的远古时间戳，之后断言它仍然精确等于这个哨兵值——只要
// 文件被真实重写过（哪怕重写后恰好落在同一毫秒），mtime 就会被内核设成
// "现在"而不再是哨兵值，与时钟粒度、机器速度都无关。
//
// 注意：不要用 birthtimeMs 代替或补强这一判别——同进程内 unlink + writeFile
// 实测过 mtime / ino / birthtime 三者同源同粒度，快速重建场景下会一起失效。
const SENTINEL = new Date('2000-01-01T00:00:00.000Z')

interface FileStat {
  rel: string
  mtimeMs: number
  ino: number
}

async function fingerprint(dir: string): Promise<FileStat[]> {
  const out: FileStat[] = []
  const walk = async (d: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const abs = join(d, entry.name)
      const rel = `${prefix}${entry.name}`
      if (entry.isDirectory()) await walk(abs, `${rel}/`)
      else {
        const s = await stat(abs)
        out.push({ rel, mtimeMs: s.mtimeMs, ino: s.ino })
      }
    }
  }
  await walk(dir, '')
  out.sort((a, b) => a.rel.localeCompare(b.rel))
  return out
}

async function setSentinelMtime(dir: string, time: Date): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) await setSentinelMtime(abs, time)
    else await utimes(abs, time, time)
  }
}

describe('worktree', () => {
  it('挂到 tree 一致的叙事分支时，一个文件都不写', async () => {
    const repo = await createTempRepo()
    await repo.write('src/a.ts', 'a\n')
    await repo.write('src/b.ts', 'b\n')
    const head = await repo.commit('base')
    const tree = await repo.git('rev-parse', `${head}^{tree}`)

    const wtParent = await mkdtemp(join(tmpdir(), 'unfold-wt-'))
    const wtDir = join(wtParent, 'work')
    await addWorktree(repo.dir, wtDir, head)

    // 打哨兵：把刚 checkout 出来的文件 mtime 全部拨回远古时间戳。
    await setSentinelMtime(wtDir, SENTINEL)
    const before = await fingerprint(wtDir)
    expect(before.length).toBe(2)
    for (const f of before) expect(f.mtimeMs).toBe(SENTINEL.getTime())

    // 造一个 tree 相同、历史不同的 tip
    const mid = await repo.git('commit-tree', tree, '-p', head, '-m', 'ch1')
    await attachWorktree(wtDir, 'unfold/test', mid)

    const after = await fingerprint(wtDir)
    // inode 作为额外信号一并保留（多一维无害），但判别力落在哨兵 mtime 上。
    expect(after).toEqual(before)
    for (const f of after) expect(f.mtimeMs).toBe(SENTINEL.getTime())

    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: wtDir })
    expect(stdout).toBe('')

    await removeWorktree(repo.dir, wtDir)
    await fsRm(wtParent, { recursive: true, force: true })
    await repo.cleanup()
  })
})
