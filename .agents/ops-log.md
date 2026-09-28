# 仓外事件

仅记录 git 与部署流水线无法还原的手工部署、配置变更和真实运行证据。不记录仓内代码改动。

## 2026-09-23 — pi-tui profile 桥接探活

- 环境：本机 Linux，Node 24.13.0，Paseo 0.8.0，DSH 0.1.5-rc.2，dsh-pi-tui 0.4.6。
- 操作：通过临时 `--patch` 在既有 `pi-tui` profile 中加载桥接，依次执行 `bridge.initialize`、`session.list`、`bridge.shutdown`。
- 结果：握手成功，目录返回 8 个模型和 4 个 preset，读取 120 个原生历史会话摘要；shutdown 后退出码 0，stderr 0 行，stdout 均为 JSON 协议。
- 数据边界：未发模型请求，未修改用户持久 profile 或历史内容。模型路由、会话内容和凭证不进入此记录。

## 2026-09-23 — 真实模型与原生会话生命周期

- 操作：在专用测试工作目录新建 DSH 会话，要求仅返回 `PASEO_DSH_ALPHA_OK`，通过 bridge 接收实时流并读取持久结果。
- 结果：回复包含指定文本，收到 19 个实时流帧、18 个持久事件，用户消息获得入队标识，close 和进程关闭成功。本次未观测到独立 reasoning 帧，不据此声称已验证真实模型思考输出。
- 补充验证：另一专用测试会话执行 open、保持相同模型的 configure、rename、close、resume；恢复沿用同一 session id，读取 7 个持久事件且模型选择保持。所有 8 个目录模型可读到 reasoning 选项；该轮未发送 prompt，最终退出码 0，stderr 0 行。
- 既有历史验证：官方只读接口成功读取一个已有会话的 18 个事件，未向其追加测试消息。测试会话内容与既有工作历史分开，用户 profile 文件保持原样。

## 2026-09-23 — Paseo 本机安装与插件总开关

- 操作：执行本地 `paseo plugin install` 安装 `paseo-dsh-pi`。插件已登记启用，但宿主的 `pluginsEnabled` 总开关关闭，初次状态为 `disabled`。
- 配置：备份宿主配置后，仅将 `pluginsEnabled` 设为 `true`，执行 `paseo daemon reload`。保留既有自定义 `dsh` Provider，新增插件使用 `dsh-pi` 标识。
- 回退：可通过 `paseo plugin disable paseo-dsh-pi` 停止插件；如需恢复总开关，使用主机侧安装前配置备份。备份、凭证和机器私有配置不进入本仓库。
- 安装结果：插件状态 `running`、enabled 为 true；Paseo 模型目录返回 8 个模型与各自思考选项。
- 完整对话：通过 `paseo run --provider dsh-pi` 创建专用测试会话，收到 `PASEO_MOBILE_READY`，最终状态 `idle`，Paseo 可见 4 个 preset 模式与用量统计。无需用户手机参与即可验证该 Daemon 会话链路；手机真机界面未在本任务中操作。
- 工具与配置：同一 Paseo 测试会话成功调用 shell 执行 `printf PASEO_TOOL_OK` 并完成回复；Paseo 的思考选项更新到 `high` 成功。

## 2026-09-23 — 会话级权限预设

- 操作：使用 DSH 官方 `permissionPresets` 与 `/permission` 命令，在专用测试会话切换权限后关闭、恢复。
- 结果：目录返回 `read-only`、`workspace-write`、`danger-full-access`；切换 `workspace-write` 后原生事件记录对应 sandbox 和 `ask` 审批策略，恢复保持该值；随后还原测试会话权限。
- 数据边界：全局默认权限保持不变；本轮没有模型调用，最终进程退出码 0、stderr 为空。

## 2026-09-23 — Paseo SDK 原生交互与审批验收

