import { defineConfig } from 'vitest/config'

// 契约测试放在各包的 tests/contract/ 下，只在 UNFOLD_CONTRACT=1 时（`pnpm test:contract`）
// 才纳入扫描；常规 `pnpm test` 必须结构性地跳过它们，不依赖测试作者自觉 self-gate。
const runningContractTests = process.env.UNFOLD_CONTRACT === '1'

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
  },
})
