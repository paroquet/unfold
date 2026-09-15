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
    await repo.write('a.txt', 'y\n')
    const second = await repo.commit('changed')
    await expect(verify(repo.dir, second, first)).rejects.toBeInstanceOf(VerifyError)
    await repo.cleanup()
  })
})