- 环境：本机 Paseo Daemon `0.8.0`，通过官方 `@getpaseo/client` 连接 `ws://127.0.0.1:6767/ws`；仅使用专用导入测试 agent `2beceb2c-9fe7-406f-b02d-456cde720c77`，cwd 为 `/tmp/paseo-dsh-lifecycle-hb7_zea_`。
- 权限路径：将会话切到 `read-only` 后，模型原生 bash 尝试写入 `PASEO_APPROVAL_OK.txt`；文件写入被拒，DSH 记录 workspace-write 升级被拒。随后切到 `workspace-write`，同一 bash 写入成功，文件内容为 `PASEO_APPROVAL_OK`。
- 交互路径：原生 `ask_user_question` 收到 `Alpha choice`（Continue/Stop），客户端以 `Continue` 应答并回合正常结束；第二回合同结构问题以 deny 应答，记录为 `Question cancelled` 并正常回合结束。
- 结果：三阶段均回到 `idle`，未取消活动回合；结束前将该测试会话权限恢复为 `danger-full-access`。未修改全局权限、未触碰其他会话、未记录 prompt 或凭证。

## 2026-09-23 — Paseo 原生历史导入与中断恢复

- 操作：重载插件后，通过 Paseo 继续既有专用测试对话，回复 `PASEO_ENV_READY`，证明宿主会话环境可以传入运行时。
- 历史入口：使用官方客户端的 `fetchRecentProviderSessions` 查询 `dsh-pi`，获得 123 个原生会话摘要；将专用生命周期测试会话的 `providerHandleId` 原样交给 `importAgent`，导入成功，持久化 token 仍包含原生 DSH 会话 ID。未导入或修改用户工作会话。
- 中断：向专用 Paseo 会话发起 `sleep 60` 工具请求，4 秒后停止返回 `stoppedCount: 1`；随后新回合返回 `PASEO_CANCEL_RECOVERED`，状态 completed。
- 呈现：Paseo 的真实 timeline 已观测到独立 reasoning 项、工具卡片和助手消息；初始无 reasoning 的桥接探活不能替代这项后续证据。

## 2026-09-23 — workspace 外工具审批 allow

- 诊断：官方 DSH preset 表为 `read-only = sandbox read-only + approval ask`、`workspace-write = sandbox workspace-write + approval ask`、`danger-full-access = sandbox danger-full-access + approval never`。此前 read-only 写入先由 bash 沙箱拒绝，模型升级重试被拒；没有产生 Paseo `kind=tool` 审批事件。
- 补测：在 `workspace-write` 下要求 bash 将固定 marker 写入专用 workspace 外目录 `$HOME/.cache/paseo-dsh-alpha-approval/ok.txt`。SDK 实际收到一个 `kind=tool`、`name=bash` 请求并自动响应 `allow`；文件内容为 `PASEO_APPROVAL_OK`，回合回到 `idle`。
- 清理：删除专用审批测试目录，会话权限恢复为 `danger-full-access`；未修改全局权限或其他会话。

## 2026-09-23 — workspace 外工具审批 deny

- 补测：沿用 `workspace-write`，要求 bash 将固定 marker 写入专用 workspace 外路径 `$HOME/.cache/paseo-dsh-alpha-approval/denied.txt`。
- 结果：SDK 实际收到一个 `kind=tool`、`name=bash` 请求并响应 `deny`；回合回到 `idle`，目标文件不存在，未发生重试或绕过。
- 清理：会话权限恢复为 `danger-full-access`，专用测试目录已删除；未修改全局权限或其他会话。

## 2026-09-23 — Daemon 重启与新建对话验收

- 操作：执行 `paseo daemon restart`，正常停止旧进程并启动新 Daemon；插件自动恢复为 enabled/running。
- 恢复：重启后向既有专用 Paseo 测试会话发送提示词，收到 `PASEO_RESTART_READY` 并正常结束。
- 新建：通过 `paseo run --provider dsh-pi` 新建会话，返回 `PASEO_ALPHA_INSTALLED`。官方移动客户端接口读取 timeline，确认恰好一个真实用户气泡、一个助手气泡；运行时注入内容没有显示成用户消息。
- 补充：可重复执行的 `npm run smoke:bridge -- --prompt` 通过真实模型、关闭和恢复检查；成功标记只从助手正文判定。
- 发布边界：本机 Linux Daemon 和官方客户端接口实测通过；未操作手机真机界面，未向远端发布 GitHub Release。

