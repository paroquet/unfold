import { describe, it, expect } from 'vitest'
import {
  editorCommand,
  formatDepEvidence,
  formatPlanDiff,
  formatPlanSummary,
  formatWarnings,
  reviewCommands,
  suggestOrder,
} from '../../src/bin/report.js'
import type { Chapter, Plan } from '../../src/narrate/plan.js'

function ch(key: string, index: number, title: string, filePaths: string[], hunks = 0): Chapter {
  return {
    key,
    index,
    title,
    intro: `读 ${title}`,
    hunkIds: Array.from({ length: hunks }, (_, i) => `${filePaths[0] ?? 'x'}#${i}`),
    filePaths,
    commitIndex: index,
    status: 'active',
    keyRenamedFrom: null,
  }
}
const PLAN: Plan = {
  version: 1,
  base: 'a'.repeat(40),
  snapshot: 'b'.repeat(40),
  plannerId: 'rule',
  rulesFingerprint: 'test',
  chapters: [ch('contract', 1, '契约', ['src/types.ts'], 2), ch('core', 2, '核心逻辑', ['src/a.ts', 'src/b.ts'], 3)],
}

describe('editorCommand', () => {
  it('给出打开叙事 worktree 的命令，不自己去 spawn', () => {
    expect(editorCommand('/state/wt')).toEqual(['code', '/state/wt'])
  })
})

describe('reviewCommands', () => {
  const lines = reviewCommands({
    worktree: '/state/wt',
    branch: 'unfold/feat-x',
    base: 'abc1234',
    chapters: [
      { title: '契约', commitIndex: 1 },
      { title: '核心逻辑', commitIndex: 2 },
      { title: '测试与文档', commitIndex: 3 },
    ],
  })

  it('第一条是用编辑器打开整个叙事 worktree', () => {
    expect(lines[0]).toContain('code /state/wt')
  })

  it('每一章各有一条可粘的 git show，章号与 ~N 对得上', () => {
    // 3 章：第 1 章是 branch~2，第 3 章是 branch 本身
    expect(lines.some((l) => l.includes('show unfold/feat-x~2') && l.includes('契约'))).toBe(true)
    expect(lines.some((l) => l.includes('show unfold/feat-x~1') && l.includes('核心逻辑'))).toBe(true)
    expect(
      lines.some((l) => /show unfold\/feat-x(\s|$)/.test(l) && l.includes('测试与文档')),
    ).toBe(true)
  })

  it('真实长路径下，命令与注释之间仍有空格——否则粘出去的命令是坏的', () => {
    const long = reviewCommands({
      worktree: '/home/pan/.local/state/unfold/repo-95c009ea/feature-20260916-025752-612-1fd87d/worktree',
      branch: 'unfold/feature-20260916-025752-612-1fd87d',
      base: 'e18ac8f32df4aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      chapters: [
        { title: '契约', commitIndex: 1 },
        { title: '核心逻辑', commitIndex: 2 },
      ],
    })
    for (const line of long) {
      const hash = line.indexOf('#')
      if (hash < 0) continue
      // 注释前必须有空白，且命令本身不能以 '#' 粘在末尾
      expect(line[hash - 1]).toBe(' ')
      expect(line.slice(0, hash).trimEnd()).not.toMatch(/#$/)
    }
  })

  it('所有命令都带 -C <worktree>，可以在任意目录下直接粘', () => {
    for (const l of lines.filter((x) => x.includes('git '))) {
      expect(l).toContain('-C /state/wt')
    }
  })

  it('空章与删除章没有 commit，不生成 git show 行', () => {
    const withGaps = reviewCommands({
      worktree: '/state/wt',
      branch: 'unfold/feat-x',
      base: 'abc1234',
      chapters: [
        { title: '契约', commitIndex: 1 },
        { title: '空章', commitIndex: null },
        { title: '核心逻辑', commitIndex: 2 },
      ],
    })
    expect(withGaps.some((l) => l.includes('空章'))).toBe(false)
    // 仍然只有两个 commit：最后一章（核心逻辑）就是分支 tip，不带 ~N
    expect(withGaps.some((l) => l.includes('show unfold/feat-x~1') && l.includes('契约'))).toBe(
      true,
    )
    expect(
      withGaps.some((l) => /show unfold\/feat-x(\s|$)/.test(l) && l.includes('核心逻辑')),
    ).toBe(true)
  })
})

describe('formatPlanSummary', () => {
  const lines = formatPlanSummary(PLAN)

  it('逐章列出标题、文件数与 hunk 数', () => {
    expect(lines.some((l) => l.includes('契约') && l.includes('1 文件') && l.includes('2 hunk'))).toBe(
      true,
    )
    expect(
      lines.some((l) => l.includes('核心逻辑') && l.includes('2 文件') && l.includes('3 hunk')),
    ).toBe(true)
  })

  it('列出每章的文件路径，便于判断分章对不对', () => {
    expect(lines.some((l) => l.includes('src/types.ts'))).toBe(true)
    expect(lines.some((l) => l.includes('src/b.ts'))).toBe(true)
  })

  it('空章标「本轮无改动」，删除章标「模块已删除」，都不列文件', () => {
    const planWithGaps: Plan = {
      ...PLAN,
      chapters: [
        { ...ch('contract', 1, '契约', ['src/types.ts'], 2), commitIndex: null, status: 'empty' },
        { ...ch('gone', 2, '老模块', [], 0), commitIndex: null, status: 'deleted', filePaths: [] },
      ],
    }
    const out = formatPlanSummary(planWithGaps)
    expect(out.some((l) => l.includes('契约') && l.includes('本轮无改动'))).toBe(true)
    expect(out.some((l) => l.includes('老模块') && l.includes('模块已删除'))).toBe(true)
    expect(out.some((l) => l.includes('src/types.ts'))).toBe(false)
  })
})

