# 决策记录: 三方依赖版本管理与启动探活机制

Status: implemented

## 问题

本项目同时依赖上游宿主（Paseo）与下游智能体核心（DeepSeek Harness 及 `@xmoon76/dsh-pi-tui`）。这三方均处于活跃甚至高频迭代阶段（Paseo 为 0.8.0 起始，DSH 存在大量 `0.1.5-rc.*` / `0.1.6-alpha.*` 预发布版本）。

若仅在 `package.json` 或 `paseo-plugin.json` 中使用宽泛的 semver 范围符号（如 `^` 或 `>=`），由于 npm/node-semver 规范规定不同预发布元组（如 `0.1.5-rc.1` 与 `0.1.6-alpha.1`）互不兼容，抽象的版本范围在实际运行时会失效。此外，当下游 CLI 或协议发生变更时，若无显式探测机制，会导致服务端子进程静默崩溃、前端挂起等问题。

## 决定

确立基于「实测基线 + 启动期探活 + 宿主 Staging 构建」的三方版本演进管理方案，具体事实落盘于 [docs/compatibility.md](../../../../docs/compatibility.md)：

1. **宿主（Paseo）契约**：在 [paseo-plugin.json](../../../../paseo-plugin.json) 声明 `"requirements": { "paseo": ">=0.8.0" }`。充分利用 Paseo 自身的 Staging 隔离机制，在 `paseo plugin update` 执行期间验证编译与构建完整性，失败时保留运行中的旧版本。
2. **下游（DSH / TUI）探活**：不依赖抽象 semver 范围硬编码，在服务端建立已知兼容组合表（当前基准锁定为 `@xmoon76/dsh-pi-tui` 0.4.6 与 DSH `0.1.5-rc.1` / `rc.2`）。在子进程拉起阶段执行启动期版本探活（Startup Check），针对版本不匹配场景提供升级指引通知，阻止异常崩溃。
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
- 服务端适配层增加了启动探活职责，需要在子进程管理模块中实现版本解析与通知转发。
- 后续每当验证了新的 DSH/TUI 版本组合，需在 [docs/compatibility.md](../../../../docs/compatibility.md) 中同步更新实测基准表。

## 怎么验证的

1. 检查各组件在本地环境的实际版本：Paseo 为 `0.8.0`，`@xmoon76/dsh-pi-tui` 为 `0.4.6`，DSH 为 `0.1.5-rc.1/rc.2` 及 `0.1.6-alpha.1`。
2. 运行 `npm run verify:notes` 与 `npm run verify:docs`，确保文档格式与相对链接全部解析通过。
