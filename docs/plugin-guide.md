# Paseo 插件规范与设计参考

本文档整理 Paseo 0.8 插件规范的关键约束、设计要点，以及优秀插件实现的借鉴经验与官方/社区链接。

## 官方规范与核心注意项

Paseo 0.8 对插件实施严格的三层架构与跨端沙箱隔离，开发 Provider 插件必须严格遵循以下规则：

### 1. 目录边界与模块导入隔离

- **`server/`（服务端）**：运行于 Paseo Daemon 调度的隔离子进程中。仅允许引入 `@getpaseo/plugin`、`@getpaseo/plugin/server`、`@getpaseo/plugin/server/provider`、`@getpaseo/plugin/server/acp`、`zod` 以及 Node.js 原生模块。
- **`client/`（客户端）**：运行于 Paseo App 前端（React Native / Expo 统一多端，覆盖桌面端 Electron、移动端 iOS/Android 以及 Web）。严禁引入任何 `node:` 内置模块，严禁直接使用全局 `window` / `document`，严禁使用 HTML 标签（如 `<div>`）或 DOM 事件（`onClick`）。所有跨端 UI 必须基于 `react-native` 组件（`View`, `Text`, `Pressable`）。
- **`shared/`（共享契约）**：仅包含纯 TypeScript 类型与 Zod Schema，禁止引入任何运行时专属库（既无 Node 也无 React）。
- **根目录限制**：插件根目录只允许存在 `paseo-plugin.json`、`index.server.ts`、`index.client.tsx` 与项目配置文件，其他代码文件放入根目录会导致构建失败。

### 2. 流式传输机制与累积快照切片（Delta Slicing）

