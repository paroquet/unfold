# Unfold 设计（spec）

> 日期：2026-09-15 · 分支：`feat/charybdis`
> 前置：`docs/handoff/2026-09-15-genesis.md`（缘起、市场证据、已与用户对齐的原则）
> 状态：brainstorming 的 architectural path 已走完，六节设计逐节经用户确认。下一步是 `writing-plans`。
> 本文只写**决策 + 为什么 + 实测证据**，不重复 handoff 已有的市场分析。

## 0. 范围

**Unfold**：把一段改动重新讲一遍，让人能按循序渐进的顺序读完 agent 产出的大改动，并把批注结构化地送回 agent 再来一轮。

**v1 的闭环只有一个**（用户明确选定）：

```
某个 worktree 里的 agent 报「干完了」（改动常常未 commit）
  → Unfold 当场对这堆改动生成叙事分支，按章阅读、标 finding
  → findings 送回同一个 agent
  → agent 改完 → 只看增量
```

v1 **不含**：GitHub / PR 拉取、多人协作、forge 集成。

## 1. 已定决策速查

| # | 决策 | 结论 |
|---|---|---|
| 1 | 包结构 | monorepo `packages/core`（纯 TS、零 `vscode` import、自带 `bin/unfold.ts`、**不发 npm**）+ `packages/vscode`（发 Marketplace）。**v1 只有一个发布物** |
| 2 | v1 闭环 | 见 §0。输入必须能吃脏工作区 |
| 3 | AI 从哪来 | v1 就调 AI，走**本机 agent CLI**（`claude` / `codex`） |
| 4 | AI 通讯层 | 自定 `AgentProvider` 窄接口 + 每家一个 adapter。ACP 以后可作第三个实现 |
| 5 | findings 回传 | **往 agent 所在终端投递**（orca 的做法），三级降级：VS Code `sendText` → `tmux send-keys` → 写文件让人粘 |
| 6 | 脏工作区快照 | 临时 index + `write-tree` + `commit-tree`。**不用 `git stash create`** |
| 7 | 代码导航 | 注册制 `LanguageNavigator`，v1 支持 TypeScript + Kotlin。`prepare` **只做右侧**，左侧走 tree-sitter 降级 |
| 8 | 叙事 worktree | **只要一个**，永远停在终态。左侧用 `toGitUri(uri, base)` 虚拟文档 |
| 9 | 文件内分章 | 接口/数据结构 v1 就按 **hunk** 粒度定死，v1 的 planner 只产整文件分配 |
| 10 | 状态存储 | 全部在**仓库外** `~/.local/state/unfold/<repo-id>/<review-id>/` |
| 11 | AI 边界 | base 推导与章节规划是 **AI 实现 + TS 约束**；`replay` / `verify` **纯 TS**，不许 AI 介入 |
| 12 | 许可证落实 | `package.json` 写 `"license": "AGPL-3.0-only"`，README 加 License 节（**第一个 commit 就做**） |

## 2. 包与边界

```
packages/core/            纯 TS，零 vscode import，自带 bin/unfold.ts（不发 npm）
  git/       snapshot.ts   脏工作区快照（§4）
             worktree.ts   叙事 worktree 的建/删/复用
             range.ts      base 推导
  narrate/   planner.ts    ChapterPlanner 接口（AI 实现 + 规则兜底）
             replay.ts     按章重提交（纯 plumbing）
             verify.ts     tree 字节一致校验，不等即拒绝出货
  findings/  model.ts      finding 模型
             anchor.ts     file + range + contentHash，锚在终态
             store.ts      状态读写
  agent/     provider.ts   AgentProvider 窄接口
             claude.ts     ClaudeAdapter
             codex.ts      CodexAdapter
  deliver/   target.ts     DeliveryTarget 接口 + resolveOwningPane
             tmux.ts       tmux send-keys
             file.ts       写文件兜底
  tour/      codetour.ts   章节 → .tours/*.json（CodeTour 格式，可互操作）
  ai/        schema.ts     结构化输出的单一真源 + 校验器（§7）
             constrain.ts  codex 走 --output-schema，claude 走 prompt 渲染 + 事后校验
  prompts/   base-selection.md · chapter-plan.md · findings.md   （markdown，运行时读取）

packages/vscode/          依赖 core，发 Marketplace
  reader/                 章节导航、diff
  findings/               批注 UI、triage、增量重看
  nav/                    LanguageNavigator 注册表（§5）
  deliver/vscode-terminal.ts   VSCodeTerminalTarget（注入 core 的降级链最前）
```

**分界线规则**：`core` 定义 `DeliveryTarget` 接口并自带 tmux / 文件两个实现；VS Code 终端那个实现**只能**住在 `vscode` 包（需要 `window.terminals` / `sendText`），启动时注入到降级链最前面。

这条规则的价值：`core` 的「零 vscode import」由**编译器**守住，而不是靠自觉；且 `bin/unfold.ts` 在 orca / CI 里跑时自动降级到 tmux / 文件，不需要任何条件编译。同理 `AgentProvider.discover` 整个留在 `core`（子进程即可，不需要编辑器）。

