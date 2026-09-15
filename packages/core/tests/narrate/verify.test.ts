import { describe, it, expect } from 'vitest'
import { createTempRepo } from '../helpers/repo.js'
import { verify, VerifyError } from '../../src/narrate/verify.js'

describe('verify', () => {
  it('tree 相同时通过', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'x\n')
    const head = await repo.commit('base')
    const tree = await repo.git('rev-parse', `${head}^{tree}`)
    const other = await repo.git('commit-tree', tree, '-m', 'same tree')
    await expect(verify(repo.dir, other, head)).resolves.toBeUndefined()
    await repo.cleanup()
  })

  it('tree 不同时抛 VerifyError 且带上两个 tree sha', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'x\n')
    const first = await repo.commit('base')
    const firstTree = await repo.git('rev-parse', `${first}^{tree}`)
    await repo.write('a.txt', 'y\n')
    const second = await repo.commit('changed')
    const secondTree = await repo.git('rev-parse', `${second}^{tree}`)

    await expect(verify(repo.dir, second, first)).rejects.toBeInstanceOf(VerifyError)

    // brief 的 Produces 明确要求 VerifyError 带上两个 tree sha 以便排查——
    // 光断言"是 VerifyError 的实例"覆盖不到这个契约，这里显式核对字段值。
    try {
      await verify(repo.dir, second, first)
      throw new Error('verify 应该抛错但没有')
    } catch (err) {
      expect(err).toBeInstanceOf(VerifyError)
      const e = err as VerifyError
      expect(e.expectedTree).toBe(firstTree)
      expect(e.actualTree).toBe(secondTree)
    }

    await repo.cleanup()
  })
})
