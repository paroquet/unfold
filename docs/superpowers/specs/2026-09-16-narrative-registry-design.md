# 章节册：按数据流分章，跨轮持久（设计）

> 日期：2026-09-16 · 分支：`feat/charybdis`
> 前置：`docs/superpowers/specs/2026-09-15-unfold-design.md`（Unfold 总设计）
> 推翻：`docs/superpowers/specs/2026-09-16-configurable-narrative-design.md` 的决策 1、2、4（见 §9）
> 状态：设计经用户逐节确认，未实现。

## 0. 问题

用户的原话：

> 当前的 rule 不合理，原因是没有按功能模块进行划分。真正的方便 review 的格式一定是基于
> 数据流、业务 domain 的，每一个模块最好同时搭配实现+测试。尽可能划分出最小的数据闭环。

现在的默认规则把改动按**文件种类**横切成四层（契约 / 核心逻辑 / 接线 / 测试与文档）。
在本分支的真实改动上，它产出 `第 1 章 核心逻辑（25 文件 / 25 hunk）` 加一个装满测试和文档的
大章——没有人能 review 这样的章节。

三处结构性阻碍，不是换一份默认配置能解决的：

1. **层必须预先枚举。** `buildPlan` 按 `ctx.rules.layers` 的数组顺序产出章节
   （`build-plan.ts:41`），planner 分到未声明的 key 直接抛错（`build-plan.ts:19-28`）。
   业务 domain 是每仓、每次改动都不同的，装不进一个预先写好的数组。
2. **「测试自成一章」写死在默认里。** `test-doc` 层带 `priority: 0`（`rules.ts:72`），
   保证它最先匹配、抢走所有 test 路径。要「实现+测试同章」，这条必须反过来。
3. **章节质量一条都没检。** `validate.ts` 只守字节完整性与跨轮漂移，不检「这一章读起来
   是不是一个闭环」。

## 1. 已定决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 配置负担 | **任意仓库零配置就能按模块出章**；配置只用于覆盖排序与文案 |
| 2 | 分组单元 | 不是目录，是「一个实现文件 + 它的测试」 |
| 3 | 章节边界 | 由**依赖序上的贪心切段**决定，不由目录决定 |
| 4 | 默认排序 | 依赖拓扑序 + SCC 破环；同时把扫描证据与建议的 `order` 打印出来 |
| 5 | 章节性质 | **跨轮持久的册**，每轮往册里归，而不是每轮重算 |
| 6 | 归属优先级 | 批注锚定 > 上一轮在册 > 依赖序切段 |
| 7 | 模块删除 | 章节标 `deleted` 留在册里，批注跟着留着；只有 `--reset-chapters` 能让它消失 |
| 8 | 章节质量 | 做成**警告**，不做成硬闸；字节一致仍是唯一的硬闸 |
| 9 | v1 枚举层 | **删除，不做兼容**（§9） |

决策 5 是这次设计的支点：章节从「本轮计算的产物」升级为「review 的持久实体」。

## 2. 三条实测证据

设计里每个关键选择都有一次实测支撑，不靠推断。

**证据 1：目录不能当章节边界。**
把测试配对回实现之后按目录分组，本分支的改动仍是 `narrate 21 文件`。
而 `packages/core/src/narrate/` 是一个**扁平目录**——路径 trie 下切到这里就撞墙，
没有子目录可以继续分。所以「按目录派生分组」这条路本身不成立。

**证据 2：模块级的依赖环是聚合出来的假象。**
模块粒度上 `narrate ↔ tour` 成环，排除 `import type` 之后依然成环
（`tour/codetour.ts:1` 取值 `hunkPath`，`narrate/run.ts` 取值 `toCodeTours`）。
落到文件级：`tour/codetour.ts → narrate/diff.ts`、`narrate/run.ts → tour/codetour.ts`，
**无环**。粒度越细越可排。

**证据 3：文件级拓扑序逐字就是数据流。**
`packages/core/src/narrate/` 内部的文件级依赖图无环，拓扑序为：

```
diff → rules → plan → build-plan → compare → compose → replay → rule-planner → validate → verify → run
```

解析 diff → 加载规则 → 规划 → 装配 → 重放 → 校验 → 编排。这正是要讲给 reviewer 的顺序。

## 3. 分组：单元与章节边界

### 3.1 单元 = 一个实现文件 + 它的测试

这是最小的数据闭环：一份行为，和证明这份行为的证据。
测试永远不独立成章——先把测试路径**规约**成它所测的实现路径（canonical path），
之后测试只是那个单元的一部分。