## 3. v1 闭环的数据流

快照一出来，**重活与 AI 两条轨道并行跑**——`prepare` 是全链最贵的一步（Kotlin 那边是一次 Gradle import，分钟级），而它只依赖终态内容，与 base 推导、章节规划无关，没有理由等 AI。

```
1. 触发       agent 报完工（或你手动开）
2. 快照       snapshot() → SNAP（commit 对象，含 untracked）
              git update-ref refs/unfold/<review-id>/round-<n> SNAP   ← 必须，见 §4.3
   │
   ├─ 轨道 A（重活，立刻开始，不等 AI）
   │   A1. git worktree add --detach <path> SNAP   内容即终态
   │   A2. LanguageNavigator.prepare(<path>)       node_modules symlink / Gradle import / LSP 索引
   │
   └─ 轨道 B（AI + 纯 TS，秒级）
       B1. base 推导  [AI+约束] git 规则给候选集 → AI 挑一个并给理由 → TS 校验
                      （第 2 轮起不问 AI：base = 上一轮的 snapshot）
       B2. 规划       [AI+约束] ChapterPlanner(base, SNAP)
                      → plan.json（hunk → chapter + 章标题 + 每章导语）
       B3. 重提交     [纯 TS]   replay() → commit_1..commit_N
       B4. 校验       [纯 TS]   verify(): tree(commit_N) == tree(SNAP)，不等即中止

3. 汇合       git -C <path> checkout -B unfold/<review-id> commit_N
              ⇒ 零文件改动，轨道 A 的索引不失效（实测，见 §11.7）
4. 阅读/批注  不等 prepare 完成即可开始：readiness() 为 indexing 时先用 tree-sitter 导航，
              就绪后自动升级为 LS。按章读，标 finding（AI 产的与人标的进同一列表），
              reviewed@blob-hash
5. 投递       deliver(session, 一行指针)
6. 等待       轮询 discover(cwd)，busy → idle
7. 下一轮     回到 2，只展示增量
```

**汇合为什么是免费的**：`tree(commit_N) == tree(SNAP)` 是 §6.3 的不变量，所以 checkout 时 git 比对两棵树发现无差异，**一个文件都不写**。实测 mtime 与 inode 全部未变、worktree 干净——轨道 A 花几分钟建好的 LSP 索引不会被汇合冲掉。这是字节一致不变量的**第二个红利**（第一个是 §6.3 的批注可移植）。

**verify 失败时**：**拒绝出货，不降级**（与 §6.3 一致）。

此前本节曾写「降级为无章节的普通 review」，与 §6.3 的「拒绝出货、不降级」直接矛盾——
Plan 1 的实现选了后者，整分支终审把这条矛盾列为必须由用户裁决的事项。

**2026-09-16 用户裁决：暂时拒绝。** 理由是字节一致是这个产品全部价值的支点，
在它失败时还把半成品交出去，等于把「这条叙事可信」这个前提悄悄撤掉而不告诉人。
「暂时」二字是字面意思：将来若要设计降级路径（例如失败时保留 `SNAP` 上的 worktree
供人读整体改动），应作为独立的设计决定重开，而不是靠这一节的措辞含糊带过。

该裁决顺带解锁了一个此前悬置的问题：**narrate 失败时残留的 ref 与 worktree 该不该清理**。
既然不降级，失败路径上的这些产物就没有保留价值，应当清理——具体实现留给 Plan 2/3。

哪一步交给 AI、输出怎么约束、失败怎么降级，见 §7。

## 4. 脏工作区快照

### 4.1 约束

`Claude Code` 默认不主动 commit，所以 v1 输入的常态是脏工作区。约束：**绝不干扰那个还活着的 agent**（不动工作区、不动 index、不动分支历史），且**绝不碰 stash 栈**（用户的 orca 多 worktree 共享 stash 栈）。

**否决方案**：`git stash create`。实测（git 2.34.1）它**抓不到 untracked 文件**，且 `-u` 被接受但静默失效——而新文件恰恰是 agent 最常产的东西。

### 4.2 采用方案（已实测）

```bash
IDX="$(git rev-parse --git-dir)/unfold-snapshot-index"   # 必须在 worktree 外
TREE=$(GIT_INDEX_FILE="$IDX" sh -c 'git read-tree HEAD && git add -A && git write-tree')
SNAP=$(git commit-tree "$TREE" -p HEAD -m "unfold: snapshot")
rm -f "$IDX"
```

性质：抓 tracked 改动 + untracked 新文件、尊重 `.gitignore`、工作区 / index / stash 栈零触碰。

**必踩的坑**：临时 index 若放在 worktree 内，会被自己的 `git add -A` 抓进 tree（实测踩到：`.unfold-tmp-index` 和 `.unfold-tmp-index.lock` 出现在快照里）。放 `$(git rev-parse --git-dir)/` 下。

### 4.3 快照必须显式钉 ref