## 2026-09-23 — Alpha 最终加载与测试会话整理

- 操作：加载最终插件代码，专用会话回复 `PASEO_FINAL_READY`；关闭并读取原生历史后，两次模型回复各出现一次。
- 整理：仅归档本任务创建或导入的 3 个 Paseo 测试 agent，保留 DSH 原生测试历史；插件保持安装且启用。

## 2026-09-23 — Paseo 升级至 0.9.1

- 来源：实时 npm registry 的 `@getpaseo/cli` latest 为 `0.9.1`；沿用 mise，以 `mise use --global npm:@getpaseo/cli@0.9.1` 安装并固定该版本，安装前备份主机 mise 配置。
- 启动：新版 `daemon restart` 只重启旧 supervisor 的 worker，查询仍为 `0.8.0`；随后完整执行 `daemon stop` 和 `daemon start`，确认 CLI 与 Daemon 均为 `0.9.1`。
- 验证：Daemon reachable，原有 6 个 Provider 均 available，relay 配置保留；`paseo-dsh-pi` 保持 enabled/running，目录返回 8 个模型。专用会话实际返回 `PASEO_091_OK`，回合正常完成，用户确认手机收到该回复；测试会话已归档。
- 范围：未升级 DSH、pi-tui 或项目 SDK 依赖；本次是宿主升级、加载和文字对话验证，未重跑完整 alpha 交互矩阵。

## 2026-09-23 — Codex CLI 升级至 0.156.0

- 操作：运行独立安装版内置的 `codex update`，官方安装器将 Codex CLI 从 `0.154.0` 更新至 `0.156.0`，平台为 Linux x64。
- 验证：更新器退出码为 0；重新执行 `codex --version` 返回 `codex-cli 0.156.0`，命令链接已指向对应版本的 standalone release。
- 生效：已运行的 Codex 会话需要重启后使用新版；本次未主动中断当前会话。

## 2026-09-23 — 按用户要求结束 Codex 旧进程

- 范围：主机检查发现当前用户只有一个 Codex 进程，PID 为 396156，版本为 0.154.0；用户明确授权全部结束。
- 操作：核实可执行文件、属主和进程启动时间后发送 SIGTERM；若 5 秒内仍未退出，再核实身份并发送 SIGKILL。
- 验证：目标进程已退出；未自动启动新的 Codex 会话。

## 2026-09-24 — 本机重载斜杠命令、附件与会话选项版本

- 操作：本地目录插件已安装，`paseo plugin install` 报 ID 已存在；改为 `npm run build` 后执行 `paseo plugin reload paseo-dsh-pi`，状态 running、enabled，无错误。
- 实测（直接驱动桥接，DSH 0.1.5-rc.2）：`session.commands` 返回 5 个命令与 26 个技能；`/compact`、`/permission`、`/plan` 与 `/plan off` 写出对应事件；文件附件入 DSH 附件库并被模型读取；当前 8 个模型均拒绝图片输入；stdio MCP 工具经预批准调用成功，追加的 system prompt 生效；不持久化会话仅写入临时目录并在关闭后删除。
- 范围：未在 Paseo App 或手机界面验证新功能；`/goal` 实测在临时会话中触发了一次模型调用，随会话关闭结束。

## 2026-09-24 — pi-tui 升级至 0.4.7-alpha.2 后桥接启动失败

