import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm as fsRm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface TempRepo {
  dir: string
  git(...args: string[]): Promise<string>
  write(rel: string, content: string): Promise<void>
  rm(rel: string): Promise<void>
  commit(msg: string): Promise<string>
  cleanup(): Promise<void>
}

export async function createTempRepo(): Promise<TempRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'unfold-test-'))

  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, {
      cwd: dir,
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout.replace(/\n$/, '')
  }

  await git('init', '-q', '-b', 'main', '.')
  await git('config', 'user.email', 'test@unfold.local')
  await git('config', 'user.name', 'Unfold Test')
  await git('config', 'commit.gpgsign', 'false')

  return {
    dir,
    git,
    async write(rel, content) {
      const abs = join(dir, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
    },
    async rm(rel) {
      await fsRm(join(dir, rel), { force: true })
    },
    async commit(msg) {
      await git('add', '-A')
      await git('commit', '-q', '-m', msg)
      return git('rev-parse', 'HEAD')
    },
    async cleanup() {
      await fsRm(dir, { recursive: true, force: true })
    },
  }
}