`SNAP` **不是** `commit_N` 的祖先（叙事分支的祖先链是 `base → commit_1 → … → commit_N`），所以一旦 worktree 从 `SNAP` 切到叙事分支，`SNAP` 就不在任何 ref 的可达范围内，`git gc --prune=now` 会把它清掉。

而 §8.4 的增量重看依赖 `diff(snapshot_{n-1}, snapshot_n)`——**每一轮的快照都必须活到 review 结束**。

```bash
git update-ref "refs/unfold/<review-id>/round-<n>" "$SNAP"
```

实测：加 ref 后可达，且扛过 `git reflog expire --expire=now --all && git gc --prune=now`。review 结束清理时连同 `refs/unfold/<review-id>/` 一起删。

## 5. 代码导航（注册制）

### 5.1 问题的准确形状

三处失效，原因各不相同：

| 位置 | 为什么没导航 |
|---|---|
| diff 左侧（上一章状态） | git 扩展的 `toGitUri(uri, ref)` 产的**只读虚拟文档**，磁盘无文件 → LS 不索引 |
| 叙事 worktree（右侧真文件） | 是真文件，但**不在 workspace folder 里** → LS 不索引 |
| 跨章跳到定义 | 定义常在本章没改的文件里，落回上面两种 |

handoff §5.2 写的「diff 右侧是真文件、LSP 天然可用」只对了一半：右侧确实是真文件，但不在 workspace folder 里就没有索引。

### 5.2 方向

不自己造次品导航，而是**让每种语言现成的 LS 真的为 review 的那棵树激活**。各语言「怎么才能激活」差异极大，故做成注册制：

```ts
interface LanguageNavigator {
  readonly languageIds: string[]
  prepare(tree: ReviewTree, source: Worktree): Promise<PrepareResult>
  readiness(): Promise<'ready' | 'indexing' | 'unavailable'>
  dispose(tree: ReviewTree): Promise<void>
}
```

### 5.3 v1 两个实现

**TypeScript** — tsserver 按 workspace folder 激活。
`prepare` = 把 review worktree 加成 workspace folder + 从源 worktree **symlink `node_modules`**（否则跨包解析全断、报一堆假错）。`tsconfig.json` 本来就在 checkout 里。

**Kotlin** — 目标是 `jetbrains.kotlin-server`（JetBrains 官方 LSP，非社区 fwcd）。其 `activationEvents` 要求 `workspaceContains:build.gradle(.kts)|pom.xml|settings.gradle(.kts)`，并提供外部工程导入钩子：

```jsonc
"intellij.projects": [ { "type": "gradle|maven|bazel|jps|gomodules|json", "path": "file:///<review-worktree>" } ]
```

`prepare` = 写这个设置 + 调命令 `jetbrains.kotlin.reloadWorkspace`。
**代价诚实记录**：这会触发一次 Gradle import，秒级到分钟级。
**待验证线索**：该扩展另有 `type: "json"` 与命令 `jetbrains.exportWorkspaceToJson`，看起来能把源 worktree 已解析的工程模型导出再喂给 review 树以跳过重新 sync。**未验证**，实现时先验。

### 5.4 降级层

没注册 navigator 的语言、或 LS 仍在 indexing 时，退到 tree-sitter tags 的名字级导航。可行性依据：`DocumentFilter.scheme` 是稳定 API，`languages.registerDefinitionProvider` 等可挂在我们自己的 scheme 上。

**成本不对称（重要）**：

| 包 | `tags.scm` | 预编译 `.wasm` |
|---|---|---|
| `tree-sitter-typescript@0.23.2` | 有 | 有 |
| `tree-sitter-kotlin@0.3.8` | **无**（只有 `highlights.scm`） | **无** |

Kotlin 的 tags 查询要自己写，wasm 要自己编。排期时按「Kotlin 降级层 = 一个独立任务」估。

### 5.5 v1 取舍

`prepare` **只对右侧（当前章状态）做**，左侧一律走 tree-sitter 降级。且 `prepare` 与 AI 轨道**并行**执行（§3），阅读不必等它完成——`readiness()` 为 `indexing` 时先用 tree-sitter 导航，就绪后自动升级。理由：索引两棵树对 TS 是翻倍、对 Kotlin/Gradle 是两次 import，而审代码时绝大多数跳转发生在当前状态侧。左右都上 LS 留给 v2。

## 6. 叙事分支：生成与校验

### 6.1 单 worktree 推论

文件级分章意味着：第 k 章涉及的文件在 `tree_k` 里已是**终态版**，故对本章文件 `tree_k` 与 `tree_N` 逐字节相同；而它们在前 k−1 章未被碰过，故左侧就是 **base 版**。于是：

- **叙事 worktree 只要一个，永远停在终态**，切章不 checkout，LSP 只索引一次（正好接住 §5.5 的 `prepare`）
- **每章 diff 左侧 = base 版**，不随章节变；既然左侧不上 LS，直接用 `toGitUri(uri, base)` 虚拟文档
- **第二个 worktree 不需要**（handoff §5.2 曾假设需要）

⚠️ 这条推论在开启**文件内分章**后，对**被拆分的文件**失效，见 §6.5。