- 现象：`~/.dsh/profiles/pi-tui` 中的 `@xmoon76/dsh-pi-tui` 于 08:13 变为 `0.4.7-alpha.2`（非本任务操作）；新版在应用就绪时若无界面调用 `markSurfaceMounted()` 即以退出码 1 结束，桥接进程随之退出，Paseo 新建或恢复 DSH 会话都会失败。
- 处置：桥接挂载时调用 `tuiStartup.markSurfaceMounted()`；重建后桥接启动、存活并执行 `/compact`、`/plan off` 正常。需在 Paseo 执行 `paseo plugin reload paseo-dsh-pi` 生效。

## 2026-09-24 — pi-tui 0.4.8 需要 DSH 0.1.7-rc.1，Paseo daemon 需完整重启

- 现象：12:29 起 `@xmoon76/dsh-pi-tui` 升至 `0.4.8`（`dsh.bundle.patch` 改为数组），全局 mise 的 DSH 升至 `0.1.7-rc.1`（非本任务操作）；Paseo daemon 启动时固化的 `PATH` 仍指向 DSH `0.1.5-rc.2`，桥接在 `loadProfileDirectory` 报 `ERR_INVALID_ARG_TYPE` 退出，`paseo provider models dsh-pi` 失败。
- 实测：DSH `0.1.7-rc.1` 下直接驱动桥接，模型、命令列表、`/plan`、`/plan off`、权限切换及对应事件正常。
- 处置：用户从新 shell 执行 `paseo daemon stop && paseo daemon start`；之后 daemon 的 `PATH` 指向 `0.1.7-rc.1`，`paseo provider models dsh-pi` 返回 8 个模型。升级 DSH 后须完整重启 daemon，`daemon restart` 不刷新环境。

## 2026-09-24 — DSH 0.1.7-rc.1 与 pi-tui 0.4.8 桥接验收

- 环境：DSH `0.1.7-rc.1`、`@xmoon76/dsh-pi-tui` `0.4.8`、模型 `CPA-an/bm-an-glm`；临时脚本直接驱动桥接，不持久化会话，专用临时 cwd。
- 结果：追加 system prompt 生效；`workspace-write` 下 workspace 外 bash 写入收到 `approval` 请求，允许后文件写入、拒绝后未写入，两次回合均 `completed`；问答请求应答后模型复述所选项；文件附件内容被模型读取；预批准 stdio MCP 工具返回值被模型引用；停止后回合 `aborted`，下一条消息正常回复；关闭后恢复会话历史完整。另 `npm run smoke:bridge -- --prompt` 通过，`paseo provider models dsh-pi` 返回 8 个模型。
- 清理：删除 `$HOME/.cache/paseo-dsh-alpha-approval` 与临时 cwd；未改动用户 profile 与全局权限。

## 2026-09-26 — 上游三方升级：DSH 0.1.7-rc.2、pi-tui 0.4.9、Paseo 0.9.2

- 来源：npm registry 实时查询；pi-tui 0.4.9（09-25 发布）peer 要求 `@deepseek-ai/dsh-* >=0.1.7-rc.2`，DSH `next` tag 为 0.1.7-rc.2（09-24 发布），`@getpaseo/cli` latest 为 0.9.2（09-24 发布）。
- 操作：备份 mise 配置后 `mise use --global npm:@deepseek-ai/dsh@0.1.7-rc.2` 与 `npm:@getpaseo/cli@0.9.2`；`~/.dsh/profiles/pi-tui` 的 `@xmoon76/dsh-pi-tui` 由 0.4.8 改 0.4.9 并 pnpm install。
- 重启：daemon 完整 `stop` + `start` 后 worker PATH 确认指向 DSH 0.1.7-rc.2 与 CLI 0.9.2；`paseo provider models dsh-pi` 返回完整目录。
- 验证：新组合下直接驱动桥接抓取真实工具调用事件流，`tool/call`、`tool/result` 形状与 0.1.7-rc.1 一致（callId 在 `message.toolCallId` 与 `source.callId`，content 为纯 text block）。

## 2026-09-26 — 工具卡不收敛缺陷修复与线上验证

