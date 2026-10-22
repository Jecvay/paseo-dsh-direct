# 决策记录: 上下文占用圆环滞后一轮：压缩后仍显示压缩前的 prompt 大小

Status: implemented

## 问题

压缩（`/compact` 或自动压缩）结束后，Paseo 的上下文占用圆环不动，仍显示压缩前的大小；直到用户发出下一次消息、模型发起下一次请求，圆环才跳到压缩后的真实值。根因在 DSH 侧的读数粒度：`@deepseek-ai/dsh-token-meter` 的 `contextPressure` 投影把占用记为最近一次请求的 prompt 大小（`pressureTokens`），压缩本身不上报请求，投影也就不动。dsh 0.2.0 的 `compaction/summary` 只写 `compactionId`、`summary`、`rawOutput` 等字段，token-meter 折算压缩缩减量所依赖的影子价格（`shadowedRange` / `shadowedTokenCount`）根本不存在，`projectedTokens`（`pressureTokens` 加上压缩后的 surface 缩减）算不出来，DSH 自己的 ContextMeter 同样滞后。实测（dsh 0.2.0-rc.2，会话 `7063be5b-40f4-40de-a1bd-45f0e7a58941`）：压缩前圆环 382k，`/compact` 完成后不变，下一条消息发出后跳到约 25k。

## 决定

桥接的 `readUsage()`（`server/dsh/service.ts`）读上下文占用时优先取 `contextPressure` 投影的 `projectedTokens`，字段不存在（dsh 0.2.0 及更早）时回退 `pressureTokens`；投影一变就重发，不等下一次请求。dsh 0.2.1 起 `compaction/summary` 写入 `shadowedRange` / `shadowedTokenCount`，`projectedTokens` 在压缩结束的那一刻就反映压缩后的占用，圆环随之更新。压缩卡片上的被压缩 token 数（`server/timeline.ts` 一直读 `shadowedTokenCount`）也从同一个上游改动拿到真实值。桥接侧订阅不用改：`onChanged` 本来就对 `contextPressure` 有反应，卡点只在取值字段。

## 考虑过的其他做法

- **不等上游、直接改读 `projectedTokens`**（当时 dsh 0.2.0 不写影子价格，`projectedTokens` 与 `pressureTokens` 只差 266）：只改一行却像修好了，实际压缩场景没有收益，反而掩盖问题——放弃，等触发条件（上游写入影子价格）后实施。
- **解析 `command/done` 文案里的 "~N tokens" 自己减**：字符串解析随上游措辞静默失效；自动压缩没有该事件；估算值在下一轮被真实值取代，圆环先跳过去再跳回来——放弃。
- **桥接里用 `ctx.tokenMeter.measure()` 重算压缩后的 prompt 大小**：固定启发式系统性低估中文与 JSON schema，圆环先显示不准的中间值再被真实值覆盖，且要为没有 token-meter 服务的 profile 做降级——放弃。
- **把缺字段反映给 dsh 上游**：dsh 没有 issue 通道，本记录是这条发现的唯一落点——不做。

## 后果

- dsh 0.2.1 及以上，压缩结束后不签发新消息，圆环在数秒内显示压缩后的占用；旧版 dsh 行为不变（滞后到下一次请求）。
- 剩余验收：在真实压缩会话上观察一次「压缩后圆环立即下降、不签发新消息」（需要 `DEEPSEEK_API_KEY`）。字段链路已由包源码核对与单测覆盖，但未在真实压缩中复现。

## 怎么验证的

- dsh `0.2.1-rc.2` 包源码核对：`@deepseek-ai/dsh-compaction-basic` 的 `commitCompactionBody` 写 `shadowedRange` / `shadowedTokenCount`；`@deepseek-ai/dsh-token-meter` 的 `pressureSchema` 带可选 `projectedTokens`。
- 单测（`server/dsh/service.test.ts`）：`projectedTokens` 存在时圆环读数取投影值，缺失时回退 `pressureTokens`。
- `npm run smoke:bridge` 在 dsh `0.2.1-rc.2` 加 350+ 会话真实历史上通过（握手、目录、`session.list`）。