规约靠两组替换，都可在配置里改：

- 目录段替换：`tests`/`test`/`__tests__`/`spec` → `src`，以及 JVM 的 `test` → `main`
- 文件名后缀剥离：`.test`/`.spec`/`_test`/`Test`

一条路径可能产生多个候选（`src/test/kotlin/FooTest.kt` 既可能对 `src/main/kotlin/Foo.kt`
也可能对 `src/src/kotlin/Foo.kt`）。**取第一个在快照树里真实存在的候选**
（`git cat-file -e <snapshot>:<path>`）；都不存在就取第一个候选。
这是证据，不是猜测。

规约只用于**分组**。章节的 `filePaths` 永远是真实路径，replay 与字节一致不受影响。

### 3.2 章节边界 = 依赖序上的贪心切段

四步，全部零配置：

1. **配对**：每个改动文件算出 canonical path，测试并入实现单元。
2. **建图**：只扫本轮改动文件的 import 行，只保留指向本轮其他改动文件的边。
   不解析整个仓库——是证据，不是全局推断。
3. **定序**：Tarjan 求强连通分量，缩点后拓扑排序（§4）。
4. **切段**：沿拓扑序贪心合并成章，两条断章规则——
   超过 `maxFiles`（默认 8，含测试）必断，**跨目录必断**。

于是同一目录里连续的数据流阶段自然合成一章，跨模块一定分开。

### 3.3 章节 key = 段首文件的 canonical path

不取序号，不取目录名。往段中间插一个新文件不会改 key，批注不漂；
只有段首换人才算新章。唯一性由构造保证（每个文件恰好属于一章），
另加一条 `chapter-key-duplicated` 硬校验兜底。

### 3.4 在本分支上的预期产出

`git 的快照与 diff 基元` → `state 的路径与目录` → `narrate 的解析与规则` →
`narrate 的规划与装配` → `narrate 的重放与校验` → `tour` → `bin` → `docs` → `仓库根配置`，
每章 2–8 个文件，都带着自己的测试。对比现状的 `核心逻辑 25 文件 / 测试与文档 一大坨`。

## 4. 定序、破环与证据打印

### 4.1 依赖从哪读

不碰工作区。每个改动文件的终态 blob sha 已在 `FileChange.blob` 里，
`git cat-file blob` 取内容扫 import 行。删除的文件与二进制文件不扫。

### 4.2 扫什么

v1 两套正则，与 LanguageNavigator 的 v1 语言对齐：

- **TS/JS**：`import … from '…'`、`export … from '…'`、`require('…')`、`import('…')`。
  只解相对路径，含 ESM 的 `.js → .ts` 扩展名换算与 `index` 补全。
  **不解** tsconfig paths，**不解** node_modules。
- **Kotlin/Java**：`import a.b.C` 取包路径，用它去**后缀匹配**本轮改动文件的路径。
  源码根（`src/main/kotlin`）不需要知道，后缀匹配自然穿过去。

其余语言不扫。**解析不出来就没有边，没有边就退化成字典序——不去猜。**
没被扫的文件照样分章，只是没有依赖序。

### 4.3 破环

Tarjan 求强连通分量，分量整体作为一个节点参与拓扑，
分量内部按 canonical path 字典序，并在该章导语里写明
「这几个文件互相依赖，先后不代表调用方向」。

### 4.4 拓扑序必须唯一

DAG 的拓扑序不唯一。同时入度归零的节点如果顺序不定，跨轮 key 就会漂。
用 Kahn + 最小堆，同层一律按 canonical path 字典序——同样的输入永远同样的输出。
这一条是跨轮稳定的前提，必须有对应的回归测试。

### 4.5 `order` 写的是路径前缀，不是章节 key

章节 key 是切段之后才产生的，人预先写不出来。所以配置里给目录前缀：

```json
{ "order": ["packages/core/src/git", "packages/core/src/state", "packages/core/src/narrate"] }
```

命中前缀的文件按给定顺序排在最前，桶内仍走依赖序；未命中的按依赖序跟在后面。
非源码文件（`.md`/`.json`/锁文件/图片）不参与依赖图，统一排最后、按路径字典序。

### 4.6 `--dry-run` 多打一块「依赖证据」

```
依赖证据
  扫描   41 个源码文件（TS 41）｜跳过 13 个（未支持依赖扫描：.md 6、.json 4、其他 3）
  连边   57 条跨文件依赖
  破环   无强连通分量
  建议   "order": ["packages/core/src/git", "packages/core/src/state", …]
```

