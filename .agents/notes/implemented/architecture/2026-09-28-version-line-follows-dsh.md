# 决策记录: 插件版本线跟随 dsh 主次版本号

Status: implemented

## 问题

[2026-09-15 的兼容性决策](2026-09-15-versioning-and-compatibility-strategy.md) 把版本兼容完全交给启动期的握手和运行时接口探测，不依据版本号字符串判断兼容——这在当时避开了 semver range 在预发布版本上失配的问题。但用户现在要求插件必须能通过版本号本身告诉用户「这条 tag 支持哪条 dsh 线」：握手成功与否只在运行时才知道，用户在选装 tag 之前无从判断该装哪一个。同类插件 `geoqiao/paseo-stuff` 的 `deepseek-harness` 用精确版本白名单、拒绝未测版本，可作参考但不采用：dsh 当前以 `-rc.N`/`-alpha.N` 预发布频繁迭代，精确白名单会在每个新 rc 发布时都要求插件跟着更新，还会挡住用户想自行尝试新版本的正当需求。

## 决定

插件版本号 `major.minor.patch` 的 `major.minor` 与 dsh 的 `major.minor` 对齐：插件 `0.1.x` 线支持 dsh `0.1.*`，`patch` 是插件自己的发布计数，不跟 dsh 走。dsh 的预发布后缀不参与匹配。插件启动时探测本机 dsh 版本（`server/dsh-version.ts`：对实际使用的可执行文件跑 `--version`，按路径缓存、带超时），与插件自身版本（`server/plugin-version.ts`：从 `package.json` 读取，不另设常量）比较（`server/version-line.ts` 的 `matchVersionLine`）。版本线不一致，或探测不到版本（超时、非 0 退出、解析不出版本号），都只在 Paseo 时间线弹一条警告并写一行 stderr（`server/provider.ts` 的 `warnOnDshVersionMismatch`，复用 `TimelineProjector` 已有的「回合警告」通知机制），从不因此拒绝启动或阻塞会话。规则落盘于 [兼容性说明「版本号规则」](../../../../docs/compatibility.md#版本号规则)。

## 考虑过的其他做法

- **精确版本白名单，拒绝未测版本**（`geoqiao/paseo-stuff` 的 `deepseek-harness` 采用）：优点是每条已验证组合都有实测背书，不会出现「版本线匹配但实际不兼容」的假阳性。缺点是 dsh 预发布节奏快，白名单会频繁过期，直接拒绝启动还会挡住用户想尝试新 dsh 版本的正当需求。
- **继续完全依赖握手 + 接口探测，不加版本号比对**（2026-09-15 决策的原状）：优点是实现简单，不需要额外探测逻辑。缺点是用户在选装插件 tag 之前无法预判兼容性，只能装上试跑才知道，体验差。
- **用 semver range 声明依赖**（如在 `package.json` 里写 `^0.1.7`）：优点是工具链原生支持，无需自己写比较逻辑。缺点是 node-semver 把不同预发布标签互相判定为不兼容，dsh 发布 `0.1.8-rc.1` 时会把明明能用的组合判成不满足；2026-09-15 决策已经否决过这条路，这里不重复采用。

## 后果

- 用户能从插件的 tag 号直接判断该装哪条线，不需要先装上试跑才知道兼容与否。
- 版本线判断只影响提示，不影响功能：DSH 握手和运行时接口检查仍是唯一能真正拒绝启动的机制，2026-09-15 决策的这部分结论不变，见该篇新增的互链标注。
- 每次发布需要同步打 tag `vX.Y.Z` 并保证 `package.json` 的 `major.minor` 与本次验证过的 dsh 线一致；忘记同步会让警告报出错误的「本插件支持」信息。

## 怎么验证的

- 单测：`server/version-line.test.ts`（纯匹配函数的一致/不一致/未确认分类）、`server/dsh-version.test.ts`（探测的成功、非 0 退出、解析失败、超时、缓存命中）、`server/provider.test.ts` 新增两个用例（版本线不一致、版本未确认时都只警告、会话仍可正常发消息完成回合）。
- `npm run smoke:bridge -- --prompt` 在本机 dsh `0.1.7-rc.2` 下跑通且 stderr 无版本警告；另造一个 `--version` 固定输出 `0.2.0-rc.1`、其余参数转发真实 dsh 的可执行文件复现警告，确认警告文案正确且会话仍可正常对话。
