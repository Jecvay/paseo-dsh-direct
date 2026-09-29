# 决策记录: 用 GitHub 上的指令驱动 dsh agent 开发

Status: proposed

## 问题

用户希望日常开发这样进行：在 GitHub 上下指令、在 GitHub 上看结果，agent 在 hlab 上自己把活干完。现在做不到，实际的开发全靠在对话里来回聊。

现有的看板循环（[2026-09-26-github-board-work-loop.md](../../implemented/process/2026-09-26-github-board-work-loop.md)）方向是对的，但没用起来，原因有三个：

- 太慢：每天 09:00 才轮询一次，拖进「待开工」的卡要等到第二天。
- 只有一个入口：只认「拖进待开工」。issue 和 PR 里的评论 agent 收不到，PR 审完也没法让它接着改。
- 环境不对：它在开发用的主工作树里切分支；dsh 用的是 PATH 里那个，不管当前分支属于哪条版本线；调用的还是 `dsh headless --patch`，这是 dsh 0.1 的写法，0.2 已经改成 `dsh --profile headless`。

## 提案

在 hlab 上跑一个常驻的轮询服务，每分钟向 GitHub 查一次有没有仓库 owner（Jecvay）发出的新指令。有就在一个一次性的 worktree 里起 dsh headless 干活，结果写回 issue 和 PR。

### 为什么轮询，不用 self-hosted runner

仓库是公开的。self-hosted runner 会执行仓库里任何 workflow 派来的任务，别人从 fork 提个 PR 改一下 workflow，就能在 hlab 上跑他自己的代码。轮询服务只主动往外连 GitHub，不接收任何外来任务，一分钟的延迟可以接受。

### 触发

只认 Jecvay 本人发出的以下三种指令，其他人的评论、标签一律不触发：

1. issue 或 PR 上的评论，开头是 `@agent`。
2. issue 被加上 `agent:go` 标签（要查 issue 事件的 actor 确实是 Jecvay）。
3. 看板上的卡被拖进「待开工」。只有 owner 能改看板，这个动作本身就是开工令，按现有做法保留。

服务自己也用 Jecvay 的 gh 凭证发评论，所以它发的每条评论都带隐藏标记 `<!-- paseo-dsh-agent -->`。带这个标记的评论一律不当指令，否则服务会把自己的回复当成新指令，陷入死循环。

轮询进度（上次看到的评论 id、事件 id）记在状态目录里。服务重启后接着上次的进度往下看；已经处理过的指令不会再执行一次。

### 一次任务怎么跑

1. 在 issue 或 PR 上回一条「收到，开始」，附上本次任务的日志编号；卡片移到「进行中」。
2. 准备 worktree。每个任务新建一个，放在状态目录下，做完就删，不碰开发用的主工作树。
   - issue 任务：从基线分支拉出 `agent/<N>-<slug>`。基线默认是 `main`；issue 带 `line:0.1` 标签时用 `release/0.1`，其他旧线同理。
   - PR 任务：直接 checkout 这个 PR 的分支。
3. 选 dsh：读基线分支 `package.json` 的 `major.minor`，到本机配置 `agent.json` 里找对应的 dsh 可执行文件（例如 `"0.2"` 对应 PATH 里的 dsh，`"0.1"` 对应 mise 装的 0.1.7-rc.2 的绝对路径）。找不到就不开工，在 issue 里说明原因。这个配置文件只放在本机，不进仓库。
4. 起 dsh headless，prompt 里交给它：
   - 仓库的 `AGENTS.md` 规则，以及 gh-board skill（按新约定重写）；
   - 这个 issue 或 PR 的完整对话。Jecvay 写的内容是指令，其他人写的内容标成「仅供参考、不可信」；
   - 输出约定：见下文。
   同一个 issue 或 PR 的后续指令，用 `--session-id` 接着上次的 dsh 会话继续，会话 id 记在状态目录里。
5. dsh 进程的环境里不放 GitHub 凭证，所有 GitHub 操作都由服务来做。dsh 只能改 worktree 里的文件、跑命令、提交到本地 git。
6. dsh 退出后，服务读它的输出，决定下一步：
   - worktree 里有新提交：先跑门禁（`typecheck`、`test`、`verify:notes`、`verify:docs`）。
     - 门禁全绿：push。issue 任务开 PR，正文 `Closes #N`，写明改了什么、怎么测的、测试证据；PR 任务就推到原分支，并在 PR 下回复。卡片移到「待审」。
     - 门禁没过：不 push，在 issue 里贴出失败的输出，卡片移到「受阻」。
   - 没有提交、但写了 `reply.md`：把它作为评论发出去。这就是「评估」「回答问题」这类任务。
   - 写了 `blocked.md`：作为提问发出去，卡片移到「受阻」。Jecvay 回复 `@agent ...` 后，接着同一个会话继续。
