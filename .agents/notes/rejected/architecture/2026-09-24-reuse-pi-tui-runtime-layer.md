# 决策记录: 改为调用 pi-tui 内部运行时层

Status: rejected — pi-tui 的运行时端口不在包导出中，技能投递、回退、附件草稿等逻辑与终端编辑器状态耦合；这些逻辑本身调用的就是桥接已直接使用的 DSH 服务

## 问题

斜杠命令、技能、附件、回退等能力在 pi-tui 中已有实现。桥接当前直接调用 DSH 官方服务（`commands`、`skills`、`attachments`、`agents` 等），需要逐项对照 pi-tui 与 DSH 官方 Web 端补齐行为。直接复用 pi-tui 的实现看似能减少重复。

## 考虑过的其他做法

- 调用 pi-tui 的 `runtime/*-port.ts` 与 `runtime/direct/` 适配层：领域划分清楚；但 `@xmoon76/dsh-pi-tui` 的 `exports` 只暴露入口、`startup` 与扩展 API，内部模块路径随版本变化，没有兼容承诺。
- 复用 pi-tui 的 `commands.ts` 执行路径：技能投递、回退和图片草稿都在这里；但它依赖编辑器草稿、会话切换栅栏、`app.setEditorText` 等终端状态，桥接禁用了 `tui-app`，无法无头运行。
- 保持直接调用 DSH 官方服务（现状）：与 pi-tui 的 direct 适配器和 DSH 官方 Web 端（`session-controller`）落在同一层服务上；行为规则（技能以 `/<名称>` 用户消息触发、回退即以 `turn/start` 前缀 fork）按两者对照实现。代价是规则需要人工对齐。

保持现状。行为对齐的依据写在 [服务端架构](../../../../docs/server-architecture.md)。
