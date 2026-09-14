# 服务端架构

本文档描述 `paseo-dsh-pi` 在 Paseo Daemon 端的服务端适配器架构与通信机制。

## 概述

服务端逻辑运行于 Paseo Daemon 调度的隔离 Node.js 子进程中，入口为 `index.server.ts`。通过引入 `@getpaseo/plugin/server`，插件向 Paseo 注册 Direct Provider 实现。

## Provider 注册与契约

插件导出的 `ProviderRegistration` 遵循以下基础契约：

- **标识符（`id`）**：`dsh`
- **显示名称（`label`）**：`DeepSeek Harness`
- **图标（`icon`）**：`dsh.svg`
- **能力协商（`capabilities`）**：支持 `prompt.message`、流式增量推送与会话配置

## 进程与协议层

服务端与本地 DSH 实例建立基于 stdio 的双向通信管道：

1. **会话生命周期**：响应 `session.open` 请求，以指定的模型、预设模式和环境变量启动 DSH 会话，发布 `session.opened`、`session.config` 与 `session.ready`。
2. **提示词交互**：接收用户消息，生成唯一 `turnId`，向 Paseo 发送对应的 `session.prompt_result` 与状态标记 `session.turn`（`started` / `completed` / `failed`）。
3. **流式事件归一化**：将 DSH 的流式增量聚合为连续的 `assistant_message` timeline item，保持 Markdown 语法的连续性与完整性。
4. **工具调用与审批**：将 DSH 工具调用映射为 Paseo 原生卡片渲染，并通过 Paseo 交互协议转发用户的授权决策。
