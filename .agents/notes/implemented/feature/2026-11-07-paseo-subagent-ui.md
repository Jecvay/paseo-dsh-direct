# 决策记录: 接入 Paseo 原生子代理界面与子会话流

Status: implemented

## 问题

Paseo 在客户端提供原生的 Subagents 轨道（输入框上方的子代理状态胶丸）和独立子代理面板（桌面端侧栏标签页、移动端抽屉），并通过父时间线的 `sub_agent` 工具卡片跳转对应子会话。此前插件未声明 `session.subsession` 能力，也只转发根会话自身的事件流，`subagent` 与 `subagent_fork` 工具调用仅作为 `unknown` 工具卡展示原始 JSON，用户无法在 Paseo 界面查看 DSH 子代理的实时思考、工具执行与多轮跟进过程。

## 决定

插件在 `CAPABILITIES` 中声明 `session.subsession`，并在工具详情投影与桥接事件流两条路径同时接入 Paseo 原生子代理契约，保持 `paseo-plugin.json` 的宿主最低版本 `>=0.11.0` 不变：

1. **父时间线 `sub_agent` 启动卡片**：`TimelineProjector` 将 `subagent` 与 `subagent_fork` 映射为 `type: "sub_agent"` 详情，`subAgentType` 取 `agent_preset`（未指定时分别为 `Subagent` 与 `Fork`），`description` 取任务描述，并在工具结果返回 `started subagent <id>` 或子会话关联建立时填入 `childSessionId`。
2. **桥接层子会话跟踪与 `fork` 种子裁剪**：`BridgeService` 维护根会话集合 `roots` 与各根会话的下属子会话集合。收到 `session/created` 且祖先属于已跟踪根会话时，记录子会话 `inheritedEventCount` 并发送 `session.child` 通知；转发 `session/event`、`agent/assistant-stream` 与 `agent/status` 时跳过 `seq < inheritedEventCount` 的继承前缀事件，避免 `subagent_fork` 把父会话历史重复投进子会话面板。`publishUsage` 与 `rootForId` 仅以 `roots` 判定根会话，确保子会话的 token 用量不覆盖父会话上下文计量，且子会话触发的审批与提问继续路由到父会话。
3. **子会话 `session.opened` 准入对齐与历史回放**：Paseo `PluginAgentSession.attachChild` 仅在子会话首次 `session.opened` 时读取 `title`、`description` 与 `toolCallId`。Provider 在 `session.child` 与 `subagent/descriptor` 阶段仅记录子会话预设和描述，待子会话真正通过准入（非 `external` 模式的 `subagent/catalog`、父工具 `tool/result`、子会话 `turn/start` 或首个可投影事件）后才向 Paseo 发出 `restoration: "parent"`、`capabilities: []` 的 `session.opened`，避免启动中途回滚留下幽灵子会话，并忽略无本地 DSH 会话的 `mode: "external"` 目录项；当存在同名描述的并发 `subagent` 调用时，暂缓打开并缓存子会话事件直至 `tool/result` 明确绑定 `toolCallId`。`session.open` 恢复历史时，桥接按非 `external` 的 `subagent/catalog` 及工具结果递归读取持久子会话快照并裁剪继承前缀，Provider 回放子会话时间线与终态 `session.turn`。
4. **子会话提示词净化与旧宿主降级**：子会话 `TimelineProjector` 剥离 DSH `withContinuableReturnGuidance` 自动追加的回传指引尾部，并将父会话经 `send_message` 发给子会话的 `agent-message` 中继还原为用户气泡；子会话回传给父会话的 `agent-message` 在父时间线保持隐藏。未协商 `session.subsession` 的宿主不发送子会话事件，自动降级为父时间线上的 `sub_agent` 工具卡片。

## 考虑过的其他做法

- **仅把 `subagent` 映射为父时间线 `sub_agent` 卡片、不接入 `session.subsession`**：改动最小，但 Paseo 的 Subagents 轨道与子代理侧栏面板依赖子会话的 `session.opened`、`timeline.item` 和 `session.turn` 事件，只改工具卡片无法点开查看子代理内部执行过程。
- **在 `session/created` 触发瞬间立即向 Paseo 发送子会话 `session.opened`**：DSH 在 `agents.create` 的 `announce` 阶段先触发 `session/created`，随后才在 `setup` 中写入 `agent-preset/selected` 与 `subagent/descriptor`。若在 `session/created` 立即发出 `session.opened`，`attachChild` 只能拿到空描述或默认标题，且并行启动多个子代理时无法按 `label` 精确匹配父工具调用。
- **把子会话 `restoration` 设为 `"core"`**：会导致 Paseo 在关闭父会话时对每个子会话发送独立的 `session.close` RPC；子会话生命周期由 DSH 父会话统一管理，使用 `restoration: "parent"` 由宿主直接解绑子会话路由。

## 后果

Paseo 桌面、Web 与移动端在 DSH 启动子代理（含 `spawn`、`fork`、多轮 `send_message` 续跑及嵌套子代理）时，均可在输入框上方看到 Subagents 轨道并在侧栏或抽屉面板实时查看子代理时间线；导入或恢复历史会话时同样完整还原。子代理运行期间 `isProviderSessionIdle` 与桥接安全检查均返回不可停止，防止后台子代理被空闲回收中断。

## 怎么验证的

单元测试覆盖 `TimelineProjector` 的 `sub_agent` 映射与提示词净化、`BridgeService` 的子会话跟踪、`fork` 继承事件过滤、根会话用量隔离、历史快照提取，以及 `provider` 的实时子会话流、历史回放和未协商 `session.subsession` 时的降级行为；另通过 Docker 容器内真实 Paseo Web UI + DSH + Playwright 端到端验证子代理轨道与面板渲染。
