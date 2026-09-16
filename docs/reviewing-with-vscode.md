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
● 第 3 章 测试与文档
● 第 2 章 核心逻辑
● 第 1 章 契约
● <base>
```

点任意一个 commit 就能看它这一章的 diff。**右侧是真文件**，所以 F12 跳转、悬停类型、
查引用全都在——这正是在 GitHub 网页上读 PR 时最缺的东西。

### 2. 逐章 `git show`

`unfold narrate` 打印的那组命令可以直接粘：

```
  code <worktree>                                   # 用 VS Code 打开
  git -C <worktree> log --oneline <base>..<branch>  # 章节一览
  git -C <worktree> show <branch>~2                 # 第 1 章 契约
  git -C <worktree> show <branch>~1                 # 第 2 章 核心逻辑
  git -C <worktree> show <branch>                   # 第 3 章 接线与调用方
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

`--reuse` 会让历轮快照各自保留自己的 ref（`round-001`、`round-002`……），
不会互相覆盖——这样任何一轮的快照都还能被找回来。

`--clean` **不删叙事分支**（`refs/heads/unfold/*`）：那是可以直接推成 PR 的产物，
删不删由你决定。

## 叙事分支可以直接推

终态与你工作区的快照**逐字节一致**，所以这条分支 merge 进去的结果和原改动完全相同。
推上去之后，在 GitHub 上逐 commit 看的人也拿到同一条叙事。
