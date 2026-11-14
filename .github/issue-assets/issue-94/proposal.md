# Issue #94: 合并节流 DSH 流式事件以消除子代理广播风暴

## 问题

Issue: https://github.com/Jecvay/paseo-dsh-direct/issues/94
基线: `2f703b84e4c8df247f50f5c4544ca3a3cdb8d2c6`（v0.2.18）；目标线: `main`（将发布 `0.2.19`，npm `latest`）。

### 现象与成因

在 Paseo Web UI 连接 daemon 并运行 2–3 个并行 DSH subagent 时，Web 客户端被大量广播淹没并周期性断线（客户端 3 秒/5 秒存活 ping 超时），导致同一连接上并发的「导入会话」等 RPC 全部失败，daemon 日志每 1–2 分钟写满 10 MB 轮转，daemon RSS 涨至 2.74 GB。实测 3 个并行子代理文本可达 ~551 条/秒，2 个子代理工具调用 25 秒 2,254 条（~90 条/秒）。

根本原因有两层：

1. **Paseo 宿主的根会话与子会话存在路径不对称**：在 Paseo 0.14–0.16.0-beta.2 中，主会话 `timeline` 事件会经过 `AgentManager.handleStreamEvent` 里的 `AgentStreamCoalescer`（60 ms 窗口）合并后才推给已打开时间线的订阅者；但子会话（`provider_subagent`）事件在 `AgentManager.dispatchSessionEvent` 直接绕过 `AgentStreamCoalescer`，经 `ProviderSubagentStore.apply` 和 `Session.forwardProviderSubagentUpdate` 逐条原样广播给所有连接时全局订阅 `agent.provider_subagents.update` 的 Web/App 客户端。
2. **本插件逐片直发与重复解析放大**：`server/timeline.ts` 的 `projectStream()` 对每个 `text-delta`、`reasoning-delta` 和 `tool-call-delta` 都立即构造 `ProviderEvent`（且每个 `tool-call-delta` 都会拼接累计 `argumentsText` 并调用一次 `JSON.parse`），`server/provider.ts` 的 `session.stream` 处理函数在主会话与子会话两条分支均直接同步转发给宿主 `emit`/`emitChildEvent`，导致插件→daemon IPC、Zod 校验、`plugin-provider.js` `snapshots` Map 累积与 WebSocket 广播同时被逐 token 放大。

### 项目责任与规模判断

`paseo-dsh-direct` 负责将 DSH 流式事件以跨端兼容、不拖垮宿主和客户端的节奏适配为 Paseo `timeline.item` 事件，不修改 Paseo 或 DSH 核心，也不应要求用户升级 Paseo 才能止血。本改动仅局限在插件服务端 `server/` 内部，不改 Direct 通信机制、协议帧格式、前后端职责边界或外部依赖，最低支持版本保持 `>=0.11.0`，属于**普通修复**（无需 `wait-human`）。

### 预期效果与范围

- 主会话与所有子会话的流式文本（`assistant_message`）、思考（`reasoning`）与工具调用（`tool_call`）增量在插件服务端按会话合并并节流输出，同时延迟 `tool-call-delta` 的参数 JSON 解析到 flush 时执行。
- 严格保留文本/思考前缀、缩进、块顺序、`remainingText` 定稿尾部补发、`sub_agent` 父子关联和关闭/故障/回合结束时的精确顺序。
- 不修改 `client/`、`shared/`、`server/dsh/bridge.ts`、`server/dsh/service.ts` 与 `paseo-plugin.json`。

### 三路证据（访问日期：2026-11-14）

- **官方（Paseo + DSH）**：
  - 核查 `@getpaseo/plugin@0.14.0`、本机 `@getpaseo/server@0.15.4` 及上游 `getpaseo/paseo` `main`（`v0.16.0-beta.2`，2026-11-11）：`ProviderTimelineItem` 契约无变更；`assistant_message` 依靠 `messageId`（同 `blockId`）合并相邻块，`reasoning` 无 `messageId`（schema `.strip()`），服务端 `mergeReasoningChunks` 与前端 `applyStreamEvent` 均按「相邻且同 `turnId`（子会话同为 `undefined`）」自动合并进同一个思考气泡，只要不跨越不同块类型就不会拆成多条气泡；主会话有 `AgentStreamCoalescer`（60 ms），子会话 `provider_subagent` 完全绕过它，且内置 Claude/OpenCode 适配器只按整块发子会话更新。
  - 核查本机 `dsh 0.2.2-rc.1` 与上游 `deepseek-ai/deepseek-harness` `master`（`0.2.2-rc.3`）：`agent/assistant-stream` 逐 chunk 同步发送且无内置节流开关；`live.settle()` 先同步持久化 `assistant/message`（触发 `session/event`），再发送 `end` 帧；`tool/call` 持久事件在 `assistant/message` 提交后产生。
