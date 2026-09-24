# 兼容性与版本管理

## Alpha 运行组合

| 组件 | 本机验证版本 | 用途 |
|---|---|---|
| Paseo | `0.8.0` | 插件宿主与 Direct Provider 协议 |
| DeepSeek Harness | `0.1.7-rc.1` | 原生 agent、会话持久化与交互服务 |
| `@xmoon76/dsh-pi-tui` | `0.4.8` | 复用的 profile 组合与扩展注册 |
| Node.js | `24.13.0` | 插件与 DSH 运行环境 |

本组合已验证真实 profile 启动、模型/preset/权限目录、真实模型与工具调用、思考输出、工具审批允许/拒绝、问答应答/拒绝、原生历史导入、停止后继续对话、Daemon 重启恢复及正常关闭。手工运行证据见 [仓外事件](../.agents/ops-log.md)。手机真机界面尚未实测；官方移动客户端使用的 Daemon 接口已验证。

Paseo `0.9.1` 另已通过本机启动、插件加载、模型目录和真实文字对话检查，用户已确认手机收到测试回复；完整交互验证基线仍为上表组合。

DSH 与 pi-tui 版本在桥接层直接验证：上表 DSH 与 pi-tui 版本已通过真实模型下的系统提示词追加、工具审批允许/拒绝、问答、文件附件、stdio MCP 工具、斜杠命令与技能、`/compact`、`/plan`、权限切换、停止后继续对话与会话恢复。pi-tui `0.4.8` 要求 DSH `>=0.1.7-rc.1`。Paseo daemon 的 `PATH` 在启动时固定，升级 DSH 后须 `paseo daemon stop` 再 `paseo daemon start`；`paseo daemon restart` 不刷新环境。

DSH 与 pi-tui 保持用户原有安装。插件安装不自动升级或替换它们；不要以重新安装独立 SDK profile 代替对既有 profile 的接入。

## 宿主契约

[paseo-plugin.json](../paseo-plugin.json) 声明 `requirements.paseo: ">=0.8.0"`，开发类型依赖固定为 `@getpaseo/plugin@0.8.0`。最低版本声明是加载条件，不代表所有更高宿主版本均经过测试。

插件注册 `dsh-pi`，不会覆盖名为 `dsh` 的既有自定义 Provider。

## DSH 契约

插件握手使用自己的 `protocolVersion: 1`。DSH 的内部服务契约由当前验证版本确定；缺少所需服务或方法、无法加载 profile、会话被占用时，操作应报告错误。

模型、provider 路由和 preset id 从实际 profile 查询，不把示例名称写死为所有用户通用的模型列表。复用 DSH 的凭证存储和配置；环境变量由宿主传入，不复制进插件源码。

TUI 界面扩展不会自动变成 Paseo 界面，具体范围见 [客户端呈现](client-architecture.md)。

## Alpha 功能边界

支持文字、图片与文件输入，正文/思考流、工具卡片、审批与用户问答、模型/preset/思考/权限/计划模式选择、中断、压缩卡片和原生历史恢复。既有 profile 中的运行时扩展继续加载。

图片与上传文件存入 DSH 附件库后随消息发送；当前模型声明不接受图片时，提示词明确报错。PR、issue、代码评审等 Paseo 上下文附件以文字发送。归档由 Paseo 管理，不改动 DSH 原生会话。

Paseo 为会话提供的 system prompt 追加到该 agent 的 DSH system prompt；MCP server（stdio 与 streamable HTTP）挂载到该会话的 DSH 进程，工具名为 `mcp__<server>__<tool>`；tool policy 预先批准的 MCP 工具不再弹出审批。SSE 类型的 MCP server 明确报错。不持久化的会话写入该会话进程的临时目录，关闭时删除，不进入 DSH 历史。达到输出上限、被插件拦截或因进程中止未完成的回合显示警告。

当前不支持会话回退与 Paseo 的 provider options。DSH profile 本身已有的配置仍由 DSH 管理。Paseo 的 `/` 目录列出 DSH 已注册命令（如 `/compact`、`/goal`、`/plan`）和用户可调用的技能；pi-tui 终端界面自带的命令（如 `/model`、`/sessions`）不在其中。Paseo 会话标题与 DSH 标题仅在新建时同步，后续 Paseo 改名不会写回原生历史。会话回退与改名受 Paseo 插件宿主限制，理由见 [回退与改名同步决策](../.agents/notes/rejected/feature/2026-09-24-paseo-rewind-and-rename-sync.md)。

## 安装、更新与发行

从 Git 安装时，Paseo 负责根据 manifest 执行构建；本地目录安装需要预先完成构建。插件构建生成并嵌入 DSH 桥接，Git checkout 不需要包含机器特定的预编译路径。

本地源码安装及重载见 [开发与验证](plugin-guide.md)。Git 安装可指定已存在的 tag 或 commit：

```bash
paseo plugin add Jecvay/paseo-dsh-pi --ref <tag-or-commit>
paseo plugin update paseo-dsh-pi
```

发行前执行 [Alpha 验收规范](alpha-acceptance.md)，记录实际验证的版本和能力。版本号采用 prerelease 形式，如 `0.1.0-alpha.1`；依赖探活、单元测试或文档门禁不能替代真实对话验证。