在通用 ACP 协议接入中（如 [Issue #4699](https://github.com/getpaseo/paseo/issues/4699)），由于缺失稳定的 `messageId`，每个流式 chunk 会被分配新的 item ID，导致界面渲染为大量破碎的气泡并破坏 Markdown 格式。

Direct Provider 的标准实现机制是：
- **累积文本快照与服务端切片**：Paseo 服务端内部通过对比上一个快照 `previousText`，在 `item.text.startsWith(previousText)` 成立时自动切片出增量并推向客户端流。因此 Provider 发射 `timeline.item`（无论是 `assistant_message` 还是 `reasoning`）时，**必须保持相同的 `item.id`，且每次发送当前回合累积的完整文本（Cumulative Snapshot）**。若 Provider 自行发送增量 token，切片判定会失败并导致界面闪烁或乱序。
- **`clientMessageId` 精准闭环**：收到 `session.prompt` 后，必须提取其中的 `clientMessageId`，既要在发射 `session.prompt_result` 时原样携带，也要在发射用户提问的 `user_message` timeline item 时回填，Paseo 客户端藉此将其与输入框乐观占位精准合并。
- **回合生命周期终结铁律**：一旦发射了 `{ type: "session.turn", turnId, state: "started" }`，后续必须且仅能发射一次该 `turnId` 的终结事件（`completed`、`failed` 或 `canceled`），否则客户端界面停止按钮将永久阻塞。

### 3. 子进程管理与崩溃恢复（Terminalization）

- **双阶段终止**：关闭连接时先向子进程发送 `SIGTERM`，若 1000ms 内未退出则升级为 `SIGKILL`，防止僵尸进程驻留。
- **崩溃状态强制终结**：若底层子进程意外退出或崩溃，必须立即将所有处于 `running`/`pending` 状态的 `tool_call` 与活跃 turn 标记为 `failed` 或 `canceled` 向上发射，并释放内存中挂起的 Promise，防止前端弹窗与加载态死锁。
- **串行执行队列（Mutation Lane）**：会话级别的配置更新与 Prompt 调度建议维护串行 Promise 队列，保证时序安全，避免并发脏写。

### 4. 权限审批与中断交互契约

- **权限申请（`session.permission`）**：高危工具执行前，Provider 发射 `session.permission` 请求并挂起内部流程。客户端用户决策后派发包含 `allow` / `deny` 的 `session.permission` 输入，Provider 处理后必须发射 `{ type: "session.permission_resolved", sessionId, permissionId }` 作为确认回执。
- **中断响应（`session.interrupt`）**：收到中断输入后，立即向底层发送取消信号，发射 `{ type: "request.completed", requestId }` 确认受理，并将当前 turn 标记为 `canceled` 终结。

### 5. 两层 Settings 体系划分

- **Session Composer Settings**：通过 `session.config` 事件动态下发 `ProviderConfigState`（支持 `model`, `modes`, `thinkingOptions`, `settings` 开关/下拉条），直接渲染在输入框上方。
- **Host Plugin Settings**：通过 `defineSettings` 声明并由 `server.registerSettings` 注册，在系统主设置菜单的插件选项卡中持久化管理（如 DSH 本地可执行文件路径、全局配置参数等）。

### 6. 图标（Icon）规格约束

`ProviderRegistration.icon` 必须是指向插件目录内相对路径的 SVG 文件（如 `icon.svg`）：
- 文件大小必须小于或等于 64 KiB；
- 必须是纯自包含矢量图，严格禁止 `<script>`、`<style>`、`<foreignObject>`、行内事件监听器以及外部 `href` 引用（允许内部 `#id` 片段引用）。

---

## 优秀插件借鉴经验

### 1. 官方 Direct Provider 示例（`provider-direct`）
- **参考地址**：[getpaseo/paseo: plugin-examples/provider-direct](https://github.com/getpaseo/paseo/tree/main/plugin-examples/provider-direct)
- **借鉴点**：
  - 展示了标准的 `ProviderConnection` 状态机模式：通过 `send()` 快速确认接收任务，通过内部队列与微任务异步 `dispatch`，通过 `onEvent` 发布快照。
  - 支持会话重放（`replay`）与持久化恢复（`persistence`）。
  - 支持通过 `addTimelineRenderer` 为特定 `timeline.item` 提供专属 UI 卡片渲染。

### 2. 官方行内思考渲染器（`inline-thinking`）
- **参考地址**：[getpaseo/paseo: plugin-examples/inline-thinking](https://github.com/getpaseo/paseo/tree/main/plugin-examples/inline-thinking)
- **借鉴点**：
  - 展示了前端 `client.addTimelineTransformer` 的强大能力：拦截内置的 `{ itemType: "reasoning" }` 思考流，自动将其包装为自定义插件卡片并在界面优雅折叠/展开，非常适合 DeepSeek R1 / V4 等带有长思考链的模型。

### 3. VS Code Web 深度集成插件（`paseo-plugin-vscode-web`）
- **参考地址**：[itsjustanks/paseo-plugin-vscode-web](https://github.com/itsjustanks/paseo-plugin-vscode-web)
- **借鉴点**：
  - 优秀的工程结构组织：清晰划分客户端面板（Workspace Panel）、命令中心动作（Command Center Item）与服务端 Tunnel 进程控制。
  - 完善的生命周期清理：在返回的 cleanup 函数中妥善关闭子进程与网络隧道，避免僵尸进程。

### 4. 社区 ACP Provider 插件（`paseo-plugin-agy-provider`）
- **参考地址**：[3ae3ae/paseo-plugin-agy-provider](https://github.com/3ae3ae/paseo-plugin-agy-provider)
- **借鉴点**：
  - 轻量级封装模式，但其实际运行中暴露了 ACP 流式分块断裂的问题，印证了采用 Direct Provider 原生对接 DSH 的必要性。

---

## 外部资源与文档索引

### 官方文档
- [Paseo 插件快速开始（v0.8）](https://paseo.sh/docs/plugins/v0.8)
- [Paseo 插件参考规范（Reference）](https://paseo.sh/docs/plugins/v0.8/reference)
- [构建 Provider 插件开发指南](https://paseo.sh/docs/plugins/v0.8/providers)
- [Paseo 插件迁移指南（0.7 -> 0.8）](https://paseo.sh/docs/plugins/v0.8/migration)
- [Paseo 社区与生态项目汇总](https://paseo.sh/docs/community)

### 社区生态与分发平台
- [paseo.cafe（社区插件目录）](https://paseo.cafe)
- [paseo-cafe 组织仓库](https://github.com/paseo-cafe/paseo-cafe)
- [Paseo 官方主仓库](https://github.com/getpaseo/paseo)

### 基础标准规范
- [Agent Client Protocol (ACP) 规范](https://agentclientprotocol.com)
- [Model Context Protocol (MCP) 规范](https://modelcontextprotocol.io)