- 缺陷：用户报告 Paseo 界面工具"执行中"动效永不消失。抓包定位：`tool/result` 投影在 `message.content` 内查找 `tool-result` block，而 DSH 实际将 callId 放在 `message.toolCallId` / `source.callId`，导致结算事件被静默丢弃。仓内修复 `server/timeline.ts`（含 turn 中断时结算遗留 running 卡），31 个单测通过。
- 线上验证：插件 rebuild + reload 后，通过 `@getpaseo/client` 读取本机真实会话时间线：90 张工具卡中 84 completed / 3 failed；reload 生效后新增 28 张卡全部正常收敛，仅 1 张为查询当时正在执行的调用。两张遗留 running 卡的时间戳与两次被中断的 reload 回合吻合（中断路径预期表现，已被新结算逻辑覆盖）。
- 插件内自 reload 教训：本对话自身运行于 dsh-pi provider 上，从会话内执行 `paseo plugin reload` 会拆掉自身桥接导致 turn 被杀；重载应由会话外终端执行。两次中断 reload 遗留一个孤儿桥接进程（无会话锁、patch 指向已失效临时目录），核实身份后 SIGTERM 清理，本会话桥接进程不受影响。

## 2026-09-26 — 向上游 dsh-pi-tui 提交官方 co-author 身份请求（issue #185）

- 事件：本仓 commit a424601 携带 `Co-Authored-By: Claude` trailer，GitHub 据此把 Claude 列为 contributor；实际工具为 XMoon 的 dsh-pi-tui。GitHub co-author 头像只能由持有对应已验证邮箱的账号（个人或 App bot）渲染，组织不能验证邮箱，需上游发布官方身份。
- 操作：以 Jecvay 账号在 XMoon/dsh-pi-tui 提交 issue #185（英文），请求其注册官方账号并公布统一署名行；未要求实现方式。
- 后续：上游若公布官方 trailer，本仓新 commit 采用之；此前不加 co-author trailer。既有 a424601 是否改写历史待定。

## 2026-09-26 — GitHub 看板工单循环上线（Project + systemd 轮询）

- GitHub：用户级 Project #1「paseo-dsh-pi」建成并链接仓库；自定义单选字段「阶段」（待办/已评估/待开工/进行中/待审/受阻）与「优先级」（P0-P3）；内置 Status 字段不可改名/改选项，弃用（UI 可隐藏）。labels 建 kind/* 六类 + roadmap。issue 表单与 PR 模板入仓（.github/）。
- 路线行动项入板：14 张工单（#3-#16）从路线笔记建单入板，优先级自动推断。
- 本机 systemd：user 单元 `~/.config/systemd/user/paseo-dsh-pi-board.{service,timer}`（每 5 分钟 oneshot；PATH 用 mise shims 保证 dsh/npm 解析；SSH 推送无 agent 依赖已验证）。
- dsh headless 凭据：默认路由 deepseek-official 缺 DEEPSEEK_API_KEY；改用 `~/.config/paseo-dsh-pi/board-patch.yml`（模型 CPA-an/bm-an-glm、danger-full-access，含私有 baseURL，不进仓）+ 凭证存储 CPA_API_KEY，实测出话正常。
- 首轮自动评估实录（systemd service 驱动 dsh headless）：#3 获结构化归并评论（含 dump-config 实测证据），自动建父单 #17 聚合 #3-#6（P0 四道护栏）并挂 sub-issue，#3/#17 移入已评估。评估/实现状态与日志在 `~/.local/state/paseo-dsh-pi/`。
- 停用轮询：`systemctl --user stop paseo-dsh-pi-board.timer`；手动一轮：`npm run board:poll`。

## 2026-09-26 — 看板轮询降频为每天一次

- 用户反馈 5 分钟一拍过于激进：timer 改为 `OnCalendar=*-*-* 09:00:00`（每天 09:00，`Persistent=true` 错过补跑），`daemon-reload + restart` 生效，下次触发次日 09:00。
- 轮询器改为单轮清完：先逐张评估全部待办（单轮封顶 12 张），再做至多一件实现；仓内代码与文档同步（scripts/board-poll.ts、docs/board.md、SKILL.md、决策笔记）。

