import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class GitError extends Error {
  readonly code: number | null
  readonly spawnErrno: string | null
  readonly stderr: string
  readonly args: string[]

  constructor(
    codeOrErrno: number | string | null,
    stderr: string,
    args: string[],
  ) {
    let message: string
    if (typeof codeOrErrno === 'string') {
      // spawn 错误（如 'ENOENT'）
      message = `git ${args.join(' ')} spawn failed: ${codeOrErrno}`
    } else {
      // git 退出码
      const code = codeOrErrno ?? -1
      message = `git ${args.join(' ')} 退出码 ${code}: ${stderr.trim()}`
    }
    super(message)
    this.name = 'GitError'
    this.code = typeof codeOrErrno === 'string' ? null : (codeOrErrno ?? -1)
    this.spawnErrno = typeof codeOrErrno === 'string' ? codeOrErrno : null
    this.stderr = stderr
    this.args = args
  }
}

export interface GitOptions {
  env?: NodeJS.ProcessEnv
  input?: string
  /**
   * 默认 true，去掉 stdout 末尾的单个换行（绝大多数 plumbing 输出都需要）。
   * 读 blob 内容时必须传 false——否则「有无结尾换行」这个信息会被吃掉，
   * 破坏字节一致。
   */
  trim?: boolean
}

/** 跑一条 git 命令。非零退出抛 GitError。 */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  try {
    const child = execFileAsync('git', args, {
      cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      maxBuffer: 256 * 1024 * 1024,
    })
    if (opts.input !== undefined) {
      child.child.stdin?.end(opts.input)
    }
    const { stdout } = await child
    return opts.trim === false ? stdout : stdout.replace(/\n$/, '')
  } catch (err: unknown) {
    const e = err as { code?: number | string; stderr?: string }
    const codeOrErrno = e.code ?? null
    throw new GitError(codeOrErrno, e.stderr ?? String(err), args)
  }
}
