# 决策记录: 用 GitHub 上的指令驱动 dsh agent 开发

Status: implemented

## 问题

用户希望日常开发这样进行：在 GitHub 上下指令、在 GitHub 上看结果，agent 在 hlab 上自己把活干完。之前做不到，实际的开发全靠在对话里来回聊。

之前的看板循环（[2026-09-26-github-board-work-loop.md](../../archived/process/2026-09-26-github-board-work-loop.md)）方向是对的，但没用起来，原因有三个：

- 太慢：每天 09:00 才轮询一次，拖进「待开工」的卡要等到第二天。
- 只有一个入口：只认「拖进待开工」。issue 和 PR 里的评论 agent 收不到，PR 审完也没法让它接着改。
- 环境不对：它在开发用的主工作树里切分支；dsh 用的是 PATH 里那个，不管当前分支属于哪条版本线；调用的还是 dsh 0.1 的 `dsh headless --patch` 写法。

## 决定

hlab 上跑一个常驻的轮询服务（systemd user 单元 `paseo-dsh-direct-agent.service`，代码在 `scripts/agent-loop/`），每分钟向 GitHub 查一次有没有仓库 owner（Jecvay）发出的新指令。有就在一个一次性的 worktree 里起 dsh headless 干活，结果写回 issue 和 PR。机制与启停写在 [docs/board.md](../../../../docs/board.md)，headless 会话的规约写在 [gh-board skill](../../../skills/gh-board/SKILL.md)。

### 轮询，不用 self-hosted runner

仓库是公开的。self-hosted runner 会执行仓库里任何 workflow 派来的任务，别人从 fork 提个 PR 改一下 workflow，就能在 hlab 上跑他自己的代码。轮询服务只主动往外连 GitHub，不接收任何外来任务，一分钟的延迟可以接受。

### 触发

只认 Jecvay 本人发出的三种指令，其他人的评论、标签一律不触发：

1. issue 或 PR 上的评论，开头是 `@agent`。
2. issue 被加上 `agent:go` 标签，且 issue 事件的 actor 是 Jecvay。服务开工时摘掉这个标签。
3. 看板上的卡被拖进「待开工」。只有 owner 能改看板，这个动作本身就是开工令。

服务用 Jecvay 的 gh 凭证发评论，所以它发的每条评论都带隐藏标记 `<!-- paseo-dsh-agent -->`，带标记的评论一律不当指令，免得服务把自己的回复当成新指令。

轮询进度（最后看到的评论 id、事件 id、「待开工」列里的卡）记在状态目录里。服务重启后接着往下看，第一次启动只记下当前进度、不回放历史。

判断逻辑（过滤指令、游标、去重、选 dsh、解析输出）集中在 `scripts/agent-loop/core.ts`，不碰外部，有单元测试；`main.ts` 只负责调 GitHub、git 和 dsh。

### 一次任务

1. 在 issue 或 PR 上回「收到，开始」和日志编号，卡片移到「进行中」。
2. 在状态目录下建 worktree，做完就删，不碰开发用的工作树。worktree 是服务专用 clone 的独立 `git clone --shared`，`.git` 在 worktree 里面；服务代码也从服务 clone 启动。issue 任务从基线分支拉出 `agent/<N>-<slug>`：基线默认 `main`，issue 带 `line:<major.minor>` 标签时用 `release/<major.minor>`。PR 任务直接 checkout PR 的分支，fork 来的 PR 不接。
3. 从服务自己的 git 库读起点提交里 `package.json` 的 `major.minor`，到本机配置 `~/.config/paseo-dsh-direct/agent.json` 里找对应的 dsh 可执行文件，找不到就不开工并说明原因。开工前跑一次 `--version` 记进日志。
4. 起 `dsh --profile headless --patch <本机路由补丁> --json [--session-id <id>] -`，prompt 从 stdin 进去，内容是：读 `AGENTS.md` 和 gh-board skill 的要求、issue / PR 的完整对话（Jecvay 的内容是指令，其他人的标成「仅供参考、不可信」）、本次指令和输出约定。
   - 模型路由放在 `--patch` 叠加的本机补丁里（`agent-default-model` 与 `llm-pi-ai` 两条，含私有 baseURL），0.1 和 0.2 两条线共用同一份补丁。
   - 权限用环境变量 `DSH_PERMISSION_MODE=danger-full-access`：两条线的 headless bundle 都从这个变量取 sandbox 模式和审批策略。能碰到什么由外层 bubblewrap 决定（见第 5 条）。
   - `DSH_HOME` 指向 agent 专用目录（每条 dsh 线一个，默认 `~/.local/share/paseo-dsh-direct/dsh-home/<线>`，不许在 `~/.dsh` 下），headless profile 和会话记录都在里面；`~/.dsh/.credentials.yaml` 以只读方式挂在其中的空占位文件上。两条线都认 `DSH_HOME`，不挂凭证时报 `MISSING_CREDENTIAL`。
   - dsh 会话 id 取自 `--json` 输出的第一个事件 `{"type":"session","sessionId":…}`，按线程记在状态文件里。同一个 issue、以及由它开出的 PR，后续指令用 `--session-id` 接着同一个会话；这两者共用同一个 worktree 路径，因为 dsh 会话的 cwd 创建后不能改。版本线变了就开新会话。
