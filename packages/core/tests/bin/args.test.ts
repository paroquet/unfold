import { describe, it, expect } from 'vitest'
import { parseArgs } from '../../src/bin/args.js'

const CWD = '/repo'

describe('parseArgs', () => {
  it('narrate 不带任何 flag：repo 落到 cwd', () => {
    const result = parseArgs(['narrate'], CWD)
    expect(result).toEqual({ ok: true, args: { repo: CWD } })
  })

  it('narrate --base <sha>', () => {
    const result = parseArgs(['narrate', '--base', 'abc123'], CWD)
    expect(result).toEqual({ ok: true, args: { repo: CWD, explicit: 'abc123' } })
  })

  it('narrate --default-branch main', () => {
    const result = parseArgs(['narrate', '--default-branch', 'main'], CWD)
    expect(result).toEqual({ ok: true, args: { repo: CWD, defaultBranch: 'main' } })
  })

  it('narrate --repo /some/path', () => {
    const result = parseArgs(['narrate', '--repo', '/some/path'], CWD)
    expect(result).toEqual({ ok: true, args: { repo: '/some/path' } })
  })

  it('三个 flag 组合', () => {
    const result = parseArgs(
      ['narrate', '--base', 'abc123', '--default-branch', 'main', '--repo', '/some/path'],
      CWD,
    )
    expect(result).toEqual({
      ok: true,
      args: { repo: '/some/path', explicit: 'abc123', defaultBranch: 'main' },
    })
  })

  it('--base 后面紧跟另一个 flag：判为 usage 错误，不把 flag 名当值吞掉', () => {
    const result = parseArgs(['narrate', '--base', '--default-branch'], CWD)
    expect(result).toEqual({ ok: false })
  })

  it('--base 是最后一个参数，没有值', () => {
    const result = parseArgs(['narrate', '--base'], CWD)
    expect(result).toEqual({ ok: false })
  })

  it('未知 flag', () => {
    const result = parseArgs(['narrate', '--nope', 'x'], CWD)
    expect(result).toEqual({ ok: false })
  })

  it('--dry-run：只算 plan，不建分支不建 worktree', () => {
    const result = parseArgs(['narrate', '--dry-run'], CWD)
    expect(result).toEqual({ ok: true, args: { repo: CWD, dryRun: true } })
  })

  it('--reuse：复用该仓库最近一次 review 目录', () => {
    const result = parseArgs(['narrate', '--reuse'], CWD)
    expect(result).toEqual({ ok: true, args: { repo: CWD, reuse: true } })
  })

  it('--clean：清理该仓库的历史 review 后退出', () => {
    const result = parseArgs(['narrate', '--clean'], CWD)
    expect(result).toEqual({ ok: true, args: { repo: CWD, clean: true } })
  })

  it('--open：跑完用编辑器打开叙事 worktree', () => {
    const result = parseArgs(['narrate', '--open'], CWD)
    expect(result).toEqual({ ok: true, args: { repo: CWD, open: true } })
  })

  it('--compare <reviewId>：与历史 plan 并排比较', () => {
    const result = parseArgs(['narrate', '--compare', 'feat-x-20260916-101500-042-a1b2c3'], CWD)
    expect(result).toEqual({
      ok: true,
      args: { repo: CWD, compare: 'feat-x-20260916-101500-042-a1b2c3' },
    })
  })

  it('--compare 后面紧跟另一个 flag：判为 usage 错误', () => {
    const result = parseArgs(['narrate', '--compare', '--open'], CWD)
    expect(result).toEqual({ ok: false })
  })

  it('--compare 是最后一个参数，没有值', () => {
    const result = parseArgs(['narrate', '--compare'], CWD)
    expect(result).toEqual({ ok: false })
  })

  it('布尔 flag 与取值 flag 混用', () => {
    const result = parseArgs(
      ['narrate', '--repo', '/r', '--dry-run', '--base', 'abc', '--open'],
      CWD,
    )
    expect(result).toEqual({
      ok: true,
      args: { repo: '/r', explicit: 'abc', dryRun: true, open: true },
    })
  })

  it('--rules <file>：指定叙事规则配置', () => {
    const result = parseArgs(['narrate', '--rules', './my-rules.json'], CWD)
    expect(result).toEqual({ ok: true, args: { repo: CWD, rulesPath: './my-rules.json' } })
  })

  it('--rules 后面紧跟另一个 flag：判为 usage 错误', () => {
    expect(parseArgs(['narrate', '--rules', '--open'], CWD)).toEqual({ ok: false })
  })

  it('命令不是 narrate', () => {
    const result = parseArgs(['status'], CWD)
    expect(result).toEqual({ ok: false })
  })

  it('完全没有参数', () => {
    const result = parseArgs([], CWD)
    expect(result).toEqual({ ok: false })
  })
})
