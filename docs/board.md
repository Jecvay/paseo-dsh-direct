# GitHub 看板工单循环（agent 拉单，人拖单）

本项目的工作调度运行在 [GitHub Projects 看板](https://github.com/users/Jecvay/projects/1)（仓库 `Jecvay/paseo-dsh-pi`，Project #1）上：**issue 即工单，看板即状态机，人只做两个动作——把卡拖进「待开工」、在 PR 上 review 合并**，其余由本地轮询器驱动的 dsh headless 会话完成。

## 阶段与字段

看板用两个自定义单选字段（内置 Status 字段不用，可隐藏）：

- **阶段**：`待办 → 已评估 → 待开工 → 进行中 → 待审 → 受阻`；issue 关闭（PR 合并）后下一次 sync 自动归档即完成。
- **优先级**：`P0 / P1 / P2 / P3`，入板时从工单标题/正文中的 P0-P3 字样自动推断。

| 阶段 | 含义 | 谁能进 |
|---|---|---|
| 待办 | 新入板，未评估 | sync 自动 |
| 已评估 | 已有归并分析评论，等人拍板 | agent（评估后） |
| 待开工 | 人已批准，等 agent 领取 | **仅人拖拽** |
| 进行中 | agent 实现中 | agent |
| 待审 | PR 已开，等人 review/合并 | agent |
| 受阻 | 卡住（原因见工单评论） | agent / 人 |

Label 体系与 `.agents/notes/` 六类 kind 一一对应（`kind/architecture` 等），另有 `roadmap` 标记路线行动项。

**工单标题与所有人读的看板产出（评论/父单正文/PR 文案）必须「说人话」**：动宾结构一句话说清做什么与做完的变化，禁止名词堆砌与内部术语——人扫看板不点开正文就能判断批不批。风格规则与执行方式（提笔前回顾 / style agent 专审）见 [`.agents/skills/gh-board/SKILL.md`](../.agents/skills/gh-board/SKILL.md)「人读内容风格」节。

## 循环

**评估循环**（agent 自动，拉单后只做判断）：轮询器取「待办」队首 → 读工单与看板/笔记/文档 → 在工单下留结构化归并分析（架构定位/归并判断/规模/依赖风险/建议优先级）→ 建议并单时创建父单并挂 sub-issue → 移「已评估」。评估不改代码。**防稀碎默认**：小改动倾向并成一轮架构迭代，独立成单须有理由。

**实现循环**（人拖进「待开工」后自动）：取「待开工」队首（WIP=1，有「进行中/待审」卡时不开工）→ 移「进行中」→ 建分支 `issue/<N>-<slug>`，实现范围 = 父单 + 全部 sub-issue 的验收标准并集 → 门禁全绿（typecheck/test/verify:notes/verify:docs）→ 提交推送 → 开 PR（正文 `Closes` 父单与每个子单）→ 移「待审」并评论 PR 链接。卡住移「受阻」并评论原因。

agent 会话的完整操作规约在 [`.agents/skills/gh-board/SKILL.md`](../.agents/skills/gh-board/SKILL.md)。

## 脚本面

```bash
npm run board -- status              # 看板概览（JSON）
npm run board -- sync                # 入板新工单/归档已关闭/补默认阶段与优先级
npm run board -- pick --for analysis # 待办队首（优先级排序）
npm run board -- pick --for work     # 待开工队首；WIP 占用时返回空队列
npm run board -- move <N> <阶段>     # 移动卡片
npm run board -- attach <父> <子>    # 挂 sub-issue（并单）
npm run board -- children <N>        # 列 sub-issue
npm run board -- archive <N>         # 归档
npm run board:poll                   # 手动跑一轮轮询器（同 timer 行为）
```

实现位于 `scripts/board.ts`（看板操作）与 `scripts/board-poll.ts`（轮询器）。项目/字段 ID 不进仓：脚本按字段名发现。

## 无头运行环境（本机）

- systemd user 单元：`~/.config/systemd/user/paseo-dsh-pi-board.{service,timer}`，timer 每 5 分钟触发 service（oneshot，运行中不重叠）。
- dsh headless 的模型路由/权限补丁：`~/.config/paseo-dsh-pi/board-patch.yml`（含私有 baseURL，不进仓）；凭证走 `~/.dsh/.credentials.yaml`（`CPA_API_KEY`），无需环境变量。
- 轮询器状态与日志：`~/.local/state/paseo-dsh-pi/`（尝试计数、每轮日志）。
- 超时：评估 10 分钟、实现 45 分钟；同一工单自动重试上限 2 次，超限移「受阻」等人处置。

## 已知边界

- WIP=1 只约束无头会话；人在同一工作树上交互开发时，无头实现循环的 `git checkout` 可能与之冲突——避免在轮询器干活时在同一目录做交互改动（看板「进行中」有卡即代表无头会话在干活）。
- 评估/实现会话消费真实模型 token（CPA-an 路由）；停用轮询：`systemctl --user stop paseo-dsh-pi-board.timer`。
