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

  it('真错误（stderr 非空）必须抛出而不是静默退化', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', '1\n')
    await repo.commit('commit')

    // 测试：rev-parse 探测时如果遇到 stderr 非空的错误，应该抛出而不是当作"ref 不存在"
    // 使用 @{u}@{u} 这样的非法 ref 引用格式，会导致 git 输出 stderr 和非 0 exit code
    const badRef = '@{u}@{u}'

    // rev-parse --verify --quiet 会因为非法的 ref 而抛出带有 stderr 的 GitError
    // resolveBase 应该让这个错误传播出来，而不是当作"ref 不存在"返回 HEAD
    await expect(
      resolveBase(repo.dir, { defaultBranch: badRef }),
    ).rejects.toThrow()

    await repo.cleanup()
  })
})