### 6.2 构造（纯 plumbing，不 checkout、不 apply patch）

```
tree_k   = base_tree 上，把第 1..k 章的每个文件整体换成终态 blob
           （删除的文件用 update-index --force-remove）
           全程 GIT_INDEX_FILE=<临时 index> + update-index --cacheinfo + write-tree
commit_k = commit-tree tree_k -p commit_{k-1} -m "<章标题>"
```

**文件级分章最大的好处**：每个文件整体替换，所以构造**不可能失败**——无 patch 冲突、无三方合并。

### 6.3 校验

`tree(commit_N) == tree(SNAP)`。按上述构造这是恒真的；真正的风险只剩「有文件没被分进任何一章」，故**最后一章固定是「其余」**。verify 失败即拒绝出货，**不降级**。

字节一致的价值不是安全，是**批注可移植**：锚在终态的批注可 1:1 落回原分支。叙事分支因此是**可丢弃的视图**，永远不是第二份真值——但它也**可以直接推成 PR**，逐 commit 看的人一样拿到叙事。

### 6.4 base 推导

优先级：显式指定 → `git merge-base @{upstream} HEAD` → `git merge-base <默认分支> HEAD` → `HEAD`（只审未提交改动）。

### 6.5 文件内分章（接口 v1 定死，实现 v2）

**纠正 handoff §5.1 的一处判断**：它把 hunk 级列为 v2 并称风险是「patch 不 apply、失败可检测」。在本设计的构造里**不会失败**——所有 hunk 来自**同一 base 的同一份 diff**，取子集应用的行号偏移是确定且唯一的，不存在三方合并。真正的风险是 **AI 把 hunk 分错组导致故事讲不通**——那是语义风险，兜底方式是「人拖动重排」，不是「退回文件级」。

架构影响：

| 组件 | 影响 |
|---|---|
| `ChapterPlanner` | 输出 `hunk → chapter`（整文件 = 所有 hunk 同章的退化情况） |
| `replay` | 「整块换 blob」→「按 hunk 子集合成内容」。仍确定性、仍不可能失败 |
| `verify` | 不变 |
| `plan.json` / 跨轮稳定 | 不变，分配单位变细 |
| 左侧 | 拆分文件的左侧变成 `content_{k-1}` 虚拟文档。因左侧本就是虚拟文档，**零额外代价** |
| 右侧 | **唯一真代价**，见下 |

右侧：拆分文件在第 k 章的「正确右侧」是 `content_k`，而 worktree 里是 `content_N`。三个选法，**默认取 (a)**：

- **(a) 在终态文件上看，只聚焦本章 hunk** — 保住 LSP；且有反直觉的好处：永远不会读到「后面还会被改掉」的死代码。代价是渐进的错觉破了一点
- (b) 打开 `content_k` 虚拟文档 — 内容严格正确，该文件丢 LSP。做成 (a) 上的一个开关
- (c) 切章时 checkout `commit_k` — 两全，但每切一章 LSP 重索引；TS 勉强，Kotlin/Gradle 不可接受

**白捡的增益**：§5 已引入 tree-sitter，拆分单位可以不是裸 hunk 而是**顶层声明**——用 tags 查询拿到函数/类范围，把 hunk 归到所属声明。章节标题于是是「这三个函数」而不是「第 40–92 行」。两个已定组件白送一个能力，不引入新依赖。

**v1 的实际范围**：`plan.json` 与 `replay` 按 hunk 粒度实现，planner 只产整文件分配。v2 换 planner + 加右侧聚焦 UI 即可，不迁移数据、不重写 replay、不重对批注锚点。

### 6.6 章节的对外格式：CodeTour

章节导出成 CodeTour 格式（`.tours/*.json`，微软，step = file/line + markdown，可绑 git ref），沿用 handoff §5.2 的决定：不自己发明格式，且与 CodeTour 扩展互操作。映射：**一章 = 一个 tour，章内的指路锚点 = step**。每章那段「为什么先看这个」写进 tour 的描述。

### 6.7 worktree 落点与跨轮稳定

落点 `~/.local/state/unfold/<repo-id>/<review-id>/worktree/`，不在仓库里。理由：不用改 `.gitignore`、多个 review 并存、清理只是删目录；放 `.git/` 下会被一堆工具默认忽略，放仓库里会污染正被审的那棵树，且会被 §4 的 `git add -A` 抓进快照。

**跨再生稳定**：章节分配存 `plan.json`。重新生成时**已分配过的文件保持原章号**，只对新增/消失的文件重新分配，避免 AI 第二次给出不同分组导致批注漂移。

## 7. AI 边界与提示词工程

### 7.1 边界表

