# 用 VS Code 读一条叙事分支（尚无插件时）

Unfold 的插件还没写，但**叙事 worktree 本身就是产品的主要形态**——它是一个真实目录、
挂在叙事分支上、章节 commit 串成一条线性链。用 VS Code 打开它，内置的 Source Control
视图就能逐章看 diff，而且因为是真文件，**语言服务器直接可用**（跳转、悬停、查引用都在）。

插件要做的很多事，这里已经有了雏形。

## 跑一次

```bash
unfold narrate --repo ~/orca/workspaces/<项目>/<worktree> --open
```

`--open` 会直接 `code <叙事 worktree>`。不加也行——命令跑完会打印一组可直接粘的命令。

## 三种看法

### 1. 内置 Source Control（推荐）

打开叙事 worktree 之后，左侧 Source Control 面板的 **Graph** 里能看到章节链：

```
● 第 3 章 bin：unfold.ts
● 第 2 章 narrate：run.ts
● 第 1 章 git：exec.ts → worktree.ts
● <base>
```

点任意一个 commit 就能看它这一章的 diff。**右侧是真文件**，所以 F12 跳转、悬停类型、
查引用全都在——这正是在 GitHub 网页上读 PR 时最缺的东西。

### 2. 逐章 `git show`

`unfold narrate` 打印的那组命令可以直接粘：

```
  code <worktree>                                   # 用 VS Code 打开
  git -C <worktree> log --oneline <base>..<branch>  # 章节一览
  git -C <worktree> show <branch>~2                 # 第 1 章 git：exec.ts → worktree.ts
  git -C <worktree> show <branch>~1                 # 第 2 章 narrate：run.ts
  git -C <worktree> show <branch>                   # 第 3 章 bin：unfold.ts
```

叙事分支是一条线性链，第 k 章就是 `<branch>~(N-k)`，最后一章是分支 tip。

### 3. CodeTour 扩展（装了的话）

