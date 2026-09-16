# 叙事策略可配置（设计）

> 日期：2026-09-16 · 分支：`feat/charybdis`
> 前置：`docs/superpowers/specs/2026-09-15-unfold-design.md`（Unfold 总设计）
> 状态：设计经用户逐节确认，已实现。
> 本文记**决策与理由**，特别是几处**推翻了 Plan 1 结论**的地方，以及 Plan 2 继承什么。

## 0. 问题

`classifyPath` 的四层分类规则写死在 `rule-planner.ts` 里：6 条正则 + 两张文案表。
想试「测试放最前」「按架构目录分章」「把 migration 单独抽一层」都改不了。

而 spec §7.1 定的是「章节规划 = AI 实现 + TS 约束」、§9.2 定的是「AI 不可用时退到规则 planner」——
也就是说 Plan 2 落地后，规则 planner **只是兜底路径**。若配置只作用在兜底上，
它一上线就基本用不着了，而「调参试叙事策略」恰恰要在日常真正跑的那条路径上才有意义。

## 1. 四个已定决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 可配置程度 | 层的个数/顺序/标题/导语/匹配规则全可改，**但仍是「一个文件 → 一个层」模型**。不做「手工钉某几个文件到某章」——那是与路径无关的一次性意图，YAGNI |
| 2 | 与 AI 的关系 | **配置是骨架，AI 在骨架内分配**。配置定「有哪些层、什么顺序、叫什么」，AI 定「哪个文件进哪层、导语怎么写」 |
| 3 | 配置位置 | `--rules <file>` → `<repo>/.unfold/narrative.json` → 内置默认。**整份替换，不合并** |
| 4 | 规则变更 | 指纹进 `plan.json`；指纹不同就重新划分、不报漂移，并打印一行提示 |

决策 2 是这次设计的支点。它带来三个结构性的好处：

- **配置作用在日常真正跑的那条路径上**，而不只是兜底
- **两个 planner 共用同一套由配置定义的 `key` 空间** —— 从 AI 回落到规则不会让任何文件换层
- **AI 结构上造不出章节**：它只能返回层 key，不在配置里的直接被 TS 拒绝，比在 prompt 里请求它别乱造硬得多

## 2. 配置格式

```json
{
  "version": 1,
  "fallback": "core",
  "layers": [
    { "key": "contract", "title": "契约", "intro": "…", "match": ["**/type{,s}/**", "**/*.d.ts"] },
    { "key": "core",     "title": "核心逻辑", "intro": "…" },
    { "key": "wiring",   "title": "接线与调用方", "intro": "…", "match": ["**/index.*"] },
    { "key": "test-doc", "title": "测试与文档", "intro": "…", "priority": 0,
      "match": ["**/test{,s}/**", "**/*.{test,spec}.*", "**/*.md"] }
  ]
}
```

- **`layers` 数组顺序 = 章节顺序**，也就是读的顺序——这是用户真正会调的东西
- **`priority` 只在需要插队匹配时才写**，缺省取「数组位置 + 1」

`priority` 这个例外不是洁癖，是**当前行为的硬需求**：`tests/schema/foo.ts` 应归「测试与文档」，
所以测试类规则要**最先匹配**；但测试在叙事里要**最后读**。一个顺序表达不了两件事。

缺省取「位置 + 1」而不是「位置」，是为了让 `priority: 0` 天然表示「最先」——
取「位置」的话 `priority: 0` 会与 `layers[0]` 的缺省值打平，实现时踩过这个坑。

**没有 `match` 的层**（例子里的 `core`）只靠 `fallback` 接收漏网文件。

### 2.1 校验的边界：glob 语法查不出来

校验覆盖：`version` 必须为 1、`layers` 非空、`key` 唯一、`fallback` 必须指向已声明的层、
`title`/`intro` 非空、`match` 是非空字符串数组。任一不满足**指名道姓报错退出，绝不静默退回默认**——
静默退回会让人以为在测新规则、实际跑的是旧的。

**但 glob 语法错查不出来**：picomatch 对写坏的 pattern 不抛错，`src/[unclosed` 只是匹配不到任何东西。
实现时验证过。所以语法错会表现为「这一层一个文件都没接到」，**靠 `--dry-run` 打印的每章文件数发现**。
设计初稿曾写「glob 语法合法」作为一条校验，那是做不到的，已如实改掉。

同类坑：`tests?` 是正则思维——glob 里 `?` 是「恰好一个字符」，正确写法是 `test{,s}`。
写测试夹具时踩过，同样只表现为静默不匹配。