describe('formatPlanDiff', () => {
  it('无差异时明确说「没有变化」，而不是打印一片空白', () => {
    const lines = formatPlanDiff({
      chaptersBefore: 2,
      chaptersAfter: 2,
      moved: [],
      added: [],
      removed: [],
    })
    expect(lines.join('\n')).toContain('没有变化')
  })

  it('换章的文件打印成 路径  旧章 → 新章', () => {
    const lines = formatPlanDiff({
      chaptersBefore: 2,
      chaptersAfter: 3,
      moved: [{ path: 'src/api.ts', from: 'core', to: 'contract' }],
      added: ['src/new.ts'],
      removed: ['src/gone.ts'],
    })
    const text = lines.join('\n')
    expect(text).toContain('src/api.ts')
    expect(text).toContain('core → contract')
    expect(text).toContain('2 → 3')
    expect(text).toContain('src/new.ts')
    expect(text).toContain('src/gone.ts')
  })
})

describe('suggestOrder', () => {
  it('按章节顺序给出去重后的目录前缀', () => {
    const plan = {
      version: 1 as const, rulesFingerprint: 'f', base: 'b', snapshot: 's', plannerId: 'p',
      chapters: [
        { index: 1, commitIndex: 1, key: 'src/git/a.ts', title: 'T', intro: 'I',
          status: 'active' as const, keyRenamedFrom: null, hunkIds: [], filePaths: ['src/git/a.ts'] },
        { index: 2, commitIndex: 2, key: 'src/git/b.ts', title: 'T', intro: 'I',
          status: 'active' as const, keyRenamedFrom: null, hunkIds: [], filePaths: ['src/git/b.ts'] },
        { index: 3, commitIndex: 3, key: 'src/bin/c.ts', title: 'T', intro: 'I',
          status: 'active' as const, keyRenamedFrom: null, hunkIds: [], filePaths: ['src/bin/c.ts'] },
      ],
    }
    expect(suggestOrder(plan)).toEqual(['src/git', 'src/bin'])
  })

  it('空章与删除章没有 commit，不进建议的 order', () => {
    const plan = {
      version: 1 as const, rulesFingerprint: 'f', base: 'b', snapshot: 's', plannerId: 'p',
      chapters: [
        { index: 1, commitIndex: null, key: 'src/old/a.ts', title: 'T', intro: 'I',
          status: 'deleted' as const, keyRenamedFrom: null, hunkIds: [], filePaths: [] },
        { index: 2, commitIndex: 1, key: 'src/bin/c.ts', title: 'T', intro: 'I',
          status: 'active' as const, keyRenamedFrom: null, hunkIds: [], filePaths: ['src/bin/c.ts'] },
      ],
    }
    expect(suggestOrder(plan)).toEqual(['src/bin'])
  })
})

describe('formatDepEvidence', () => {
  it('把扫了多少、跳过哪些、在哪破的环都说出来', () => {
    const lines = formatDepEvidence({
      graph: {
        edges: new Map([['a.ts', new Set(['b.ts'])], ['b.ts', new Set()]]),
        scanned: ['a.ts', 'b.ts'],
        skipped: [{ path: 'r.md', reason: '未支持依赖扫描的文件类型' }],
      },
      cycles: [['x.ts', 'y.ts']],
      suggestion: ['src/git'],
    }).join('\n')

    expect(lines).toContain('扫描')
    expect(lines).toContain('跳过 1')
    expect(lines).toContain('未支持依赖扫描的文件类型')
    expect(lines).toContain('连边   1')
    expect(lines).toContain('x.ts')
    expect(lines).toContain('"order": ["src/git"]')
  })

  it('无环时明说「无强连通分量」，而不是留空', () => {
    const lines = formatDepEvidence({
      graph: { edges: new Map(), scanned: [], skipped: [] }, cycles: [], suggestion: [],
    }).join('\n')
    expect(lines).toContain('无强连通分量')
  })
})

describe('formatWarnings', () => {
  it('没有警告时返回空数组，不打印一个空标题', () => {
    expect(formatWarnings([])).toEqual([])
  })

  it('只打 warn，不打 error——error 已经让整轮抛掉了', () => {
    const lines = formatWarnings([
      { code: 'chapter-no-test', severity: 'warn', message: '第 3 章没有测试' },
      { code: 'file-missing', severity: 'error', message: '不该出现在这里' },
    ]).join('\n')
    expect(lines).toContain('第 3 章没有测试')
    expect(lines).not.toContain('不该出现在这里')
  })
})
