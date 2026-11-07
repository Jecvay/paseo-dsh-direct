# 决策记录: 桥接启动等待可由设置页调整

Status: implemented

## 问题

桥接的启动等待是 `server/bridge-client.ts` 里的常量 `15_000`：`launchDshBridge` 调用 `waitUntilReady(options.startupTimeoutMs ?? 15_000)`，而 `startupTimeoutMs` 只有测试在传，插件本身从不传入。DSH 起桥在空闲机器上约 5 秒（`paseo` / `web` 两个 profile 各测三次，5.2–5.4 秒），但多个 dsh-pi 会话同时起桥、或机器正在处理别的重活时会明显变慢；超过 15 秒的等待以 `DSH bridge did not become ready within 15000ms` 失败，客户端重试又各自再起一个桥，形成更多并发起桥。这是启动窗口的容量问题，不是 DSH 坏了。

## 决定

设置页的 `Connection` 区域新增 `Startup timeout`（`shared/settings.ts` 的 `startupTimeoutSeconds`，字符串）。`server/dsh-config.ts` 的 `parseStartupTimeoutSeconds` 把它解析为整数秒并换算成毫秒，`mergeDshConfigured` 把结果放进 `DshConfigured.startupTimeoutMs`；`index.server.ts` 在 `createBridge` 与子代理设置页的 `open` 两处传给 `launchDshBridge`，最终进入 `waitUntilReady`。留空或纯空白仍是 15 秒默认（`DEFAULT_STARTUP_TIMEOUT_SECONDS`），上限 600 秒（`MAX_STARTUP_TIMEOUT_SECONDS`），没有环境变量覆盖。非法的值不让整页设置失效：其余字段照常生效，写一行 stderr，超时按默认。

## 考虑过的其他做法

- **只把常量改成 45 秒**：不加字段，一次改死。优点是改动最小，没有新 UI 和解析逻辑；缺点是不同机器、不同并发度需要的窗口不一样，用户改不了，也不能给慢机器留足时间。
- **用环境变量 `PASEO_DSH_STARTUP_TIMEOUT`**：与 `PASEO_DSH_EXECUTABLE` / `PASEO_DSH_PROFILE` 一致，不用改设置页。缺点是它只影响起桥等待，不是安装身份，放进环境变量会让「这台机器跑哪个 dsh」和「允许它慢多久」混在同一层；设置页已有「对新会话生效」的即时路径，更贴合这个可变的等待窗口。
- **失败后自动重试一次**：不改等待窗口，起桥失败重来。缺点是重试同样会再 spawn 一个 dsh，窗口不够时只是放大并发，而且失败已经发生在用户可见的时间线里。

## 后果

- 慢启动不再在 15 秒被判失败；需要更长的窗口由用户显式设置，改动只对新会话生效，已运行的桥不受影响。
- 解析失败被降级为「忽略这一项」而不是拒绝整页设置，避免一个拼写错误让 executable/profile 也一起失效。
- 设置页多了一个字段，`settings` 的 schema 版本不变（新增可选字段不破坏旧存档）。
- 目录缓存键（`getCatalogCacheKey`）不包含启动超时：它不影响目录内容，只影响起桥等待，所以同一安装与 profile 的目录发现继续复用。

## 怎么验证的

- `server/dsh-config.test.ts` 新增四组用例：空白/整秒改写毫秒、非数字与越界（0、601、`4.5`、`45s`）带原因、合并进 `DshConfigured` 时非法值保持未设且不影响 profile、非法超时只 warn 一行并保留其余字段。
- `npm run build`、四个 typecheck 目标、`npm test`（289 tests，287 pass、2 个环境门控 skip）、`npm run verify:notes`、`npm run verify:docs` 全部通过。
- 真实环境：Paseo 0.14.0 Daemon、dsh 0.2.1-rc.2、`paseo` profile 下起桥 5.2–5.4 秒；本改动的窗口只影响超时判定，不改变起桥本身的路径。
