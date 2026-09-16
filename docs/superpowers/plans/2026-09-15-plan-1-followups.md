# Plan 1 遗留项（Plan 2 开工前必须处理）

> 来源：Plan 1（core 叙事引擎）的逐任务审查与整分支终审，2026-09-15。
> Plan 1 最终状态：42 个 commit，83 个测试全绿，2 个 Critical + 15 个 Important 全部解决。
> 本文只记**已确认存在、但按裁决推迟**的项，以及**必须由用户裁决的 spec 矛盾**。

## 0. 必须先由用户裁决：spec 自相矛盾

**S1：verify 失败时，是降级还是拒绝出货？**

- spec §3 写：「verify 失败时：轨道 A 的 worktree 仍停在 `SNAP`（detached），本身就是一份有效的「整体改动」视图。**降级为无章节的普通 review，而不是整轮失败**。」
- spec §6.3 写：「verify 失败即拒绝出货，**不降级**。」

Plan 1 的实现选了后者（`run.ts` 直接抛 `VerifyError`）。

**为什么必须先解决**：Plan 1 的终审提出「narrate 失败时残留的 ref 与 worktree 该不该清理」，答案完全取决于这条——若按 §3 要保留 worktree 供降级阅读，则「一律清理」是错的；若按 §6.3 拒绝出货，则应清理。Plan 2/3 的降级路径无法在矛盾未解时设计。

## 1. 静默缺陷：v1 落在死路径，v2 全部变活

这三项的共同点是 **v1 的 RulePlanner 不拆文件，所以走不到；而 Plan 2 的 AI planner 一上线就全部变成活路径**。其中两项 `verify` 结构上抓不到。

### 1.1 `parseHunks` 对引号化 / 含空格的路径静默丢掉全部 hunk

`packages/core/src/narrate/diff.ts`

`parseRaw` 走 `-z` 拿到**原始路径**，`parseHunks` 却从 patch 正文的 `--- a/…` / `+++ b/…` 取路径。两者在两种常见情况下对不上，而 `hunksByPath.get(path) ?? []` 直接吞掉：

```
--- a/has space.ts<TAB>           ← 含空格时 git 追加一个制表符
+++ "b/\344\270\255\346\226\207.ts"  ← 非 ASCII 时整体 C-quote + 八进制转义
```

实测产出：`[{path:"has space.ts", hunks:0}, {path:"plain.ts", hunks:1}, {path:"中文.ts", hunks:0}]`

**为什么 verify 抓不到**：`replay` 的 `isComplete = (0 === 0)` 恒真 → 走快路径用终态 blob → tree 仍然字节一致 → verify 通过。这是一个连 verify 都看不见的静默数据缺失。

**2026-09-16 用 `--dry-run` 在真实输入上复现**（一个含空格 / 中文 / 符号链接 / 权限位变更的仓库）：

```
$ unfold narrate --default-branch main --dry-run
  第 1 章 契约（1 文件 / 1 hunk）
      src/types.ts
  第 2 章 核心逻辑（3 文件 / 0 hunk）
      src/has space.ts        ← 真有内容改动，hunk 数 0
      src/run.sh              ← 仅改权限位，0 hunk 是对的
      src/有空格 中文.ts       ← 真有内容改动，hunk 数 0
```

同一次运行里，`tests/e2e/real-repo.test.ts` 的四条产品承诺**全部通过**——
再次印证：承诺成立不等于数据完整，而 115 个合成测试一个都没发现这件事。
对中文路径的用户（本项目的第一个用户就是）来说，这是日常会撞上的。

**v1 后果**：仅 CodeTour 的 step 从真实行号退回第 1 行。
**v2 后果**：AI planner 按 hunk 分章时，任何中文 / 带空格路径的文件分章能力直接消失。

**修法**：`git -c core.quotePath=false` 可解引号化（实测有效）但**制表符仍在**，需一并 strip；更稳的做法是改从 `diff --git` 行取路径，或直接按 `parseRaw` 给出的路径逐文件取 patch。同时应与 `parseRaw` 一致地 fail loud（见 1.4）。

### 1.2 慢路径对非 UTF-8 文本静默损坏内容

`packages/core/src/git/exec.ts` + `packages/core/src/narrate/replay.ts`

`git()` 返回 `execFile` 的 stdout **字符串**（默认 UTF-8 解码）。`cat-file blob` 读 base、`hash-object --stdin` 写回时，任何非 UTF-8 但不含 NUL 的文本（latin-1、GBK 片段等，git 不判为 binary）会被替换成 U+FFFD：

```
base 第 6 行:  63 61 66 e9 0a        ("café")
中间态第 6 行: 63 61 66 ef bf bd 0a  (U+FFFD)
```

**为什么 verify 抓不到**：终章走快路径用终态 blob，`tree(tip)` 仍一致；被污染的只有**中间章的 commit**。这正落在 spec §7.1 声称「构造不可能失败、verify 是恒真断言」的盲区里。

**修法**：`git()` 增加 buffer 模式，blob 读写全程走 `Buffer`；`composeContent` 相应改为按 Buffer 或 latin1 安全串处理。注意 patch 正文本身也是 UTF-8 解码的，`+` 行同样受影响，**这是一次性要一起做的改造**。做完应更新 `exec.ts` 中关于 `trim: false` 与「字节一致」的注释——当前注释对非 UTF-8 内容给不了它承诺的保真。

