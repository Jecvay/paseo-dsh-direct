# gh-board 工单循环 — agent 操作规约

本 skill 定义 agent 参与 GitHub Projects 看板（[paseo-dsh-pi 项目看板](https://github.com/users/Jecvay/projects/1)）的完整循环。看板即状态机，脚本面是 `npm run board`（`scripts/board.ts`），字段是「阶段」与「优先级」。

## 不变量（先读）

1. **`待开工` 列只有人能拖进**（开工令）。agent 永不把卡移进 `待开工`。
2. **评估 ≠ 实现**。评估循环只产出归并分析与建议，不改代码。
3. **WIP = 1**。`进行中` 或 `待审` 有卡时，不开启新工作（`pick --for work` 已内置该守卫）。
4. **每单一 PR**；并单时**一个 PR 关闭父单与全部子单**（正文逐个写 `Closes #N`）。
5. **防稀碎优先**：小改动默认倾向并成一轮架构迭代；独立成单须有理由（如可独立验收、发布节奏需要）。
6. 动手前先读 `AGENTS.md` 与相关 `docs/`；方向性决定写 `.agents/notes/`（六类 kind 与 label 对应）。

## 人读内容风格（提笔前必过）

**规则来源**：人审批靠扫读，任何面向人的产出——工单标题、归并评论、PR 标题与正文、父单正文——都要先过风格关。两种方式任选其一，缺一不可省：

1. **提笔前回顾本节**：写之前重读一遍本节规则再落笔（无头会话默认走这条）；
2. **style agent 审核**：重要产出（父单正文、对外文档）写完后派一个 style subagent 专审可读性并回改（prompt 里给出本节规则原文与产出文本）。

**标题**——审批的第一眼：

- 动宾结构优先：一句话说清「做什么、做完有什么变化」（如「握手时核对事件名，防静默丢事件」）。
- 禁止名词堆砌与内部术语（护栏/闸/台账/耦合/碎裂向量/组合树断言…）；必须引用术语时用动词把它变成动作（「建 SDK 使用清单，升级时对照查变化」而不是「capability 机械化台账」）。
- 保持简短（约一行内）；优先级前缀 `[P0]`-`[P3]` 保留；并单父单尾部加「（并单）」。
- 自检标准：**不点开正文，人能否判断这单批不批**。不能就重写。

**评论与正文**——同样的标准：

- 结论先行：第一行就是判断（并单/独立/规模/建议），证据随后。
- 用完整短句说清因果，不甩术语链；术语首次出现时用一句话解释它指什么。
- 面向「不了解内部实现的维护者」写，不面向写代码的那个自己。

评估循环发现既有标题不合格时，**直接改写**（`gh issue edit <N> --title`）并在归并评论里注明「标题已改写：旧 → 新」。agent 建父单时同此风格。

## 阶段语义

| 阶段 | 含义 | 谁能进 |
|---|---|---|
| 待办 | 新入板，未评估 | sync 自动 |
| 已评估 | 已有归并分析评论，等人拍板 | agent（评估完成后） |
| 待开工 | 人已批准，等 agent 领取 | **仅人拖拽** |
| 进行中 | agent 实现中 | agent |
| 待审 | PR 已开，等人 review/合并 | agent |
| 受阻 | 卡住（原因见评论），等人处置 | agent / 人 |

issue 关闭（PR 合并）→ 下一次 `sync` 自动归档，即「完成」。

## 评估循环（拉单后只做判断）

输入：`待办` 列的一张卡。

1. `npm run board sync`，然后 `npm run board pick --for analysis`，取队首。
2. 读工单正文（`gh issue view <N> --repo Jecvay/paseo-dsh-pi`）、看板全量（`npm run board status`）、相关 `.agents/notes/` 与 `docs/`。
3. 只做判断，在工单下评论（`gh issue comment`），固定结构：

   ```markdown
   **归并评估**（agent 自动）

   - 架构定位：落在哪个子系统 / 哪条路线（链接 docs 或笔记）
   - 归并判断：独立成单 | 建议并单 → #<父单> | 建议拆分为 …
   - 规模：S | M | L
   - 依赖与风险：
   - 建议优先级：P0-P3（含理由）
   ```

4. 并单操作：父单不存在就创建（正文含问题/验收标准两节，打 kind label），`npm run board attach <父> <子>` 挂 sub-issue，并把归并结论摘要评论到父单。父单也移 `已评估`。
5. `npm run board move <N> 已评估`。**到此为止，不开工。**

## 实现循环（人拖进待开工后）

输入：`待开工` 列的一张卡（父单）。

1. `npm run board sync`，`npm run board pick --for work`；队列非空才继续，取队首（优先级 P0 最先）。
2. `npm run board move <N> 进行中`；`npm run board children <N>` 取全部子单，实现范围 = 父单 + 子单的验收标准并集。
3. 分支：`git checkout main && git pull && git checkout -b issue/<N>-<短slug>`。
4. 按工单正文验收标准实现；遵守 `AGENTS.md` 全部约定（笔记落点、docs 现在时、敏感信息红线）。
5. 门禁全绿后再开 PR：`npm run typecheck && npm test && npm run verify:notes && npm run verify:docs`（lefthook 提交时还会再拦一次）。
6. 提交（conventional message，说明做了什么与验证结果）、推送分支、`gh pr create --base main --fill-first`? 否——正文按 PR 模板手写：改动摘要 / 验证结果 / 边界确认，`Closes #父单` 加每个子单的 `Closes #子单`。
7. `npm run board move <N> 待审`，在工单评论 PR 链接与验证摘要。
8. 卡住：`npm run board move <N> 受阻` + 评论具体阻塞条件。人处置后拖回 `待开工` 才会重试。

## 无头运行（board-poll）

`scripts/board-poll.ts` 是轮询器入口（systemd user timer 每天 09:00 一次）：

1. `sync`；
2. 逐张清「待办」评估（每张独立 10 分钟超时，单轮封顶 12 张）；
3. 有 `待开工` 且 WIP 空闲 → 起**实现循环**（45 分钟超时，每轮至多一件）；
4. 超时/失败 → 计数；同一工单自动重试上限 2 次（状态文件 `~/.local/state/paseo-dsh-pi/board-state.json`）。

无头会话的提示词只需：`读 .agents/skills/gh-board/SKILL.md，执行评估循环/实现循环，工单 #N`。

## 人的动作（唯二）

- 看板上把卡拖进 `待开工`（批准开工；并单场景拖**父单**）；
- PR 上 review、合并（合并即关单，sync 归档）。
