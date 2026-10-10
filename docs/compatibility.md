# 兼容性与版本管理

## 版本号规则

插件版本号 `major.minor.patch` 的 `major.minor` 跟随 DSH：插件 `0.1.x` 线支持 DSH `0.1.*`，插件 `0.2.x` 线支持 DSH `0.2.*`。最后一位 `patch` 是插件自己的发布计数，不跟 DSH 走。DSH 的预发布后缀（`-rc.N`、`-alpha.N`）不参与匹配，只看 `major.minor`：DSH `0.1.7-rc.2` 属于 `0.1` 线。插件自身的版本号只在 `package.json` 里维护一份，不另设常量。每次发布打 git tag `vX.Y.Z`（如 `v0.1.1`）。

插件启动时对实际使用的 DSH 可执行文件跑一次 `--version`（结果按可执行文件路径缓存，同一进程内不重复探测），与插件自身版本线比对：

- **一致**：无提示。
- **不一致**（DSH 的 `major.minor` 线与插件不同）或**未确认**（探测超时、DSH 进程非 0 退出、或输出解析不出版本号）：插件照常启动和使用，只在 Paseo 时间线里显示一条警告，同时写一行到 stderr 日志。插件从不因为版本线不符拒绝启动——能否真正工作由 DSH 握手和运行时接口决定，见下方「DSH 契约」。

## npm 发布与 dist-tag

插件以包名 `paseo-dsh-direct`（无 scope）发布到 npm。当前最新 dsh 线（`main` 分支）发布为 `latest`；更早的 dsh 线（如 `release/0.1`）发布时带 `--tag dsh-<major.minor>`（如 `dsh-0.1`），装法是 `npm:paseo-dsh-direct@dsh-<major.minor>`。发布流程见 [AGENTS.md](../AGENTS.md)「发布到 npm」。

Paseo Settings 里的 Install Plugin 输入框没有 Git ref 字段，粘贴 Git 地址总是装 `main` 分支（当前 dsh 线）；要装旧线的 Git tag，须用命令行 `paseo plugin install <url> --ref <tag>`。npm 来源不受这个限制——dist-tag 直接写在 `npm:<package>@<tag>` 里，Settings 输入框和命令行都能用。

## Alpha 运行组合

| 插件版本线 | 已实测的 DSH 版本 | 获取方式 |
|---|---|---|
| `0.2.x` | `0.2.0-rc.1`（安装方式见下） | `npm:paseo-dsh-direct`，或 Git `main` |
| `0.1.x` | `0.1.7-rc.2` | `npm:paseo-dsh-direct@dsh-0.1`，或 Git 分支 `release/0.1` |

本机同时验证 Paseo `0.9.2`、Node.js `24.13.0`。手工运行证据见 [仓外事件](../.agents/ops-log.md)。手机真机界面尚未实测；官方移动客户端使用的 Daemon 接口已验证。

**0.2 线**：在 DSH `0.2.0-rc.1` 下，用插件真实的 provider 路径（`createDshProvider` + `launchDshBridge`，不经 Paseo Daemon）和真实模型验证了：自动创建 `paseo` profile、模型/preset/权限目录、含 bash 工具调用的真实回合、工具审批允许/拒绝、问答应答/拒绝、斜杠目录含 `/compact` 与 `/plan`、关闭后按持久化句柄恢复会话并继续对话；`npm run smoke:bridge -- --prompt` 通过，DSH 子进程不监听 TCP 端口、不开浏览器。图片与文件附件、MCP、中断、Paseo Daemon 内加载与重启恢复在 0.2 线尚未复测。

DSH `0.2.0-rc.1` 用 `npm install @deepseek-ai/dsh@0.2.0-rc.1` 即可正常安装。

mise 2026.9.8 的 npm 后端装 `@deepseek-ai/dsh@0.2.0-rc.1` 会报 peer 依赖解析不收敛（`aube install failed: ... peer-context fixed-point did not converge`）；改用 npm 装即可，全局 `npm install -g @deepseek-ai/dsh@0.2.0-rc.1`，或装到独立目录后用 `PASEO_DSH_EXECUTABLE` 指过去。

**0.1 线**：`v0.1.2` 在 DSH `0.1.7-rc.2` 下验证了自动创建 `paseo` profile、模型/preset/权限目录、真实模型与工具调用、思考输出、原生历史导入、停止后继续对话、Daemon 重启恢复及正常关闭；桥接层用真实模型还验证过 system prompt 追加、文件附件、stdio MCP 工具、斜杠命令与技能、`/compact`、`/plan`、权限切换。0.1 线从 `v0.1.3` 起修复了工具审批和问答请求被 web 模板的 `api-remotes` 行转给浏览器端、送不到 Paseo、回合一直等待的问题：`v0.1.1` 加载失败不可安装，`v0.1.2` 有这个问题，`v0.1.3` 在 DSH `0.1.7-rc.2` 下实测审批允许/拒绝、问答应答/拒答四项通过。权限预设为 `danger-full-access`（不发起审批）、模型也不调用提问工具时，旧版本不受这个问题影响。

Paseo `0.9.2` 为当前验证基线：本机启动、插件加载、模型目录、真实文字对话与真实工具调用（工具卡完整收敛）均已验证。早期 `0.8.0` / `0.9.1` 组合的历史验证结论不因此失效。Paseo daemon 的 `PATH` 在启动时固定，升级 DSH 后须 `paseo daemon stop` 再 `paseo daemon start`；`paseo daemon restart` 不刷新环境。