### 1.3 `narrate()` 写死 `new RulePlanner()`，两道安全闸的集成路径零覆盖

`packages/core/src/narrate/run.ts`

终审变异：把 `if (issues.length > 0)` 改成 `if (false)`（即完全忽略 `validatePlan` 的结论），**83 个测试全绿**。根因是没有注入 planner 的缝——v1 的 RulePlanner 恒产合法 plan，任何测试都构造不出「plan 非法 → narrate 必须硬中止」这条路径。

**修法**：`NarrateOptions` 增加 `planner?: ChapterPlanner`。Plan 2 接 AI planner 时无论如何都要改这个签名，现在补既补上测试缝，又提前把 Plan 2 的接口定下来。

### 1.4 `parseHunks` / `toCodeTours` 的静默 continue

两处遇到「取不到就当没有」，而同文件的 `parseRaw` 是 `throw`。与 1.1 同源，应在同一次「diff.ts 收紧」里按统一的 fail-loud 策略处理。

## 2. 其它已确认的技术债

### 2.1 临时 index 文件名应改为每次调用唯一

`snapshot.ts` 的 `unfold-snapshot-index` 与 `replay.ts` 的 `unfold-replay-index` 是固定名，导致「同一 repo 不得并发调用」成为前置条件（目前仅写在 `snapshot.ts` 的文档注释里）。

终审复审的反建议（已采纳）：**不要按「加锁」方向排期**——进程内锁对跨进程并发无效，而真正危险的正是两个 `unfold narrate` 进程同时跑。把文件名改成每次调用唯一（复用 reviewId 或随机后缀），前置条件本身直接消失。**两行改动**。做完需同步更新 `snapshot.ts` 的注释。

### 2.2 `validatePlan` 缺 `chapter-empty` 规则

`pinToPreviousChapters` 能把一整章搬空，而空章会产出空 commit。v1 的 `run.ts` 从不传 `previous`，故不发作；Plan 2 会。建议新增 `ValidationCode: 'chapter-empty'`。

### 2.3 状态布局需迁移到 `rounds/NNN.json`（S2）

spec §8.1 要求 `rounds/001.json`（snapshot sha · plan · reviewed 映射）+ `findings.json`；Plan 1 落的是根级 `plan.json` + `meta.json`，无 `rounds/`。但 `pinSnapshot` 已在写 `refs/unfold/<id>/round-001`——**ref 层已有轮次概念，磁盘层没有**。

Plan 1 的完成标准第 7 条明确认可了当前布局，属有意简化。但 Plan 2 接第 2 轮时必须先迁移，且要考虑已有 review 目录的兼容。

### 2.4 `--abbrev=40` 假设 SHA-1 仓库

`diff.ts`。裁决为维持不修：SHA-256 仓库上游仍属实验性，正确做法需 `git rev-parse --show-object-format` 门控，归属「仓库/环境探测」任务，现在做是无处安放的孤儿代码。

## 3. 已 park 的 Minor（终审后归档，不阻塞合并）

1. `run.ts` 的 D3 早退重排，把「快照 commit 创建 → `pinSnapshot` 钉 ref」的无引用窗口从数毫秒拉长到覆盖 `resolveBase` + `computeChanges` 全程。**既有竞态被放宽，非新竞态**；触发需 narrate 运行中恰好有人手动 `gc --prune=now`。与 2.1 合并处理最划算
2. 整章只含删除文件时产出 `"steps": []` 的空 tour。相比修复前「step 指向不存在的文件」是严格改善，取舍已写进 `codetour.ts` 注释
3. `codetour.ts` 的 `seen.add` 提前，仅对**非法 plan** 行为有变；narrate 主路径够不到（`validate` 的 `hunk-unknown` 先行拦截），只影响直接调用导出 API 的第三方
4. `addWorktree` 的友好报错靠匹配英文 stderr，git 被本地化时退回裸 `GitError`。降级而非崩溃
5. `exec.test.ts` 的 `repo.cleanup()` 在 `finally` 之外，断言失败时漏清两个临时仓。本仓既有写法
6. `diff.ts` 一处错误文案括号不配对。纯文案
7. 测试污染被从 `~/.local/state/` 搬到 `<tmpdir>/unfold-vitest-xdg-state/`，**未消除**（每跑一次仍新增一个空 repo-id 目录）

## 4. 一条流程观察

Plan 1 的多位 reviewer 做过高质量的手工验证——在真实 linked worktree 里验 `repoId`、验 `removeWorktree` 不留残骸、验哨兵 mtime 的判别力。但**这些验证起初都没有变成 shipped 测试**，终审的变异测试证实其中至少两条当时完全没有回归保护。

建议后续 plan 在逐任务审查的收尾加一条：**凡 reviewer 手工验证过的行为，要么固化成测试，要么显式记为 accepted risk**。

另：`docs/superpowers/plans/2026-09-15-core-narrative-engine.md` 仍写着要创建 `packages/core/src/narrate/planner.ts`（该死文件已在终审修复轮删除）。plan 是历史记录不必改，但 Plan 2 若照它回溯文件清单会对不上。