| 步骤 | 谁做 | TS 侧的约束 |
|---|---|---|
| base 推导（§3 步骤 3） | **AI 挑 + TS 约束**。git 规则只给**候选集**，AI 读 commit message / 作者 / 时间，挑出「这一轮 agent 是从哪开始干的」并给理由 | 必须是 `HEAD` 的祖先、必须存在、diff 非空。**第 2 轮起不问 AI**——base 就是上一轮的 snapshot，确定性的 |
| 章节规划（步骤 4） | **AI 实现**：hunk → chapter 分配 + 章标题 + 每章「为什么先看这个」 | 见 §7.3 |
| 重提交 `replay`（步骤 5） | **纯 TS，不许 AI 介入** | —— |
| 校验 `verify`（步骤 6） | **纯 TS** | —— |
| findings（步骤 8） | **AI + 人**，产出进同一个列表由人 triage | schema 校验；anchor 必须能解析到真实位置 |

**为什么 `replay` 必须是 TS**：AI 一旦参与生成中间内容，§6.2 的「构造不可能失败」与 §6.3 的「tree 字节一致恒真」同时失效——`verify` 会从**恒真断言**退化成**可能失败的检查**，整条设计的支点就没了。中间态是从同一份 diff **推导**出来的，不是生成出来的。handoff §5.1 当初选文件级分章，理由原话即「构造确定性、无需 AI 生成中间内容」。

### 7.2 结构化输出层

JSON Schema 定义一次，作为**单一真源**（`core/src/ai/schema.ts`），两条路共用同一个校验器：

- **codex**：直接传 `--output-schema <FILE>`
- **claude**：没有这个 flag（§9.2 记录的不对称）→ 把同一份 schema 渲染进 prompt 的格式说明，输出后**用同一份 schema 校验**

失败处理链：schema 校验失败 → 带着具体错误重试 N 次 → 仍失败 → **降级到规则 planner**（§9.2 的兜底）。claude 侧只是比 codex 多一次「说服 + 验收」，不是另一套代码路径。

### 7.3 语义校验（schema 管不到，但错了会毁掉跨轮稳定）

- 每个 hunk **恰好**被分配一次，不多不少
- 章号从 1 连续
- 引用的 file / hunk id 必须真实存在
- **跨轮**：上一轮已分配过的文件，章号必须与上一轮一致；不一致就拒绝本次输出、沿用上一轮分配（这是 §6.7 跨轮稳定的执行点）

### 7.4 输入预算

这条最影响可行性：大改动的 diff 可能几万行，不能整个塞进 prompt。给 planner 的是**结构摘要**而非全文：

```
文件列表 + 每文件的 hunk 数 / 行数
+ tree-sitter 抽出的顶层声明名
+ 每个 hunk 落在哪个声明上
```

AI 需要看具体内容时再第二轮追问。这份符号表与 §6.5「按顶层声明拆」用的是同一套 tree-sitter 产物——**一份数据两处用，不引入新依赖**。

### 7.5 提示词的存放与可复现

- 提示词放 `packages/core/src/prompts/*.md`，**运行时读取，不内联进 TS**。理由：用户是第一个用户、他会想自己调；markdown 能直接读改、能进 diff 被 review、能做快照测试
- 三个：`base-selection.md` / `chapter-plan.md` / `findings.md`
- `plan.json` 除分配结果外，另存 **模型 id + prompt 文件的内容 hash + AI 的原始输出**。出问题时要能分清是 prompt 的锅还是模型的锅；跨轮稳定若起争议，也要有对账依据

## 8. finding 模型与重看状态

### 8.1 存储布局（仓库外）

```
~/.local/state/unfold/<repo-id>/<review-id>/
  meta.json        repo / base / branch / 创建时间
  rounds/001.json  snapshot sha · plan（章节分配）· reviewed 映射
  rounds/002.json
  findings.json
  worktree/        叙事 worktree
```

**标识符定义**（避免实现时各写各的）：

- `<repo-id>` = `<仓库根目录名>-<git-common-dir 绝对路径的 sha256 前 8 位>`。取 common dir 而非 worktree 路径，使同一仓库的多个 orca worktree 落在同一个 `<repo-id>` 下；带目录名是为了人眼能认出来
- `<review-id>` = `<分支名 slug>-<创建时刻 YYYYMMDD-HHMMSS>`。同一分支可以有多次 review 并存，按时间区分

放仓库外是硬约束：§4 的快照用 `git add -A`，`.unfold/` 若在仓库里就会被抓进快照，除非逼用户改 `.gitignore`。deliver 时用绝对路径，agent 一样读得到。

**已知代价（用户已接受）**：findings 跟着机器走、不跟着仓库走——换台机器 review 记录就没了，也没法把批注给别人看。若日后需要，应另设计导出/导入，**不是**改存储位置。

### 8.2 finding

```ts
{
  id, round,
  kind: 'question' | 'must-fix' | 'nit' | 'praise' | 'bookmark',
  severity,
  origin: 'human' | 'ai',
  status: 'open' | 'needs-recheck' | 'resolved' | 'dismissed',
  anchor: { file, range, contentHash }   // 锚在终态，可 1:1 落回原分支
}
```

`bookmark` 只是 `kind` 的一个取值——JetBrains 式书签不单做一套。

### 8.3 anchor 重定位

agent 改完之后：文件 blob 未变 → anchor 直接有效；变了 → 用 `contentHash` 在新内容里找那几行，找到就挪行号，找不到就标 `stale` 交给人判断。**不猜、不静默丢。**

