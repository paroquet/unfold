import { describe, it, expect } from 'vitest'
import { createTempRepo } from '../helpers/repo.js'
import { resolveBase } from '../../src/git/range.js'

describe('resolveBase', () => {
  it('显式指定时原样解析成 sha', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', '1\n')
    const first = await repo.commit('first')
    await repo.write('a.txt', '2\n')
    await repo.commit('second')

    const r = await resolveBase(repo.dir, { explicit: first })
    expect(r).toEqual({ base: first, source: 'explicit' })
    await repo.cleanup()
  })

  it('有 upstream 时取与 upstream 的 merge-base', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', '1\n')
    const forkPoint = await repo.commit('base')
    await repo.git('branch', 'origin-main')
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.git('config', 'branch.feature.remote', '.')
    await repo.git('config', 'branch.feature.merge', 'refs/heads/origin-main')
    await repo.write('a.txt', '2\n')
    await repo.commit('work')

    const r = await resolveBase(repo.dir)
    expect(r).toEqual({ base: forkPoint, source: 'upstream' })
    await repo.cleanup()
  })

  it('无 upstream 时退到与默认分支的 merge-base', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', '1\n')
    const forkPoint = await repo.commit('base')
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.write('a.txt', '2\n')
    await repo.commit('work')

    const r = await resolveBase(repo.dir, { defaultBranch: 'main' })
    expect(r).toEqual({ base: forkPoint, source: 'default-branch' })
    await repo.cleanup()
  })

  it('默认分支不存在或就在当前分支上时退到 HEAD', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', '1\n')
    const head = await repo.commit('only')

    const r = await resolveBase(repo.dir, { defaultBranch: 'nonexistent' })
    expect(r).toEqual({ base: head, source: 'head' })
    await repo.cleanup()
  })

  it('无共同祖先时正常退到下一档或 HEAD', async () => {
    const repo = await createTempRepo()
    // 创建第一个 orphan 分支
    await repo.git('checkout', '--orphan', 'orphan1')
    await repo.write('a.txt', '1\n')
    await repo.commit('orphan1-commit')
    // 切到第二个 orphan 分支（与 orphan1 无共同祖先）
    await repo.git('checkout', '--orphan', 'orphan2')
    await repo.write('b.txt', '2\n')
    const head = await repo.commit('orphan2-commit')

    // 即使设置了默认分支为 orphan1，由于无共同祖先，也应该安全地退到 HEAD
    const r = await resolveBase(repo.dir, { defaultBranch: 'orphan1' })
    expect(r).toEqual({ base: head, source: 'head' })
    await repo.cleanup()
  })

  it('真错误（merge-base 失败）必须抛出而不是静默退化', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', '1\n')
    await repo.commit('commit')

    // 构造一个指向 blob 对象（非树或提交）的 ref
    // blob 对象在 merge-base 中会导致错误（exit 128 且 stderr 非空）
    await repo.write('blob-file.txt', 'blob content\n')
    const blob = await repo.git('hash-object', '-w', 'blob-file.txt')
    await repo.git('update-ref', 'refs/weird/thing', blob)

    // merge-base 会因为 blob 对象而抛出真错误
    // resolveBase 应该让这个错误传播出来，而不是安全地返回 HEAD
    await expect(
      resolveBase(repo.dir, { defaultBranch: 'refs/weird/thing' }),
    ).rejects.toThrow()

    await repo.cleanup()
  })

  it('stale tracking（配置了但 ref 失效）应该安全地落到下一档', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', '1\n')
    const base = await repo.commit('base')

    // 创建一个分支并配置为 upstream
    await repo.git('branch', 'origin-main')
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.git('config', 'branch.feature.remote', '.')
    await repo.git('config', 'branch.feature.merge', 'refs/heads/deleted-branch')

    // 删除了 tracking 分支（模拟 stale tracking）
    await repo.write('a.txt', '2\n')
    await repo.commit('work')

    // 即使 upstream tracking 配置存在但 ref 已失效，也应该安全地落到下一档（HEAD）
    // 而不是抛错
    const r = await resolveBase(repo.dir, { defaultBranch: 'origin-main' })
    // 由于 origin-main 存在且与 HEAD 有分歧点，应该返回 base（分歧点）
    expect(r).toEqual({ base, source: 'default-branch' })

    await repo.cleanup()
  })

  it('路径不存在时应该抛错（证明顶层 rev-parse HEAD 没被吞掉）', async () => {
    // 调用不存在的仓库路径
    await expect(resolveBase('/nonexistent/repo/path')).rejects.toThrow()
  })
})
