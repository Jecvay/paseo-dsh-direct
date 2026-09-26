# 决策记录: GitHub 看板工单循环（agent 拉单，人拖单）

Status: implemented

## 问题

路线方针提案（[2026-09-26 多角度调研综合](../../proposed/process/2026-09-26-roadmap-multi-angle-research.md)）产出了 P0-P3 共 14 个行动项，但排期与执行缺少一个「人轻参与、agent 重执行」的调度面：纯口头/会话内指派无法沉淀优先级与状态，人来写 issue 再人来实现的成本又太高。需要一套让 agent 承担评估与实现、人只做批准与 review 的工作循环。

## 决定

以 GitHub Projects v2（用户级 Project #1，链接本仓库）为唯一状态机，issue 为唯一工单载体：

- **阶段字段驱动**：`待办 → 已评估 → 待开工 → 进行中 → 待审 / 受阻`，关闭即归档。自定义字段「阶段」「优先级」（P0-P3，入板自动从正文推断）；不用内置 Status 字段（不可改名/改选项）。
- **评估与实现分离**：agent 自动评估「待办」卡只做归并判断（建议并单时建父单挂 sub-issue），**不改代码**；「待开工」列只有人能拖进——这一下拖拽是开工令。
- **防稀碎默认**：并单优先，一轮架构迭代一个 PR（`Closes` 父单与全部子单）；WIP=1。
- **本地自动轮询**：systemd user timer 每 5 分钟跑 `scripts/board-poll.ts`——sync → 有「待开工」起实现循环（45 分钟超时）、否则有「待办」起评估循环（10 分钟超时）；失败重试上限 2 次后移「受阻」。
- **无头会话**：`dsh headless --patch <本机私有补丁>`（模型路由 CPA-an/bm-an-glm、danger-full-access，凭证走 dsh 凭证存储）；agent 行为规约在 `.agents/skills/gh-board/SKILL.md`，会话提示词只指工单号。
- **项目/字段 ID 不进仓**：`scripts/board.ts` 按字段名发现；本机路径与私有配置只在 docs/board.md 描述、值放 `~/.config/paseo-dsh-pi/`。

## 考虑过的其他做法

- **手动召唤 agent 拉单**：零基础设施，但人仍需记得开会话；与「人只拖单」的目标不符。保留为退化模式（`npm run board:poll` 手动等价）。
- **GitHub Actions 驱动**：云端无法拉起本机 dsh；仅适合 CI 门禁（已由 ci.yml 承担）。
- **直接提交 main 省去 PR**：快但没有 review 拦截面，与每单一 PR 的安全边界冲突。
- **人在看板上拖进某列触发立即实现（无评估层）**：会退化为每个小改动一个碎 PR，与架构迭代节奏冲突——故坚持评估层先行、人基于归并分析拍板。

## 后果

- 路线 14 个行动项已全部入板（#3-#16）；首轮自动评估即产出并单判断（#17 父单聚合 #3-#6 P0 护栏）。
- 人对本项目的参与面收敛为：看板拖「待开工」+ PR review 合并。
- 无头实现循环会在本仓工作树上切分支——人在同一目录交互开发时需避让（「进行中」有卡即避让，docs/board.md 已记边界）。
- 评估/实现消费真实模型 token；停用 = `systemctl --user stop paseo-dsh-pi-board.timer`。
- 工单正文即验收标准来源；AGENTS.md 约定「动手前读工单」纳入既有门禁流程。

## 怎么验证的

board.ts 全子命令对真实 Project 实测（入板/阶段移动/优先级推断/sub-issue 挂载与查询/WIP 守卫/关闭自动归档）；systemd service 实跑一轮评估循环——#3 获结构化归并评论、自动建父单 #17 挂四个子单、卡片移入「已评估」（详见 [ops-log](../../../../.agents/ops-log.md)）。typecheck:scripts 通过。
