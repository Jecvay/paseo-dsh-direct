# 决策记录: 三方依赖版本管理与启动探活机制

Status: implemented

## 问题

本项目同时依赖上游宿主（Paseo）与下游智能体核心（DeepSeek Harness 及 `@xmoon76/dsh-pi-tui`）。这三方均处于活跃甚至高频迭代阶段（Paseo 为 0.8.0 起始，DSH 存在大量 `0.1.5-rc.*` / `0.1.6-alpha.*` 预发布版本）。

若仅在 `package.json` 或 `paseo-plugin.json` 中使用宽泛的 semver 范围符号（如 `^` 或 `>=`），由于 npm/node-semver 规范规定不同预发布元组（如 `0.1.5-rc.1` 与 `0.1.6-alpha.1`）互不兼容，抽象的版本范围在实际运行时会失效。此外，当下游 CLI 或协议发生变更时，若无显式探测机制，会导致服务端子进程静默崩溃、前端挂起等问题。

## 决定

确立基于「实测基线 + 启动期探活 + 宿主 Staging 构建」的三方版本演进管理方案，具体事实落盘于 [docs/compatibility.md](../../../../docs/compatibility.md)：

1. **宿主（Paseo）契约**：在 [paseo-plugin.json](../../../../paseo-plugin.json) 声明 `"requirements": { "paseo": ">=0.8.0" }`。充分利用 Paseo 自身的 Staging 隔离机制，在 `paseo plugin update` 执行期间验证编译与构建完整性，失败时保留运行中的旧版本。
2. **下游（DSH / TUI）探活**：实测组合记录于兼容性文档，当前为 `@xmoon76/dsh-pi-tui` 0.4.9 与 DSH `0.1.7-rc.2`。启动检查桥接握手及必要运行时接口，不依据包版本字符串硬拒绝未经测试的版本。缺失服务、启动超时或协议不匹配通过 Provider 错误报告。
运行时接入和握手的具体机制见 [pi-tui Direct 桥接决策](2026-09-23-pi-tui-direct-bridge.md)。SDK 依赖版本的选取见 [Paseo SDK 0.9 对齐](2026-09-26-paseo-sdk-09-alignment.md)。

3. **版本发布渠道**：维护日常主分支跟踪与 Git Tag 发布机制，允许用户按需固定 `--ref <tag>` 获得稳定体验。

## 考虑过的其他做法

1. **仅依赖 package.json 中的 semver range 限制下游版本**
   - 优点：实现简单，无需编写额外的探活逻辑。
   - 缺点：在 DSH 预发布（alpha/rc）频繁演进的情况下，node-semver 不会自动匹配跨标签的 prerelease，导致即使功能兼容也会报依赖冲突或反向失效。
2. **强行锁定单个静态版本并执行进程硬退出（Exit-on-Mismatch）**
   - 优点：完全规避任何未测版本的风险。
   - 缺点：下游发布日常安全补丁或小修复时，用户插件立刻不可用，完全失去向前兼容弹性。

## 后果

- 插件具有了确定的运行基线和明确的升级路径，用户更新时受 Paseo 原子暂存构建机制保护。
- 服务端适配层负责握手、运行时接口检查、启动超时与错误转发；未测试版本仍可能在调用尚未覆盖的服务时失败。
- 后续每当验证了新的 DSH/TUI 版本组合，需在 [docs/compatibility.md](../../../../docs/compatibility.md) 中同步更新实测基准表。

## 怎么验证的

1. 检查各组件在本地环境的实际版本：Paseo 为 `0.8.0`，`@xmoon76/dsh-pi-tui` 为 `0.4.6`，DSH 为 `0.1.5-rc.2`。其他源码版本不构成运行时实测证据。
2. 运行 `npm run verify:notes` 与 `npm run verify:docs`，确保文档格式与相对链接全部解析通过。
