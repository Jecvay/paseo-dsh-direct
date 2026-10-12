# 决策记录: 上下文占用圆环滞后一轮：压缩后仍显示压缩前的 prompt 大小

Status: proposed

## 问题

压缩（`/compact` 或自动压缩）结束后，Paseo 的上下文占用圆环不动，仍显示压缩前的大小；直到用户发出**下一次**消息、模型发起下一次请求，圆环才跳到压缩后的真实值。实测（DSH 0.2.0-rc.2，会话 `7063be5b-40f4-40de-a1bd-45f0e7a58941`）：

- 压缩前最后一次请求：`assistant/message` @seq 1757，usage `totalTokens: 382221`。圆环显示 `382 / 1m`、`已使用 38%`——圆环上的 382 就是这次请求的 prompt 大小。
- `/compact` 执行完（`compaction/start` @1762 → `compaction/end` @1765，`command/done` @1766 报 "Compacted 693 history items (~329912 tokens)"）：圆环**仍是 382**。
- 用户发出下一条消息、模型开始回复的那一刻，圆环才变。压缩后第一次请求是 `assistant/message` @seq 1776，usage `totalTokens: 24979`；压缩完约 11 分钟后从 daemon 读到 `contextWindowUsedTokens: 72808`（同一会话 @seq 1980 附近，`totalTokens: 76732`）。

即：**占用读数只在请求产生时前进一步**，压缩本身不带读数。用户视角是"圆环没跟上压缩"，容易误以为压缩没生效。

根因在 DSH 侧，不在本插件的字段映射。`server/dsh/service.ts` 的 `readUsage()` 读 `contextPressure` 投影，取 `pressureTokens`（最近一次请求的 provider 上报 prompt 大小：input + cache read/write，不含 output）。这个字段按 `@deepseek-ai/dsh-token-meter` 自己的契约，**看不到压缩**——只有请求上报 usage，压缩不上报。该包为此另发布 `projectedTokens`＝`pressureTokens` 加上采样之后 surface 的有符号变化（`lib/types/usage-projection.js` 的 wire view），但 surface 的缩减量来自 `compaction/summary` 上的影子价格，而 DSH 0.2.0-rc.2 实际写进日志的 `compaction/summary` payload 只有 `compactionId`、`sourceCommandId`、`summary`、`rawOutput`——**`shadowedRange` / `shadowedTokenCount` 两个字段根本不存在**。`foldSurfaceProjection` 拿不到 claim，按"无相邻影子价格的替换折叠为零增量"处理，于是 `surfaceTokens` 不变，`projectedTokens` 也就没有降下来。

后果是 DSH 自己的 ContextMeter 同样滞后——这是 harness 的读数粒度问题，不是 Paseo 或本插件特有的缺陷。本插件只是把 DSH 给的数搬到 Paseo：daemon 侧 `lastUsage.contextWindowUsedTokens` 实测为 72808，而直接读同一条会话日志的 dsh 投影得到 71631；两者不是同一瞬间取样，量级与趋势一致，没有映射错误。

## 提案

**现在什么都不改**，把这条记下来等上游补齐读数通道。触发条件明确、可机械检查：

1. **触发**：升级 dsh 版本时，检查新版 `compaction/summary` 事件是否新带 `shadowedRange` / `shadowedTokenCount`（或 `contextPressure` 是否新增了别的、压缩后立即更新的字段）。
2. **检查方式**（不用跑完整会话，解开 npm tarball 即可）：解压新版的 `@deepseek-ai/dsh-token-meter`，看 `lib/types/surface-projection.js` 的 `foldSurfaceProjection` 是否还在处理影子价格，以及 `@deepseek-ai/dsh-compaction-basic` 写出 `compaction/summary` 时是否带上这两个字段。若上游仍不写，保持现状。
3. **上游写了之后**：若 `compaction/summary` 带上了影子价格，`projectedTokens` 会自动开始响应压缩。此时 `readUsage()` 要读 `projectedTokens` 而不是 `pressureTokens`（dsh 自己的 ContextMeter 用的就是这个，`grep 'projectedTokens ?? pressure?.pressureTokens' dsh-client-ui-conversation/lib/client.js`）。

   bridge 侧的触发链路**不需要改**：`onChanged` 已经对 `contextPressure` 有反应（只过滤 `tokenUsage` 和 `contextPressure` 两个 key，见 `server/dsh/service.ts` 的 `readUsage()` 与构造函数里的订阅），卡点在 `readUsage()` 的词汇表里没有 `projectedTokens` 这个字段可以搬。所以这不是"订阅漏了 key"，而是取值字段的问题——只改 `readUsage()` 一处即可，改完压缩结束的那一刻圆环就会更新。

