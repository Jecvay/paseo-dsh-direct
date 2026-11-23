# 决策记录: 接入 Paseo 0.17 的提供方 turn 与会话指标

Status: implemented

## 问题

Paseo 0.17.2 给 provider 增加了 `ProviderMetric`、完成回合上的可选 `metrics` 字段和 `session.metrics` 事件。未接入的插件会话只有宿主补的一行 `Model`，用户看不到插件自己测到的耗时、token 与缓存命中。Paseo 0.11 至 0.17.1 没有 `session.metrics` 事件，收到它会被当成未知事件；turn 上的可选字段则会被旧 schema 丢弃。

本项目此前的 `session.usage` 只转发整会话累计 token，没有 per-turn 差值、没有耗时，也没有会话指标；PR #54 明确把 turns/steps/tok/s 留给 Paseo 的自定义 surface。

## 决定

`@getpaseo/plugin` 开发依赖与 `@getpaseo/client`、`@getpaseo/protocol` 可选 peer 固定为 `0.17.3`。`requirements.paseo` 保持 `>=0.11.0`：`session.metrics` 通过连接能力协商启用，旧宿主不提供该能力时插件不发会话指标事件；turn 上的 `metrics` 是可选字段，旧宿主解析时丢弃。理由沿用 [只为真实不兼容提高版本下限](../process/2026-10-11-raise-version-floors-only-on-real-incompatibility.md)。

turn 指标只在 `completed` 终态附带：`Model` 取模型目录的显示名，`Elapsed` 取 DSH `turn/start` 与 `turn/end` 事件的 `time` 差，`Tokens` 取回合起止的累计 token 差（未命中缓存的输入与输出），`Cache` 取 `cacheRead / (uncachedInput + cacheRead + cacheWrite)` 的整百分比，达到 50% 时使用 `ok` tone。任何一行缺少可信数据就省略，不补零。prompt/command RPC 返回前就结束的回合在事件到达时结算，RPC 延迟不进入耗时。

会话指标在打开完成后、每次 usage 变化后和每个完成回合后发送，包含 `Turns`、累计 `Tokens` 与整会话累计 `Cache`，按 JSON 签名去重；`ready` 之前不发。`Turns` 只计 `turn/end` 中分类为完成的回合，包括 `max-tokens`、`blocked`、`interrupted` 这类带警告的完成；失败和取消回合不增加 Turns，也不带 footer 指标。打开会话时从 `session.open` 的 `turn/end` 历史恢复 Turns，并从新增的 `session.open.usage` 恢复整会话 token 基线。恢复会话没有可用 token 快照时，第一条同时带输入与输出的读数成为后续回合的基线；发生在这个回合内的首条读数不会反过来充当该回合起点，所以该回合只显示 Model/Elapsed，下一回合起才有 Tokens/Cache。

桥接在 `session.open` 结果中附带整会话 usage；`BridgeUsage` 增加仅内部使用的 `cacheWriteTokens`，转发给 Paseo 前由 provider 白名单剥离。子会话不参与根会话的 Turns/Tokens/Cache，也不加 footer 指标。cost 不提供：DSH 没有可核实的美元成本数据源。

历史 replay 的逐 turn 指标留作二阶段。数据都在 DSH 持久事件里，但要在每个旧 turn 的 items 之后发对应的 `completed`，还要恢复该 turn 的模型，得用真实宿主验证 footer 归属后才做。

## 考虑过的其他做法

1. **把 `readUsage()` 的累计值直接当 turn Tokens**：不用新增状态，但每一轮都会显示整会话历史，否决。
2. **从每条 `assistant/message.usage` 重新聚合 turn token**：更精确，也能顺带处理 retry，但要复刻 DSH 的 replace 与 attempt 生命周期；首阶段用打开快照/回合起点做差，打开时补基线已能避免历史污染。
3. **按 Paseo 版本决定是否发新事件**：provider 协议只暴露协议版本和能力，不暴露应用 semver，`0.14` 与 `0.17` 的协议版本都是 1；按版本判断不可行，能力协商才是现有契约。
4. **提高 `requirements.paseo` 到 0.17.2**：能省掉降级分支，但旧宿主本来可以安全忽略 turn 字段，普通会话也不依赖新事件；这属于锦上添花，违反最低版本规则。
5. **第一阶段一起做 replay 逐 turn 指标**：Paseo 的 footer 归属要求按 turn 顺序补发 `completed`，且历史路径不会自动补 Model；先用 live 验证数据口径，风险更低。
6. **自己做 cost**：需要维护模型价目表和缓存价格，DSH 不提供权威数值，容易把估算显示成事实，不做。

## 后果

- Paseo 0.17.2 及以上的完成回合显示 Model/Elapsed/Tokens/Cache；会话详情显示 Turns/累计 Tokens/累计 Cache。0.11 至 0.17.1 不显示新指标，连接与现有 usage 保持不变。
- 会话 Cache 采用整会话累计口径，压缩前后会混合；Paseo 内置 provider 更常用最后一轮或最后一次回复的口径。若真实界面反馈累计值不好读，可另开一轮改成 last-turn。
- 最后一次 token 读数如果晚于 `turn/end`，该回合会少算最后一拍，且没有后续修正事件；当前依赖 DSH 在 `turn/end` 前完成 token 投影更新。真实宿主若复现，需要改为回合结束后补读或从消息 usage 聚合。
- 恢复会话的首轮指标取决于打开快照是否带完整输入/输出；只有 context 或部分 token 的 profile 会从首条完整读数起算，首轮可能省略 Tokens。
- 子会话仍显示自己的回合生命周期，但没有 footer 指标；根会话的 token 总量是否包含子代理取决于 DSH 的 `tokenUsage` 投影，本次不改变该口径。
- cost 仍然没有；历史 replay 后旧回合 footer 仍无指标，但会话级 Turns/Tokens/Cache 会在打开时恢复。
- 把一个带父会话继承前缀的 fork 子会话当作普通根会话导入时，`Turns` 可能包含继承历史；正常根会话与实时子会话不受影响。

## 怎么验证的

`npm run build`、四组 typecheck、全量测试、notes 与文档门禁通过。新增测试覆盖：能力协商门控、完成回合的 Model/Elapsed/Tokens/Cache、deferred 回合按事件时间计时、失败/取消不带指标、恢复会话的历史 Turns 与 token 基线、context-only/partial 读数不污染首轮、`session.usage` 合并后转发且不泄漏 `cacheWriteTokens`。

隔离的 Paseo 0.14.0 Daemon（真实 0.14 `server`/`client`/`plugin` 包、真实 DSH、loopback 脚本模型）验证了插件加载、两个插件子进程运行和一次真实回合，说明旧宿主能接受带可选 `metrics` 字段的 turn 事件并保持连接。该 E2E 随后的空闲回收断言在 DSH 0.2.2-rc.5 上与未改动的基线同样超时，属于环境/DSH 版本差异，不作为本次通过项。隔离的 Paseo 0.17.3 Daemon 与随桌面版打包的 0.17.3 Web 渲染器验证了实际界面：Turn stats 弹层显示 Model/Elapsed/Tokens/Cache，Context window 弹层显示 Turns/累计 Tokens/累计 Cache，页面刷新后两者仍在。真实安装的桌面客户端、手机端和用户自己的 Daemon 尚未实测。
