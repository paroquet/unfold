# Task 3 Report: base 推导

## 完成概述

按 brief 的 TDD 流程完整实现了 `resolveBase()` 函数及其全套测试，涵盖 review base 的优先级推导逻辑。

## 执行过程

### Step 1: 写失败测试
创建 `packages/core/tests/git/range.test.ts`，照抄 brief 中的测试代码，涵盖四个场景：
- 显式指定 base
- 有 upstream 时使用 merge-base
- 无 upstream 时退到默认分支 merge-base
- 无默认分支或 base 与 HEAD 相同时退到 HEAD

### Step 2: 运行，确认失败
```
pnpm vitest run packages/core/tests/git/range.test.ts
# 输出：FAIL - Cannot find module '../../src/git/range.js'
```
测试如预期失败（模块不存在）。

### Step 3: 实现
创建 `packages/core/src/git/range.ts`，实现：
- `BaseSource` 类型：四种 base 来源
- `BaseResolution` 接口：返回 base sha 和来源
- `ResolveBaseOptions` 接口：配置选项
- `tryGit()` 辅助函数：捕获 GitError 返回 null
- `resolveBase()` 主函数：按优先级推导 base

核心逻辑：
1. 若显式指定，直接解析成 sha（使用 `^{commit}` 消除 annotated tag）
2. 若有 upstream，取与 upstream 的 merge-base
3. 无 upstream 时，退到与默认分支的 merge-base
4. 最后退到 HEAD

### Step 4: 运行测试，确认通过
```
pnpm vitest run packages/core/tests/git/range.test.ts
# 输出：PASS - Test Files 1 passed (1), Tests 4 passed (4)
```

### Step 5: 全测试验证
```
pnpm test
# 输出：Test Files 3 passed (3), Tests 12 passed (12)
```
前序的 8 个测试保持通过，新增 4 个测试全通过。

### 类型检查
```
pnpm typecheck
# 输出：无错误
```
代码通过严格模式 + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`。

## 对 brief 的偏离

无。照抄代码字数不差。

## 疑虑

无。实现符合需求，所有测试通过。

---

## Review 反馈与修复（Coordinator）

**问题识别：** `tryGit` 错误判别过宽，会导致真故障（如对象库损坏）无声退化为 HEAD，而非抛出。

### 修复内容

#### 1. 修正 `GitError` 类型声明
**文件：** `packages/core/src/git/exec.ts`

**问题：** 当 git 二进制不存在时，Node 给的 `err.code` 是字符串 `'ENOENT'`，但原声明为 `number`，被 `as` 断言吞掉了类型问题。

**修复：**
- `code` 改为 `number | null`（git 退出码或 null）
- 新增 `spawnErrno` 字段（如 `'ENOENT'`）来区分 spawn 层错误
- 构造逻辑区分两种错误类型，消息相应调整

**测试验证：**
```
pnpm test
# 输出：Test Files 3 passed (3), Tests 14 passed (14)
# 前序 6 个 Task 2 测试保持通过
```

#### 2. 精细化错误判别逻辑
**文件：** `packages/core/src/git/range.ts`

**修改内容：**
- `tryGit()` 的判别规则改为：
  - GitError 的 `stderr` 非空 → 真错误，抛出
  - GitError 的 `stderr` 为空 → 良性（ref 不存在、无共同祖先等），返回 null
  - spawn 错误（spawnErrno 非 null）→ 真错误，抛出
  
- `resolveBase()` 的 upstream 探测改为用 git config 而非 `rev-parse`，避免 `@{upstream}` 不存在时的 stderr 污染

- defaultBranch 探测前加一层 `rev-parse --verify --quiet`，确保在探测阶段捕获真错误（stderr 非空）

**设计理由：**
- 通过先探测 ref 可解析性，区分"ref 不存在"（stderr 空）和"真错误"（stderr 非空）
- 只有在 ref 存在后才调用 merge-base，确保 merge-base 本身的错误也被正确判别
- 无共同祖先（两个 orphan 分支）的特殊情况由 merge-base 的"exit 1 且 stderr 为空"来识别，正确落到下一档

#### 3. 新增测试覆盖
**文件：** `packages/core/tests/git/range.test.ts`

新增两个测试：

1. **无共同祖先**：两个 orphan 分支，验证 `resolveBase` 安全地落到 HEAD 而不是抛错
   ```
   test: 无共同祖先时正常退到下一档或 HEAD
   ```

2. **真错误必须抛出**：使用 `@{u}@{u}` 这样的非法 ref 引用（导致 stderr "fatal: no upstream configured"），验证 resolveBase 正确抛出而不是返回 HEAD
   ```
   test: 真错误（stderr 非空）必须抛出而不是静默退化
   ```

### 完整测试结果
```bash
pnpm test
# 输出：Test Files 3 passed (3), Tests 14 passed (14)
#       （从原来的 12 个增加到 14 个，新增 2 个，所有原有测试保持通过）

pnpm typecheck
# 输出：无错误

pnpm build
# 输出：构建成功
```

### 对 brief 的偏离

- brief 中的实现是初版，缺少错误判别的细节；修复后的实现更严格
- 新增了 2 个测试（总计 6 个），覆盖了"无共同祖先"和"真错误必须抛出"两个关键场景
- `GitError` 的类型改动是必要的，修正了原有的类型谎言

### 遗留疑虑

无。修复符合 coordinator 的判别标准和行为要求。

---

**初始 Commit:** `77229bc` feat(core): base 推导

**修复 Commit:** `450dfc3` fix(core): 错误判别精细化、区分真故障与良性 ref 不存在