- **社区经验**：
  - `pingdotgg/t3code`（PR #19626 / #24086 / #16317 / #24267）、`grunmin/dsh-acp-enhanced`（PR #18，75 ms）、`clouvet/sprite-swarm`（PR #163，60 ms）、`TracecatHQ/tracecat`（PR #3887，100 ms + 延迟 `parsePartialJson`）、`openclaw/openclaw`（PR #137030 / #173948）、`CodeAgentMobile/codeagent-mobile-clients`（PR #999）与 `IppClub/Dora-SSR`（PR #147）：一致验证了「首片立即（leading-edge）+ 固定节流窗口（50–150 ms）+ 文本追加/工具 last-value 覆盖 + 延迟 JSON 解析 + 因果边界前同步 flush + flush 后保留冷却时间防退化」的模式。
- **本项目**：
  - `0.2.16`（PR #83）为消除 $O(N^2)$ 累计重传将文本/思考改为每次发增量加唯一 `id`（`${blockId}#${rev}:${index}`）；`0.2.17`（PR #93，[subagent UI 决策记录](../../.agents/notes/implemented/feature/2026-11-07-paseo-subagent-ui.md)）接入子会话，直接在 `server/provider.ts:453-471` 逐帧透传。
  - `server/provider.ts:1322-1331`（`correlateChildWithParentCall`）与 `ensureChildOpened` 依赖父会话 `observeProjectedSubagentCalls` 采集 `subagent` 描述与关联状态；`closeSession` / `failSession` 需保证无残留定时器或幽灵事件。

## 提案

### 改什么，数据如何流动

```text
DSH session.stream (text-delta / reasoning-delta / tool-call-delta / end)
  │
  ├─► TimelineProjector.projectStream(frame, { deferToolDetail: true })
  │     • 同步更新 streamedText（保证与定稿 remainingText 精确对齐）
  │     • 文本/思考：返回带唯一 id 的增量 item（assistant_message 带 messageId）
  │     • tool-call-delta：只拼接 argumentsText、标记 dirtyTools，不调 parseArguments/toolDetail
  │
  └─► StreamCoalescer (按 nativeSessionId 分桶，主/子会话统一，leading-edge + 120 ms 窗口)
        • 相邻同 messageId 的 assistant_message → 拼接 text，保留首条 id 与最新 timestamp
        • 相邻同块（同 # 前缀）的 reasoning → 拼接 text，保留首条 id 与最新 timestamp
        • 同 callId 的 tool_call → 原地覆盖并保持插入顺序
        • 大块保护：本批次新增文本/思考字符累计超过 64 KB 时提前 flush（不统计累计的 tool_call.argumentsText）
        │
        ├─ 触发条件（首片直发 / 120 ms trailing timer / 终态 tool_call / 64 KB 文本上限 /
        │            frame.type==="end" / session.event 到达前 / session.status 非 running 前 /
        │            interaction.request 前 / correlateChildWithParentCall 前 / close 或 fail 前）：
        │
        ▼ flush(sessionKey)  [先取出并清空桶再调 onFlush，防重入重复发射]
      若为 tool_call 且仍在 dirtyTools → materializeToolCall(callId, timestamp)（调一次 parseArguments + toolDetail，保留已有 childSessionId）
        │
        ├─ 主会话：observeProjectedSubagentCalls → emit
        └─ 子会话：observeProjectedSubagentCalls → emitChildEvent（仍受 child.opened / pendingEvents 门控）
```

具体设计与关键细节：

