# Issue #96: 在审批前显示完整计划正文

## 问题

[Issue #96](https://github.com/Jecvay/paseo-dsh-direct/issues/96) 报告：计划模式能弹出 Approve / Keep planning，但计划正文不可见，工具卡只有 raw JSON。

基线：`bdbbb87ec2cb5cb70d729014d0feab0ac3828200`；目标：`main`；当前版本 `0.2.19`，候选准备 `0.2.20`。

已用合成 `tool/call` 在基线复现：`exit_plan_mode` 的 Markdown 被包装成 `unknown.input.raw`。桥接已原样传递 `QuestionItem.detail` 和 `intent`，但 `server/provider.ts` 将计划审核统一转成普通问答，没有传递正文。属于本插件的呈现与回复映射责任；这是普通修复，不改变协议、依赖、最低版本或前后端边界，不需要 `wait-human`。

### 三路证据

访问日期：2026-11-15。三路独立只读调研分别核对官方接口、社区经验与项目历史。源码证明接口与调用语义，尚不能代替本候选的实际运行验收。

- 最新版本核对：Paseo npm latest 为 [0.15.4](https://github.com/getpaseo/paseo/tree/1c00b365c9e0b74c1580eba33d905d693125ae21)，beta 为 0.16.0-beta.2；DSH npm latest 为报告使用的 [0.2.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db)，GitHub 最新发布及 npm next 为 [0.2.2-rc.3](https://github.com/deepseek-ai/deepseek-harness/tree/38a6a5c965aa99ab525161efb7cc5cf1fe62fced)。运行验证使用已安装版本，版本通道差异不触发依赖升级。
- 官方 Paseo：[最低支持版本 0.11 的 Provider 类型](https://github.com/getpaseo/paseo/blob/22488d4502cd0c8a4ee4619af991762f071b60a7/packages/plugin/src/server/provider.ts) 已有 `detail.type: plan`、`kind: plan`、`metadata.planText` 与权限动作；[0.11 原生界面](https://github.com/getpaseo/paseo/blob/22488d4502cd0c8a4ee4619af991762f071b60a7/packages/app/src/agent-stream/view.tsx) 将 deny 按钮发送为 `behavior: deny`、`selectedActionId` 和默认拒绝文字。官方调研同时核对开发 SDK 0.14 与当前源码，使用这些接口不需提高最低版本。
- 官方 DSH：[报告使用的 0.2.2-rc.1 计划工具](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/plan/plan-mode/src/index.ts) 提交单个 `plan-review` 问题，完整 Markdown 在 `detail`，批准标签在 `intent.approve`；当前源码仍使用 Approve / Keep planning 两个选项。该工具需要收到选项答案；拒绝整个问答请求会取消审核，不能当成继续规划。公共问答契约允许其他形状，因此双选限制是本插件保守选择原生计划卡的条件，不是上游协议要求。
- 社区：[Prompt Studio 计划审核实现](https://github.com/pufflyai/prompt-studio/blob/8d64cf17ab7a602b85be2babd9230cf83f77147c/extensions/harness-claude-code/src/plan-mode.ts) 专门展示 Markdown，只接受精确批准答案，反馈继续规划；[Centralu #2043](https://github.com/ijun17/centralu/issues/2043) 报告同类 raw JSON 展示缺陷，其关联录制 PR 只提供证据，未修复展示；[ClaudeCodeUI 计划卡](https://github.com/Atypical-Consulting/ClaudeCodeUI/blob/80c1d63c338ed12bb24fe989fb999242c89babce/Components/Session/PermissionCard.razor) 复用 Markdown 组件并区分 Keep planning。共同经验是明确识别审核、在决定前展示正文、区分批准与继续规划；这些项目使用 Claude 协议，不能把其 `updatedInput` 或权限模式修改照搬到 DSH。调研实际联网检索并读取固定源码，未运行第三方产品；第三方问题报告不算本次独立复现。
- 项目：[历史 #8](https://github.com/Jecvay/paseo-dsh-direct/issues/8) 是计划模式状态卡，不负责计划正文；[PR #84](https://github.com/Jecvay/paseo-dsh-direct/pull/84) 要求精确匹配内置工具名，MCP 保持通用卡；[PR #82](https://github.com/Jecvay/paseo-dsh-direct/pull/82) 已处理问答中的逗号与自定义输入，普通问答路径应保留。当前实现位于 `server/timeline.ts`、`server/provider.ts`，桥接契约位于 `shared/bridge-protocol.ts`。

## 提案

### 改什么，数据如何流动

1. `server/timeline.ts` 精确识别 `exit_plan_mode`，将 `args.plan` 映射为 `{ type: "plan", text }`；缺少有效字符串时以空正文等待流式参数完成。既有流式、定稿、结果与历史回放共用此映射；MCP 和近似工具名仍走通用分支。
2. `server/provider.ts` 用一个纯 helper 识别单题、单选、非空正文、明确 `plan-review` 意图且有两个不同有效标签的审核；批准标签必须来自 `intent.approve` 并命中选项。其他形状继续使用完整普通问答路径，避免吞掉额外问题。
3. 识别成功后发送 `kind: "plan"`、原问题标题、`input.plan`、`metadata.planText` 和计划 detail，使用固定 `approve-plan` / `keep-planning` 动作。批准动作使用 allow；继续规划动作使用 deny，适配宿主原生按钮协议。
4. 回复使用同一识别 helper：批准动作（含没有 action id 的传统 allow）选中 `intent.approve`；明确点击 keep-planning 且没有 `interrupt: true` 时选中原来的另一选项。其他拒绝或中断仍取消请求，不把默认拒绝文字当修改意见。未知 action id 取消问题，不得批准计划。原生计划卡不新增文字反馈输入框；普通问题的答案解析和逗号处理不变。
5. `server/dsh/service.ts` 用 DSH 已支持恢复的 `{ name: "UserQuestionError", code: "ASK_CANCELLED", message }` 错误格式取消问题。真实宿主集成发现，普通 `Error("Question cancelled")` 会被当成工具失败，导致模型再次运行；DSH 0.2.2-rc.1 和 rc.3 的 `userQuestions.ask` 会将带类型的错误恢复为原生取消错误，使计划工具结束当前回合。此修正不引入新依赖或改变 RPC 帧。
6. 同一 PR 准备 `0.2.20`、changelog、当前行为说明、此方案和 SVG/PNG 图解。不改用户当前安装。

### 施工顺序

先实现和复现回归测试，再验证真实 DSH 与隔离 Paseo 宿主的计划审批往返。四路 simplify 与独立 code-review 完成后，对最终候选执行构建、类型检查、完整测试、文档门禁和包内容核查。补齐实际验证结果，推送候选并等待最终 HEAD 的确定性 CI 结果。

### 兼容与回退

Paseo 最低版本保持 0.11，开发 SDK 保持 0.14；使用宿主原生 Markdown 计划呈现，客户端不新增 Node/DOM 依赖。未携带审核意图或复杂问题组保持原普通问答行为；工具卡仍能展示有效计划正文。回退只需撤销本候选，无持久数据迁移或用户配置变更。

## 考虑过的其他做法

- 只修工具卡：能在展开工具后读计划，但审批卡仍缺正文，也没有解决原生计划审核入口。
- 将任何含计划字样的问题转成计划卡：容易误判并丢掉问题，故要求明确意图与保守形状。
- 新增自定义客户端计划组件：重复 Paseo 原生能力，还需承担跨端兼容，没有必要。
- 将 Keep planning 直接作为取消：DSH 无法收到继续规划选项，会中断现有工具流程，拒绝此方案。

## 怎么算做完

- 原生工具卡在实时流、定稿、结果和历史回放中保留 Markdown；部分参数不显示 raw JSON，近似/MCP 名称不被误识别。
- 审批卡包含完整计划与两项原生动作；批准、继续规划和中断分别映射到正确的 DSH 答案或取消，不会误批准。
- 复杂/不完整审核回到普通问答，普通问题与含逗号的自定义输入回归通过。
- 隔离环境用真实 DSH 和 Paseo 验证往返，不连接用户当前 daemon，不调用收费模型。实际客户端和平台未测项明确列出。
- 候选 PR、图解、最终验证和版本可审查；本人先决定合并与发布，发布核验后再决定最终体验结案。最终确认前 issue 保持打开，PR 不含自动关单关键字。

## 风险

原生客户端展示取决于 Paseo 自身的计划组件。协议与宿主集成验收不能冒充手机真机或实际 Web UI 验收；发布审批时需明确尚未覆盖的范围。对复杂审核保守退回普通问答，避免自行推断批准选项。

## 实施与验证记录

- 已完成两处原生计划映射及带类型的问答取消；没有新增依赖、协议字段或客户端组件。
- 四路独立 simplify：清晰度、职责边界和效率资源均无发现；复用角度建议将已有普通问答测试与计划测试抽成公共 fixture。未采纳这项低优先级建议：计划测试已用本地 setup 复用自身初始化，跨越既有测试的重构增加本次范围，且同步关闭交互需要保持显式。最终独立 code-review 另行执行，不以 simplify 代替。
- `npm run build`、四个 typecheck target、`npm test`（302 pass、0 fail、3 个默认环境跳过）、`verify:notes`、`verify:docs` 与 `git diff --check` 通过。默认跳过包括真实收费模型、旧的 Paseo 0.14 隔离验收，以及需显式开启的新计划集成测试；新计划集成另外手动启用运行，结果见下。
- Linux：真实 Paseo 0.15.4 分别搭配 dsh 0.2.2-rc.1（13.3 秒）与 0.2.2-rc.3（13.5 秒）的隔离集成均通过。宿主收到完整计划、原生格式批准使 DSH 退出计划模式、继续规划使其提交新稿、明确中断不再调用模型、重载后保留三个版本的计划。全程使用临时 home 和 loopback 脚本模型，不调用收费模型、不改当前安装。
- `npm pack --dry-run --json`：40 个分发文件，版本 0.2.20，不含测试和 issue 图解材料。SVG 的 XML 与实际 PNG 渲染检查通过。
- 尚未验证：实际 Web、桌面与手机的 Markdown 视觉和点击体验；Paseo 0.11/0.14 为源码契约核对，本次未运行它们的真实宿主。
- 候选尚未合并或发布。本人明确批准当前完整候选后才执行合并与发布；发布核验后另请本人确认最终体验，确认前不关闭 issue。