前三行是证据不是结论：扫了多少、跳过哪些（按语言诚实标注）、在哪破的环。
`建议` 那行是把本轮算出的依赖序按章节的公共目录前缀去重后得到的，
可以直接粘进 `.unfold/narrative.json` 把顺序钉死，也可以不理。

## 5. 章节册

### 5.1 册是主体

现在是每轮重算——`buildPlan` 推导出章节，空层 `continue` 丢掉（`build-plan.ts:43`），
跨轮钉回只是优化。**改成：册是主体，每轮的改动往册里归。**

册持久化在 review 目录下 `registry.json`，每轮更新而不是重算。

**册的生命周期就是一次 review 的生命周期。** 「跨轮」指同一个 review 的多个轮次，
也就是 `--reuse` 走的那条路径（`run.ts:185`，轮次由 `nextRound` 递增）。
不带 `--reuse` 就是开一次新的 review，得到一本新的空册——这是**预期行为**：
新的 PR 本来就该重新讲一遍。第一轮册为空，全部改动走优先级阶梯的第 3 条，册由此建立。

章节三种状态：

- `active`：本轮有改动
- `empty`：模块还在，本轮没动
- `deleted`：该章成员在快照里已全部不存在

**删除的模块标 `deleted` 但留在册里**，它的批注跟着留着。
册里的顺序一旦定下就不重排——新章按依赖序插到该去的位置，已有章不动。

### 5.2 册 ≠ commit 链

册里 20 章、本轮只有 3 章有改动，不能产 17 个空 commit。
所以 `plan.json` 的 `chapters` 是完整的册（含 `empty` 与 `deleted`），
**replay 只对有 hunk 的章产 commit**。

`chapter-index` 那条校验改成「册内序号从 1 起连续」，commit 序号另算，
两者在 `plan.json` 里分别是 `index` 与 `commitIndex`（无 commit 的章为 `null`）。

### 5.3 归属优先级阶梯

新的核心规则，AI planner 也绕不过去：

1. 这个 hunk 命中了某条批注的锚点 → 归**该批注所在的章**。
   「命中」的判据：该 hunk 的新行范围 `newStart … newStart + newLines`
   与迁移后的批注行范围有交集
2. 这个文件上一轮在册里的某一章 → **沿用**
3. 都不命中 → 按 §3 的依赖序切段，优先并入相邻章，装不下才新开。
   并入同样受 §3.2 的两条断章规则约束：跨目录不并，超 `maxFiles` 不并。
   默认倾向合并而非新开，是因为新开章会把后面所有章的阅读顺序整个推移

第 1 条是这次引入的新能力：**批注对应的修改，要回到批注所在的章**。
它可能和依赖序打架——批注在第 3 章，新改动按依赖序该排第 7 章——
这时候归第 3 章，并触发 `chapter-backward-dep` 警告。不拦，但让代价看得见。

实现上，第 1、2 条由 TS 先算出一张 `pinned: Map<hunkId|path, chapterKey>`，
planner 只对剩下的表态。

### 5.4 批注锚点每轮迁移

批注锚在 `(文件路径, 行范围, 锚定内容的 sha256)`。每轮拿本轮 diff 把锚点推到新行号：

- 该文件本轮无 hunk → 行号不变
- 完全结束于批注范围**之前**的 hunk → 累加偏移 `newLines - oldLines`
- 与批注范围**重叠**的 hunk → 标 `stale`，范围重算为该 hunk 的 `newStart …
  newStart + newLines`。**不丢弃**——它恰好说明「你批注的这段代码被改了」，
  这是 review 最该看见的信号
- 该文件被删除 → 批注标 `orphaned`；若某章全部批注都 orphaned 且成员清空，该章标 `deleted`

只有 core 做得了这件事，因为只有 core 手里有 diff。

### 5.5 `--reset-chapters`

唯一能让章节消失的操作：丢弃 `registry.json` 重推，
并打印将影响多少条批注。批注**不删**，只把 `chapterKey` 置空并标 `unanchored`，
下一轮按锚点所在文件重新归入新章。

### 5.6 规则变化不再自动重排

现在指纹不同就自动不沿用上一轮归属（`build-plan.ts:75`）。有了册之后这是错的——
规则变了不该自动打散册。改成打印

```
规则已变更（指纹 a1b2c3 → d4e5f6）。要按新规则重排章节请跑 --reset-chapters。
```