### 8.4 增量重看

- **reviewed@blob-hash（文件级）**：记「在 blob X 上看过此文件」。下一轮该文件 blob 变了则 stale，且展示 `diff(X, 新blob)`——**只给增量**。这正是强于 GitHub "Viewed" 的地方（后者文件一变整个重置）
- **「针对这条 finding 的改动」**：每轮记 snapshot sha，下一轮对每条 finding 展示 `diff(snapshot_{n-1}, snapshot_n)` 限定到其锚定文件。人只判「修没修对」
- status 自动 `open` → `needs-recheck`；确认/驳回是人的动作。**AI 不做 accept/reject、不做修复**（handoff §5.3）

## 9. AgentProvider 与 deliver

### 9.1 两种 session 关系

设计的骨架是把它们分开：**Unfold 自己拥有的 session**（排章节、产 findings）与**别人的 session**（那个刚报完工的 agent，只需发现 + 投递）。

```ts
interface AgentSession {
  id: string; name?: string; cwd: string; pid: number
  kind: 'interactive' | 'background'
  status: 'idle' | 'busy' | 'done' | 'unknown'
}

interface AgentProvider {
  readonly id: 'claude' | 'codex'
  discover(cwd: string): Promise<AgentSession[]>
  ask(prompt: string, opts): AsyncIterable<AgentEvent>
  deliver(s: AgentSession, line: string): Promise<DeliveryResult>
}
```

### 9.2 ask

只有两个调用点，即 handoff §5.3 的两件事：`ChapterPlanner` 的 AI 实现、findings 生成。

**规则兜底**：本机没装 agent CLI、未登录、或调用失败时，`ChapterPlanner` 退到确定性规则排序（默认顺序：契约 `schema`/类型/接口 → 核心逻辑 → 接线与调用方 → 测试与文档，靠路径与扩展名启发式判定），findings 则只由人产。**闭环不因为 AI 不可用而断**——叙事分支、阅读、批注、投递全部不依赖 AI。

- claude：`claude -p <prompt> --output-format json` → `{session_id, result, is_error, num_turns}`
- codex：`codex exec --json --output-schema <FILE>`

**不对称要记住**：codex 有 JSON Schema 约束输出，**claude 没有** → claude 侧只能靠 prompt 约束 + 解析容错。两条路如何共用一份 schema 与校验器，见 §7.2。

### 9.3 deliver：往终端投递

这是 orca 的做法（见 §11 证据）。三条路共用一段逻辑——**pid 祖先匹配**：

```
discover() 给出 agent 进程 pid
        ↓ 沿 ppid 链上溯
 ① VS Code 终端：window.terminals → terminal.processId（shell pid）命中 → sendText(line, true)
 ② tmux：tmux list-panes -a -F '#{pane_pid} #{session_name}:#{window}.#{pane}' 命中 → send-keys
 ③ 都不命中：写文件 + 返回一行让人自己粘
```

抽 `resolveOwningPane(agentPid)` 三条路共用。

**同一 cwd 有多个候选 session 时**：不自动挑。列出来让人选（这正是 orca 那个下拉在做的事），列表显示 `name` / `status` / 最后活动时间。只有恰好一个候选时才免选。理由：投递是有副作用的动作，猜错就是往错误的 agent 里塞指令。

**跨平台坑**：ppid 链在 Linux 读 `/proc/<pid>/stat`；Windows 无 `/proc`。开发在 WSL 但扩展宿主可能跑在 Windows 侧，这层必须有平台实现，不得假设 `/proc` 存在。

**投递内容是一行指针**（因为 `sendText` 不包 bracketed paste，多行会被 TUI 当成多次回车）：

```
读 <绝对路径>/findings.json 里 status=open 的条目并修改，改完不要 commit
```

「改完不要 commit」是必要的：§4 的快照机制要的就是脏工作区，agent 自己 commit 会把 base 推移。

### 9.4 闭环回来

deliver 后轮询 `discover(cwd)`，目标 session 由 `busy` 回到 `idle` 即重新快照、开新一轮、只展示增量。这是 v1 唯一的自动化触发点。

## 10. 测试策略

`core` 零网络、零 `vscode` import，主体是单测 + 真实临时 git 仓库 fixture。按 `superpowers:test-driven-development`，先测后码。

**四条高价值测试，各自对应一个产品承诺：**

| 承诺 | 测什么 |
|---|---|
| 叙事分支不改变任何东西 | `tree(commit_N) == tree(SNAP)` 恒真；缺一个文件就该红 |
| 不干扰正在干活的 agent | 快照后：worktree 无变化、index 无 staged、`git stash list` 条数不变、临时 index 已删且未进 tree |
| 批注不漂移 | 同一份改动跑两轮 plan，已分配文件章号不变；anchor 重定位：内容在 → 挪行号，内容没了 → `stale`，绝不静默丢 |
| adapter 不碎 | 见下 |

**adapter 分两层**（唯一依赖外部产物的地方）：

