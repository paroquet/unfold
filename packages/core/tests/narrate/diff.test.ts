import { describe, it, expect } from 'vitest'
import { createTempRepo } from '../helpers/repo.js'
import { computeChanges } from '../../src/narrate/diff.js'

describe('computeChanges', () => {
  it('区分新增、修改、删除，并给出终态与 base 态的 blob', async () => {
    const repo = await createTempRepo()
    await repo.write('keep.txt', 'a\nb\nc\n')
    await repo.write('gone.txt', 'bye\n')
    const base = await repo.commit('base')

    await repo.write('keep.txt', 'a\nB\nc\n')
    await repo.rm('gone.txt')
    await repo.write('fresh.txt', 'new\n')
    const head = await repo.commit('work')

    const changes = await computeChanges(repo.dir, base, head)
    expect(changes.map((c) => c.path)).toEqual(['fresh.txt', 'gone.txt', 'keep.txt'])

    const fresh = changes[0]!
    expect(fresh.kind).toBe('add')
    expect(fresh.oldBlob).toBeNull()
    expect(fresh.blob).toMatch(/^[0-9a-f]{40}$/)

    const gone = changes[1]!
    expect(gone.kind).toBe('delete')
    expect(gone.blob).toBeNull()
    expect(gone.oldBlob).toMatch(/^[0-9a-f]{40}$/)

    const keep = changes[2]!
    expect(keep.kind).toBe('modify')
    expect(keep.mode).toBe('100644')
    await repo.cleanup()
  })

  it('hunk 带行号与原始正文，id 在一次计算内唯一', async () => {
    const repo = await createTempRepo()
    await repo.write('f.txt', ['l1','l2','l3','l4','l5','l6','l7','l8','l9','l10','l11','l12'].join('\n') + '\n')
    const base = await repo.commit('base')
    await repo.write('f.txt', ['L1','l2','l3','l4','l5','l6','l7','l8','l9','l10','l11','L12'].join('\n') + '\n')
    const head = await repo.commit('work')

    const changes = await computeChanges(repo.dir, base, head)
    const f = changes[0]!
    expect(f.hunks.length).toBe(2)
    expect(f.hunks[0]!.oldStart).toBe(1)
    expect(f.hunks[0]!.lines.some((l) => l === '-l1')).toBe(true)
    expect(f.hunks[0]!.lines.some((l) => l === '+L1')).toBe(true)
    expect(new Set(f.hunks.map((h) => h.id)).size).toBe(2)
    await repo.cleanup()
  })

  it('二进制文件标记 binary 且没有 hunk', async () => {
    const repo = await createTempRepo()
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFile(join(repo.dir, 'b.bin'), Buffer.from([0, 1, 2, 0, 3]))
    const base = await repo.commit('base')
    await writeFile(join(repo.dir, 'b.bin'), Buffer.from([0, 9, 9, 0, 9]))
    const head = await repo.commit('work')

    const changes = await computeChanges(repo.dir, base, head)
    expect(changes[0]!.binary).toBe(true)
    expect(changes[0]!.hunks).toEqual([])
    await repo.cleanup()
  })

  it('重命名按删除加新增处理（--no-renames）', async () => {
    const repo = await createTempRepo()
    await repo.write('old.txt', 'same content\n')
    const base = await repo.commit('base')
    await repo.git('mv', 'old.txt', 'new.txt')
    const head = await repo.commit('rename')

    const changes = await computeChanges(repo.dir, base, head)
    expect(changes.map((c) => `${c.path}:${c.kind}`)).toEqual(['new.txt:add', 'old.txt:delete'])
    await repo.cleanup()
  })
})