指纹的用途从「要不要沿用」降级成「要不要提示」。

## 6. 章节验收

### 6.1 先加 severity

现在 `validatePlan` 返回的 issue 一律抛错（`run.ts:89`）。
`ValidationIssue` 加 `severity: 'error' | 'warn'`，
`planAndValidate` 只在有 `error` 时抛，`warn` 随返回值上浮、由 CLI 打印。

### 6.2 硬闸不放宽

`hunk-missing` / `hunk-duplicated` / `hunk-unknown` / `file-missing` / `file-duplicated` /
`file-unknown` / `chapter-index` / `cross-round-drift`，加一条 `chapter-key-duplicated`。
它们守的是**正确性**：漏一个 hunk，`tree(commit_N) == tree(SNAP)` 就不成立；
key 撞了，批注就钉错章。

### 6.3 新增警告

| 码 | 什么时候出现 |
|---|---|
| `chapter-no-test` | 这章有实现改动，却没有任何测试文件 |
| `chapter-test-only` | 这章只有测试，对应实现不在本轮改动里 |
| `chapter-oversized` | 超过 `maxFiles`。切段本来按它切，所以只可能来自：过大的强连通分量、`order` 覆盖、册沿用（第 2 条）或批注归属（第 1 条）把文件塞了进来 |
| `chapter-backward-dep` | 第 N 章依赖第 M 章且 M > N |

**为什么不做成硬闸。** spec §3 裁决的「verify 失败拒绝出货」守的是字节一致，那是正确性；
章节好不好读是可读性。把可读性做成硬闸，等于用工具的审美否决用户的改动——
纯文档改动、纯重构、来不及补测试的 hotfix 会直接叙不出来。
用户的原话是「**最好**同时搭配实现+测试」，按这个分量做成显眼的警告。

## 7. 数据格式

### 7.1 `.unfold/narrative.json`（v2）

```json
{
  "version": 2,
  "maxFiles": 8,
  "pair": {
    "dirs": [["tests", "src"], ["test", "src"], ["__tests__", "src"], ["spec", "src"], ["test", "main"]],
    "suffixes": [".test", ".spec", "_test", "Test"]
  },
  "order": ["packages/core/src/git", "packages/core/src/state"],
  "titles": {
    "packages/core/src/git/snapshot.ts": { "title": "快照与 diff 基元", "intro": "…" }
  }
}
```

全部字段可省略；空文件等价于内置默认。`titles` 的 key 是章节 key，
用于覆盖自动生成的标题与导语。

### 7.2 `registry.json`（review 目录下）

```json
{
  "version": 1,
  "chapters": [
    {
      "key": "packages/core/src/git/snapshot.ts",
      "index": 1,
      "title": "git 的快照与 diff 基元",
      "intro": "…",
      "status": "active",
      "members": ["packages/core/src/git/snapshot.ts", "packages/core/src/git/exec.ts"],
      "keyRenamedFrom": null,
      "createdRound": 1,
      "lastActiveRound": 3
    }
  ]
}
```

`members` 存的是 canonical path。段首文件被删除时，key 顺延给该章剩下的、
拓扑序最靠前的文件，并写一条 `keyRenamedFrom` 让上层把批注迁过去。

### 7.3 `annotations.json`（review 目录下）

```json
{
  "version": 1,
  "annotations": [
    {
      "id": "a1b2c3",
      "chapterKey": "packages/core/src/git/snapshot.ts",
      "path": "packages/core/src/git/snapshot.ts",
      "startLine": 10,
      "endLine": 14,
      "anchorHash": "sha256:…",
      "body": "临时索引必须落在 git dir 里",
      "state": "live",
      "round": 2
    }
  ]
}
```

`state`：`live` | `stale`（锚定的代码本轮被改）| `orphaned`（文件已删）|
`unanchored`（册被重置）。

**core 只读、迁移、按它归属；采集批注是 VS Code 插件的事（Plan 3/4）。**
core 的测试用手写的 `annotations.json`，不依赖插件存在——这一层现在就能完整实现和测试。

## 8. 文件结构与影响面

### 8.1 新增（`packages/core/src/narrate/`）

| 文件 | 职责 |
|---|---|
| `pair.ts` | 测试路径 → 实现路径的规约（canonical path） |
| `deps.ts` | 读终态 blob、按语言扫 import、只在改动文件间连边 |
| `order.ts` | Tarjan 缩点 + Kahn 拓扑（确定性）+ `order` 前缀覆盖 |
| `segment.ts` | 沿拓扑序贪心切段（`maxFiles`、跨目录必断） |
| `registry.ts` | 章节册的读写与状态迁移、新章插位 |
| `anchors.ts` | 批注锚点迁移与 `stale`/`orphaned` 标记 |

