import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class GitError extends Error {
  constructor(
    readonly code: number,
    readonly stderr: string,
    readonly args: string[],
  ) {
    super(`git ${args.join(' ')} 退出码 ${code}: ${stderr.trim()}`)
    this.name = 'GitError'
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
    const e = err as { code?: number; stderr?: string }
    throw new GitError(e.code ?? -1, e.stderr ?? String(err), args)
  }
}
