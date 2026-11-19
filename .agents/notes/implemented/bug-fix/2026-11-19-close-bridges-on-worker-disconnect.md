# 决策记录: 在插件进程与宿主断开时关闭桥接并释放会话写租约

Status: implemented

## 问题

Paseo Daemon 异常退出后，插件 worker 及其启动的 `dsh` 桥接子进程不会随之退出，持续占住会话写租约（`session.lock`），导致新启动的 Daemon 每次重开该会话都报错 `already owned by an active write handle`，历史无法加载，直到人工杀掉残留子进程。这一故障已在真实机器上复现：更早一次 worker 留下的桥接子进程持续占住 `session.lock` 数小时。

根因在宿主与插件之间的退出信号断层。Paseo Daemon（`@getpaseo/server` 的 `PluginRuntime`）通过 `fork(..., { stdio: ["ignore", "pipe", "pipe", "ipc"] })` 启动插件 worker，插件 worker 再为目录发现与每个打开的会话各自启动一个 `dsh` 桥接子进程（`stdio: ["pipe", "pipe", "pipe"]`）。正常卸载时，Daemon 经 IPC 发送 `shutdown` 消息关闭连接；但当 Daemon 崩溃或被 `SIGKILL` 终止时，这条消息不会发出，插件 worker 内已启动的 `dsh` 子进程句柄、管道与活动定时器使事件循环继续存活，桥接子进程的 stdin 管道不关闭，写租约也就不会释放。

## 决定

插件入口 `index.server.ts` 跟踪活动及正在建立的 `ProviderConnection`，并在 `process` 上为 `disconnect`、`SIGTERM` 和 `SIGINT` 注册与插件卸载共用的幂等关闭逻辑（同时作为 `contribute` 的清理函数返回）：

- Paseo 以带 IPC 通道的 `fork` 启动插件 worker，Daemon 进程一旦退出，操作系统立即关闭父端套接字并在插件 worker 内触发 `process` 的 `disconnect` 事件；`SIGTERM` 与 `SIGINT` 覆盖对插件 worker 本身的外部终止请求。
- 任一触发事件到达时，处理函数吸收已关闭 IPC 通道上的晚到发送错误（`ERR_IPC_CHANNEL_CLOSED`），调用既有关闭路径：`startup.abort()` 取消未完成的启动（见 [桥接启动等待可由设置页调整](../feature/2026-11-07-configurable-bridge-startup-timeout.md)）、`subagents.dispose()` 收尾设置读写桥接，并对全部活动与正在建立的 `ProviderConnection` 调用 `close()`。全部桥接关闭完成后再注销进程监听并执行 `process.exit(0)`，避免清理途中收到重复信号提前中断清理，也避免残留 worker 继续挂起。
- 正常插件卸载直接调用同一个 `shutdown` 函数，同样释放全部桥接并注销进程监听，但不调用 `process.exit(0)`，交由宿主 worker 包装层回传关闭确认。

每个桥接的 `close()` 先发送 `bridge.shutdown` 让 DSH 释放 agent 句柄与 `session.lock`，未在时限内退出的子进程依次经 `SIGTERM`、`SIGKILL` 有界终止并删除临时目录；worker 退出关闭 stdin 写端也会让仍依赖管道边界的子进程经 `input.on("close")` 走 `service.shutdown()` 释放写租约。当前机制见 [服务端架构](../../../../docs/server-architecture.md#关闭与错误)。

## 考虑过的其他做法

- **在 `dsh` 桥接子进程内轮询 `process.ppid`**：优点是不改动插件入口。缺点有四项：第一，桥接的直接父进程是插件 worker 而不是 Paseo Daemon，Daemon 异常死亡后插件 worker 仍然活着，桥接看到的 `ppid` 不会变化，根本观测不到本次故障。第二，插件 worker 真正退出时桥接的 stdin 已经到达 EOF，现有的 `input.on("close")` 路径本就会先一步触发 `service.shutdown()`，轮询只是更慢的重复。第三，Windows 上 libuv 的 `process.ppid` 取自进程创建快照，父进程退出后不会更新。第四，DSH 的 `appExit` 只设置退出码，stdin 仍打开时不能保证进程退出。因此放弃。
- **重开会话遇到写锁冲突时直接删除 `session.lock`**：优点是表面上能立刻绕过报错。缺点是破坏 DSH 官方 `SessionWriteLease` 的跨进程互斥保证（见 [Direct 桥接](../architecture/2026-09-23-pi-tui-direct-bridge.md)）：插件无法区分锁文件属于失去宿主的残留桥接，还是用户在另一个终端正在运行的 DSH TUI 或活动桥接；强删锁文件会让两个进程同时写同一份会话 JSONL 日志，造成历史损坏。因此放弃。
- **额外启动独立看门狗进程监管桥接**：优点是不依赖插件 worker 自身的事件循环。缺点是多引入一层需要跨平台生命周期管理和自我防孤儿的常驻进程，扩大了故障面；宿主与插件 worker 之间本就有内核维护的 IPC 通道，`disconnect` 事件直接反映宿主生死，无需新增监管进程。因此放弃。

## 后果

- Paseo Daemon 崩溃、被强杀，或插件 worker 收到 `SIGTERM`/`SIGINT` 时，插件 worker 会主动关闭全部活动桥接并退出，`session.lock` 随之释放，重启后的 Daemon 可直接重新打开同一会话。
- 退出等待受 `bridge.close()` 既有时限（`bridge.shutdown` 500ms、`SIGTERM` 1s、`SIGKILL` 1s）约束，不会让残留 worker 无限挂起。
- 若插件 worker 自身被 `SIGKILL` 直接杀死，用户态监听不会运行；此时操作系统内核直接关闭 worker 持有的全部管道写端，`dsh` 子进程经既有的 stdin EOF 路径执行 `service.shutdown()` 释放写租约。

## 怎么验证的

- 核对 Paseo 服务端插件运行时源码（`packages/server/src/server/plugins/runtime.ts` 与 `plugin-process.ts`），确认插件 worker 由 `fork(..., { stdio: ["ignore", "pipe", "pipe", "ipc"] })` 启动，且宿主异常死亡时不发 `shutdown` 消息、由 worker 侧 `process` 收到 `disconnect`。
- 单测（`server/settings-wiring.test.ts`）验证插件入口注册 `disconnect`、`SIGTERM`、`SIGINT` 监听，`disconnect` 触发时关闭活动 Provider 连接持有的桥接、注销进程监听并以退出码 `0` 结束 worker。
- 通过 `npm run build`、`npm run typecheck`、`npm test`、`npm run verify:notes`、`npm run verify:docs` 与 `git diff --check`。需要启动真实 Daemon 强杀再重开会话的端到端场景未在此构建自动测试。