- **单测**用录制的 fixture（真实 `claude agents --json` 输出）——常规 CI 跑
- **契约测试**真调本机 CLI，只验证「字段还在、命令还接受这些 flag」。需已装并登录 CLI，故**单独打标记、不进常规 CI**。这是上游改 flag 时唯一能当场报警的东西

**不测**：中间提交能否编译（handoff §5.1 已定「中间提交不必能编译」）。

**deliver**：`resolveOwningPane` 纯逻辑，注入伪造进程树单测；`sendText` / `tmux send-keys` 是接口，测试用 fake。真实终端投递靠 `@vscode/test-electron` 跑一两个集成用例，不追覆盖。

## 11. 实测证据附录

> 用户的标准：预测不算数，文档 / 源码 / 日志才算。以下全部为 2026-09-15 在本机实测或读源码所得，后续 session 不必重新推导。
> 环境：`claude` 2.1.272 · `codex-cli` 0.153.4 · git 2.34.1 · VS Code Stable `645f29cc31` · WSL2

### 11.1 Claude Code CLI

- `claude agents --json [--cwd <path>]` 列出活着的 session。
  - interactive：`{pid, cwd, kind, startedAt, sessionId, name, status}`，`status` ∈ `busy`/`idle`
  - background：`{pid, id, cwd, kind, startedAt, sessionId, name, state}`，注意是 **`state` 不是 `status`**，且多一个短 `id`
  - **adapter 必须归一化这两种形状**
- `--session-id <uuid>` 用指定 id 建会话；`-r/--resume <id>` 续同一条对话，**session id 保持不变**，两轮追加进同一个 `.jsonl`
- **没有公开的「向活着的 session 投递消息」CLI**。跨 session 消息走 `/run/user/<uid>/cc-socks/<pid>.sock`（socket 确实存在且与 pid 一一对应），协议未公开
- **resume 一个 background session 会被拒绝**，即使其 `state` 已是 `done`：
  ```
  Error: Session <uuid> is running as a background session (<short>). Run `claude attach <short>`
  to open it, or `claude stop <short>` first to resume it here. Add --fork-session to branch off a copy instead.
  ```
  「干完了」≠「放开了」
- **resume 一个活着的 idle interactive session 不被拒绝，但会静默分叉 transcript**。实测父链：带外那轮 `user uuid=1cbdd59a parent=178a52d4`，终端接着说的那轮 `user uuid=2e30f9ed parent=178a52d4`——**同一个 parent**；随后问终端里的 agent「这段对话你回答过哪几个词」，它答「只有一个」，完全不知道带外那轮存在。**这是本设计放弃 resume 路线的直接原因。**
- **没落过盘的 session `--resume` 找不到**（`No conversation found with session ID: ...`），哪怕 `claude agents --json` 列着它。对 deliver 无害，但若日后想让 `ask` 复用已有 session 会撞上

### 11.2 Codex CLI

- `codex agents` 走 shared local app-server daemon；磁盘另有 `~/.codex/session_index.jsonl`
- `codex queue --thread <uuid|name> --message <text>` —— **公开的**「向已有 session 投递」命令（claude 侧没有对应物）
- `codex exec --json` / `--output-schema <FILE>` / `codex exec resume <id>` / `codex fork`

### 11.3 orca 如何做到「发送注释至某个 session 且不分叉」

读 `Orca.exe` 的 `resources/app.asar`（Electron 打包，字符串可直接检索）：

- 入口 `sendNotesToActiveAgentSession({worktreeId, prompt, noteTarget})`，`noteTarget = {tabId, leafId}`，并检查 `entry.ptyId`
- 依赖模块名：`terminal-pty-input-transaction`、`agent-paste-draft`、`agent-process-recognition`
- 失败码：`terminal_handle_stale` / `terminal_exited` / `terminal_gone` / `no_active_terminal`
- 计数：`pty.write` 48 处、`terminal.sendText` 23 处、bracketed paste 标记 `200~` / `201~` 各 22 处、`bracketed` 134 处
- **`--session-id` 0 处、`fork-session` 0 处、`cc-socks` 0 处**
- 按 pane 跟踪 agent 状态：`claudeLeadStateByPaneKey`（`working`/`waiting`/`done`）、`lastPromptByPaneKey`、`claudeSubagentRosterByPaneKey`；识别 claude / codex / gemini / opencode / copilot / droid / cursor
- `--input-format stream-json` 只用于模型发现（`request_id: "orca-model-discovery"`, `subtype: "list_models"`），**不是会话本体**

**结论**：orca 是把文字以 bracketed paste 写进那个 agent 所在终端的 PTY，等同于人手动粘贴 + 回车。进程同一个、会话同一个，所以不分叉。它能这么做是因为**它自己就是终端宿主**。

### 11.4 VS Code 稳定 API（`vscode.d.ts`，Stable 645f29cc31）