这六个模块本身是一条干净的数据流（配对 → 连边 → 定序 → 切段 → 归册 → 迁锚），
文件级无环——用 §3/§4 的算法叙这次改动，它会把自己分成几章可读的内容。

### 8.2 改造

- `plan.ts`：`Chapter` 加 `status`、`commitIndex`、`keyRenamedFrom`；
  `Assignment` 从 `byLayer` 改为 `byChapter` + `proposed`
- `build-plan.ts`：从「按 layers 装配」改为「按册 + 优先级阶梯装配」
- `validate.ts`：`severity` 分级、四条新警告、`chapter-index` 语义改为册内序号
- `run.ts`：编排新增读册、迁锚、更新册；replay 只对有 hunk 的章产 commit
- `rules.ts`：v2 schema；`classifyPath`、`DEFAULT_RULES` 的四层定义删除
- `bin/report.ts`：依赖证据块、体检提示、册状态
- `bin/args.ts` + `bin/unfold.ts`：`--reset-chapters`
- `state/`：`registry.json` 与 `annotations.json` 的读写

既有测试中 `rules.test.ts`、`rule-planner.test.ts`、`validate.test.ts`、
`replay.test.ts` 要跟着改。

## 9. 推翻了什么

对 `2026-09-16-configurable-narrative-design.md`：

| 原决策 | 现在 |
|---|---|
| 1「一个文件 → 一个层」，层预先枚举 | 层不再枚举；单元是「实现+测试」，边界由依赖序切段决定 |
| 2「配置是骨架，AI 在骨架内分配」 | **册**是骨架；配置只给策略参数（`maxFiles`/`pair`）与排序/文案覆盖 |
| 4「指纹不同就重新划分」 | 指纹不同只**提示**；重排要显式 `--reset-chapters` |

**v1 枚举层删除，不做兼容。** 加载到 `version: 1` 的文件时明确报错并给迁移指引，
不做静默转换。证据：本仓库没有 `.unfold/narrative.json`，该功能 2026-09-16 才落地、
没有外部使用者。理由不是省事——`buildPlan` 要背「册 + 优先级阶梯」已经够复杂，
再并存一套枚举层分组，两条路径的跨轮语义不一样，长期都得维护。
代价是「所有 `*.proto` 单独成章」这类**按种类**的诉求表达不了了——
而这正是这次被判定为不合理的切法。

## 10. Plan 2 的 AI planner 契约

今天的约束是「key 必须在 `rules.layers` 里」。册出现之后，这个约束既太松又太紧。

优先级阶梯的第 1、2 条 **AI 说了不算**：批注锚定的 hunk 归批注所在章、
上一轮在册的文件沿用原章，这两条由 TS 先算完，直接从 AI 的取值域里拿掉。
AI 只对第 3 条有发言权：**新出现的文件归哪一章，以及要不要提议一个新章**。

```ts
interface Assignment {
  /** 只覆盖未被 pinned 的文件；key 可以是册里已有的章，或 proposed 里声明的新章 */
  byChapter: Map<string, string>
  /** 提议的新章：必须给出 title、intro 与插在册里的位置 */
  proposed?: Map<string, { title: string; intro: string; after: string | null }>
  intros?: Map<string, string>
}
```

TS 侧的不变式换成：每个改动文件恰好一次、新章数量有上限（防止 AI 每轮重新发明整本册）、
单章大小有上限。这比「key 必须在预声明列表里」是更强的约束，不是更弱——
存量归属被册和批注钉死，AI 的发挥空间只剩增量。

## 11. 不做什么

- **册的归档**。册只增不减，`deleted` 章永远留着，仓库活得够久册会长。
  现在不设计归档，`--reset-chapters` 是唯一出口；等真长到碍事再说。
- **跨语言的依赖解析**。v1 只 TS/JS + Kotlin/Java，其余语言退化成字典序并在
  `--dry-run` 里诚实标注。真正的跨语言符号级依赖是 LanguageNavigator（Plan 4）的事。
- **hunk 级归属的 UI**。核心已支持一个文件的 hunk 分散到多章；怎么呈现是插件的事。
- **批注的采集与展示**。core 只定义格式、迁移锚点、按它归属。