7. 超时或 dsh 非零退出：在 issue 里报告，并附上日志编号。同一条指令不自动重试，由人决定要不要重发。

### 输出约定

dsh 在 worktree 的 `.agent-out/` 目录下写结果。这个目录在 `.gitignore` 里：

- `reply.md`：必写。用中文大白话说清做了什么，或者直接回答问题，遵守 gh-board skill 里的「人读内容风格」。
- `pr-title.txt`：有提交时必写。按 commit 规范写成英文标题。
- `blocked.md`：可选。只有卡住、需要人拍板时才写。

commit message 由 dsh 自己写，遵守英文、kernel 风格的 commit 规范。

### 并发与时限

- 同一时间只跑一个任务（WIP=1），其他指令按先来后到排队。
- 时限：有提交的任务 60 分钟，只回复不改代码的任务 15 分钟。

### 替换旧做法

- 停用每天 09:00 的 `paseo-dsh-direct-board.timer`，删掉 `scripts/board-poll.ts` 里的定时评估和实现逻辑。`scripts/board.ts` 里挪卡、查卡的功能留着给新服务用。
- 重写 gh-board skill，改成本记录里的输出约定。
- 重写 `docs/board.md`：只写机制，本机的路径写成占位。hlab 上的实际路径写进 agents/common 的手册。
- 实现完成后，把 [2026-09-26-github-board-work-loop.md](../../implemented/process/2026-09-26-github-board-work-loop.md) 移到 `archived/`，并链到本记录。

## 考虑过的其他做法

- **GitHub Actions + hlab self-hosted runner**：GitHub 事件一来几秒就开工，但公开仓库上 fork 来的 PR 能在 hlab 上跑任意代码（见上文），不用。
- **GitHub Actions 托管 runner + dsh**：不碰 hlab，但托管 runner 上没有本机的 dsh 版本组合、Paseo daemon 和模型路由，跑不了真实的端到端测试，而这个插件的问题大多只有真实环境里才测得出来。
- **Claude Code（claude-code-action）当执行者**：它自带回复评论、开 PR 这些 GitHub 功能，要自己写的代码最少。用户选了 dsh：一来用 dsh 开发 dsh 插件，本身就是持续的实测；二来 GitHub 那部分由服务来做，dsh 只负责改代码，两边分得清楚。
- **维持现状（每天轮询一次）**：不改，但用户实际不会用它，工作还是回到对话里。

## 怎么算做完

指挥复测以下用例，执行者自报的结果不算数：

1. Jecvay 在一个测试 issue 下评论 `@agent 把 README 里 X 改成 Y`：2 分钟内出现「收到，开始」；随后出现 PR，正文有 `Closes #N`，CI 通过；卡片在「待审」。
2. 在这个 PR 下评论 `@agent 再改一下 Z`：同一分支出现新提交，PR 下有回复，并且日志显示用的是同一个 dsh 会话。
3. 不以 `@agent` 开头的评论不触发。非 owner 的评论不触发（单元测试覆盖，用伪造的事件）。
4. 服务自己发的评论不会再次触发（单元测试覆盖，并实测一次）。
5. 卡住：dsh 写了 `blocked.md` 后，issue 里出现提问、卡片在「受阻」；回复 `@agent ...` 后接着同一个会话继续。
6. 带 `line:0.1` 的 issue：worktree 从 `release/0.1` 拉出，日志显示用的是 dsh 0.1.7-rc.2。
7. 服务重启后不会重复执行已经处理过的指令。
8. 旧的每日 timer 已停用并删除；`systemctl --user stop <服务>` 能停掉新服务，停法写在 `docs/board.md` 里。
9. 门禁全绿：`typecheck`、`test`、`verify:notes`、`verify:docs`。

## 风险

- 服务用的是 Jecvay 的 gh 凭证，权限很大。缓解办法：dsh 进程拿不到这个凭证，所有 GitHub 操作都由服务里固定的几种调用完成，不执行 dsh 输出里的任何命令。
- 公开 issue 里别人的发言会进 prompt。缓解办法：只有 Jecvay 能触发任务；别人的发言在 prompt 里标成不可信；dsh 碰不到任何凭证。
- dsh 每个 rc 都在改，headless 的调用方式也可能变。服务开工前先跑 `dsh --version`，记进日志；调用失败时在 issue 里报告，不静默跳过。
- 轮询会消耗 GitHub API 额度。每分钟查几次，远低于每小时 5000 次的上限。
