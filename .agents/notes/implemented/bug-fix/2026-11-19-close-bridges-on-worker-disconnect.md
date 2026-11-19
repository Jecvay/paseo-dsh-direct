# 决策记录: 在插件 worker 与宿主断开时关闭桥接并释放会话写租约

Status: implemented

## 问题

Paseo Daemon 异常退出后，插件 worker 及其启动的 `dsh` 桥接子进程不会随之退出，持续占住会话写租约（`session.lock`），导致新启动的 Daemon 每次重开该会话都报错 `already owned by an active write handle`，历史无法加载，直到人工杀掉残留子进程。报告者在真实机器上遇到过这种情况：一次运行遗留的桥接子进程一直占住 `session.lock`，人工清理前无法重开会话。

Paseo Daemon（`@getpaseo/server` 的 `PluginRuntime`）通过 `fork(..., { stdio: ["ignore", "pipe", "pipe", "ipc"] })` 启动插件 worker，插件 worker 再为目录发现与每个打开的会话各自启动一个 `dsh` 桥接子进程（`stdio: ["pipe", "pipe", "pipe"]`）。正常卸载时，Daemon 经 IPC 发送 `shutdown` 消息；但 Daemon 崩溃或被 `SIGKILL` 终止时这条消息不会发出，插件 worker 内已启动的 `dsh` 子进程句柄、管道与活动定时器使事件循环继续存活，桥接子进程的 stdin 管道不关闭，写租约也就不会释放。

## 决定

插件入口 `index.server.ts` 跟踪进行中的桥接启动与 `connect`，以及已经建立的 `ProviderConnection`，并在 `process` 的 `disconnect`、`SIGTERM`、`SIGINT` 上注册与插件卸载共用的幂等 `shutdown`：

- Paseo 以带 IPC 通道的 `fork` 启动插件 worker；Daemon 进程一旦退出，操作系统关闭通道，Node 在插件 worker 内触发 `process` 的 `disconnect` 事件。`SIGTERM` 与 `SIGINT` 覆盖对插件 worker 本身的外部终止请求。
- 任一触发到达时，`shutdown` 取消 `startup`（未完成的桥接启动随之终止，见 [桥接启动等待可由设置页调整](../feature/2026-11-07-configurable-bridge-startup-timeout.md)），等待 `subagents.dispose()`、所有进行中的启动与 `connect`，并关闭全部已建立的 `ProviderConnection`。关闭晚于快照建立的连接在 `connect` 包装里发现自己已中止，会立即关闭再抛出中止错误。
- 每个 `ProviderConnection.close()` 关闭目录发现桥接、全部会话桥接与仍在打开的会话启动；每个桥接先发送 `bridge.shutdown` 让 DSH 释放 agent 句柄与 `session.lock`，未在时限内退出的子进程依次经 `SIGTERM`、`SIGKILL` 有界终止并删除临时目录。
- 清理完成后注销进程监听。宿主断开或收到终止信号时，worker 随后执行 `process.exit(0)`；正常插件卸载调用同一个 `shutdown`，清理完成后返回，不强制退出，由宿主结束 worker。
- 宿主退出窗口内吸收两类预期写失败：已关闭 IPC 通道上的晚到发送（`ERR_IPC_CHANNEL_CLOSED`）和已经失去读者的 stderr 写入（`EPIPE`），避免清理中途被错误打死；其他错误仍然致命。
- 宿主退出路径带 10 秒兜底期限：即使某个清理步骤没有结束，worker 也退出。退出会关闭各桥接的 stdin 写端；对已经进入 ready 的桥接，既有 EOF 路径会释放写租约（这一回收未单独实测）。

worker 被 `SIGKILL` 直接杀死时用户态监听不会运行；内核关闭 worker 持有的 stdin 写端，桥接的 `process.stdin` `end`/`close` 处理走 `service.shutdown()` 释放写租约。

## 考虑过的其他做法

