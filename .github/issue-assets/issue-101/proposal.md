# Issue #101: 接入 Paseo 0.17 的 turn/session 指标

Issue: https://github.com/Jecvay/paseo-dsh-direct/issues/101
基线: `ba79bbd3badc4043f67b1708b38adf06da40b0a2`；目标线: `main`（dsh 0.2 线，插件 0.2.x）。

## 问题

Paseo 0.17.2 起，provider 可以在 turn 完成事件上附带 `{ label, value, tone? }` 指标行，并可按 `session.metrics` 能力上报会话级指标。本插件没有接，插件会话在 Paseo 里只有 daemon 补的一行 `Model`，看不到耗时、token 和缓存命中。

预期效果：DSH 的 live turn 在 Paseo footer 显示 Model、Elapsed、Tokens、Cache；会话上下文详情显示 Turns、Tokens、Cache。旧版 Paseo 不显示新指标且连接不受影响。cost 与 replay 逐 turn 指标不在本次范围。

规模判断：普通功能修改，不是通信机制、协议帧或前后端边界变更。需要升级开发用 SDK 版本，但通过能力协商降级，不提高 `requirements.paseo`。

### 三路证据

- 官方（2026-11-23）：Paseo 文档 “Report metrics” 规定 `session.turn` 的 `completed` 可带 `metrics`，`session.metrics` 事件必须先在能力协商中得到同名能力；旧宿主会忽略 turn 上的 `metrics` 字段，但会拒绝并关闭发送了未知 `session.metrics` 事件的连接。`@getpaseo/plugin@0.17.2` 与 `0.17.3` 的 provider metrics 类型相同；两个版本之间只有 ACP 相关文件有变化，本插件不使用这些接口。对本仓有影响的公开类型变化是新增 `ProviderMetric`、`session.metrics` 和变为可选的 `ProviderConfigState.settings`。来源：https://paseo.sh/docs/plugins/providers 、https://github.com/getpaseo/paseo/pull/10496 。
- 社区：Paseo 内置 Claude、OpenCode v2、Pi、Oh My Pi provider 按“完成的 turn 上报可选字段、session token 用累计计数器、cache 单独一个桶”处理（Codex 目前仍只有 Model）；ACP 生态出现过把 session 累计 usage 当 turn 增量求和导致 token 成倍放大的案例。共同经验是计时取 turn 事件时间而不是 RPC 返回时间，缺失数据时不补零。来源：Paseo `packages/server/src/server/agent/providers/*/metrics.ts`、agentclientprotocol/agent-client-protocol#1860 。
- 本项目：`server/dsh/service.ts` 的 `tokenUsage` 投影已经是整会话累计值，含 uncached input、cache read、cache write、output 四个互斥桶；每个 DSH 持久事件带 `time`，`turn/start`/`turn/end` 可用来计时。`sessionUsage` 目前只转发累计 usage，不保存快照；`finishTurn` 只发终态，不带 metrics。PR #54 明确把 turns/steps/tok/s 留给 Paseo 的自定义 surface，本 issue 正是那个 surface 到来后的后续。现有 `requirements.paseo: ">=0.11.0"` 与最低版本决定要求新能力按协商降级。

冲突裁决：issue 说“回放逐 turn 计时 DSH 历史大概率没有”，实际 DSH 事件都带时间；但 replay 的 footer 归属和 model 恢复仍需真实宿主验证，按 issue 的二阶段处理。issue 说 token/cache 直接用 `readUsage()`，实际累计值不能当 turn 值，必须做差；`cacheWriteTokens` 也要补进桥接，否则命中率偏高。

`Turns` 的口径固定为“分类为完成的 `turn/end` 数”：`max-tokens`、`blocked`、`interrupted` 这类带警告的完成计入，failed 与 canceled 不计入。历史恢复和 live 回合使用同一个分类函数。失败/取消后如果 usage 有更新，会话 Tokens/Cache 仍会更新，但 Turns 不变。

## 提案

### 改什么，数据如何流动

1. 依赖：`@getpaseo/plugin` 开发依赖与 `@getpaseo/client`、`@getpaseo/protocol` 可选 peer 一起升到 `0.17.3`。`requirements.paseo` 保持 `>=0.11.0`。
2. 能力：`CAPABILITIES` 增加 `session.metrics`。连接时仍由 `negotiateProviderCapabilities(request.capabilities, supported)` 求交集，旧宿主不会得到该能力。
3. 会话打开：桥接在 `session.open` 结果里附带 `usage`，即 DSH `tokenUsage` + `contextPressure` 的当前整会话累计值；`usage` 至少同时有输入与输出 token 才算可用基线。bridge 协议新增内部字段 `cacheWriteTokens`，只用于计算缓存命中，不转发给 Paseo。
4. turn 计时：根会话收到 `turn/start` 时用事件 `time` 建立测量，记下当时的累计 usage 和模型显示名。`turn/end` 到达时用事件 `time` 结算。prompt/command RPC 返回前的终止继续走 `dispatch.deferred`，但 metrics 在事件到达时就算好，RPC 延迟不进入 Elapsed。
5. turn 指标：`finishTurn` 只在 `completed` 时带 `metrics`。Tokens 用 turn 起止的累计值做差；Cache 用 `cacheRead / (uncachedInput + cacheRead + cacheWrite)` 计算整百分比。数据不完整就省略对应行，不补 0。失败/取消不带 metrics。
6. 会话指标：根会话完成一个 turn 后发 `session.metrics`，内容为 Turns、累计 Tokens、累计 Cache。打开已有会话时从历史 `turn/end` 事件恢复 Turns，并用打开时的 usage 直接给出 Tokens/Cache。只在协商到 `session.metrics` 时发送，且用 JSON 签名去重。子会话不参与根会话指标。
7. 版本与文档：插件版本 0.2.24，CHANGELOG 记录；兼容性文档更新开发 SDK 与验证基线；架构文档补充指标数据来源；按方向性决定写一篇 notes，说明为什么升级 SDK 但不提高宿主下限。

