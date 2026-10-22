# 决策记录: 插件侧时间线聚焦模式（折叠思考→工具循环）

Status: rejected — 原生「摘要」模式已承担折叠，插件 transformer 无法合并被思考切开的工具段，且会波及其他 provider；循环不折叠是上游的分组语义，交由上游自行演进

## 问题

用户希望时间线有类似 Claude Code focus mode 的呈现：连续的「思考 → 工具调用」循环折叠显示，只突出当前活动。调查后的现状：

- Paseo 原生「摘要」模式（设置 → 外观 → 工具调用显示，`toolCallDetailLevel`，默认「完整详情」）已经把时间线上**相邻**的 `tool_call` 合并成一个 run，折成汇总徽章（「运行了 N 个命令 · 编辑了 M 个文件」，点开看每次调用明细）。
- 但 run 的封段条件是任何非工具条目——思考行也一样封段（paseo 仓 `packages/app/src/tool-calls/detail-level/grouping.ts` 的 `prepareGroupedHistory()`）。
- DSH 每个 step 都是先思考后动手，插件投影出的时间线恒为「思考 → 工具 → 思考 → 工具」，因此每个 run 只有 1 个调用：工具虽然折成了徽章（「运行了 1 个命令」），思考行却是独立的行夹在中间，循环整体不折叠，视觉上仍是一长排。

## 决定

不做插件侧聚焦模式，也不向上游提 issue/PR；把调查结论记录在案，等上游自行调整分组语义。

## 考虑过的其他做法

1. **插件 transformer 压细思考行**：用 `addTimelineTransformer` 认领 `reasoning` 条目，渲染成更轻的一行，降低视觉密度。缺点：transformer 在原生分组**之后**逐条执行（paseo 仓 `packages/app/src/agent-stream/view.tsx`，分组在 L542、变换在 L564），只能改单条呈现，无法把跨思考的工具段合并成一行；且 client contribution 全 host 生效，transform 只拿到 `{ item, phase }`、没有 agent/provider 上下文，无法只对 DSH 会话生效，会连带改掉同 daemon 上其他 provider 的思考呈现。renderer 虽有 `agentId` 可以按 provider 分支，但那时原生思考行已被替换，回退只能复刻原生行，随宿主升级脆弱。
2. **server 端不投影独立 reasoning 条目**，把思考文本并进后续 tool_call 的 metadata 交由插件渲染：会丢掉原生思考展示与流式渐显体验；renderer 缺失（插件停用、其他客户端）时思考内容直接消失。
3. **给 Paseo 上游提 issue/PR**：让分组把思考并入 run 而非封段（徽章变成「思考了 N 次 · 运行了 M 个命令」，sheet 里展开看思考与明细），对全部 provider 有益，改动集中在宿主 grouping 与 sheet 渲染。不做——上游对时间线呈现有自己的审美，尊重其演进节奏，不替它定方向。

## 重新评估的触发条件

满足任一条即重开本决定：

- 上游把摘要模式的分组语义改为「思考并入 run」或提供等价的整轮折叠档位。
- 插件协议让 transformer 拿到 agent 上下文（可按 provider 限定作用范围）且在原生分组之前执行（可参与合并）。