DSH 保持用户原有安装，插件不自动升级或替换它。插件只需要 DSH 本身，默认 profile 由 DSH 官方 `web` 模板生成，不依赖第三方 DSH 扩展包。

## 宿主契约

[paseo-plugin.json](../paseo-plugin.json) 声明 `requirements.paseo: ">=0.11.0"`，开发类型依赖固定为 `@getpaseo/plugin@0.11.2`，可选 peer 依赖 `@getpaseo/client`、`@getpaseo/protocol` 同为 `0.11.2`。最低版本声明是加载条件，不代表所有更高宿主版本均经过测试。清单带 `name` 与 `icon`（均要求 Paseo 0.11.0 及以上）；Paseo 0.8 至 0.10 的用户安装 `npm:paseo-dsh-direct@0.2.1`。

Provider 注册了 `status()`：Paseo 0.11 及以上列出 Provider 时，用 `PASEO_DSH_EXECUTABLE`（未设置则取 `PATH` 里的 `dsh`）运行 `--version`（结果按可执行路径缓存）。`dsh` 无法运行时报告不可用并给出原因；`major.minor` 线与插件不一致时仍报告可用，附带与会话时间线相同的版本线警告。插件自己启动 `dsh`，所以不注册 `command`。`paseo-plugin.json` 的 `name` 为 `DeepSeek Harness`，`icon` 指向仓库根的 256x256 透明底 PNG `dsh.png`（由 `dsh.svg` 渲染）。

插件注册 `dsh-pi`，不会覆盖名为 `dsh` 的既有自定义 Provider。

## DSH 契约

插件握手使用自己的 `protocolVersion: 1`。DSH 的内部服务契约由当前验证版本确定；缺少所需服务或方法、无法加载 profile、会话被占用时，操作应报告错误。

模型、provider 路由和 preset id 从实际 profile 查询，不把示例名称写死为所有用户通用的模型列表。复用 DSH 的凭证存储和配置；环境变量由宿主传入，不复制进插件源码。

DSH 的界面扩展不会自动变成 Paseo 界面，具体范围见 [客户端呈现](client-architecture.md)。

## Alpha 功能边界

支持文字、图片与文件输入，正文/思考流、工具卡片、审批与用户问答、模型/preset/思考/权限/计划模式选择、中断、压缩卡片和原生历史恢复。profile 中的运行时扩展照常加载，只有服务浏览器界面的几行在启动时禁用（清单见 [服务端架构](server-architecture.md)）。

图片与上传文件存入 DSH 附件库后随消息发送；当前模型声明不接受图片时，提示词明确报错。PR、issue、代码评审等 Paseo 上下文附件以文字发送。归档由 Paseo 管理，不改动 DSH 原生会话。

Paseo 为会话提供的 system prompt 追加到该 agent 的 DSH system prompt；MCP server（stdio 与 streamable HTTP）挂载到该会话的 DSH 进程，工具名为 `mcp__<server>__<tool>`；tool policy 预先批准的 MCP 工具不再弹出审批。SSE 类型的 MCP server 明确报错。不持久化的会话写入该会话进程的临时目录，关闭时删除，不进入 DSH 历史。达到输出上限、被插件拦截或因进程中止未完成的回合显示警告。

当前不支持会话回退与 Paseo 的 provider options。DSH profile 本身已有的配置仍由 DSH 管理。Paseo 的 `/` 目录列出 DSH 已注册命令（如 `/compact`、`/goal`、`/plan`）和用户可调用的技能；只属于终端界面的命令（如 `/model`、`/sessions`）不在其中。Paseo 会话标题与 DSH 标题仅在新建时同步，后续 Paseo 改名不会写回原生历史。会话回退与改名受 Paseo 插件宿主限制，理由见 [回退与改名同步决策](../.agents/notes/rejected/feature/2026-09-24-paseo-rewind-and-rename-sync.md)。

## 安装、更新与发行

从 Git 或 npm 安装时，Paseo 负责根据 [paseo-plugin.json](../paseo-plugin.json) 的 `build` 命令执行构建；本地目录安装需要预先完成构建。插件构建生成并嵌入 DSH 桥接，Git checkout 或 npm 包本身都不需要包含机器特定的预编译路径。

manifest 的构建命令是 `npm install --include=dev`，不是 `npm ci`：npm 发布时无论 `files` 字段怎么写都会剔除 `package-lock.json`（这是 npm 打包的硬规则，`.npmignore` 负负得正的写法也绕不过去），npm 安装来源拿到的目录里没有锁文件，`npm ci` 会直接报错退出；Git 安装的 checkout 里锁文件还在，`npm install` 对它同样有效，所以两种来源共用同一条构建命令。

本地源码安装及重载见 [开发与验证](plugin-guide.md)。Git 来源写 `github:owner/repository` 或完整 Git 地址；Paseo 0.11 起不带前缀的 `owner/slug` 指向插件注册表，不能用来装本插件。Git 或 npm 安装可指定已存在的 tag、commit 或 dist-tag：

```bash
paseo plugin install github:Jecvay/paseo-dsh-direct --ref <tag-or-commit>
paseo plugin install npm:paseo-dsh-direct@<version-or-tag>
paseo plugin update paseo-dsh-direct
```

发行前执行 [Alpha 验收规范](alpha-acceptance.md)，记录实际验证的版本和能力。版本号规则见上文「版本号规则」一节；依赖探活、单元测试或文档门禁不能替代真实对话验证。
