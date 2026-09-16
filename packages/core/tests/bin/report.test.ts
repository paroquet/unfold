import { describe, it, expect } from 'vitest'
import {
  editorCommand,
  formatPlanDiff,
  formatPlanSummary,
  reviewCommands,
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
    chapterTitles: ['契约', '核心逻辑', '测试与文档'],
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
      chapterTitles: ['契约', '核心逻辑'],
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