1. **新增 `server/stream-coalescer.ts`**：
   - 纯 TypeScript 工具模块（不依赖全局单例状态），注入 `{ windowMs, maxBufferChars, timers, now, onFlush }`，默认 `windowMs = 120`（ms，接近 issue #94 验证的 150 ms 削峰率并兼顾主会话流畅度）、`maxBufferChars = 65_536`。
   - **调度策略（Leading-edge + 固定 trailing 窗口）**：
     - 维护每个 `key` 的 `lastFlushAt: number | null`。空闲窗口后第一批条目同步立即 flush（首字延迟 0 ms）；若距上次 flush 不足 `windowMs` 且尚无定时器，则挂一个 `windowMs` 的 `setTimeout`（调用 `.unref?.()`，避免阻止进程退出）。
     - **防退化（`Dora-SSR` 教训）**：定时器或手动 `flush` 排空缓冲条目时保留 `lastFlushAt` 直到会话结束或清理（`discard(key)` / `dispose()`），这样连续流不会退化成「每次 flush 后下一片又变首片直发」。
     - **防重入**：`flush(key)` 必须在调用 `onFlush` **之前**先把该 `key` 的当前缓冲数组与索引表取出并清空（同时清理该 `key` 的挂起定时器），确保 `onFlush` 经由 `observeProjectedSubagentCalls` → `ensureChildOpened` → `correlateChildWithParentCall` 重入 `flush(key)` 时直接成为空操作。
   - **合并策略**：
     - `assistant_message`：若缓冲尾部同为 `assistant_message` 且 `messageId !== undefined && prev.messageId === next.messageId`，则拼接 `text`、更新 `timestamp`，保留该批次首条的唯一 `id`（例如首条的 `${blockId}#0:0` 与第二批首条的 `${blockId}#0:12` 均区别于 `blockId` 且跨批不重复，既能在 Paseo 同一气泡内拼接，又不会触发 `mapTimelineItem` 把非累计增量当累计快照做前缀误切片）。
     - `reasoning`：对带 `#` 后缀的 `id` 取 `#` 前缀（`const hash = id.lastIndexOf("#"); const prefix = hash >= 0 ? id.slice(0, hash) : undefined`）；仅当缓冲尾部同为 `reasoning` 且两者存在相同非空 `prefix` 时拼接 `text`、更新 `timestamp`，保留首条 `id` 且不附加 `messageId`。无 `#` 的 `id` 不跨条目误合并。
     - `tool_call`：按 `callId` 记录在 `entries` 中的下标；重复到达时原地更新最新事件（更新 `timestamp`、`name` 等）并保持首次插入顺序；若状态非 `"running"` 则立即 `flush(key)`。
     - `maxBufferChars` 仅累加当前缓冲内 `assistant_message` / `reasoning` 的增量 `text.length`，不累加 `tool_call` 的全量 `argumentsText`，避免大参数 `write` 超过 64 KB 后每片退化成同步直发。
   - **生命周期安全**：提供 `flush(key)`、`discard(key)`、`flushAll()`、`dispose()`（清空全部定时器与缓冲并拒绝后续入队/flush）。

2. **改造 `server/timeline.ts`（保持纯同步、无定时器）**：
   - `projectStream(frame, options?: { deferToolDetail?: boolean })`：默认 `deferToolDetail` 为 `false`，保持既有 `TimelineProjector` 单测行为不变。
   - 维护 `private readonly dirtyTools = new Set<string>()`：
     - 当 `deferToolDetail: true` 时，`tool-call-delta` 把 `argumentDelta` 拼进 `tools.get(callId).metadata.argumentsText`，保留 `existing?.detail.type === "sub_agent" ? existing.detail.childSessionId : undefined`，暂放 `{ type: "unknown", input: {}, output: {} }` 占位 `detail`，并将 `callId` 加入 `dirtyTools`。
     - 新增 `materializeToolCall(callId: string, timestamp?: string): SessionEvent | undefined`：若 `!this.dirtyTools.has(callId)` 则返回 `undefined`；否则从 `dirtyTools` 移除 `callId`，按当前 `this.tools.get(callId)` 的 `name` 与 `argumentsText` 运行一次 `parseArguments()` 和 `toolDetail()`，若之前已有 `childSessionId`（且新 `detail.type === "sub_agent"` 且新 `detail.childSessionId` 为空）则保留原 `childSessionId`，更新 `this.tools` 并返回带传入 `timestamp` 的 `timeline.item` 事件。
     - 在 `projectToolCall`、`projectToolResult`、`settleRunningTools` 与 `attachSubagentChild` 入口自洽兜底：分别清除 `dirtyTools`（`projectToolCall`）或在读 `this.tools` 前先内部 materialize 目标 `callId`（`projectToolResult`、`attachSubagentChild`）或所有 dirty running tools（`settleRunningTools`），确保占位 `unknown` 在任何调用路径都绝不泄漏。