| 能力 | 位置 |
|---|---|
| `Terminal.sendText(text, shouldExecute?)` | 7731 行 |
| `Terminal.processId: Thenable<number \| undefined>` | 7682 行 |
| `Terminal.shellIntegration` / `TerminalShellExecution.read(): AsyncIterable<string>` | 7721 / 7996 行 |
| `DocumentFilter.scheme` | 2375 行起（可挂自定义 scheme） |
| `languages.registerDefinitionProvider` | 14905 |
| `registerImplementationProvider` / `registerTypeDefinitionProvider` | 14918 / 14931 |
| `registerHoverProvider` / `registerDocumentSymbolProvider` / `registerReferenceProvider` | 14957 / 15011 / 15036 |

git 内置扩展对外 API 有 `toGitUri(uri, ref)`（`extensions/git/dist/main.js` 确认），diff 左侧即其产的只读虚拟文档。

**`Terminal.processId` + `claude agents --json` 的 pid** 组合，使 Unfold 能靠 pid 祖先匹配认出「哪个 VS Code 终端里跑的是哪个 Claude session」，**无需刮终端输出**（orca 因为要支持任意 agent 才去做进程识别）。

### 11.5 Kotlin LSP（`jetbrains.kotlin-server@0.0.12-linux-x64`）

- `activationEvents`：`onLanguage:kotlin`、`workspaceContains:{build.gradle,build.gradle.kts,pom.xml,settings.gradle,settings.gradle.kts}`（含 `*/` 前缀变体）
- 关键设置：
  - `intellij.projects`: array of `{type: 'gradle'|'maven'|'bazel'|'jps'|'gomodules'|'gomodules-recursive-scan'|'json', path: 'file:///...'}` —— "Externally configured projects to import automatically"
  - `intellij.buildTool`（`null` 自动检测，`""` 禁用导入）、`intellij.jdkForSymbolResolution`
- 命令：`jetbrains.kotlin.reloadWorkspace`、`jetbrains.kotlin.restartLsp`、`jetbrains.kotlin.clearCachesAndRestartLsp`、`jetbrains.exportWorkspaceToJson`

### 11.6 tree-sitter 语法包

`web-tree-sitter@0.27.0`（WASM，扩展宿主内可用，无需原生编译）。

| 包 | 版本 | `queries/tags.scm` | 预编译 `.wasm` |
|---|---|---|---|
| `tree-sitter-typescript` | 0.23.2 | 有 | 有（`tree-sitter-typescript.wasm`、`tree-sitter-tsx.wasm`） |
| `tree-sitter-kotlin` | 0.3.8 | **无**（仅 `highlights.scm`） | **无** |

### 11.7 git 快照

- `git stash create` 只抓 tracked 改动；`-u` 被接受但**静默失效**（生成的 commit 只有 2 个 parent、无 `^3`，tree 里没有 untracked 文件）
- 临时 index 配方（§4）实测通过：抓到 untracked、排除 gitignored、worktree/index/stash 栈零触碰
- 临时 index 放 worktree 内会被自己 `add -A` 抓进 tree（实测踩到）
- **汇合零改动**：worktree 先 `worktree add --detach <SNAP>`，待 `replay` 产出 `commit_N`（tree 与 SNAP 一致）后 `checkout -B <branch> commit_N`，实测**全部文件 mtime 与 inode 未变**、`git status` 干净。这是 §3 双轨并行成立的前提
- **快照可达性**：`SNAP` 不是 `commit_N` 的祖先，汇合后即不可达（`git rev-list --all` 查不到），`git gc --prune=now` 会清除。`git update-ref refs/unfold/<review-id>/round-<n> <SNAP>` 后实测扛过 `reflog expire --expire=now --all` + `gc --prune=now`

### 11.8 npm 上的现成件

`@anthropic-ai/claude-agent-sdk@0.3.272` · `@openai/codex-sdk@0.154.0` · `@agentclientprotocol/sdk@1.4.0`（ACP）· `@zed-industries/claude-code-acp@0.16.2`

**ACP 未选用的理由**：它是「编辑器拉起 agent」的协议，**没有「发现一个已经在跑的 session」原语**，而那恰是 v1 闭环的出口。选 `AgentProvider` 自定接口后，ACP 以后可作为第三个 adapter 实现，不冲突。

## 12. 明确不做（v1）

- git log / graph（GitLens + 内置 Source Control Graph 够了）
- 代码补全
- forge 深度集成（v1 只 export）
- **不用 webview 做 diff**——真实编辑器 + decorations，这是导航免费的前提
- AI 做 accept / reject 或自动修复

## 13. 待验证清单（实现时先验）

1. `intellij.projects` 的 `type: "json"` + `jetbrains.exportWorkspaceToJson` 能否让 review worktree 跳过 Gradle sync
2. `terminal.sendText` 向 claude TUI 投递的实际行为（无 bracketed paste 时多行的表现、以及一行指针是否稳定触发）
3. Windows 侧 ppid 链的实现方式（无 `/proc`）
4. `tree-sitter-kotlin` 的 `tags.scm` 自写 + wasm 自编的实际工作量
5. review worktree symlink `node_modules` 后 tsserver 的实际表现（是否有 realpath 导致的重复索引）