每次跑都会在 `<状态目录>/tours/` 下产出 `chapter-001.tour` 之类的文件，是
[CodeTour](https://marketplace.visualstudio.com/items?itemName=vsls-contrib.codetour) 的格式。
把它们拷进叙事 worktree 的 `.tours/` 目录，CodeTour 扩展就能带着你一步步走。

每个 step 指向「该章改动所在的文件与行号」，描述是章节标题。

## 调参：先用 `--dry-run` 看分章

改动大的时候，先不建分支、只看章节会怎么分：

```bash
unfold narrate --repo <path> --dry-run
```

秒级返回，什么都不落地。觉得分得不对就换参数再看。

## 比较两次的分章

```bash
unfold narrate --repo <path> --reuse --compare latest
```

打印「章节数变化」和「哪些文件换了章」，不用靠脑子记上一次长什么样。

> 注意 `--compare` 的基线是在**本次跑之前**取的。否则新产出的 review 会立刻成为
> `latest`，等于拿新 plan 跟自己比。

## 反复试的时候

| 想要 | 用 |
|---|---|
| 只看分章，不留任何产物 | `--dry-run` |
| 路径稳定，VS Code 窗口不用重开 | `--reuse`（复用同一个 review 目录，轮次递增） |
| 清掉堆积的 review 目录与快照 ref | `--clean` |
| 换一套叙事策略 | `--rules <file>`，或把配置提交到 `<repo>/.unfold/narrative.json` |
| 丢掉章节册重新推导 | `--reset-chapters` |

`--reuse` 会让历轮快照各自保留自己的 ref（`round-001`、`round-002`……），不会互相
覆盖——这样任何一轮的快照都还能被找回来。

`--clean` **不删叙事分支**（`refs/heads/unfold/*`）：那是可以直接推成 PR 的产物，
删不删由你决定。

## 章节怎么来的

章节不是配置枚举出来的。Unfold 把本轮改动过的文件按 import 关系连边、拓扑定序，
再按 `maxFiles`（默认 8）贪心切成一段一段——一段就是一章，实现文件和配对到它的
测试文件天生同段（配对规则见 `pair`）。想调的不是「加/删一层」，而是这三样：

- `maxFiles`：一章最多装多少个真实文件，超了就断成下一章；调小切得更细，调大切得更粗。
- `order`：路径前缀数组，命中的整体排到最前、按给定顺序；桶内仍然走依赖序。
  它不是章节 key（key 要切段之后才有），而是稳定、可读、下一轮仍然认得的目录前缀。
- `titles`：按章节 key 覆盖自动生成的标题与导语，纯文案，不影响分章，也不改规则指纹。

在仓库根放一份 `.unfold/narrative.json`：

```json
{
  "version": 2,
  "maxFiles": 6,
  "order": ["src/db", "src/api"],
  "titles": {
    "src/db/schema.ts": {
      "title": "数据库迁移",
      "intro": "先看迁移：它决定了数据形状，改不回去。"
    }
  }
}
```

`--rules <file>` 可以临时覆盖它，调参时不必动仓库。

改了 `maxFiles` / `order` / `pair` 会让**规则指纹**变化，下一轮不再沿用上一轮的
章节归属（会打印一行提示）。只改 `titles` 指纹不变——纯文案不该让你已有的批注失效。

## 依赖证据：给证据，不给结论

`--dry-run`（以及正式跑）打印的章节列表之后，紧跟一块「依赖证据」：

```
依赖证据
  扫描   30 个源码文件｜跳过 27（未支持依赖扫描的文件类型 24、内容不可读（已删除或二进制） 3）
  连边   90 条跨文件依赖
  破环   无强连通分量
  建议   "order": ["docs", "packages/core/src/bin", "packages/core/src/narrate"]
```

这一块只给证据，不下结论：扫了多少个文件、跳过了哪些（按语言/可读性诚实标出原因，
不是悄悄吞掉）、在哪破的环（真有强连通分量时把成员列出来）、以及基于本轮实际顺序
反推出的一份可以直接粘进 `order` 的建议。你完全可以不认同它、换一份自己的 `order`
覆盖——但你得先看得见我们是基于什么算出来的，而不是被告知「已经为你智能排好序」。

## 章节册与 `--reset-chapters`

章节一旦分过，就会记进仓库状态目录里的「章节册」，跨轮持久：下一轮同样的文件沿用
上一轮的章节归属，批注也跟着钉在章上，不会因为这一轮改了别的地方就漂移。**没有
「过期」或「自动重算」这回事**——想丢掉整本册、按当前规则重新推导一遍，唯一的办法
是显式加 `--reset-chapters`：

```bash
unfold narrate --repo <path> --reset-chapters
```

它会丢掉旧册重新切段；已经打在旧章上的批注不会被删，只是解除跟旧章的绑定，下一轮
按批注锚点所在的文件重新归入新章。这是**唯一**能让一个章节真正消失的操作。

## 章节体检：只提示，不拦截

跑完（或 `--dry-run`）如果有可读性上的问题，会在最后打一块「提示」，比如：

```
提示
  第 22 章「bin：unfold.ts」有 1 个实现文件、0 个测试
  第 26 章「仓库根：pnpm-lock.yaml → vitest.config.ts」有 1 个实现文件、0 个测试
```

这些提示**一律是 warn，不拦截出货**——纯文档改动、纯重构、来不及补测试的 hotfix
都会触发类似提示；如果拦下来，这工具在这些场景下就没法用了。它只是提醒你「这里
可能值得再看一眼」，看完该怎么处理仍然由你决定。

## 叙事分支可以直接推

终态与你工作区的快照**逐字节一致**，所以这条分支 merge 进去的结果和原改动完全相同。
推上去之后，在 GitHub 上逐 commit 看的人也拿到同一条叙事。
