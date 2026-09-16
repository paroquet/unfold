import { describe, it, expect } from 'vitest'
import { RulePlanner } from '../../src/narrate/rule-planner.js'
import { DEFAULT_RULES } from '../../src/narrate/rules.js'
import type { NarrativeRules } from '../../src/narrate/rules.js'
import type { PlanContext } from '../../src/narrate/plan.js'
import type { FileChange } from '../../src/narrate/diff.js'

function change(path: string): FileChange {
  return {
    path,
    kind: 'modify',
    binary: false,
    mode: '100644',
    blob: 'b'.repeat(40),
    oldMode: '100644',
    oldBlob: 'a'.repeat(40),
    hunks: [
      { id: `${path}#0`, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] },
    ],
  }
}

function ctx(paths: string[], rules: NarrativeRules = DEFAULT_RULES): PlanContext {
  return {
    base: 'a'.repeat(40),
    snapshot: 'b'.repeat(40),
    changes: paths.map(change),
    rules,
  }
}

describe('RulePlanner.assign', () => {
  it('每个改动文件都拿到一个层 key，一个不漏', async () => {
    const c = ctx(['src/types.ts', 'src/engine.ts', 'src/index.ts', 'tests/a.test.ts'])
    const { byLayer } = await new RulePlanner().assign(c)
    expect([...byLayer.keys()].sort()).toEqual(
      ['src/engine.ts', 'src/index.ts', 'src/types.ts', 'tests/a.test.ts'].sort(),
    )
    expect(byLayer.get('src/types.ts')).toBe('contract')
    expect(byLayer.get('src/engine.ts')).toBe('core')
    expect(byLayer.get('src/index.ts')).toBe('wiring')
    expect(byLayer.get('tests/a.test.ts')).toBe('test-doc')
  })

  it('用的是 ctx.rules 而不是写死的规则——换一份规则结果就跟着变', async () => {
    const custom: NarrativeRules = {
      version: 1,
      fallback: 'everything',
      layers: [{ key: 'everything', title: '全部', intro: 'i' }],
    }
    const { byLayer } = await new RulePlanner().assign(ctx(['src/types.ts', 'tests/a.test.ts'], custom))
    expect([...byLayer.values()]).toEqual(['everything', 'everything'])
  })

  it('不产出章节、不碰顺序——那是 buildPlan 的事', async () => {
    const result = await new RulePlanner().assign(ctx(['src/a.ts']))
    expect(Object.keys(result)).toEqual(['byLayer'])
  })
})