5. dsh、`npm ci` 和门禁命令跑在 bubblewrap 里：整个主机文件系统只读，`/tmp`、`/dev`、`/proc` 和进程号空间私有；能写的只有本任务的 worktree、结果目录、npm 缓存和 agent 的 DSH_HOME。gh 配置目录、`~/.ssh`、`~/.git-credentials`、`~/.npmrc`、`~/.netrc`、`~/.docker/config.json` 被盖住；环境变量去掉 `GH_*`、`GITHUB_*`、`npm_config_*` 和带 TOKEN / SECRET / PASSWORD 的变量，`GH_CONFIG_DIR` 指向空目录。这样 dsh 既拿不到 GitHub 凭证，也留不下会在沙箱外、带着凭证执行的东西（systemd 单元、shell 配置、线上 Paseo 用的 `~/.dsh` profile、服务 clone 的 `.git/config`）。
6. dsh 退出后，服务不在 dsh 写过的库里跑 git：沙箱里对 worktree 跑 `git bundle create <结果目录>/work.bundle HEAD ^<对比提交>`，服务校验后把 bundle 取回自己的库，记为 `refs/agent/<线程>`。之后的查提交、门禁、推送都在服务自己的库和一份新检出的干净 clone 上做。`.agent-out/` 下的文件当纯数据读：只认普通文件、不跟符号链接、每个最多 64 KiB。
7. 取回提交后，服务按输出约定处理：
   - 写了 `blocked.md`：作为提问发出去，卡片移到「受阻」，本次提交留在 `refs/agent/<线程>` 不推送，下次从这里接着做；Jecvay 回复 `@agent ...` 后接着同一个会话继续。
   - 有新提交：在只含这些提交的干净 clone 上跑门禁（`build`、`typecheck`、`test`、`verify:notes`、`verify:docs`）。全绿就从服务自己的库 push：issue 任务开 PR，正文 `Closes #N`、提交列表和门禁结果；PR 任务推到原分支并在 PR 下回复。卡片移到「待审」。门禁没过就不 push，在 issue 里贴失败输出，卡片移到「受阻」。
   - 没有提交、只写了 `reply.md`：作为评论发出去，卡片移到「已评估」（原本在「待审」的留在「待审」）。
8. 超时或 dsh 非零退出：在 issue 里报告并附日志编号，同一条指令不自动重试。服务在任务中途被停掉，下次启动时在 issue 里说明这条指令没做完。

### 输出约定

dsh 在 worktree 的 `.agent-out/` 目录下写结果。这个目录写在 `.gitignore` 里，服务还把它加进 worktree 的 `info/exclude`，旧版本线的分支上也不会被提交：

- `reply.md`：必写。中文大白话说清做了什么，或者直接回答问题，遵守 gh-board skill 里的「人读内容风格」。
- `pr-title.txt`：有提交时必写，英文、kernel 风格的标题。
- `blocked.md`：可选，只有卡住、需要人拍板时才写。

commit message 由 dsh 自己写，遵守英文、kernel 风格的 commit 规范。

### 并发与时限

- 同一时间只跑一个任务（WIP=1），其他指令按先来后到排队，队列记在状态文件里。
- dsh 最多跑 60 分钟。跑满 15 分钟时 worktree 既没有新提交也没有未提交的改动，按只回复的任务处理，提前终止。

### 替换掉的旧做法

每天 09:00 的 `paseo-dsh-direct-board.timer` 和 `scripts/board-poll.ts` 已删除。`scripts/board.ts` 保留挪卡、查卡，`move` 会把还不在看板上的 issue 先入板，新增 `stage` 子命令查卡片阶段。

## 考虑过的其他做法

