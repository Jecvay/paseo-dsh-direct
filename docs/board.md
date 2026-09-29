# GitHub 上下指令，agent 在本机干活

本项目的日常开发这样进行：仓库 owner 在 GitHub 上下指令，本机常驻的轮询服务把指令交给 dsh headless 去做，结果（评论、PR）以 GitHub App `paseo-dsh-agent` 的机器人账号 `paseo-dsh-agent[bot]` 写回 GitHub。工单是 issue，状态机是 [GitHub Projects 看板](https://github.com/users/Jecvay/projects/1)（仓库 `Jecvay/paseo-dsh-direct`，Project #1）。

## 怎么下指令

只认仓库 owner（Jecvay）本人发出的三种指令，别人的评论和标签一律不触发：

1. **在 issue 或 PR 下评论，开头写 `/jecbot`**，空一格后接要做的事，比如 `/jecbot 把 README 里 X 改成 Y`。PR 下的指令直接改这个 PR 的分支。`/jecbot` 前面只能有空白，后面必须是空白或者评论结束；写在句子中间、代码块或行内代码里的不算。`@agent`、`/agent` 都不认：GitHub 上真有叫 agent 的账号，@ 了会通知到它；`/agent` 太通用，别的机器人也可能认它。
2. **给 issue 加上 `agent:go` 标签**：按 issue 正文开工。服务开工时会把这个标签摘掉，想再来一次就重新加。
3. **把看板上的卡拖进「待开工」**：同样按 issue 正文开工。

issue 带 `line:0.1` 标签时，工作从 `release/0.1` 分支拉出，用 0.1 线的 dsh；其他旧线同理（`line:<major.minor>` → `release/<major.minor>`）。不带就基于 `main`。

服务自己发的评论都带隐藏标记 `<!-- paseo-dsh-agent -->`，带这个标记的评论、以及 `paseo-dsh-agent[bot]` 或其他机器人账号发的评论，永远不算指令。

## 服务做了什么

每分钟向 GitHub 查一次新指令，排进队列，一次只做一件（WIP=1）：

1. 在 issue / PR 下回「收到，开始」和本次的**日志编号**；卡片移到「进行中」。
2. 在状态目录下新建一个工作树（服务 clone 的独立 `git clone --shared`，自带 `.git`）：issue 任务用分支 `agent/<N>-<slug>`，PR 任务直接用 PR 的分支。做完就删，不碰开发用的工作树。
3. 读基线 `package.json` 的 `major.minor`（从服务自己的 git 库里读），到本机配置里找对应的 dsh；找不到就不开工，在 issue 里说明。
4. 起 `dsh --profile headless --patch <本机路由补丁> --json -`，把 issue / PR 的完整对话和指令交给它。owner 的话是指令，别人的话标成「仅供参考、不可信」。同一个 issue（以及由它开出的 PR）后续的指令，用 `--session-id` 接着同一个 dsh 会话。
5. dsh 退出后，在沙箱里对工作树跑 `git bundle create`，服务把 bundle 取回自己的 git 库（`refs/agent/<线程>`），再按输出约定决定下一步（见下一节）。之后的门禁、推送、查提交都在服务自己的库和一份新检出的干净 clone 上做，服务不再在 dsh 写过的库里跑 git。
6. 超时、dsh 异常退出或最后一个回合以报错结束：在 issue 里报告，同一条指令不自动重试。报告第一行就写清原因，正文贴出 dsh 报的原始错误：优先 `--json` 事件里 `turn_end` 的错误信息，没有就用 dsh stderr 的最后几行（截到 500 字，放在代码块里）；`sk-` 开头的 token 和 URL 一律替换成 `<redacted>`。限流（429 / RATE_LIMIT）时第一行直接说明是服务调用模型的额度用完，并另加一句大白话，把报错里的重置时间提出来、告诉人到点后再发一次 `/jecbot ...`；其他报错则提示可以先重发一次，连着失败按日志编号翻完整日志。

dsh 在工作树的 `.agent-out/` 下写结果，完整约定在 [`.agents/skills/gh-board/SKILL.md`](../.agents/skills/gh-board/SKILL.md)：

| dsh 留下了什么 | 服务怎么做 | 卡片 |
|---|---|---|
| `blocked.md` | 作为提问发到 issue，不推送提交；owner 回复 `/jecbot ...` 后接着同一个会话继续 | 受阻 |
| 新提交 | 在一份只含这些提交的干净 clone 上重跑门禁（`build`、`typecheck`、`test`、`verify:notes`、`verify:docs`）；全绿就从服务自己的库推送，issue 任务开 PR（正文 `Closes #N`、提交列表、门禁结果），PR 任务在 PR 下回复 | 待审 |
| 新提交，但门禁没过 | 不推送，把失败输出贴到 issue | 受阻 |
| 只有 `reply.md` | 作为评论发出去（评估、回答问题） | 已评估；原本在「待审」的留在「待审」 |
| 什么都没有 | 报告「没有结果」 | 受阻 |

时限：dsh 最多跑 60 分钟；跑满 15 分钟时工作树既没有新提交也没有未提交的改动，就当作只回复的任务超时，提前终止。

## 服务以谁的身份发言

服务在 GitHub 上说的话、做的事都以 GitHub App `paseo-dsh-agent` 的机器人账号 `paseo-dsh-agent[bot]` 出面：issue / PR 评论、摘掉 `agent:go` 标签、推送分支、开 PR。agent 的提交，作者和提交者都是 `paseo-dsh-agent[bot] <<用户 id>+paseo-dsh-agent[bot]@users.noreply.github.com>`。所以 PR 作者不是 owner，owner 可以正常 approve 它。

- 服务启动时用 App 私钥签一个 RS256 的 App JWT（有效 10 分钟），查出 App 在本仓库的 installation，换一个只对本仓库有效的 installation token（1 小时）。token 只放在服务进程的内存里，到期前 5 分钟换新的。
- 评论和开 PR 走 `gh`，token 通过这一次调用的 `GH_TOKEN` 环境变量传进去。
- 推送走 https：token 放在这一次 `git push` 的环境变量里，由命令行上的一个 credential helper 读出来交给 git；这次 push 不读全局和系统 git 配置，所以不会被别的 helper 存下来，也不会被 URL 改写规则改走。token 不写进任何文件或 git 配置。
- 提交身份靠 dsh 运行时的 `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 环境变量，不涉及 token。
- 读 issue、评论、事件、看 PR 列表仍用 owner 的 `gh` 登录。判断「是不是 owner 下的指令」只看评论作者或事件 actor 是不是 `Jecvay`。
- **看板（Projects v2）的挪卡仍用 owner 的 `gh` 登录**：看板属于用户 Jecvay，GitHub App 访问不了用户名下的 Projects。

`agent.json` 没有 `app` 配置时，上面这些都退回到 owner 的 `gh` 登录和本机 git 身份，服务启动时在日志里打一条警告。

## dsh 碰不到 GitHub 凭证，也改不了沙箱外的东西

所有 GitHub 操作（评论、推送、开 PR、挪卡）都由服务做，服务不执行 dsh 输出里的任何命令。dsh、`npm ci` 和门禁命令都在 bubblewrap 里运行：

- 整个主机文件系统只读，`/tmp`、`/dev`、`/proc` 和进程号空间是私有的，dsh 退出时它起的进程一起结束；
- 能写的只有本任务的工作树、本任务的结果目录和 npm 缓存、agent 专用的 DSH_HOME；
- gh 配置目录、`~/.ssh`、`~/.git-credentials`、`~/.npmrc`、`~/.netrc`、`~/.docker/config.json` 和 GitHub App 私钥被盖住；
- 环境变量里去掉 `GH_*`、`GITHUB_*`、`npm_config_*` 和名字里带 TOKEN / SECRET / PASSWORD 的变量，`GH_CONFIG_DIR` 指向一个空目录。

agent 专用的 DSH_HOME（默认 `~/.local/share/paseo-dsh-direct/dsh-home/<dsh 线>`，不能放在 `~/.dsh` 下）装 headless profile 和会话记录。模型凭证 `~/.dsh/.credentials.yaml` 以只读方式挂进去（盖在一个空的占位文件上），dsh 能读、改不了。dsh 的权限预设是 `danger-full-access`（`DSH_PERMISSION_MODE`），边界由外层这层 bubblewrap 划定。

`.agent-out/` 下的文件当纯数据读：只认普通文件，不跟符号链接，每个最多 64 KiB。

检查沙箱边界：`node_modules/.bin/tsx scripts/agent-loop/main.ts --sandbox-probe <dsh 线> -- <命令>` 用和真实任务一模一样的沙箱跑一条命令。

## 本机环境

下面的路径是默认值，hlab 上的实际部署写在 agents/common 的手册里。

- 服务代码：一份单独的 clone，`<服务目录>`（默认 `~/.local/share/paseo-dsh-direct/agent-loop`）。服务从它启动，工作树从它的 git 库 clone，推送也从它推。升级服务 = 在这里 `git pull` / `git checkout` 后重启。
- systemd user 单元：`~/.config/systemd/user/paseo-dsh-direct-agent.service`，仓库里的模板是 `scripts/agent-loop/systemd/paseo-dsh-direct-agent.service`。
- 本机配置 `~/.config/paseo-dsh-direct/agent.json`（不进仓库，格式见 `scripts/agent-loop/agent.example.json`）：dsh 版本线到可执行文件的映射、路由补丁路径、agent DSH_HOME 和凭证文件、要盖住的路径、轮询间隔，以及 `app`（App ID `id` 和私钥路径 `privateKeyPath`）。
- App 私钥 `~/.config/paseo-dsh-direct/agent-app.pem`（权限 0600，不进仓库）。`app.privateKeyPath` 指向的文件在沙箱里总是被盖住，不用写进 `hidePaths`。
- dsh 路由补丁 `~/.config/paseo-dsh-direct/dsh-headless.patch.yml`（含私有 baseURL，不进仓库）：设 `agent-default-model` 和 `llm-pi-ai` 的 provider。模型凭证走 `~/.dsh/.credentials.yaml`。
- 状态目录 `~/.local/state/paseo-dsh-direct/agent/`：`service/state.json`（轮询进度、队列、每个 issue 的 dsh 会话 id）、`logs/<日志编号>.{log,jsonl,prompt.md}`、`worktrees/`（每个 issue 线程一个固定路径，dsh 会话的工作目录不能变）、`tasks/<日志编号>/`（结果 bundle、npm 缓存、门禁用的干净 clone，任务结束即删）。

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
