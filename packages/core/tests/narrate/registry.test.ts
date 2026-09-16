import { describe, it, expect } from 'vitest'
import { EMPTY_REGISTRY, updateRegistry } from '../../src/narrate/registry.js'
import type { Segment } from '../../src/narrate/segment.js'

const seg = (key: string, members: string[]): Segment => ({
  key, members, title: `T ${key}`, intro: `I ${key}`,
})

describe('updateRegistry', () => {
  it('空册时 segments 原样成章，轮次记在 createdRound', () => {
    const got = updateRegistry({
      registry: EMPTY_REGISTRY,
      segments: [seg('a.ts', ['a.ts', 'b.ts'])],
      round: 1,
      unitsAlive: new Set(['a.ts', 'b.ts']),
      activeUnits: new Set(['a.ts']),
      order: ['a.ts', 'b.ts'],
    })
    expect(got.chapters).toHaveLength(1)
    expect(got.chapters[0]).toMatchObject({
      key: 'a.ts', index: 1, status: 'active', members: ['a.ts', 'b.ts'], createdRound: 1,
    })
  })

  it('本轮没动的章标 empty 而不是消失', () => {
    const before = updateRegistry({
      registry: EMPTY_REGISTRY, segments: [seg('a.ts', ['a.ts'])], round: 1,
      unitsAlive: new Set(['a.ts']), activeUnits: new Set(['a.ts']), order: ['a.ts'],
    })
    const after = updateRegistry({
      registry: before, segments: [], round: 2,
      unitsAlive: new Set(['a.ts']), activeUnits: new Set(), order: [],
    })
    expect(after.chapters).toHaveLength(1)
    expect(after.chapters[0]?.status).toBe('empty')
    expect(after.chapters[0]?.lastActiveRound).toBe(1)
  })

  it('成员全被删除时章标 deleted，仍留在册里', () => {
    const before = updateRegistry({
      registry: EMPTY_REGISTRY, segments: [seg('a.ts', ['a.ts'])], round: 1,
      unitsAlive: new Set(['a.ts']), activeUnits: new Set(['a.ts']), order: ['a.ts'],
    })
    const after = updateRegistry({
      registry: before, segments: [], round: 2,
      unitsAlive: new Set(), activeUnits: new Set(), order: [],
    })
    expect(after.chapters).toHaveLength(1)
    expect(after.chapters[0]?.status).toBe('deleted')
  })

  it('段首文件被删时 key 顺延，并记下 keyRenamedFrom', () => {
    const before = updateRegistry({
      registry: EMPTY_REGISTRY, segments: [seg('a.ts', ['a.ts', 'b.ts'])], round: 1,
      unitsAlive: new Set(['a.ts', 'b.ts']), activeUnits: new Set(['a.ts']), order: ['a.ts', 'b.ts'],
    })
    const after = updateRegistry({
      registry: before, segments: [], round: 2,
      unitsAlive: new Set(['b.ts']), activeUnits: new Set(), order: ['b.ts'],
    })
    expect(after.chapters[0]?.key).toBe('b.ts')
    expect(after.chapters[0]?.keyRenamedFrom).toBe('a.ts')
  })

  it('已在册的文件不会被本轮的 segment 拉到别的章去', () => {
    const before = updateRegistry({
      registry: EMPTY_REGISTRY, segments: [seg('a.ts', ['a.ts', 'b.ts'])], round: 1,
      unitsAlive: new Set(['a.ts', 'b.ts']), activeUnits: new Set(['a.ts']), order: ['a.ts', 'b.ts'],
    })
    // 第 2 轮算出来的段把 b.ts 划到了另一章——册优先，b.ts 必须留在原章
    const after = updateRegistry({
      registry: before, segments: [seg('a.ts', ['a.ts']), seg('b.ts', ['b.ts'])], round: 2,
      unitsAlive: new Set(['a.ts', 'b.ts']), activeUnits: new Set(['a.ts']), order: ['a.ts', 'b.ts'],
    })
    expect(after.chapters).toHaveLength(1)
    expect(after.chapters[0]?.members).toEqual(['a.ts', 'b.ts'])
  })

  it('新章插位时忽略本轮没有位置的空章，锚在真正排在它后面的章上（I1 回归）', () => {
    const before = updateRegistry({
      registry: EMPTY_REGISTRY,
      segments: [seg('x/a.ts', ['x/a.ts']), seg('y/b.ts', ['y/b.ts'])],
      round: 1,
      unitsAlive: new Set(['x/a.ts', 'y/b.ts']),
      activeUnits: new Set(['x/a.ts', 'y/b.ts']),
      order: ['x/a.ts', 'y/b.ts'],
    })
    // 第 2 轮：x/a.ts 那章本轮没动（不在 order 里）→ 空章，没有位置；
    // 新章 z/c.ts 在依赖序上排在 y/b.ts 之后，必须落到最后。
    // 修之前空章的 posOf 是 +Infinity，findIndex 第一个就命中它，
    // z/c.ts 会被插到最前面，读者先读到依赖别人的那一章。
    const after = updateRegistry({
      registry: before,
      segments: [seg('y/b.ts', ['y/b.ts']), seg('z/c.ts', ['z/c.ts'])],
      round: 2,
      unitsAlive: new Set(['x/a.ts', 'y/b.ts', 'z/c.ts']),
      activeUnits: new Set(['y/b.ts', 'z/c.ts']),
      order: ['y/b.ts', 'z/c.ts'],
    })
    expect(after.chapters.map((c) => c.key)).toEqual(['x/a.ts', 'y/b.ts', 'z/c.ts'])
    expect(after.chapters.map((c) => c.status)).toEqual(['empty', 'active', 'active'])
  })

  it('新章按依赖序插到该去的位置，已有章不重排', () => {
    const before = updateRegistry({
      registry: EMPTY_REGISTRY,
      segments: [seg('x/a.ts', ['x/a.ts']), seg('z/c.ts', ['z/c.ts'])],
      round: 1,
      unitsAlive: new Set(['x/a.ts', 'z/c.ts']),
      activeUnits: new Set(['x/a.ts', 'z/c.ts']),
      order: ['x/a.ts', 'z/c.ts'],
    })
    const after = updateRegistry({
      registry: before,
      segments: [seg('y/b.ts', ['y/b.ts'])],
      round: 2,
      unitsAlive: new Set(['x/a.ts', 'y/b.ts', 'z/c.ts']),
      activeUnits: new Set(['y/b.ts']),
      order: ['x/a.ts', 'y/b.ts', 'z/c.ts'],
    })
    expect(after.chapters.map((c) => c.key)).toEqual(['x/a.ts', 'y/b.ts', 'z/c.ts'])
    expect(after.chapters.map((c) => c.index)).toEqual([1, 2, 3])
  })
})