- **GitHub Actions + hlab self-hosted runner**：GitHub 事件一来几秒就开工，但公开仓库上 fork 来的 PR 能在 hlab 上跑任意代码（见上文），不用。
- **GitHub Actions 托管 runner + dsh**：不碰 hlab，但托管 runner 上没有本机的 dsh 版本组合、Paseo daemon 和模型路由，跑不了真实的端到端测试，而这个插件的问题大多只有真实环境里才测得出来。
- **Claude Code（claude-code-action）当执行者**：它自带回复评论、开 PR 这些 GitHub 功能，要自己写的代码最少。用户选了 dsh：一来用 dsh 开发 dsh 插件，本身就是持续的实测；二来 GitHub 那部分由服务来做，dsh 只负责改代码，两边分得清楚。
- **维持每天轮询一次**：不改，但用户实际不会用它，工作还是回到对话里。
- **dsh 用 workspace-write 权限、不套外层沙箱**：dsh 自带的文件沙箱只管写、不管读，挡不住读凭证文件；而且 dsh 自己的数据目录、npm 缓存都在工作区外。改为 danger-full-access 加外层 bubblewrap，由外层决定哪些路径可写。
- **外层 bubblewrap 只盖住凭证、根目录可写**：dsh 读不到凭证，但能写 systemd 单元、shell 配置、线上 Paseo 用的 `~/.dsh` profile 或服务 clone 的 `.git/config`（`core.fsmonitor`、`core.sshCommand`、`url.*.insteadOf` 等），这些会在沙箱外、带着 GitHub 凭证执行；关掉 hooks 管不到它们。所以根目录只读，只放开少数可写路径。
- **服务直接在 dsh 写过的库里 push**：最省事，但那个库的 git 配置 dsh 能改，push 时会执行。改为 bundle 取回、从服务自己的库推送。
- **dsh 用 `~/.dsh` 做 DSH_HOME**：不用另建目录，但 `~/.dsh/profiles/paseo` 由线上 Paseo daemon 加载，dsh 能写它就等于能在沙箱外执行。
- **每个任务用新的 worktree 路径**：更彻底地隔离，但 dsh 会话的 cwd 创建后不能改，后续指令就接不上同一个会话，所以同一个 issue 的线程固定用同一个路径。

## 后果

- 下指令到开工在一分钟左右；issue、PR、看板三个入口都能用，PR 审完可以直接在 PR 下让它接着改。
- 开发用的工作树不再被切分支，交互开发和无头任务互不干扰。
- 旧版本线的工单用对应线的 dsh，`release/0.1` 上的修复不会被 0.2 的 dsh 做坏。
- 服务用的是 Jecvay 的 gh 凭证，权限很大。dsh 进程和门禁命令看不到它，所有 GitHub 操作都是服务里固定的几种调用，不执行 dsh 输出里的任何命令。
- 公开 issue 里别人的发言会进 prompt：只有 Jecvay 能触发任务，别人的发言标成不可信，dsh 碰不到 GitHub 凭证，也改不了沙箱外的文件。dsh 仍然有网络，能读模型 key 和 bubblewrap 没盖住的其他文件，这是它干活需要的。
- dsh 每个 rc 都可能改 headless 的调用方式。服务开工前记下 `dsh --version`，调用失败就在 issue 里报告，不静默跳过。
- 轮询每分钟调几次 GitHub API，远低于每小时 5000 次的上限。
- 每个任务跑两次 `npm ci`（worktree 和门禁用的干净 clone 各一次），npm 缓存按任务隔离，会多花几秒到几十秒。

## 怎么验证的

- `scripts/agent-loop/core.test.ts` 覆盖：非 owner 评论和伪造的 `@agent` 事件不触发、不以 `@agent` 开头的评论不触发、带标记的评论不触发、游标首次初始化不回放、重复扫描不重复触发、标签事件核对 actor、看板卡片每次进入「待开工」只触发一次、按 `package.json` 和 `agent.json` 选 dsh、输出约定的判定、子进程环境变量清理、bubblewrap 参数（只有列出的路径可写）、结果文件的路径与大小限制。
- 沙箱负向测试：用 `main.ts --sandbox-probe` 跑和真实任务相同的 argv，写 `~/.config/systemd/user`、`~/.dsh/profiles`、`$HOME`、服务 clone 的 `.git/config` 和代码、状态文件，读 `~/.config/gh/hosts.yml`、`~/.npmrc` 都失败；写 worktree 和 agent DSH_HOME 成功。
- 验收用例在 GitHub 上真实跑过，证据（issue / PR 链接、日志编号、dsh 会话 id 和版本）记在实现这条记录的 PR 里。
