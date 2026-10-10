# 决策记录: 不改用 dsh 的 Host/Client 接口驱动 dsh

Status: rejected — dsh 的 Host/Client 接口是内部接口，无稳定承诺且不接受非浏览器认证；公开驱动面又缺审批、提问与取消

## 问题

插件现在把进程内的 Cordis 桥接插件加载进 `paseo` profile 的 `dsh` 子进程，依赖 dsh 内部的服务名、事件名和 profile 行（见 [Pi TUI 直连桥接](../../implemented/architecture/2026-09-23-pi-tui-direct-bridge.md)）。每次 dsh 小版本升级都可能破坏这些内部依赖。dsh 自己为 Web/Desktop 应用把内部拆成 Host 与 Client 两半，能否改用这条 Host/Client 链路驱动 dsh，从而不再加载桥接插件？

## 调研结论

- Host/Client 传输是 `/api` POST 加 `/api/remote.mux` WebSocket；类型由 Host 源码经 Typert（`@Remote`）生成。
- 认证走浏览器 cookie，不接受 bearer token；服务只绑定 loopback。
- 这是 dsh 自用的内部接口，没有稳定性承诺。
- dsh 的公开驱动面都很窄：SDK JSON-RPC 没有审批、用户提问和取消；ACP 定位为 automation-only，交互能力降级；headless `--json` 是单向输出。

## 决定

不改用 Host/Client 接口。继续把 Cordis 桥接插件加载进 `paseo` profile 的 `dsh` 子进程，通过 stdio 通信。

## 考虑过的其他做法

1. **用 Host/Client 接口（`/api` 与 `/api/remote.mux`）**：交互能力最全，且不需要往 dsh 里加载插件。缺点是它同样是内部接口，没有稳定承诺，类型随 Host 源码变；认证只认浏览器 cookie，插件要伪造浏览器会话；仅 loopback 绑定，与 daemon 分机部署冲突。依赖的内部面没有变小，只是换了一种。
2. **SDK JSON-RPC**：公开且稳定，但没有审批、用户提问和取消，Paseo 的核心交互做不出来。
3. **ACP**：公开，但 automation-only，交互降级，正是 Direct Provider 要绕开的路径。
4. **headless `--json`**：只有输出流，没有输入通道，无法响应审批与提问。

## 后果

- 插件依赖 dsh 的内部服务名、事件名和 profile 行；dsh 小版本升级可能破坏桥接。
- 缓解办法是大声失败的护栏：启动时检查 profile 行，握手时检查所需服务与事件，审批与提问有冒烟测试。
- dsh 发布稳定接口之前，每个 dsh 小版本都要跑一遍桥接冒烟。

## 重新评估的触发条件

满足任一条就重新打开本决定：

- dsh 发布稳定、有文档的 remote/driver API，覆盖审批、用户提问和取消。
- dsh 的 host API 支持 bearer/token 认证，非浏览器客户端可以接入。
- 桥接依赖的内部接口在连续两个 dsh 小版本中被破坏。
- dsh 移除 `--dump-config` 或 profile 机制。