## 2026-09-28 — 本机建 paseo profile，插件去 pi-tui 依赖

- `dsh --profile paseo --from-default-profile web --dump-config` 建 `~/.dsh/profiles/paseo`（bundles：dsh-base + dsh-web-app）；把 `~/.dsh/profiles/pi-tui/cordis.patch.yml` 第 43 行到文件末（llm-deepseek、agent-default-model、llm-pi-ai 的 CPA-an/CPA-rs 八个模型、permission）原样放进 paseo 的 `cordis.patch.yml`，保留其头部注释，替换掉模板自带的空列表 `[]`。pi-tui profile 两个文件 sha256 前后一致，未改动。
- 实测：只禁 `web-startup` 时 DSH 因必需行 `webserver`、`connection` 未激活而拒绝启动；最终禁 `web-startup`、`webserver`、`web-runtime`、`connection` 四行，`npm run smoke:bridge -- --prompt` 通过，dsh 子进程无 TCP 监听、无浏览器进程。线上 Paseo daemon 未 reload，仍跑主工作树的旧代码。

## 2026-09-28 — PR #18 合并上线（插件改跑 paseo profile）

- 20:45 左右 rebase 合并 PR #18 进 main（CI 两轮 pass），主工作树 ff 到 3e7f0d0，`npm run build` 后 `paseo plugin reload paseo-dsh-pi`；reload 前 6 个 dsh-pi agent 均 idle。
- 线上验收：`paseo provider models dsh-pi` 列出 10 个模型（CPA-an/CPA-rs 各 4 + deepseek-official 2），dsh 子进程以 `--profile paseo` 运行；真实 agent（bm-an-glm-flash）bash 工具调用 `uname -r` 输出与本机一致，四个 preset 均出现在模式列表。本机 permission 为 danger-full-access，CLI 无法切权限 preset，审批弹窗未在线上复测（桥层已验证）。测试 agent 已删除。
- dsh 0.2.0-rc.1 当日发布但无法安装：`@deepseek-ai/dsh-web-app@0.2.0-rc.1` 依赖的 `@deepseek-ai/dsh-client-ui-settings-account@0.2.0-rc.1` 未发布（官方 registry 绕缓存查实，全树 252 包仅缺这一个），与本机 npm 源无关；未提上游 issue。

## 2026-09-28 — 仓库改名 paseo-dsh-direct

- 原因：插件已不接 pi-tui；同名 `paseo-deepseek-harness` 已被 geoqiao 的 ACP 插件占用（paseo.cafe 收录为 `deepseek-harness`），改用突出 Direct 接入的名字。
- GitHub：`gh repo rename` → Jecvay/paseo-dsh-direct（旧 URL 自动跳转），Project #1 标题同步改名。
- 本机：源码目录移到 `~/src/paseo-dsh-direct`，旧路径 `~/src/paseo-dsh-pi` 留软链接（已有 Paseo agent 的 cwd 仍可用）；看板 systemd 单元改名 `paseo-dsh-direct-board.{service,timer}`（systemd-analyze verify 通过，timer 下次 09-29 09:00），`~/.config/paseo-dsh-direct/`、`~/.local/state/paseo-dsh-direct/` 同步改名。
- Paseo：备份 `~/.paseo/config.json.bak-20260928-pre-rename-dsh-direct` 后 `paseo plugin remove paseo-dsh-pi` + `install ~/src/paseo-dsh-direct`；新插件 running，Provider id `dsh-pi` 不变，`paseo provider models dsh-pi` 10 个模型正常。

## 2026-09-28 — v0.1.1 上线即加载失败，v0.1.2 修复

