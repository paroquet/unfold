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

  it('命令不是 narrate', () => {
    const result = parseArgs(['status'], CWD)
    expect(result).toEqual({ ok: false })
  })

  it('完全没有参数', () => {
    const result = parseArgs([], CWD)
    expect(result).toEqual({ ok: false })
  })
})