3. **改造 `server/provider.ts`**：
   - 在 `SessionState` 中为每个打开的会话持有一个 `coalescer: StreamCoalescer`（按 `nativeId` 区分根会话和各个子会话）。
   - **`onFlush` 回调**：
     - 对 `timeline.item` 中的 `tool_call`，若 `projector.materializeToolCall(item.callId, event.timestamp)` 返回新事件则采用物化后的事件（否则沿用原事件，例如来自非 `deferToolDetail` 路径）。
     - 根会话：执行 `observeProjectedSubagentCalls(session, session.nativeId, item, emit)` 后 `emit(item)`。
     - 子会话：执行 `observeProjectedSubagentCalls(session, child.nativeId, item, emit)` 后 `emitChildEvent(session, child, item, emit)`（依然受 `child.opened` / `child.pendingEvents` 门控）。
     - 注意：`onFlush` 仅依赖 `emit` 自身的 `if (closed) return;` 守卫，不拦截 `session.closed === true` 期间由 `failSession` / `closeSession` 主动发起的收尾 flush。
   - **`session.stream`**：
     - 根会话：传 `{ deferToolDetail: true }` 调用 `session.projector.projectStream(frame)` 并 `session.coalescer.enqueue(session.nativeId, item)`；当 `frame.type === "end"` 时执行 `session.coalescer.flush(session.nativeId)`。
     - 子会话：当 `session.subsessionsEnabled` 为 `true` 时，传 `{ deferToolDetail: true }` 调用 `child.projector.projectStream(frame)`，若 `projected.length > 0` 立即同步调用 `ensureChildOpened(session, child, emit)`，随后 `session.coalescer.enqueue(child.nativeId, item)`；当 `frame.type === "end"` 时 `session.coalescer.flush(child.nativeId)`。当 `!session.subsessionsEnabled` 时保持原行为（`deferToolDetail: false` 且不入队 `coalescer`，避免产生无人消费的 dirty 状态与定时器）。
   - **边界强制 flush**：
     - `session.event` 到达时：根会话最先 `session.coalescer.flush(session.nativeId)`；子会话在找到 `child` 后最先 `session.coalescer.flush(child.nativeId)`（在 `turn/start`、`turn/end`、`subagent/catalog`、`projectEvent` 之前）。
     - `session.status` 非 `"running"` 时：无论 `session.activeTurnId` 是否存在（覆盖 `dispatch.sawRunning` 延迟结算路径），先 flush 对应 `nativeId`。
     - `interaction.request` 发出前：先 `session.coalescer.flush(session.nativeId)`。
     - `correlateChildWithParentCall` 读取 `pendingSubagentCalls` / 调用 `attachSubagentChild` 之前：先 `session.coalescer.flush(child.parentNativeId)`，保证父工具卡描述已物化且后续不会覆盖 `childSessionId`。
   - **关闭与失败清理（严格避免放进 `releaseBridgeListeners`）**：
     - `ensureChildOpened` 开头加 `if (session.closed) return;`，防止 teardown 期间的收尾 flush 触发新子会话打开。
     - `failSession`：`session.closed = true` → `releaseBridgeListeners` → `flush(session.nativeId)` 且对所有子会话「若 `child.opened && session.subsessionsEnabled` 则 `flush(child.nativeId)`，否则 `discard(child.nativeId)`」→ `session.coalescer.dispose()` → `failRunningTools` 与终态事件。
     - `closeSession`：`session.closed = true` → `releaseBridgeListeners` → `flush(session.nativeId)` 且对已打开子会话 `flush(child.nativeId)`（其余 `discard`）→ `session.coalescer.dispose()`（必须在 `await session.bridge.request("session.close")` 之前清理定时器）→ `finishChildTurn` / `finishTurn` / `session.closed`。
     - `connection.close()` 与 `openSession` 的 `catch`：显式调用 `session.coalescer.dispose()`，保证即使未调用 `session.close` 也绝不泄漏任何定时器。