## 3. 接口重塑

```ts
interface Assignment {
  byLayer: Map<string, string>   // 文件路径 → 层 key
  intros?: Map<string, string>   // 可选：本轮定制导语，覆盖配置里的静态文案
}

interface ChapterPlanner {
  readonly id: string
  assign(ctx: PlanContext): Promise<Assignment>   // 只回答归属
}

interface PlanContext {
  base: string; snapshot: string; changes: FileChange[]
  rules: NarrativeRules       // 新增
  previous?: Plan
}
```

装配集中到 `buildPlan(ctx, assignment, plannerId)`，**两个 planner 共用**：校验 key 取值域、
校验无漏分配、按 `layers` 顺序建章、空层不产出、`index` 连续编号、`title`/`intro` 取自配置、
跨轮钉回。`RulePlanner` 拆完只剩十几行。

### 3.1 推翻 Plan 1 的两条结论

**「其余」兜底章去掉了。** Plan 1 里它保证「没有文件漏网」、让 `verify` 恒真；
但它同时是审查判定的「每次运行系统性产生一个空 commit」的那一个。
现在 `fallback` 指向一个**真实存在的层**，每个文件必定有归属，兜底章失去存在理由。

**漏分配从「静默兜住」改为「明确报错」。** Task 5 的审查当时保留兜底逻辑，理由是
「未来 AI planner 可能留下未分配文件」。现在那种情况由 `buildPlan` 直接抛错——
AI 漏分配文件是**它出错了**，该被发现并按 spec §7.2 走「重试 → 降级到规则 planner」，
而不是被悄悄补上一章。

两条都是**前提变了**（`fallback` 现在是真实层）才成立，不是推翻当时的判断。

## 4. 规则指纹与跨轮稳定

`Plan` 增加 `rulesFingerprint`。指纹**只覆盖能改变归属的部分**：`fallback`、各层的 `key`、
`match`、解析后的 `priority`。**不覆盖 `title` / `intro`**——改文案是最常见的微调，
没有任何文件换层，不该让上一轮的批注失效。

`layers` 顺序进指纹，因为 `priority` 缺省取数组位置，换顺序就换了匹配次序，**可能**改变归属。
这里偏保守：误判「变了」只是多划分一次，误判「没变」会把批注钉到错误的章上。

**两处判据必须一致**：`buildPlan`（要不要沿用上一轮归属）与 `validatePlan`（要不要报
`cross-round-drift`）。实现时漏了后者，结果是改规则再跑直接被校验中止——设计的目的当场落空，
靠冒烟测试才发现。这条已补测试并做过变异验收。

历史 `plan.json` 没有该字段 → 视为指纹未知 → 必然不同 → 重新划分。升级平滑，无需迁移。

## 5. Plan 2 继承什么

`AiPlanner` 实现同一个 `assign(ctx) → Assignment`，输出 schema 小得多：

```jsonc
{
  "assignments": [{ "path": "src/api.ts", "layer": "contract" }],
  "intros": [{ "layer": "contract", "text": "这次的契约改动集中在鉴权返回值…" }]
}
```

不产标题、不定顺序、不管空章与编号——全在 `buildPlan` 里，而且已被 Plan 1 的多轮审查磨过。
**AI 能出错的面小了一圈**，spec §7.2 的「schema 校验失败 → 重试 → 降级」也更容易做对。

`ctx.rules.layers` 就是喂给 prompt 的骨架，同时是 `buildPlan` 的硬校验域。

`NarrateOptions.planner` 已经预留——Plan 1 终审的 I3（`narrate` 写死 `new RulePlanner()`，
两道安全闸的集成路径零覆盖）顺带在这里解决了。

## 6. 一条实现期发现的缺口

`narrate` **从来没往 `PlanContext` 里放过 `previous`** ——跨轮钉回至今只在单测里跑过，
真实路径上根本没启用。本次接 `--reuse` 时一并补上：复用时从 review 目录读回上一轮 plan。

这解释了为什么 Plan 1 的跨轮机制「测得住但没人用过」。

## 7. 不做

- **手工钉文件到某章**（决策 1 排除）：与路径无关的一次性意图，等真的需要再说
- **用户级配置**（`~/.config/unfold/`）：层的定义与项目结构强绑定，跨项目默认很难写对
- **配置合并**：key 空间是一个整体，半份默认半份自定义会让 `fallback` 指向哪、`match` 引不引用得到都难以推理