### 施工顺序

1. 升依赖、加能力、修 `settings` 变为可选带来的测试类型错误。
2. 新增 `server/turn-metrics.ts`（格式化、缓存百分比、turn/session 行）与单测。
3. 桥接补 `cacheWriteTokens` 与 `session.open.usage`，补 service 测试。
4. provider 增加 turn 测量状态、usage 快照、会话累计、能力门控和事件发送，补 provider 测试。
5. 更新 `package.json` 版本与 lock、`CHANGELOG.md`、`docs/compatibility.md`、`docs/en/compatibility.md`、`docs/server-architecture.md`、`docs/alpha-acceptance.md`、`README.md`、`OVERVIEW.md`，并写 `.agents/notes/implemented/architecture/2026-11-23-paseo-provider-metrics.md`。
6. 四路 simplify、独立 review、全量验证、`.github/issue-assets/issue-101/summary.svg`、候选 PR。
7. 由仓库本人单独确认合并与发布；issue 评论只写修复说明，不写审批话术。

### 兼容与回退

- 旧 Paseo（0.11–0.17.1）不提供 `session.metrics`，协商结果不含该能力，插件不发 `session.metrics` 事件；`session.turn` 上的 `metrics` 是可选字段，旧宿主解析时丢弃。
- 旧 DSH 没有可读的整会话 token 快照时，插件把首个同时带输入与输出的读数当作后续回合的基线；该回合本身不显示 Tokens/Cache，首个 turn 只统计之后新增的 token；只有 context 或部分 token 的读数不会成为基线。没有 `cacheWriteTokens` 时省略 Cache 行。
- 不改 `client/` 界面，不改 DSH 通信协议版本，不新增运行时依赖，不提高 `requirements.paseo`。
- 回退只需撤回候选提交并重新发一个 patch 版本；没有数据迁移或配置变化。

## 考虑过的其他做法

- 直接用 `readUsage()` 的累计值当 turn Tokens：会把整会话历史算进每一轮，否决。
- 从每个 `assistant/message.usage` 重新聚合 turn token：更精确，但要处理 retry、attempt 缺失和 replace 语义，首阶段用累计差值足够，且已在打开时补基线。
- 发 `session.metrics` 前判断 Paseo 版本：provider 协议只暴露协议版本和能力，不暴露应用 semver；按能力协商是唯一可靠方式，否决。
- 第一阶段一起做 replay 逐 turn 指标：需要处理 footer 归属、稳定 turn id 和历史 model 恢复，风险高于收益，按 issue 留二阶段。

## 怎么算做完

- 数据完整的新宿主：完成的 turn 出现 Model/Elapsed/Tokens/Cache 四行；会话详情出现 Turns/累计 Tokens/累计 Cache；失败/取消的 turn 没有指标且不增加 Turns。
- 数据不完整：缺哪个桶就省略对应行，不补零；旧 DSH 没有 cache write 时只省略 Cache。
- 旧宿主：不出现 `session.metrics` 事件，turn 上的额外字段被忽略，连接与现有 usage 保持。
- 恢复会话：有完整快照时打开即显示历史 turn 数与累计 token，下一轮只增加本轮；只有 context/部分 token 时从首个完整读数起算。
- 自动化：`npm run build`、四组 typecheck、`npm test`、`npm run verify:notes`、`npm run verify:docs` 全部通过。
- 真实 Paseo 0.17 宿主的界面显示需要在候选 PR 后验证；没有独立测试站，发布前由本人确认。旧宿主端到端只验证了加载与真实回合，空闲回收断言在 DSH 0.2.2-rc.5 上与基线同样超时，不算通过项。

## 风险

- live turn 的最后一次 usage 理论上可能晚于 `turn/end`；当前按 DSH 的投影变化顺序处理，若真实宿主发现缺最后一拍，需要改为在 turn 结束时补读或从消息 usage 聚合。
- 会话 Cache 采用整会话累计口径，压缩前后会混合；Paseo 内置 provider 更常用“最后一轮”口径，是否调整留给真实界面反馈。
- 历史 replay 的 turn 指标仍是二阶段；刷新后旧 turn footer 不会立即恢复指标，但会话级 Turns/Tokens/Cache 会恢复。
- 真实 Paseo 0.17 客户端与手机端的视觉效果尚未实测。
