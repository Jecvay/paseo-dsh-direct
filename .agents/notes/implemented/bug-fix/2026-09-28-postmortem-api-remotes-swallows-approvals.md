# 决策记录: 复盘：web 模板的 api-remotes 行截走审批和问答，回合一直等待

Status: implemented

## 问题

插件改跑官方 `web` 模板生成的 `paseo` profile 之后（见 [去 pi-tui 依赖](../process/2026-09-26-drop-pi-tui-dependency.md)），只要 DSH 要发起工具审批或向用户提问，Paseo 就收不到请求，回合一直停在「运行中」。DSH 0.1.7-rc.2 和 0.2.0-rc.1 都能复现，已发布的 `v0.1.2` 带着这个问题。

原因在 web 模板的 `api-remotes` 行（`@deepseek-ai/dsh-api-remotes`）。它把一批宿主事件经 API 网关转发给浏览器端，其中 `approval/request` 和 `user-questions/request` 是 waterfall：它比桥接先注册，先接下请求，放进队列等浏览器端回答，不调用 `next()`。我们禁用了 webserver 和 connection，根本没有浏览器连得上来，请求就永远等着，桥接的 `approval/request` 监听器轮不到。DSH 会话日志里能看到 `approval/asked`，却一直等不到 `approval/decided`。

这件事满足复盘三条件：机制不明显（禁用的都是「开浏览器」的行，谁也想不到一个没端口的行会截走审批）；逃逸原因是流程缺口；重新排查一遍要翻 DSH 的 waterfall 顺序和网关代码，代价高。

**防线为什么没拦住**：

- 单测用假桥接，不经过真实 profile 的组合树，测不到别的行抢先处理事件。
- 换 profile 时只跑了 `npm run smoke:bridge -- --prompt`，它只发一条不用工具的提示词，不触发审批也不提问。去 pi-tui 那篇记录写明「WP3 alpha 验收全量重跑未在本次做」，上线时本机权限预设又是 `danger-full-access`（不发起审批），审批弹窗没在线上复测。
- 兼容性文档写着审批等能力「只依赖 DSH 官方服务，与 profile 由哪些 bundle 组成无关」，这个判断让人觉得换 profile 不必重测审批。它是错的：同一个 profile 里的其他行也能抢先处理同一个 waterfall 事件。

## 决定

启动桥接时生成的 patch 把 `api-remotes` 和另外四个浏览器界面行（`web-startup`、`webserver`、`web-runtime`、`connection`）一起禁用（`server/bridge-client.ts` 的 `DISABLED_SURFACE_ROWS`）。这一行只服务浏览器端，禁用后 DSH 照常启动，桥接能收到审批和问答。

护栏：`server/bridge-client.test.ts` 断言禁用清单里有 `api-remotes`，有人从清单里删掉它，单测直接失败。兼容性文档删掉了「与 profile 组成无关」的说法，并写明 `v0.1.2` 的这个已知问题。

## 考虑过的其他做法

- **在桥接里抢先注册 waterfall 监听**：优点是不改 profile 组合。缺点是 Cordis 的 waterfall 顺序取决于注册顺序和作用域，桥接是最后插入的行，要抢到前面只能靠 DSH 内部实现细节，DSH 一升级就可能又失效。
- **保留 `api-remotes`，让桥接去网关的远程事件队列里取请求**：优点是完全不改组合树。缺点是要依赖 API 网关的内部协议，这正是插件想避开的浏览器端接口。
- **换成不带浏览器行的官方模板（如 acp/headless）**：优点是从根上没有浏览器端的行。缺点是这些模板不带 standard/ptc/minimal/cordis 四个 preset，去 pi-tui 那次已经因此选了 web 模板。

## 后果

- 审批和问答在 `paseo` profile 下能正常送达 Paseo，允许、拒绝、应答、拒答都能让回合正常结束。
- 以后 web 模板再加「转发给浏览器端」的行，同类问题还会出现；单测只能守住已知的这一行。能大声失败的办法是把审批和问答放进真实模型的自动化验收，目前还没有做，发版前要按 [Alpha 验收规范](../../../../docs/alpha-acceptance.md) 手工跑这两项。
- `v0.1.2` 没有修，0.1 线的用户在需要审批或提问的场景下仍会卡住。

## 怎么验证的

- 在 DSH 0.2.0-rc.1 和 0.1.7-rc.2 下，用 `createDshProvider` + `launchDshBridge` 以 `read-only` 权限预设让模型越权写文件：不禁 `api-remotes` 时 DSH 日志有 `approval/asked`、桥接收不到请求、回合不结束；禁用后 Paseo 收到审批请求，允许时文件写成、拒绝时文件不存在，两种情况回合都正常完成。
- 同样在 0.2.0-rc.1 下验证问答：应答后模型按所选项回复，拒答后回合正常完成。证据见 [仓外事件](../../../ops-log.md) 2026-09-28 的 dsh 0.2 适配条目。