### 施工顺序

1. 新增 `server/stream-coalescer.ts` 及 `server/stream-coalescer.test.ts`（覆盖文本/思考拼接、`#` 前缀边界、`tool_call` 原地覆盖、leading-edge + trailing 节拍、64 KB 文本上限、防退化、防重入与 `flush`/`discard`/`dispose`）。
2. 在 `server/timeline.ts` 增加 `deferToolDetail`、`dirtyTools`、`materializeToolCall` 与自洽兜底，并在 `server/timeline.test.ts` 补充延迟解析与 `childSessionId` 保留测试。
3. 在 `server/provider.ts` 接入 `StreamCoalescer` 与全部边界 flush / 清理逻辑，并在 `server/provider.test.ts` 补充高并发子代理节流、顺序边界、未打开子会话缓冲、`correlateChildWithParentCall` 关联与关闭/故障清理测试。
4. 同步文档（`docs/server-architecture.md` 补充流式合并节流说明）与发布材料（`package.json`、`package-lock.json` 升至 `0.2.19`，`CHANGELOG.md` 新增 `0.2.19` 条目）。

### 兼容与回退

- **兼容**：仅调整标准 `timeline.item` 事件从插件发往 Paseo Daemon 的节奏，不改变任何 Paseo 协议字段或 DSH 桥接协议；`paseo-plugin.json` 保持 `>=0.11.0`。
- **回退**：改动集中于 `server/stream-coalescer.ts` 与 `server/provider.ts` / `server/timeline.ts` 的调用点，若需回退直接恢复对应提交即可，无持久化数据格式变更。

## 考虑过的其他做法

- **仅对子会话合并、不对主会话合并**：虽可解决 `agent.provider_subagents.update` 风暴，但主会话在插件进程侧仍会承受每 token `JSON.parse`、Zod 校验、Node IPC 传输和宿主 `timelineSnapshots` 增长；采用 leading-edge + 120 ms 对主/子会话统一处理且首片 0 延迟，兼顾两路收益与代码统一。
- **把定时器放进 `TimelineProjector`**：会把纯同步投影器污染成带定时器和异步清理的状态机，破坏现有回放与单元测试隔离。
- **在 `server/dsh/service.ts` 跨进程合并**：需修改 DSH 桥接进程内事件循环与关闭等待逻辑，依然无法解决插件侧 `tool-call-delta` 重复解析与边界同步问题；留在 `server/provider.ts` 离出口与会话状态机最近。
- **复用 `blockId` 并重发累计全文（Paseo 文档常规方式）**：虽能减少宿主 `snapshots` Map 条目数，但每次 flush 传输 $O(\text{总长度})$ 字节，且在 `remainingText` 与非前缀回退场景风险较高；本方案在 120 ms 节流下 `snapshots` 增长已下降 >95% 且保持 $O(N)$ 传输。

## 怎么算做完

- `npm run build`、`npm run typecheck`（含 `shared`/`server`/`client`/`scripts`）、`npm test`、`npm run verify:notes`、`npm run verify:docs` 全部通过。
- 新增单测证明：3 个并行子代理高频发射 ~550 msg/s 文本与 ~90 msg/s 大参数 `tool-call-delta` 时，向外 `emit` 速率降至 ~25–30 msg/s 以下、JSON 解析次数与消息数下降 ≥90%，且合并后拼接文本（含缩进与定稿尾部）、思考气泡、工具卡片、父子关联与关闭清理完全正确、无定时器泄漏。
- 生成 `.github/issue-assets/issue-94/summary.svg`（并通过 XML 与视觉检查），创建候选 PR（引用 `Refs #94`），等待 CI 全绿并经人工确认后才合并发布。

## 风险

- 本机测试通过模拟高速率桥接事件与可控时钟验证节流与时序；未直接在 Paseo Web UI + Relay 真机长时间跑完高并发重构任务，真机体验待发布后由用户最终验收确认。
- 若极多子代理（例如 15 个以上）同时全速输出，单一 120 ms 每会话窗口总速率仍可线性叠加（约 `N × 8.3` 条/秒）；本方案先解决常规 2–5 个并行子代理场景，保留清晰接口以便后续按需引入连接级背压。
