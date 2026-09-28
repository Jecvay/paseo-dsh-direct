# 决策记录: dsh 新版本发布自动开单

Status: proposed

## 问题

dsh 预发布很频繁，0.1.7-alpha.2、rc.1、rc.2 和 0.2.0-rc.1 在一周内相继发出。现在全靠人发现新版本再叫 agent 适配，经常晚一步。

GitHub 没法把上游的发布事件推给我们。webhook 只有上游仓 `deepseek-ai/deepseek-harness` 的管理员能配；Watch → Releases 只发邮件和站内通知，是给人看的；npm 也不支持订阅别人包的发布。所以只能由 hlab 自己去轮询。

还有一个坑：上游有 GitHub Release 不等于能装上。2026-09-28 的 0.2.0-rc.1 已经有 Release（tag `dsh-v0.2.0-rc.1`，标了 prerelease），但 `@deepseek-ai/dsh-web-app` 依赖的 `@deepseek-ai/dsh-client-ui-settings-account@0.2.0-rc.1` 没发布，`npm install` 直接 ETARGET 报错。

## 提案

推迟，等 0.2 线适配完成后再做。做的时候按下面的方案：

1. hlab 上加一个 systemd user timer，和看板轮询器放在一起，每 30–60 分钟查一次 npm registry 里 `@deepseek-ai/dsh` 的版本列表。以 npm 为准，因为用户装的是 npm 上的包。查到的最新版本记在 `~/.local/state/paseo-dsh-direct/` 下。
2. 发现新版本后，把 `@deepseek-ai/*` 依赖树整棵查一遍，看有没有漏发的包，得出「能装」或「缺 X」。
3. 在看板「待办」列开一张单，标题形如「dsh 0.2.0-rc.2 发布：适配」，正文附上能不能装的结论。按版本号规则分两种：
   - major.minor 没变（比如 rc.1 → rc.2）：同一条插件线内的复测，任务是跑验收、把新版本补进已实测表、发一个插件 patch 版本；
   - major.minor 变了：开新插件线，按大改动评估。
4. 每天 09:00 的看板轮询器负责评估这张单。进入实现仍要人把卡拖进「待开工」，沿用看板铁律。

实现时尽量复用 `scripts/board.ts` 的开单和挪卡能力，整件事控制在一个 PR 里。

**最终目标**：同一条线内的新版本从发现到发出插件 patch 版本全程由 agent 完成，人只在 major.minor 变化（开新插件线）时拍板。卡在人这里的不是监控，而是验收：现在 agent 的「测过了」只有 `smoke:bridge` 能自动证明，审批、问答、MCP、`/compact`、`/plan`、会话恢复还靠人工。要先把 [Alpha 验收规范](../../../../docs/alpha-acceptance.md) 全量做成可自动运行、结果留证据的测试，机器能自己判断过没过，才能撤掉同线版本的人工开工闸。

## 考虑过的其他做法

- 盯 GitHub Releases（API 或 `releases.atom`）：优点是有发布说明可看；缺点是 Release 发出时包可能还装不上（0.2.0-rc.1 就是例子），而且最终还得去 npm 核实。可以把 Release 链接附在工单里当参考，不拿它当触发条件。
- 用 GitHub Actions 定时任务查版本，再通过 hlab 上的 self-hosted runner 拉起 agent：优点是调度托管在 GitHub；缺点是 hlab 本来就常开，这样只是多维护一个 runner，还给机器多开了一个入口。
- 同一条线内的小版本全自动走完（复测、改表、开 PR），不经过人：省事，但 dsh 每个 rc 都在改内部事件，没人把关容易把坏组合写进「已实测」。这正是最终目标，前提是全量验收自动化；在那之前先用人工开工闸。
- 维持人工发现：零成本，但会一直晚一步。

## 怎么算做完

- 模拟上游发了新版本（把状态文件里记录的「已见版本」改旧），一次轮询就能在看板「待办」列开出一张单，正文里有版本号、能不能装的结论和上游 Release 链接。
- 同一个版本不会重复开单。
- 依赖树里有包缺失时，工单正文列出缺的包名。
- timer 可以用 `systemctl --user stop` 停掉，docs/board.md 写明怎么停。

## 风险

npm registry 查询失败或超时时，本轮只记日志不开单，避免因网络问题乱开单。
