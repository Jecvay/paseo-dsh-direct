# 服务端架构

`paseo-dsh-direct` 注册 Paseo Direct Provider `dsh-pi`，显示为 `DeepSeek Harness`。插件标识为 `paseo-dsh-direct`。服务端入口是 `index.server.ts`；实现位于 `server/`，跨进程契约位于 `shared/`。

## 运行边界

运行链路为 Paseo Daemon → 插件服务端 → DSH 子进程 → `paseo` profile。插件不修改 Paseo 或 DSH 核心。

`paseo` profile 由 DSH 官方 `web` 模板生成：bundle 为 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`，后者自带 `standard`、`ptc`、`minimal`、`cordis` 四个 agent preset。启动前 `server/bridge-client.ts` 检查 `$DSH_HOME/profiles/<profile>`（`$DSH_HOME` 为空或未设置时是 `~/.dsh`，解析方式与 DSH 相同）。目录缺失且 profile 是默认的 `paseo` 时，执行一次 `dsh --profile paseo --from-default-profile web --dump-config` 创建它（60 秒超时，输出丢弃）；`PASEO_DSH_PROFILE` 指定的 profile 缺失时直接报错并给出创建命令。模型路由、默认模型和权限预设属于用户层 `cordis.patch.yml`，插件不写它。

DSH 桥接以 Cordis 插件形式运行在 DSH 内部。启动时生成临时 patch，先禁用 web 模板里服务浏览器界面的五行，再加载桥接；会话的 MCP server 以 `@deepseek-ai/dsh-mcp-client` 条目插入同一 patch；不持久化的会话把 `session-persistence-jsonl` 的 `root` 覆盖到该进程的临时目录，关闭桥接时随目录删除。用户持久 profile 文件保持原样。

| 禁用的行 | 原本作用 | 为什么一并禁用 |
|---|---|---|
| `web-startup` | 解析 web 启动参数，提供 `webStartup` 服务 | 桥接就是这个 profile 的界面，不需要网页 |
| `webserver` | 绑定 HTTP 端口（默认 3080） | 启动审计把它列为必需行，缺 `webStartup` 会让 DSH 启动失败 |
| `web-runtime` | 托管前端、打印 URL、按配置打开浏览器 | 依赖前两行 |
| `connection` | 把网关挂到 webserver 的 `/api` | 启动审计把它列为必需行，缺 `webRuntime` 会让 DSH 启动失败 |
| `api-remotes` | 把工具审批（`approval/request`）和问答（`user-questions/request`）等宿主事件经网关转给浏览器端 | 它排在桥接前面接下审批和问答；没有浏览器连着时请求一直等待，桥接收不到 |

DSH 的启动审计忽略被禁用的必需行，所以禁用这五行后 DSH 正常启动，不监听任何 TCP 端口，也不打开浏览器。依赖它们的浏览器端插件行（如 `file-upload`、`client-hmr`、`open-in-app`）停在等待状态，DSH 在 stderr 打一条「entries did not activate」提示，不影响桥接。preset 行和会话、工具相关的行不受影响。`appReady` 与 `appExit` 由 DSH 启动器提供，桥接在 `appReady` 之后开始读 stdin。浏览器端界面插件不等同于 Paseo 前端功能。

模型目录和历史发现使用独立桥接；每个活动 Paseo 会话拥有自己的 DSH 子进程，接收宿主提供的会话环境变量。关闭会话时释放对应子进程。

智能体执行循环属于 DSH。profile 的扩展注册照常运行，DSH 自带的浏览器界面不在本链路中执行。

桥接通过官方 DSH 服务访问会话、agent、presets、模型、实时输出与交互请求。它不直接改写持久会话文件，也不在 Paseo 进程中加载另一套 DSH 运行时。

## Provider 可用性

Provider 注册 `command: ["dsh"]` 与 `status()`（Paseo 0.11 及以上调用）。

### dsh 的选择

Paseo 在 `status` 与 `connect` 请求里带 `launch`（`command`、`args`、`env`）：`command` 是 Daemon 解析后的可执行路径，默认值来自注册的 `command`，可被 Paseo 配置 `agents.providers.dsh-pi.command` 与 `env` 覆盖；`env` 是 Daemon 持有的完整环境（含覆盖项，已去掉父会话变量）。旧版 Daemon 或独立调用不带 `launch`。

`resolveDshLaunch` 按以下顺序选可执行文件：

1. 非空的 `PASEO_DSH_EXECUTABLE`：显式环境变量是最具体的信号，已有安装继续生效；此时 `launch.args` 属于被覆盖的命令，不使用。
2. `launch.command`，`launch.args` 排在 dsh 自己的参数（`--profile` 等）之前。
3. `PATH` 里的 `dsh`。

桥接子进程的环境以 `launch.env` 为底（没有 `launch` 时用 `process.env`），再叠加会话环境变量。`status()` 对同一请求的 `launch` 套用同一顺序，对解析出的命令加参数运行 `--version`，结果按命令与参数缓存，探测使用 `launch.env`。无法运行时返回不可用，并提示安装 dsh、设置 `agents.providers.dsh-pi.command` 或 `PASEO_DSH_EXECUTABLE`，然后重启 Daemon；`major.minor` 线与插件不一致时返回可用并附与会话时间线相同的警告。

### 漂移防护

DSH 内部契约随版本变化。桥接启动有两道检查，任一失败都使连接失败并写明原因：

- **profile 行检查**：profile 就绪后运行 `dsh --profile <profile> --dump-config`，断言禁用清单里的每一行（`web-startup`、`webserver`、`web-runtime`、`connection`、`api-remotes`）都在输出中；缺行时报错，点名缺失的行与 dsh 版本。禁用不存在的行不会报错，改名后的行会让浏览器界面与桥接并存，所以必须先断言。dump 失败或无输出时没有证据，检查放行，由真正的启动报告错误。
- **握手检查**：`bridge.initialize` 的 `missing` 列出桥接依赖而 DSH 未提供的服务与方法（`agents.get/create/resume`、`sessionQuery.listSessions/readSession/observeSession`、`agentPresets.list/resolve/mount/select`、`llm.listProviders/listModels`），插件据此拒绝连接并列出缺项和 dsh 版本。字段缺省表示没有缺项，`protocolVersion` 保持 1。

其他行是否也监听 `approval/request` 与 `user-questions/request`，无法从配置输出静态判断，Cordis 也不提供监听者枚举，因此不检查；真实 dsh 的审批与问答往返由 `server/e2e-interaction.test.ts` 覆盖（需要 `DEEPSEEK_API_KEY` 与可运行的 `dsh`，否则跳过）。

## 桥接资源

`server/dsh/bridge.ts` 构建为 `dist/dsh-bridge.mjs`，同时生成嵌入服务端 bundle 的源码字符串。启动器把该资源写入专用临时目录，再通过绝对路径加载。资源定位不依赖 Paseo Daemon 的工作目录。

构建依赖由 `package-lock.json` 固定。桥接使用 Node 内置模块、DSH 已加载的服务，以及从实际 DSH 安装中解析的官方模型选择 helper；不额外安装另一份 DSH 运行时。

## 协议

stdio 使用按换行分帧的 JSON-RPC 2.0。stdout 仅承载协议，诊断写入 stderr。握手检查插件自己的 `protocolVersion`；该版本与 DSH 包版本相互独立。

| 请求 | 用途 |
|---|---|
| `bridge.initialize` | 确认桥接版本与能力，读取模型和 preset 目录 |
| `session.list` | 查询原生持久会话摘要 |
| `session.read` | 只读读取原生历史 |
| `session.open` | 创建会话或通过 DSH 官方恢复接口接管会话 |
| `session.prompt` | 将用户输入（文字、图片、文件）交给对应 agent |
| `session.steer` | 向活动回合补充引导输入 |
| `session.configure` | 修改当前会话的模型、preset、思考与权限选择 |
| `session.rename` | 设置原生会话标题 |
| `session.commands` | 列出会话可用的 DSH 命令与用户可调用技能 |
| `session.command` | 通过 DSH 命令服务执行一条已注册命令 |
| `session.cancel` | 取消当前工作 |
| `session.close` | 释放会话和写租约 |
| `interaction.respond` | 回复审批或用户问答 |
| `bridge.shutdown` | 清理运行时并结束桥接 |

持久事件、实时 assistant stream、agent 状态和交互请求使用不同通知。持久事件负责重放和最终事实；实时流负责逐步显示正文、思考和工具参数，不能以历史日志通知替代。

## Paseo 呈现契约

- 模型和 preset 目录通过 Paseo `catalog` 提供；已提交的选择通过 `session.config` 回传。
- 用户消息与 `session.prompt_result` 回填同一个 `clientMessageId`，以合并客户端乐观输入。
- 提示词内容按原顺序传给桥接：图片以 base64 经 `attachments.saveImage` 存为 DSH 图片块，上传文件由桥接按本机路径读取、经 `attachments.saveFile` 存为文件块；PR、issue、代码评审等上下文附件按 Paseo 的文字格式展开。当前模型的 `inputModalities` 不含图片时拒绝图片提示词。用户气泡以 `[image]`、`[file: 名称]` 标记附件。
- 回放历史时，`turn/end` 的失败原因显示为错误条目；`max-tokens`、`blocked`、`interrupted` 结束的回合在直播与回放中都显示为警告通知。
- `compaction/start` 与 `compaction/end` 显示为同一张压缩卡片（进行中 → 完成），`compaction/summary` 提供被压缩的 token 数；由命令发起的压缩标记为手动，失败另显示错误通知。
- Paseo 的 system prompt 在 agent `setup` 中以 agent 作用域的 `systemPrompt.section`（order 10100）追加；tool policy 预先批准的 `mcp__<server>__<tool>` 在桥接的审批钩子中直接允许，其他工具照常询问。
- 计划模式以设置开关呈现（会话存在 `/plan` 命令时）：开关执行 DSH `/plan` 或 `/plan off`，开关状态跟随 `plan/mode` 事件，包括计划被批准后 DSH 自行退出。
- 同一条助手消息和思考使用稳定 item id，向 Paseo 发送累计快照，由宿主切出网络增量。
- 工具状态映射为原生工具卡片，审批和用户问答通过原生交互事件传递。
- 只将真实用户来源的消息显示为用户气泡，运行时注入的上下文和技能目录不冒充用户输入。
- 每个已开始的回合有且仅有一个完成、失败或取消终态。失败终态携带 DSH `turn/end` 记录的 LLM 失败信息（消息、错误码、HTTP 状态与 request id）。
- 非 Paseo 发起的 DSH 回合（如 `/goal` 续跑、DSH 在同一运行期内连续消化的排队输入）以 `turn/start` 为起点上报为自主回合，由 `turn/end` 或 agent 转入空闲结束。
- DSH `permission/preset` 事件（`/permission` 或其他来源）同步更新 Paseo 的权限设置。
- 斜杠目录通过 `session.commands` 提供，会话打开、回合结束和命令执行后刷新；同名时已注册命令优先于技能。已注册命令经 `session.command` 执行；命令返回时 agent 仍在运行（如 `/plan <消息>`），该命令即作为本次输入的回合上报，否则按不产生回合的命令完成。其 `command/run` 显示为用户输入，`command/done` 的结果文本显示为通知。技能调用作为以 `/<技能名>` 开头的普通用户消息发送，由 DSH 注入技能正文。

## 历史与一致性

Paseo 的 Import session 入口查询 DSH 原生历史。Provider 持久化数据保存原生 DSH session id；恢复沿用同一身份与存储。

历史查询使用官方只读接口，写入通过 agent 的恢复与生命周期接口。DSH 写租约负责排除同时写入：被另一个 TUI 或进程占用的会话不能强行接管。

权限选项来自官方 permission preset 目录。会话级切换沿用 DSH `/permission` 命令，写入原生会话事件，不修改全局默认值。`danger-full-access` 的 `never` 审批策略表示不发起审批，并非自动允许所有需要额外授权的操作。

## 关闭与错误

请求超时、协议失败和进程退出须结束挂起请求。关闭时先请求桥接释放 agent、等待持久化清理；无法正常退出的子进程采用有界终止。活动回合、工具和交互不能在进程退出后保留永久运行状态。

架构理由见 `.agents/notes/implemented/` 下的桥接与 profile 决策记录，行为验收见 [Alpha 验收规范](alpha-acceptance.md)。
