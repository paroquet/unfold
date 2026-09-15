import { describe, it, expect } from 'vitest'
import { createTempRepo } from '../helpers/repo.js'
import { computeChanges } from '../../src/narrate/diff.js'
import { RulePlanner } from '../../src/narrate/rule-planner.js'
import { replay } from '../../src/narrate/replay.js'

describe('replay', () => {
  it('终态 tree 与 snapshot tree 逐字节一致', async () => {
    const repo = await createTempRepo()
    await repo.write('src/types.ts', 'export type T = 1\n')
    await repo.write('src/engine.ts', 'export const run = () => 1\n')
    await repo.write('README.md', 'old\n')
    const base = await repo.commit('base')

    await repo.write('src/types.ts', 'export type T = 2\n')
    await repo.write('src/engine.ts', 'export const run = () => 2\n')
    await repo.write('README.md', 'new\n')
    await repo.write('src/added.ts', 'export const added = true\n')
    const head = await repo.commit('work')

    const changes = await computeChanges(repo.dir, base, head)
    const plan = await new RulePlanner().plan({ base, snapshot: head, changes })
    const result = await replay(repo.dir, plan, changes)

    expect(await repo.git('rev-parse', `${result.tip}^{tree}`)).toBe(
      await repo.git('rev-parse', `${head}^{tree}`),
    )
    expect(result.commits.length).toBe(plan.chapters.length)
    await repo.cleanup()
  })

  it('中间 commit 只含到本章为止的改动', async () => {
    const repo = await createTempRepo()
    await repo.write('src/types.ts', 'A\n')
    await repo.write('src/engine.ts', 'B\n')
    const base = await repo.commit('base')
    await repo.write('src/types.ts', 'A2\n')
    await repo.write('src/engine.ts', 'B2\n')
    const head = await repo.commit('work')

    const changes = await computeChanges(repo.dir, base, head)
    const plan = await new RulePlanner().plan({ base, snapshot: head, changes })
    const result = await replay(repo.dir, plan, changes)

    const first = result.commits[0]!
    expect(await repo.git('cat-file', 'blob', `${first}:src/types.ts`)).toBe('A2')
    expect(await repo.git('cat-file', 'blob', `${first}:src/engine.ts`)).toBe('B')
    await repo.cleanup()
  })

  it('删除的文件在其所属章节被移除', async () => {
    const repo = await createTempRepo()
    await repo.write('src/engine.ts', 'keep\n')
    await repo.write('src/gone.ts', 'bye\n')
    const base = await repo.commit('base')
    await repo.rm('src/gone.ts')
    const head = await repo.commit('delete')

    const changes = await computeChanges(repo.dir, base, head)
    const plan = await new RulePlanner().plan({ base, snapshot: head, changes })
    const result = await replay(repo.dir, plan, changes)

    const files = await repo.git('ls-tree', '-r', '--name-only', result.tip)
    expect(files.split('\n')).not.toContain('src/gone.ts')
    expect(await repo.git('rev-parse', `${result.tip}^{tree}`)).toBe(
      await repo.git('rev-parse', `${head}^{tree}`),
    )
    await repo.cleanup()
  })

  it('文件内分章：同一文件的 hunk 拆到两章时，中间态只含前一章的改动', async () => {
    const repo = await createTempRepo()
    const base12 = `${Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join('\n')}\n`
    await repo.write('src/engine.ts', base12)
    const base = await repo.commit('base')
    await repo.write('src/engine.ts', base12.replace('l1\n', 'L1\n').replace('l12\n', 'L12\n'))
    const head = await repo.commit('work')

    const changes = await computeChanges(repo.dir, base, head)
    const file = changes[0]!
    expect(file.hunks.length).toBe(2)

    // 手工造一个把两个 hunk 拆到两章的 plan。v1 的 RulePlanner 不会这么排，
    // 但 replay 必须已经支持——这正是 spec §6.5 说的「接口 v1 就定死」。
    const plan = {
      version: 1 as const,
      base,
      snapshot: head,
      plannerId: 'manual',
      chapters: [
        { index: 1, key: 'first-half', title: '前半', intro: 'i', hunkIds: [file.hunks[0]!.id], filePaths: [] },
        { index: 2, key: 'second-half', title: '后半', intro: 'i', hunkIds: [file.hunks[1]!.id], filePaths: ['src/engine.ts'] },
      ],
    }

    const result = await replay(repo.dir, plan, changes)
    const mid = (await repo.git('cat-file', 'blob', `${result.commits[0]!}:src/engine.ts`)).split('\n')
    expect(mid[0]).toBe('L1')   // 第 1 章的改动已落地
    expect(mid[11]).toBe('l12') // 第 2 章的改动还没落地

    expect(await repo.git('rev-parse', `${result.tip}^{tree}`)).toBe(
      await repo.git('rev-parse', `${head}^{tree}`),
    )
    await repo.cleanup()
  })

  it('二进制文件整体替换且不破坏字节一致', async () => {
    const repo = await createTempRepo()
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFile(join(repo.dir, 'img.bin'), Buffer.from([0, 1, 2, 0]))
    await repo.write('src/engine.ts', 'x\n')
    const base = await repo.commit('base')
    await writeFile(join(repo.dir, 'img.bin'), Buffer.from([0, 9, 8, 0]))
    const head = await repo.commit('work')

    const changes = await computeChanges(repo.dir, base, head)
    const plan = await new RulePlanner().plan({ base, snapshot: head, changes })
    const result = await replay(repo.dir, plan, changes)

    expect(await repo.git('rev-parse', `${result.tip}^{tree}`)).toBe(
      await repo.git('rev-parse', `${head}^{tree}`),
    )
    await repo.cleanup()
  })
})
