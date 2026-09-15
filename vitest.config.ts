import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// 契约测试放在各包的 tests/contract/ 下，只在 UNFOLD_CONTRACT=1 时（`pnpm test:contract`）
// 才纳入扫描；常规 `pnpm test` 必须结构性地跳过它们，不依赖测试作者自觉 self-gate。
const runningContractTests = process.env.UNFOLD_CONTRACT === '1'

// state/paths.ts 已经读 process.env['XDG_STATE_HOME']，测试进程里把它重定向
// 到系统临时目录，避免 pnpm test 往用户真实 ~/.local/state/unfold/ 写东西——
// 测试中途失败时留下的是完整 review 目录 + 一个注册在已删除临时仓上的
// git worktree，不该污染用户机器。
const testXdgStateHome = join(tmpdir(), 'unfold-vitest-xdg-state')

export default defineConfig({
  test: {
    include: runningContractTests
      ? ['packages/*/tests/contract/**/*.test.ts']
      : ['packages/*/tests/**/*.test.ts'],
    exclude: runningContractTests
      ? ['**/node_modules/**', '**/.git/**']
      : ['**/node_modules/**', '**/.git/**', 'packages/*/tests/contract/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      XDG_STATE_HOME: testXdgStateHome,
    },
  },
})
