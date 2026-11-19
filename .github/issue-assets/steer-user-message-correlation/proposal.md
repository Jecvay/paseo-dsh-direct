# 合并工作中补充输入的两条时间线记录

## 问题

用户在 agent 工作时补充输入，Paseo 有时显示两条相同消息。本机会话的原生 DSH 日志每次只记录一条 `user/message`。Paseo 同时收到自己记录的已提交消息和插件回传的 DSH 消息，后者缺少 `clientMessageId`。

本次从 `fd8d340f3595a53cc17bc0c9b2593c0eb4238d4f` 开始，目标为 `main` 的 `0.2` 线。GitHub 没有对应的项目 issue。改动仅涉及 Direct Provider 服务端适配，是普通兼容修复。

### 调研证据

2026 年 11 月 20 日核对了以下证据。

- Paseo 的 Provider 约定要求回传用户消息时复制原 `clientMessageId`。最低支持版 `0.11.0` 和当前稳定版 `0.16.2` 都用该字段关联提交记录，`0.17.0-beta.1` 延续同一机制。[Provider 指南](https://paseo.sh/docs/plugins/providers.md#complete-the-first-prompt) · [0.11.0 合并逻辑](https://github.com/getpaseo/paseo/blob/22488d4502cd0c8a4ee4619af991762f071b60a7/packages/server/src/server/agent/agent-manager.ts#L4716) · [0.16.2 并发测试](https://github.com/getpaseo/paseo/blob/2ee30f4164af42ba209236ab3a31bf9532592fc3/packages/server/src/server/agent/agent-manager.test.ts#L1755-L1793)
- DSH 从调用方传入原生消息 ID，`steer` 先入队，到模型步骤时才写入 `user/message`。排队输入可能在被消费前丢弃，原生通知也可能早于 RPC 回执。`0.2.0-rc.1` 与 npm 最新的 `0.2.2-rc.5` 均提供这些接口。[早期 DSH 的 inbox](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/core/agent-loop/src/inbox.ts#L226-L240) · [最新 DSH 的消息提交](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/packages/core/agent-loop/src/agent.ts#L468-L478)
- Paseo 的 Codex/Traex 适配也报告过同样的双记录。Happier 的 Codex 适配按发送标识保留原生终端输入，Paseo 的 Pi 适配测试覆盖消费先于回执和两条内容相同的输入。本项目能在 DSH 入队前拿到精确身份。[Paseo #10073](https://github.com/getpaseo/paseo/issues/10073) · [Happier #400](https://github.com/happier-dev/happier/pull/400) · [Paseo Pi #6561](https://github.com/getpaseo/paseo/pull/6561)
- 本插件的普通输入已经带上 `clientMessageId`。`steer` 只确认回执，随后由原生事件上报气泡。基线在隔离的 Linux Paseo `0.16.2` 和 DSH `0.2.2-rc.1` 上复现，发送两条内容相同的补充消息后得到四条时间线记录。[服务端架构](../../../docs/server-architecture.md#paseo-呈现契约)

## 提案

1. Provider 把原 `clientMessageId` 通过 `session.steer.params.clientMessageId?` 传给内部桥接，并在 `await` 之前捕获当前活动 `turnId` 用于回执。
2. DSH 桥接在调用 `agent.steer` 前，按根会话在 `RecordEntry` 上记录自己分配的消息 UUID 和客户端 ID（`steerCorrelations`）。匹配的 `user/message` 到来时，在 `session.event` 通知信封的 `clientMessageId?` 字段附带该 ID 并删除关联。DSH 的 `agent/inbox/discarded` 通知（载荷 `{agent, message.id}`）和 `agent.steer` 同步抛错时清理关联；会话关闭时释放该会话的关联。关联只随桥接存活，DSH 的持久事件保留原格式。
3. 时间线投影把该 `clientMessageId` 放进 `user_message` 条目（Paseo 已有字段），Paseo 将其归入已提交记录并补上原生 `messageId`。普通输入、子会话和历史回放继续使用原有路径。

内部 RPC 仅增加可选字段，分帧、版本、公开 SDK 和客户端 API 保持原约定。候选以 `0.2.22` 发布，回退可使用 `0.2.21`，无需迁移会话数据。

## 考虑过的其他做法

- 只回执并屏蔽这条实时回显可以减少输出。按 ID 合并可让 Paseo 保留原生消息 ID，后续逻辑仍可据此定位 DSH 消息。
- 等 RPC 返回后再关联会漏掉提前到达的通知。按文本合并会误删用户有意重复发送的消息。

## 验收

- 覆盖 RPC 回执前后的消息事件、同文本的两次发送、无关联原生输入、已丢弃输入和回执时回合已结束。
- 用真实 Paseo 和 DSH 的隔离宿主复现：两次 steer 对应两条时间线记录；取消一条尚未提交的排隊 steer 时 `agent/inbox/discarded` 确实送达并清理关联；从 DSH 历史强制重建（`refreshAgent`）后每条输入仍只有一行。
- 跑构建、四路类型检查、测试、笔记和文档门禁。完成审查和候选 CI 后提交发布确认。

## 风险

- 关联以“我们分配并传入、DSH 原样落盘”的消息 UUID 为准。若 DSH 某版本改写该 ID，则不合并，关联留到会话关闭时清掉，最多导致该条仍显示两次，不会删除或篡改原生消息。
- `agent/inbox/discarded` 是 DSH 的私有 dispatch 事件，最低支持版本（0.2.0-rc.1）与当前版本均有，但需真实 DSH 集成实测确认送达与载荷。
- 排队后被 DSH 丢弃的输入不会产生原生消息；Paseo 侧此前记录的已提交气泡可能仍显示。这与宿主对其他 provider 的语义一致，本次不撤回该气泡。
- 从 Paseo 已有该 steer 提交记录的 agent 强制重建历史时，重建行仅含原生 ID；需实测确认重建与既有记录不会叠加成两行。
