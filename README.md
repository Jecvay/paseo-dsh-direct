# paseo-dsh-pi

`paseo-dsh-pi` 是为 [Paseo](https://github.com/getpaseo/paseo) 打造的第三方 Provider Plugin，旨在将 [@xmoon76/dsh-pi-tui](https://github.com/XMoon/dsh-pi-tui) 与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）直连接入到 Paseo 生态中，使全平台用户（Desktop、Web、iOS、Android）都能获得原生级的 DSH 智能体交互体验。

---

## 相关项目

- **Paseo**：[github.com/getpaseo/paseo](https://github.com/getpaseo/paseo) — 现代化、跨端（桌面/移动/Web）的智能体工作空间与运行时宿主。
- **DeepSeek Harness**：[github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — DeepSeek 官方智能体框架与核心协议。
- **dsh-pi-tui**：[github.com/XMoon/dsh-pi-tui](https://github.com/XMoon/dsh-pi-tui) — DeepSeek Harness 的终端交互与 Profile 扩展。

---

## 为什么使用 paseo-dsh-pi？

在泛型 ACP（Agent Client Protocol）适配器模式下，由于协议层缺失稳定的消息标识与累计快照切片机制，流式 token 会被切碎为大量独立气泡，导致 Markdown 排版撕裂、长思考链展示不佳以及中断交互迟滞。

`paseo-dsh-pi` 采用 Paseo 0.8+ 的 **Direct Provider** 直连架构：

- **平滑流式响应**：基于服务端增量切片（Delta Slicing）机制，保持 Markdown 渲染的连续性与完整性。
- **原生思考过程**：针对 DeepSeek 模型的长推理链（`reasoning`），提供原生的折叠展开与行内思考卡片。
- **子进程与生命周期守护**：实现双阶段优雅退出（`SIGTERM` -> `SIGKILL`）与崩溃强制终结，杜绝僵尸进程与前端状态死锁。
- **交互与审批流**：将 DSH 的高危工具调用无缝映射为 Paseo 原生卡片渲染，支持用户的实时授权与中断操作。

---

## 技术选型与规约

- **全栈 TypeScript**：项目完全基于 **TypeScript**（TS / TSX）开发。Paseo 0.8 插件系统原生集成 `esbuild` 编译器，且 Paseo 核心、DeepSeek Harness 以及 `dsh-pi-tui` 均基于 TypeScript 开发，具有天然的类型契约共享优势和 AI 编码协同效率。
- **文档分工（Docs vs. Agent Notes）**：
  - **`docs/`（产品说明书）**：面向人类开发者、上下游项目以及其他协作 Agent，只描述**当前生效的技术机制与使用说明**（现在时，不掺杂变更历史与决策推导）。
  - **`.agents/notes/`（决策记录）**：记录在工程演化过程中人与 Agent 共同做出的**关键架构与方向性决策**（为什么这么选、放弃了哪些替代做法、如何验证）。

---

## 快速上手

### 1. 前置要求

- **Paseo**：`>=0.8.0`
- **DSH 运行环境**：已安装并配置好 DeepSeek Harness（推荐 `0.1.5-rc.1` / `0.1.5-rc.2`）与 `@xmoon76/dsh-pi-tui`（当前推荐 `0.4.6`）。

### 2. 安装插件

在终端中执行以下命令，直接从 GitHub 安装插件：

```bash
# 安装最新稳定版本
paseo plugin add Jecvay/paseo-dsh-pi

# 或锁定特定发布版本
paseo plugin add Jecvay/paseo-dsh-pi --ref v0.1.0
```

本地开发与调试场景下，可直接从本地路径载入：

```bash
paseo plugin install /absolute/path/to/paseo-dsh-pi
```

### 3. 更新插件

依托 Paseo 的暂存隔离与原子构建机制，插件支持无损热更新：

```bash
paseo plugin update paseo-dsh-pi
```

---

## 架构与文档

本仓库遵循严格的 Paseo 0.8 插件规范（`server/`、`client/`、`shared/` 三层隔离）与 Agent 工程化规范：

- [文档总索引](docs/README.md)：各子系统细节文档指引。
- [服务端架构](docs/server-architecture.md)：Paseo Daemon 侧 Direct Provider 实现、stdio 通信管道与流式转换。
- [客户端架构](docs/client-architecture.md)：Paseo App 前端品牌展示、React Native 跨平台约束与模型配置卡片。
- [兼容性与版本管理](docs/compatibility.md)：三方基准版本矩阵、运行时启动探活与发布策略。
- [插件开发与设计参考](docs/plugin-guide.md)：Paseo 官方核心约束、生命周期状态机与设计借鉴。
- [Agent 规约与红线](AGENTS.md)：协作规范与时态落点准则。

---

## License

MIT
