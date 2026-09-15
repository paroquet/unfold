import { describe, it, expect } from 'vitest'
import { createTempRepo } from './repo.js'

describe('createTempRepo', () => {
  it('建出一个可用的 git 仓库，且 cleanup 后目录消失', async () => {
    const repo = await createTempRepo()
    await repo.write('a.txt', 'hello\n')
    const sha = await repo.commit('init')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(await repo.git('rev-parse', 'HEAD')).toBe(sha)
    expect(await repo.git('status', '--porcelain')).toBe('')

    const { existsSync } = await import('node:fs')
    expect(existsSync(repo.dir)).toBe(true)
    await repo.cleanup()
    expect(existsSync(repo.dir)).toBe(false)
  })

  it('write 会自动建父目录，rm 能删文件', async () => {
    const repo = await createTempRepo()
    await repo.write('src/deep/x.ts', 'export const x = 1\n')
    await repo.commit('add x')
    expect(await repo.git('ls-files')).toContain('src/deep/x.ts')
    await repo.rm('src/deep/x.ts')
    expect(await repo.git('status', '--porcelain')).toContain('src/deep/x.ts')
    await repo.cleanup()
  })
})
