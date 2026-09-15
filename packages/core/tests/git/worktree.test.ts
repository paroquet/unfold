import { describe, it, expect } from 'vitest'
import { mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTempRepo } from '../helpers/repo.js'
import { addWorktree, attachWorktree, removeWorktree } from '../../src/git/worktree.js'

async function fingerprint(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const abs = join(d, entry.name)
      const rel = `${prefix}${entry.name}`
      if (entry.isDirectory()) await walk(abs, `${rel}/`)
      else {
        const s = await stat(abs)
        out.push(`${rel} ${s.mtimeMs} ${s.ino}`)
      }
    }
  }
  await walk(dir, '')
  return out.sort()
}

describe('worktree', () => {
  it('挂到 tree 一致的叙事分支时，一个文件都不写', async () => {
    const repo = await createTempRepo()
    await repo.write('src/a.ts', 'a\n')
    await repo.write('src/b.ts', 'b\n')
    const head = await repo.commit('base')
    const tree = await repo.git('rev-parse', `${head}^{tree}`)

    const wtDir = join(await mkdtemp(join(tmpdir(), 'unfold-wt-')), 'work')
    await addWorktree(repo.dir, wtDir, head)
    const before = await fingerprint(wtDir)
    expect(before.length).toBe(2)

    // 造一个 tree 相同、历史不同的 tip
    const mid = await repo.git('commit-tree', tree, '-p', head, '-m', 'ch1')
    await attachWorktree(wtDir, 'unfold/test', mid)

    expect(await fingerprint(wtDir)).toEqual(before)
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: wtDir })
    expect(stdout).toBe('')

    await removeWorktree(repo.dir, wtDir)
    await repo.cleanup()
  })
})
