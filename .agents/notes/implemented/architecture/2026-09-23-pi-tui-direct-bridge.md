# 决策记录: 复用 pi-tui profile 的 Direct Provider 桥接

Status: implemented

## 问题

首版必须复用已有 `pi-tui` profile、配置、扩展注册与历史会话。DSH `0.1.5-rc.2` 标准 SDK 的请求只有初始化、提示词入队和整个运行时关闭，缺少审批回复、用户问答与逐会话取消。持久事件通知也不能替代实时 assistant stream。仅在 Paseo 侧实现 Direct Provider 不足以完整连接这些能力。

本机已有名为 `dsh` 的自定义 Provider；Paseo 不允许插件注册与已配置 Provider 相同的标识。

## 决定

1. 保持 Paseo Direct Provider，插件 id 为 `paseo-dsh-pi`，Provider id 为 `dsh-pi`，与已有 Provider 并存。
2. 插件携带独立编译的 DSH Cordis bridge。用本次启动的 `--patch` 将 bridge 注入既有 `pi-tui` profile，禁用 `tui-app`；会话级的 MCP server 与不持久化会话的存储根目录也经同一 patch 设置。保留 `tui-startup`、扩展宿主和内建扩展注册。不修改用户持久配置。
3. bridge 通过官方 `ctx` 服务访问模型、presets、持久会话查询、agent 恢复、实时流、审批与用户问答。DSH 原生持久化和写租约拥有数据一致性，插件不直接重写 session 文件。
4. Paseo 子进程与 DSH bridge 使用 JSONL JSON-RPC 2.0，握手携带 `protocolVersion: 1`。协议包含 catalog、历史读取、open/prompt/cancel/close、交互回复和 shutdown；持久事件与实时 stream 使用独立通知。
5. bridge 源码位于 `server/dsh/`，构建资源位于 `dist/`；构建同时将 bridge 作为字符串嵌入服务端生成模块，运行时写入专用临时目录。Paseo 的服务端 bundle 通过求值加载，SDK 不暴露插件资源目录，因此不依赖 `cwd` 或 `import.meta.url` 寻找资源。桥接从已安装的 DSH 解析官方模型选择 helper，避免复制其 scoped listener 语义；Paseo 侧不导入 DSH 运行时包，也不另外安装 DSH npm 依赖。TypeScript 和 esbuild 作为开发/构建依赖。
6. 通过 Paseo 原生历史导入、持久化 token、timeline、权限和问答接口呈现能力。不把 TUI 专属菜单、快捷键或终端绘制扩展描述为 Paseo UI 功能。

本决定补充 [TypeScript 选型](2026-09-16-adopt-typescript-as-core-language.md) 的运行时接入机制；版本验证规则以 [兼容性决策](2026-09-15-versioning-and-compatibility-strategy.md) 为基础，实测范围以兼容性文档为准。

## 考虑过的其他做法

- 仅使用 DSH 标准 SDK：接口少、易接入；无法完成用户要求的审批和逐会话中断，且不能直接代表 pi-tui 的 preset/profile 语义。
- 新建独立 SDK profile：启动隔离简单；不满足复用现有 pi-tui 配置与历史的硬约束。
- 解析 TUI 屏幕或模拟键盘输入：无需了解内部服务；缺少稳定消息标识和结构化交互，无法保证恢复、审批与跨端呈现。
- 修改 Paseo 或 DSH 核心：可扩展接口；需要维护上游补丁，不符合外部插件的项目边界。
- 替换本机已有 `dsh` Provider：标识较短；会影响已有 Paseo 会话和配置，alpha 无此必要。

## 后果

- 模型目录和历史发现使用独立 bridge，每个活动 Paseo 会话使用独立 DSH 子进程，以便将宿主的会话环境变量在运行时启动前传入。代价是每个会话占用一个运行时。
- 原生恢复保留历史中的模型、preset、思考与权限配置。Paseo 补齐的目录默认值不构成覆盖历史的用户意图，恢复后通过明确的配置操作修改。
- DSH 内部服务处于预发布阶段；结构类型只能减少构建耦合，不能保证未经测试版本兼容。握手、必要服务检查、请求超时和进程退出清理负责显式报告失败。
- TUI 界面能力不自动映射；alpha 的文字、工具和交互通过 Paseo 原生组件呈现。功能边界记录在 [兼容性说明](../../../../docs/compatibility.md)。

## 怎么验证的

- 协议和 Provider 测试覆盖流式身份、请求失败、会话环境、恢复配置、审批/问答与退出清理；分层类型检查和文档门禁验证构建边界。
- 本机 Paseo 完成安装、真实模型对话、工具调用、停止后继续对话、官方历史入口导入并保留原生会话标识。
- 真实 profile 探活、权限配置与部署证据见 [仓外事件](../../../ops-log.md)。测试和实际验证范围以 [Alpha 验收规范](../../../../docs/alpha-acceptance.md) 和 [兼容性说明](../../../../docs/compatibility.md) 为准。