- **在 `dsh` 桥接子进程内轮询 `process.ppid`**：优点是不改动插件入口。缺点有四项：第一，桥接的直接父进程是插件 worker 而不是 Paseo Daemon，Daemon 异常死亡后插件 worker 仍然活着，桥接看到的 `ppid` 不会变化，根本观测不到本次故障。第二，插件 worker 真正退出时桥接的 stdin 已经到达 EOF，现有的 `process.stdin` `end`/`close` → `onEnd` 路径本就会先一步触发 `service.shutdown()`，轮询只是更慢的重复。第三，Windows 上 libuv 的 `process.ppid` 取自进程创建快照，父进程退出后不会更新。第四，DSH 的 `appExit` 关闭应用树后只设置退出码，stdin 仍打开时不能保证进程退出。因此放弃。
- **重开会话遇到写锁冲突时直接删除 `session.lock`**：优点是表面上能立刻绕过报错。缺点是破坏 DSH 官方 `SessionWriteLease` 的跨进程互斥保证（见 [Direct 桥接](../architecture/2026-09-23-pi-tui-direct-bridge.md)）：插件无法区分锁文件属于失去宿主的残留桥接，还是用户在另一个终端正在运行的 DSH TUI 或活动桥接；强删锁文件会让两个进程同时写同一份会话 JSONL 日志，造成历史损坏。因此放弃。
- **额外启动独立看门狗进程监管桥接**：优点是不依赖插件 worker 自身的事件循环。缺点是多引入一层需要跨平台生命周期管理和自我防孤儿的常驻进程，扩大了故障面；宿主与插件 worker 之间本就有内核维护的 IPC 通道，`disconnect` 事件直接反映宿主生死，无需新增监管进程。因此放弃。

## 后果

- Daemon 崩溃、被强杀，或插件 worker 收到 `SIGTERM`/`SIGINT` 时，worker 会关闭本次运行建立的桥接并退出；重启后重开会话的端到端场景尚未实测，写租约随桥接关闭或进程退出释放。
- 单个桥接的关闭阶段有界（`bridge.shutdown` 500ms、`SIGTERM` 1s、`SIGKILL` 1s），但整个 `shutdown` 还要等进行中的 `connect`、会话打开与设置桥接收尾；宿主退出路径的 10 秒兜底期限是这条路径退出总时长的上界。
- 若插件 worker 被 `SIGKILL` 直接杀死，stdin EOF 回收写租约的路径按代码推断，未单独实测。
- 正常卸载仍返回清理结果；宿主先调用它，再断开 IPC 并结束 worker。

## 怎么验证的

- 核对 Paseo 0.11、0.14、0.15.3 的固定源码：`packages/server/src/server/plugins/runtime.ts` 均以 `fork(..., { stdio: ["ignore", "pipe", "pipe", "ipc"] })` 启动插件 worker，`plugin-process.ts` 在收到 IPC `shutdown` 消息时调用插件清理，随后执行 `process.disconnect()`。宿主被强杀时这条消息不会发出；`disconnect` 是 Node 在 IPC 通道关闭时发给 worker `process` 的事件，不是 Paseo 源码注册的。
- 在 Node 24 上手工探针确认：父进程被杀后子进程收到 `disconnect`；此后 `process.send` 的失败以 `process` 的 `error` 事件报告 `ERR_IPC_CHANNEL_CLOSED`，stderr 写入报告 `EPIPE`，没有监听者时子进程以 1 退出。
- 单测（`server/settings-wiring.test.ts`）覆盖三条触发（`disconnect`、`SIGTERM`、`SIGINT`）、重复触发只清理一次、活动连接的桥接被关闭、`connect` 在 `shutdown` 期间完成时被关闭、正常卸载不调用 `process.exit`，以及清理窗口内忽略 `ERR_IPC_CHANNEL_CLOSED`/`EPIPE` 但仍让其他错误致命、监听注销与调用 `process.exit(0)`。
- 通过 `npm run build`、`npm run typecheck`、`npm test`、`npm run verify:notes`、`npm run verify:docs` 与 `git diff --check`。
- 未实测：真实 Daemon 强杀后重开会话；worker 被 `SIGKILL` 或 10 秒兜底期限强制退出后的写租约回收。
