# 决策记录: Paseo 回退与改名同步到 DSH

Status: rejected — Paseo 0.9.1 插件宿主在回退后用只增不减的事件历史重建时间线，且插件协议没有改名输入与标题更新事件；插件侧无法正确实现

## 问题

用户希望 Paseo 的会话回退、会话改名与 DSH 原生会话保持一致。归档另作说明：Provider 未声明 `session.archive` 时 Paseo 仍自行完成归档，pi-tui profile 也没有挂载 DSH 的 `workspaceRegistry`，无原生归档可同步。

## 考虑过的其他做法

- 对话回退按 pi-tui 做法 fork：以目标用户回合的 `turn/start` 之前的事件为种子调用 `agents.create`，再用 `session.persistence` 把 Paseo 会话切换到子会话。DSH 侧可行；但 Paseo `PluginAgentSession.streamHistory()` 返回会话打开以来累积的全部事件，`AgentManager.rewind` 据此强制重建时间线，被回退的消息会原样回到界面。
- 文件回退：DSH 没有文件检查点，pi-tui 的回退也只回退对话。
- Paseo 改名写回 DSH：`ProviderInput` 没有改名请求；`ProviderEvent` 也没有标题更新事件，只有 `session.opened` 携带一次标题。新建会话时的标题已通过 `session.rename` 写入 DSH。

Paseo 插件宿主补齐历史替换或改名输入后重新评估，参照 Paseo `packages/server/src/server/agent/plugin-provider.ts` 与 `agent-manager.ts` 的 `rewind`。