若上游走了另一条路（例如新增一个"压缩后重新计量"的事件或字段），以上第 1、2 步照样能发现，按实际字段名调整第 3 步。

## 考虑过的其他做法

- **立刻改用 `projectedTokens` 作为分子**：只改一行，看起来像是现在就修好了。实测这条路在压缩场景下没有收益——`projectedTokens` 与 `pressureTokens` 在压缩后的同一份 snapshot 上只差 266（71365 对 71631，会话 `7063be5b`），因为上游没写影子价格，`surfaceTokens` 根本没缩。单独改字段不解决问题，反而会让人以为已经修好了。
- **解析 `command/done` 的文案里那个 "~329912 tokens"，自己从读数里减掉**：优点是不依赖上游，立刻能显示。缺点有三：那是给人读的本地化文案（解析字符串，上游改一个词就静默失效）；自动压缩没有这个 `command/done` 事件，只覆盖手打 `/compact`；"~" 说明它本身是估算，减出来的数在下一轮就被 provider 的真实值取代，圆环会先跳到估算值再跳回来。用一个会静默失效的字符串解析换一次跳变，不值得。
- **在 bridge 里自己调 `ctx.tokenMeter.measure()` 重算压缩后的 prompt 大小**：优点是完全不依赖上游，压缩后立即有数。缺点是 `measure()` 是固定启发式（每 4 字符 1 token），系统性地低估中文与 JSON schema；圆环会先显示我们的估算、下一轮再被 provider 的真实值覆盖，等于把"滞后一轮"换成"显示一个不准的中间值再跳"。而且 bridge 得因此 `inject` token-meter 服务，在没有该服务的 profile 上要额外降级。等上游补影子价格更干净。
- **把这条反映给 dsh 上游**：用户已决定不做——dsh 上游没有 issue 通道。本记录就是这条发现的唯一落点，等升级时按上面的触发条件自查。

## 怎么算做完

- 压缩（`/compact` 与自动压缩两种来源都算）结束后，**用户不发出任何新消息**的情况下，Paseo 圆环在数秒内显示压缩后的占用，不再等于压缩前的值。
- 验收要用真实 dsh 会话跑一遍：记录压缩前最后一次 `assistant/message` 的 `totalTokens`，执行压缩，不签发下一条消息，直接读 Paseo 侧 `lastUsage.contextWindowUsedTokens`，它必须已经接近压缩后的大小而不是压缩前的大小。同一会话的下一次真实请求上报的值与圆环显示值之差，应保持在读数粒度允许的范围内。

## 风险

- **上游不写影子价格**：这条会长期停在 `proposed`。`proposed` 永不归档（见 [notes/README.md](../../README.md)），所以它会一直躺在目录里等触发条件；代价是每次读 `.agents/notes/proposed/` 都要过一次它的判据。
- **上游换了机制**：第 1、2 步只认字段名，若上游改成别的事件形态，检查会得出"上游仍不写"的结论而漏掉修好的情况。所以第 2 步的问法要落在"压缩后有没有可用的真实读数"上，不只盯两个字段名。
- **记录过期**：本条基于 dsh 0.2.0-rc.2 的实际日志形态。dsh 升级本身不自动让这条失效，但若压缩事件形态变了，第 2 步的检查方式要在同一次升级里改齐。
- **不做的代价**：圆环在压缩后的一轮里显示偏大（本例 382k 对真实 25k，约 15 倍），用户会误以为压缩没生效——但这不会导致任何错误操作，只是观感问题。
