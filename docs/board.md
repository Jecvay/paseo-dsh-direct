# GitHub 上下指令，agent 在本机干活

本项目的日常开发这样进行：仓库 owner 在 GitHub 上下指令，本机常驻的轮询服务把指令交给 dsh headless 去做，结果（评论、PR）写回 GitHub。工单是 issue，状态机是 [GitHub Projects 看板](https://github.com/users/Jecvay/projects/1)（仓库 `Jecvay/paseo-dsh-direct`，Project #1）。

## 怎么下指令

只认仓库 owner（Jecvay）本人发出的三种指令，别人的评论和标签一律不触发：

1. **在 issue 或 PR 下评论，开头写 `@agent`**，后面接要做的事，比如 `@agent 把 README 里 X 改成 Y`。PR 下的指令直接改这个 PR 的分支。
2. **给 issue 加上 `agent:go` 标签**：按 issue 正文开工。服务开工时会把这个标签摘掉，想再来一次就重新加。
3. **把看板上的卡拖进「待开工」**：同样按 issue 正文开工。

issue 带 `line:0.1` 标签时，工作从 `release/0.1` 分支拉出，用 0.1 线的 dsh；其他旧线同理（`line:<major.minor>` → `release/<major.minor>`）。不带就基于 `main`。

服务自己发的评论都带隐藏标记 `<!-- paseo-dsh-agent -->`，带这个标记的评论永远不算指令。

## 服务做了什么

每分钟向 GitHub 查一次新指令，排进队列，一次只做一件（WIP=1）：

1. 在 issue / PR 下回「收到，开始」和本次的**日志编号**；卡片移到「进行中」。
2. 在状态目录下新建一个工作树：issue 任务用分支 `agent/<N>-<slug>`，PR 任务直接用 PR 的分支。做完就删，不碰开发用的工作树。
3. 读工作树里 `package.json` 的 `major.minor`，到本机配置里找对应的 dsh；找不到就不开工，在 issue 里说明。
4. 起 `dsh --profile headless --patch <本机路由补丁> --json -`，把 issue / PR 的完整对话和指令交给它。owner 的话是指令，别人的话标成「仅供参考、不可信」。同一个 issue（以及由它开出的 PR）后续的指令，用 `--session-id` 接着同一个 dsh 会话。
5. dsh 退出后按输出约定决定下一步（见下一节）。
6. 超时或 dsh 异常退出：在 issue 里报告，同一条指令不自动重试。

dsh 在工作树的 `.agent-out/` 下写结果，完整约定在 [`.agents/skills/gh-board/SKILL.md`](../.agents/skills/gh-board/SKILL.md)：

| dsh 留下了什么 | 服务怎么做 | 卡片 |
|---|---|---|
| `blocked.md` | 作为提问发到 issue，不推送提交；owner 回复 `@agent ...` 后接着同一个会话继续 | 受阻 |
| 新提交 | 重跑门禁（`build`、`typecheck`、`test`、`verify:notes`、`verify:docs`）；全绿就推送，issue 任务开 PR（正文 `Closes #N`、提交列表、门禁结果），PR 任务在 PR 下回复 | 待审 |
| 新提交，但门禁没过 | 不推送，把失败输出贴到 issue | 受阻 |
| 只有 `reply.md` | 作为评论发出去（评估、回答问题） | 已评估；原本在「待审」的留在「待审」 |
| 什么都没有 | 报告「没有结果」 | 受阻 |

时限：dsh 最多跑 60 分钟；跑满 15 分钟时工作树既没有新提交也没有未提交的改动，就当作只回复的任务超时，提前终止。

## dsh 碰不到 GitHub 凭证

所有 GitHub 操作（评论、推送、开 PR、挪卡）都由服务做，服务不执行 dsh 输出里的任何命令。dsh 和门禁命令在 bubblewrap 里运行：

- 环境变量里去掉 `GH_*`、`GITHUB_*` 和名字里带 TOKEN / SECRET / PASSWORD 的变量，`GH_CONFIG_DIR` 指向一个空目录；
- gh 配置目录、`~/.ssh`、`~/.git-credentials` 用空目录或 `/dev/null` 盖住；
- 服务自己的代码目录、状态文件和配置里列出的目录只读；工作树和 git 对象库可写。

dsh 的权限预设是 `danger-full-access`（`DSH_PERMISSION_MODE`），外层靠上面这层 bubblewrap 兜底。

## 本机环境

下面的路径是默认值，hlab 上的实际部署写在 agents/common 的手册里。

- 服务代码：一份单独的 clone，`<服务目录>`（默认 `~/.local/share/paseo-dsh-direct/agent-loop`）。服务从它启动，工作树也从它的 git 库拉出。升级服务 = 在这里 `git pull` / `git checkout` 后重启。
- systemd user 单元：`~/.config/systemd/user/paseo-dsh-direct-agent.service`，仓库里的模板是 `scripts/agent-loop/systemd/paseo-dsh-direct-agent.service`。
- 本机配置 `~/.config/paseo-dsh-direct/agent.json`（不进仓库，格式见 `scripts/agent-loop/agent.example.json`）：dsh 版本线到可执行文件的映射、路由补丁路径、沙箱设置、轮询间隔。
- dsh 路由补丁 `~/.config/paseo-dsh-direct/dsh-headless.patch.yml`（含私有 baseURL，不进仓库）：设 `agent-default-model` 和 `llm-pi-ai` 的 provider。模型凭证走 `~/.dsh/.credentials.yaml`。
- 状态目录 `~/.local/state/paseo-dsh-direct/agent/`：`service/state.json`（轮询进度、队列、每个 issue 的 dsh 会话 id）、`logs/<日志编号>.{log,jsonl,prompt.md}`、`worktrees/`。

轮询进度按评论 id、事件 id 记，服务重启后接着往下看，处理过的指令不会再执行。第一次启动只记下当前进度，不回放历史。

## 启停

```bash
systemctl --user stop paseo-dsh-direct-agent.service      # 停服务（正在跑的 dsh 一起停）
systemctl --user start paseo-dsh-direct-agent.service     # 启动
systemctl --user disable --now paseo-dsh-direct-agent.service  # 停掉并不再开机自启
journalctl --user -u paseo-dsh-direct-agent.service -f    # 看服务日志
```

任务跑到一半被停掉，下次启动时服务会在对应的 issue 里说明这条指令没做完，不会自动重做。

## 阶段与看板脚本

看板用两个自定义单选字段：「阶段」（`待办 → 已评估 → 待开工 → 进行中 → 待审 → 受阻`，issue 关闭后 sync 自动归档）和「优先级」（`P0`–`P3`，入板时从标题 / 正文推断）。「待开工」只有人能拖进。

```bash
npm run board -- status              # 看板概览（JSON）
npm run board -- sync                # 入板新工单、归档已关闭、补默认阶段和优先级
npm run board -- move <N> <阶段>     # 移动卡片（不在看板上的 issue 先入板）
npm run board -- stage <N>           # 查卡片所在阶段
npm run board -- attach <父> <子>    # 挂 sub-issue（并单）
npm run board -- children <N>        # 列 sub-issue
npm run board -- archive <N>         # 归档
```

看板操作在 `scripts/board.ts`，服务在 `scripts/agent-loop/`（`core.ts` 是不碰外部的判断逻辑，有单元测试；`main.ts` 负责调用 GitHub、git 和 dsh）。项目和字段的 ID 不进仓库，脚本按字段名查。

标题和所有给人看的产出（评论、PR 文案）要说人话，规则见 [`.agents/skills/gh-board/SKILL.md`](../.agents/skills/gh-board/SKILL.md)「人读内容风格」节。