- 合并 PR #19 并打 `v0.1.1` 后 `paseo plugin reload`，插件变 failed：`server/plugin-version.ts` 运行时 import `../package.json`，Paseo 插件加载器拒绝 client/server/shared 以外的模块。单测与 CI 都不经过 Paseo 加载器，没拦住。故障期间无运行中的 dsh-pi 会话。
- 处置：主工作树切修复分支（版本号改由 `npm run build` 生成 `server/generated-version.ts`）后 reload，插件恢复 running；真实会话（dsh 0.1.7-rc.2）正常回复且无版本警告。修复经 PR #20 合并，打 `v0.1.2`，主工作树回到 main 再 reload，running。
- 护栏：新增 `server/module-boundary.test.ts`，插件模块相对 import 出界即失败，已验证能拦住 0.1.1 的写法。`v0.1.1` tag 保留不挪，CHANGELOG 注明勿装。

## 2026-09-28 — 线上插件改为固定 tag 的独立 worktree

- 原因：主工作树要合并 dsh 0.2 适配（插件 0.2 线），而本机 dsh 仍是 0.1.7-rc.2，线上必须钉在 0.1 线的发布 tag 上，不能再跟主工作树的 HEAD 走。
- 操作：新建 `~/src/paseo-dsh-direct-live`，是本仓的独立 git worktree，detached 在发布 tag `v0.1.2`；里面 `npm ci --include=dev` + `npm run build` 后，备份 `~/.paseo/config.json.bak-20260928-pre-live-worktree`，`paseo plugin remove paseo-dsh-direct` 再 `paseo plugin install /home/jecvay/src/paseo-dsh-direct-live`。结果：插件 running，`paseo provider models dsh-pi` 10 个模型正常。
- 以后上线新版本：在 `~/src/paseo-dsh-direct-live` checkout 新 tag → `npm ci --include=dev` → `npm run build` → `paseo plugin reload paseo-dsh-direct`。

## 2026-09-28 — dsh 0.2.0-rc.1 适配实测（插件 0.2.0，未上线）

- 安装：dsh 0.2.0-rc.1 装在 `~/.local/opt/dsh-0.2.0-rc.1/`（独立 package.json，`overrides` 把漏发的 `@deepseek-ai/dsh-client-ui-settings-account` 顶成 0.1.7-rc.2），`npm install` 546 包，`dsh --version` 输出 `0.2.0-rc.1`。未改 mise 全局、未 `npm -g`。
- 隔离：所有 0.2 实验带 `DSH_HOME=~/.local/share/dsh-0.2-test`；该目录下用插件同款命令建 `paseo` profile，用户层 `cordis.patch.yml` 从 `~/.dsh/profiles/paseo` 复制，凭证复制为 0600。开工前后 `~/.dsh/profiles/{pi-tui,paseo}/cordis.patch.yml` sha256 不变，`~/.dsh/sessions` 下没有测试期间新建的文件。
- 组合树：0.2 与 0.1.7-rc.2 的 web 模板 dump 相比，只多了 `otel`、`desktop-product-telemetry`、`product-analytics`、`ui-settings-session-log`，少了 `time-context`、`schedule`、`ui-schedule`（后三行在 0.1 里本就禁用）；禁用的浏览器行和四个 preset 行 id 不变。
- 实测（真实 provider 路径，模型 CPA-an/bm-an-glm）：`npm run smoke:bridge -- --prompt` 通过，DSH 子进程无 TCP 监听、无浏览器进程；含 bash 工具调用的回合完成且无版本警告；用 0.1.7-rc.2 可执行文件开会话出现版本警告、回合照常完成；审批允许/拒绝、问答应答/拒答、斜杠目录含 `/compact` `/plan`、会话恢复均通过。
- 发现：`paseo` profile 下审批和问答请求被 web 模板的 `api-remotes` 行截走，回合一直等待，0.1.7-rc.2 同样复现，线上 `v0.1.2` 带着这个问题。0.2.0 在禁用清单里加了 `api-remotes`，复盘见 `.agents/notes/implemented/bug-fix/2026-09-28-postmortem-api-remotes-swallows-approvals.md`。
- 线上 Paseo 插件未 reload，仍是 `~/src/paseo-dsh-direct-live` 的 `v0.1.2`。
