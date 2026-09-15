import { git } from '../git/exec.js'

export class VerifyError extends Error {
  constructor(
    readonly expectedTree: string,
    readonly actualTree: string,
  ) {
    super(
      `叙事分支的终态 tree 与快照不一致：期望 ${expectedTree}，实际 ${actualTree}。` +
        `拒绝出货——有改动没有被分进任何章节。`,
    )
    this.name = 'VerifyError'
  }
}

/**
 * 字节一致校验（spec §6.3）。这是产品承诺，不降级：不等就中止。
 */
export async function verify(
  repo: string,
  tip: string,
  snapshotCommit: string,
): Promise<void> {
  const expected = await git(repo, ['rev-parse', `${snapshotCommit}^{tree}`])
  const actual = await git(repo, ['rev-parse', `${tip}^{tree}`])
  if (expected !== actual) throw new VerifyError(expected, actual)
}
