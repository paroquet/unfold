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

/**
 * git 子进程要清洗掉的环境变量：一旦存在，git 会优先信它们而不是 cwd，
 * 「所有 git 子进程调用必须显式传 cwd」这条全局约束就被环境变量本身
 * 推翻了。本工具的目标场景是被 agent / orca / git hook 拉起，这些环境
 * 里 GIT_DIR 等变量很可能已经设着——一旦如此，Unfold 会操作到另一个仓库
 * 上，零干扰承诺直接失效。调用点若确实需要注入（snapshot / replay 用
 * GIT_INDEX_FILE 指向专用临时 index），走 opts.env 显式声明，会在下面
 * 清洗之后再叠加回去，不受影响。
 */
const GIT_ENV_TO_SCRUB = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const

/** 跑一条 git 命令。非零退出抛 GitError。 */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  try {
    const baseEnv = { ...process.env }
    for (const key of GIT_ENV_TO_SCRUB) delete baseEnv[key]
    const env = opts.env ? { ...baseEnv, ...opts.env } : baseEnv

    const child = execFileAsync('git', args, {
      cwd,
      env,
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
