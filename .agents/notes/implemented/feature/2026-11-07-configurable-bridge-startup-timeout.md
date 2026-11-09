# 决策记录: 桥接启动等待可由设置页调整

Status: implemented

## 问题

桥接就绪等待默认是 15 秒。作者报告空闲机器上 `paseo` / `web` profile 各三次约 5.2–5.4 秒，并将繁忙时的超时归因于多会话恢复；计时取自浏览器就绪日志，不能代表本插件的 `spawn → bridge.ready`。目前没有独立复现并发慢启动、确认宿主重试行为或测得生产延迟分布的证据。因此，允许用户显式延长就绪等待可以提供排障余地，但不能据此认定根因或宣称修复了并发恢复故障。

## 决定

候选实现保留设置页 `Connection` 区域的 `Startup timeout`（`shared/settings.ts` 的可选字符串 `startupTimeoutSeconds`）。`server/dsh-config.ts` 的 `parseStartupTimeoutSeconds` 接受 1–600 整数秒并换算成毫秒，经 `DshConfigured.startupTimeoutMs` 传递。留空或纯空白仍使用共享默认常量的 15 秒；600 秒是策略上限，没有生产延迟数据支持它作为实测阈值。没有环境变量覆盖。非法文本只忽略超时项并保留 executable/profile，诊断记录固定原因，不回显输入。

`index.server.ts` 的 Provider `createBridge` 与子代理设置 `open` 两处入口在每次起桥时读取设置，传给 `launchDshBridge` 的 `waitUntilReady`。这涵盖会话创建/恢复、目录/历史发现、子代理设置读写的所有新桥接；运行中的桥接不变。窗口只覆盖桥接进程 spawn 到收到 `bridge.ready`；前置 profile 创建 60 秒、配置检查 20 秒和后置 `bridge.initialize` 30 秒各自独立。

宿主的外层时限保留：[Paseo 0.11 runtime](https://github.com/getpaseo/paseo/blob/22488d4502cd0c8a4ee4619af991762f071b60a7/packages/server/src/server/plugins/runtime.ts)、[SDK 对应 0.14 runtime](https://github.com/getpaseo/paseo/blob/8c6de842a3157530c26a7a94c78a3d647fb96ce9/packages/server/src/server/plugins/runtime.ts) 与 [0.15.3 runtime](https://github.com/getpaseo/paseo/blob/d91ae138cb931447635e94296023414a58bedcc5/packages/server/src/server/plugins/runtime.ts) 均对 `provider.connect` 和普通插件 RPC 设 30 秒计时器；已连接的 `session.open` 事件路径没有同类计时器。设置不能承诺目录发现或设置操作端到端等待 600 秒。RPC 超时不保证取消底层 task，子代理设置保存可能稍后提交，重试前须核对状态。

## 考虑过的其他做法

- **提高固定默认值**：改动小，但所有故障都会更晚反馈，也无法适配不同主机。保留默认 15 秒，把更长等待留给显式选择。
- **增加环境变量**：无需设置控件，但会复制现有设置入口；就绪等待不改变安装身份，现有设置的逐次读取已覆盖这个参数。
- **失败后自动重试**：可能增加子进程和生命周期竞态；没有复现证据支持它能解决本次问题。
- **引入全局启动队列或共享会话进程**：会扩大生命周期或隔离模型的改动，没有并发现场证据支撑。候选保留现有隔离模型，只在插件卸载时取消尚未完成的启动，确保宿主强制终止插件前能清理自有启动进程。

## 后果

- 更长窗口允许本来会在 15 秒后超时的桥接继续等待 ready；实际收益仍取决于启动能否完成及宿主外层时限。
- 失败反馈和连接关闭等待可能随窗口一起延长；宿主强制停止插件也可能先于桥接完成。
- Windows 旧 shim 等待 stdin EOF 的死锁已有启动路径修复，延长等待不能解决死锁。
- 新字段保持 settings schema version 1；目录缓存键不含启动超时，因为它不改变目录内容。撤回候选无需数据迁移。

## 怎么验证的

候选分支合入 `main` 后，build、四个 typecheck target、271 项测试通过（另 2 项环境条件跳过）、notes/docs 门禁与 diff 检查通过。真实 DSH 0.2.2-rc.1 在 Linux / Node 24.22.1 临时 home/profile 下完成设置初始化、保存、冲突拒绝、恢复与关闭，`spawn` 到插件 `bridge.ready` 为 1781ms；受控进程延迟 16 秒时，20 秒窗口后初始化成功，关闭清理了子进程与临时目录。

真实 Paseo 0.15.3 隔离宿主验证：卸载时 600 秒等待中的候选启动在 19ms 内退出并清理临时目录；已连接会话在 32.1 秒后到达 `session.ready`。通用宿主探针显示 Provider connect 与普通 RPC 在约 30 秒超时，而 RPC 的设置标记可能于 32 秒晚提交。Paseo 0.11/0.14 未运行；未实测多会话慢启动、Windows/macOS、原生移动端或真实设置 UI；真实模型测试因缺少 API 凭证跳过，Paseo 0.14 全生命周期测试因运行时依赖不可用而跳过。详细版本、源码身份和限制见 [PR #91 proposal](../../../../.github/issue-assets/pr-91/proposal.md)。本笔记的 implemented 表示候选代码已实现，不表示已获合并批准或已发布。
