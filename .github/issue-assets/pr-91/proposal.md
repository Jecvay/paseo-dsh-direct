# PR #91：允许调整桥接就绪等待时间

## 目标与范围

[PR #91](https://github.com/Jecvay/paseo-dsh-direct/pull/91) 希望允许繁忙主机延长 DSH 桥接的 15 秒就绪等待。原始候选为 `0d2156250630aefa8b245295f55a6da8a221b3f9`，审查基线为 `main` 的 `0cdd32197f081a49bba8f46f4368e995a7c7a911`（0.2.17）。本次直接续办 PR，没有关联普通 issue。

插件负责启动、等待与清理自己拥有的 DSH 子进程，因此设置等待上限属于插件职责。功能只控制桥接进程 `spawnDsh` 到收到 `bridge.ready` 的等待；默认仍为 15 秒，显式设置接受 1–600 整数秒。Provider `createBridge` 与子代理设置 `open` 两处入口覆盖所有新桥接，包括会话创建/恢复、目录/历史发现和设置读写。前置 profile 创建 60 秒、配置检查 20 秒与后置 `bridge.initialize` 30 秒各自独立。此候选不降低并发、不自动重试、不修复确定性死锁，也不保证整个操作在设置窗口内完成。保留 Direct Provider、跨端边界和最低版本。

作者报告空闲时约 5 秒启动，并将繁忙时超时归因于多会话恢复。该计时使用浏览器就绪日志，不能代替插件 `bridge.ready` 的计时；本轮尚未独立复现繁忙机器的并发故障或宿主重试行为。

## 三路独立调查

核对日期：2026-11-09。官方接口、社区经验和项目历史由三个独立 agent 只读调查，随后另做方案审查。

- 官方 Paseo：开发 SDK 锁定 `@getpaseo/plugin@0.14.0`，查询时最新包为 0.15.3。[设置契约](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/plugin/src/settings.ts) 支持 host 设置；新增可选字符串兼容已有 version 1 文档，无须迁移。已分别核对最低支持版 [0.11 runtime @ 22488d4](https://github.com/getpaseo/paseo/blob/22488d4502cd0c8a4ee4619af991762f071b60a7/packages/server/src/server/plugins/runtime.ts)、SDK 对应 [0.14 runtime @ 8c6de84](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/plugins/runtime.ts) 与 [0.15.3 runtime @ d91ae13](https://github.com/getpaseo/paseo/blob/d91ae138cb931447635e94296023414a58bedcc5/packages/server/src/server/plugins/runtime.ts)：三者的 `provider.connect` 和普通插件 RPC 均有 30 秒外层时限。对应已连接会话的 `session.open` 事件路径（[0.11](https://github.com/getpaseo/paseo/blob/22488d4502cd0c8a4ee4619af991762f071b60a7/packages/server/src/server/agent/plugin-provider.ts)、[0.14](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/agent/plugin-provider.ts)、[0.15.3](https://github.com/getpaseo/paseo/blob/d91ae138cb931447635e94296023414a58bedcc5/packages/server/src/server/agent/plugin-provider.ts)）没有同类计时器。较大设置不能承诺目录发现或子代理设置端到端等待 600 秒。RPC 超时不保证取消底层 task，设置保存可能稍后提交，重试前应读取并核对状态。以上是固定源码结论，各版本实测结果仍须单独记录。
- 官方 DSH：查询时 npm 最新与本机版本均为 `0.2.2-rc.1`，不作为本项目锁定依赖。[profile 启动源码](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/cli/src/profile-boot.ts) 在启动树完成后提交 `appReady`。`bridge.ready` 属于本插件注入的桥接入口，并非 DSH 官方公开协议。无需升级依赖或提高最低版本。
- 社区：[Claude Code 并发恢复报告](https://github.com/anthropics/claude-code/issues/107472) 展示多会话启动可能触发 MCP 超时，但只是另一项目的用户报告；[OpenClaw 初始化重试改动](https://github.com/openclaw/openclaw/pull/177331) 强调原始 deadline、取消、有限重试与清理。它处理网络初始化的 429，不是本仓的本地就绪信号，不能照搬协议或据此认定本仓根因。
- 项目历史：[issue #50](https://github.com/Jecvay/paseo-dsh-direct/issues/50) 与 [#48](https://github.com/Jecvay/paseo-dsh-direct/issues/48) 记录 Windows shim 等待 stdin EOF 的死锁，现由直接启动底层程序处理，加长等待不能修复它。[PR #82](https://github.com/Jecvay/paseo-dsh-direct/pull/82) 的启动排空与迟到桥接清理已在主线，应保留并回归。[设置 issue #9](https://github.com/Jecvay/paseo-dsh-direct/issues/9) 与当前实现支持热读设置、只影响新桥接。没有同类未完成候选需要另开 issue。

## 施工方案

1. 合入当前 main 到隔离候选分支，保留贡献者原始提交与署名；仅向原 PR 候选分支推送，不改发布分支。
2. 保留 `startupTimeoutSeconds` 可选文本设置及两处起桥透传。空白用默认，非法文本忽略这一项并保留 executable/profile；诊断只写固定错误原因，不回显用户输入。统一默认常量，避免 UI 与启动器分离。
3. UI 与当前行为文档统一称桥接就绪等待，说明适用所有新桥接、前置检查与后续初始化各自的时限、宿主外层限制及较长关闭等待。校正现有笔记的实测口径，不另造重复决策。
4. 补可控子进程测试：同一延迟在短窗口失败、长窗口成功；永不就绪失败后进程和临时目录清理；就绪前退出快速失败。保留解析边界、设置热读和现有 Provider 关闭竞态回归。
5. 准备版本 0.2.18、锁文件、changelog 和图解；四路 simplify、独立 code review、风格审查后完成完整门禁、隔离真实 DSH 验收及最终 HEAD 的 CI。
6. 仅在验收结果足以支持候选时请求本人批准精确 HEAD 的合并与发布；否则记录缺失证据，继续补验收。未批准不合并、不发布、不更新用户现用环境。

## 验收与取舍

必需：build、四个 typecheck target、全部单元测试、notes/docs 门禁和 diff 检查。以下标准用于填写结果，不表示已通过：

| 验收项 | 必须提供的证据 |
|---|---|
| 解析与入口 | 1/600 接受，空白默认 15；0/601/小数/非数字被忽略且保留其他字段，诊断不回显输入；两处入口热读并传入全部新桥接 |
| 就绪与清理 | 同一个受控子进程延迟在短窗口失败、长窗口成功，至少一例 ready 超过 15 秒；永不 ready 和 ready 前退出时清理进程与临时目录；启动途中关闭、迟到桥接和并发关闭回归 |
| 独立阶段 | profile init 60 秒、dump 20 秒和 initialize 30 秒不随设置变化；ready 后 initialize 卡住按其独立时限失败 |
| 宿主兼容性 | 对 Paseo 0.11 / SDK 对应 0.14 / 0.15.3 分别记录固定 SHA 与运行结果；验证 Provider connect、普通插件 RPC 的 30 秒外层边界，以及已连接 `session.open` 超过 30 秒后的 ready 行为；未运行版本标为未验证 |
| 超时后保存 | 受控 settings save 延迟触及 RPC 超时，观察底层 task 与持久配置是否稍后提交；读取状态后再决定是否重试，不把超时当作取消 |
| 真实 DSH 与 UI | 临时 home/profile 完成 ready、初始化与关闭，不调用收费模型；直接测量 spawn → `bridge.ready`，记录版本和平台；无 UI、真机或并发慢启动证据的项目各自标为未验证 |

新增子进程测试必须验证实际等待和清理，不能只检查源码字符串。完整标准同步于 [Alpha 验收规范](../../../docs/alpha-acceptance.md#桥接就绪等待验收)。

600 秒是显式可选的策略上限，没有生产延迟分布支撑。较长等待可能延长失败反馈以及连接关闭等待。隔离真实 Paseo 0.15.3 运行时确认：32 秒的连接与普通 RPC 都在约 30 秒报错，但普通 RPC 的临时保存标记仍在 32 秒写入；模拟 600 秒启动的插件在关闭后，其普通 Node 子进程仍然存活。这证明宿主没有替插件回收任意子进程的保证，尚未据此认定真实 DSH 一定遗留。

因此候选增加仅在插件卸载时生效的启动取消信号：两处入口共用、跟踪未完成启动；卸载先取消，起桥各阶段停止自己的启动进程并清理临时目录，再等待任务结束。启动成功后移除启动取消监听，活动会话仍由既有 Provider 关闭路径处理。新增卸载期间启动的真实候选测试必须确认子进程和目录被回收。这是同一插件生命周期的清理修复，不更改协议、前后端边界、依赖或最低版本。全局启动队列、自动重试与连接级取消重构仍不在范围。保留默认值可避免所有用户默默承担更长等待。

提高固定默认值会让所有故障更晚反馈；增加环境变量会复制已有设置入口；自动重试会增加进程和竞态；共享会话进程违背当前隔离模型。均不在本次范围。撤回候选无需数据迁移。

## 实际结果

三路调查、独立方案审查、四路 simplify、独立 code review 和风格审查已完成。候选合入最新 main 后的最终门禁通过：build、四个 typecheck target、271 项测试（另 2 项环境条件跳过）、notes/docs 门禁和 `git diff --check`。真实 DSH 设置验收、受控 16 秒 ready 和真实 Paseo 0.15.3 双端编译器均通过。四路建议中采纳默认常量解耦、毫秒单位注释、测试失败时回收已打开桥接；宿主实验又发现卸载时可能留下未就绪子进程，因此新增启动取消与关闭确认，最终 code review 已复查该修订。CI 尚待推送后运行。

Linux、Node 24.22.1 下，真实 DSH 0.2.2-rc.1 使用临时 home 完成设置初始化、保存、冲突拒绝、恢复与关闭；独立测量 spawn 到插件 `bridge.ready` 为 1781ms，初始化完成且子进程退出。受控子进程延迟 16 秒，在 20 秒配置下约 16082ms 完成初始化，关闭后进程和临时目录均回收。这些结果不证明并发负载原因或各平台界面已通过。

真实 Paseo 0.15.3 双端编译器通过。隔离宿主通用连接/RPC实验在约 30001ms 超时，32 秒后连接被关闭、普通 RPC 临时保存标记仍写入；该实验验证宿主行为，未冒充本仓真实子代理设置保存验收。安装包 runtime.js 的 SHA-256 为 `908804bb291f37c2b02f756dfbaba46dd2942daa7044f399ca131ab03a826574`。0.11/0.14 只有固定源码核对，未运行对应宿主。真实候选卸载回收与已连接会话超过 30 秒的结果已在 Paseo 0.15.3 隔离宿主验证：设置 600 秒等待时，`stopPluginById` 触发插件 disposer，18ms 后插件与启动子进程均退出，临时目录删除；已建立连接后的 32.1 秒 `session.open` 到达 `session.ready`。`index.server.ts` / `server/bridge-client.ts` 源码摘要为 SHA-256 `f7a43abdd15e824e136f674f5a9becac38eea06e4c3bb9e8cd97d6465550dac5` / `12d8535630ed129fdb4de9e73fc68ba1838f8d60263867ad0934dadf457c5bfe`，编译 bundle SHA-256 `fd9a07d7962ac8acf4204c51632cb4f6a05ba580835c8f6a45e9b2ada4492b30`。此结果只适用于 Node 24.22.1/Linux x64 隔离宿主，未运行 Paseo 0.11/0.14；候选最终 SHA 与 CI 尚待。

并发慢启动、Windows/macOS 运行、原生移动端和真实设置页输入保存尚未实测；真实模型交互测试缺少凭证，固定 Paseo 0.14 全生命周期测试缺少对应运行时依赖。最终 HEAD 的 CI 待推送后核实。本候选未获合并/发布批准、未合并、未发布。

配套图解：[summary.svg](summary.svg)。图中的待验证状态与本文一致，后续只根据实际证据更新。
