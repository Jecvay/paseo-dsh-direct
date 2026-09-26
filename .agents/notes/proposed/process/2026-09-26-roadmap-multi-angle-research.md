# 决策记录: 路线方针优化(多角度调研综合)

Status: proposed

## 问题

插件 alpha 已功能完备(Linux daemon 上真机模型/工具/审批/问答/历史导入/中断恢复全验证),但路线方针没有系统对照过官方文档与生态:方向是否正确、官方能力面有多少没用上、双上游(dsh 内部契约 + pi-tui 逐版硬配对 + @getpaseo/plugin 快节奏)的耦合怎么管、什么情况下应该放弃自研。2026-09-26 用四路 subagent 只读调研(paseo 官方插件 API / dsh 官方架构与入口 / 生态先例对照 / 本仓现状基线)回答这些问题。

## 提案

**总判断三条**:

1. 现路线方向正确、生态位成立——Direct Provider + `--patch` 注入 Cordis bridge 与 paseo 官方 in-tree pi provider(spawn 进程+注入自研 extension)、opencode provider(materialize bundle 注入)完全同构,是官方模式的社区重演;npm 与 paseo.cafe(215 插件、provider 类 15 个)均无现成 paseo↔dsh 桥。
2. 核心风险是双上游耦合,不是架构错误——dsh 内部 ctx 契约预发布逐 rc 洗牌、pi-tui 第三方逐版硬配对、@getpaseo/plugin minor 约 2 周且 0.8 曾无兼容期硬断裂。方针围绕「管耦合」而非「换架构」。
3. dsh 官方 sdk profile 不足以替代(3 请求+4 通知,无 cancel/审批应答/流式增量);acp 是官方为自动化客户端造的正门,但今日切换丢 steer/流式/斜杠命令/问答,核心 UX 倒退。

**存在理由与放弃判据**:插件价值锚定「复用 pi-tui profile 资产」(preset/skills/斜杠命令/原生历史/审批问答/逐会话取消),不是「让模型能用」——后者官方 pi provider 或 `extends: claude`+CPA 零维护。触发重评(任一):dsh SDK wire 补齐 cancel/approval/userQA/steer;dsh 进 paseo ACP catalog 或被内置;连续两个 dsh 版本追不上 ctx 契约;pi-tui 停更或掉队。命中前两条→桥降级为薄适配或停自研;后两条→评估自建 profile 或止损。

**行动项分层**:

- **P0 护栏**(低成本先行):①桥启动前 `dsh --dump-config --patch <patch.json>` 断言组合树含预期行——拦「目标行改名→disable 静默失效→TUI 与桥抢 stdout」这一最阴险碎裂向量;②握手时对消费的内部事件名抽样断言;③manifest 版本加上界 `>=0.8.0 <0.10`,每个 paseo minor 跑测试再放宽;④抄 paseo-omp 的 capability 机械化台账,SDK 升级先 diff。
- **P1 能力补齐**(官方已给、我们未用):①usage 补 contextWindow 字段+模型 contextWindowMaxTokens,点亮上下文计量表(纯映射,成本最低);②timeline.plugin 自定义卡片+renderer,把 goal 续跑/plan 切换/preset 变更可视化(官方 provider-direct「完全体」标配);③registerSettings+设置屏替代 PASEO_DSH_* 环境变量,cache key 纳入生效配置。
- **P2 条件触发**:revertToken(需 dsh 截断历史)、subsession 子 agent 轨道(需 dsh 子会话事件)、ACP 迁移试点(自建 dsh-base+acp-app profile 只读验证,不动用户 pi-tui)。
- **P3 分发与成熟度**:npm 发布+paseo.cafe 提交;手机真机实测;dsh 侧 acp profile 路由修复(settings 迁移后新存储未吃到 CPA 路由),修好留 `extends: acp` 当低成本对照组;根 README/README.zh/docs/en 版本表同步到 0.9.2/0.1.7-rc.2/0.4.9。

**技术债标记**:对 pi-tui 的唯一硬依赖是 `tuiStartup` 握手与 profile 复用;若自建 profile 可行可去掉第三方依赖,兼容面收敛为 dsh 内部契约一层,与放弃判据联动评估。

## 考虑过的其他做法

- 迁到 dsh 官方 sdk profile:协议面太窄(cancel/审批应答/流式/会话查询全无,官方明言无兼容承诺),迁移数周且功能净减,仅列观察项——等 server→client 审批流与流式上线再评。
- 迁到 dsh acp profile:官方正门、有 conformance,但丢 steer/流式/命令/问答,先做 read-only 试点再谈。
- 恢复 paseo 侧 `extends: acp` provider 替代插件:acp profile 路由修复后可用,但 preset/skills/命令/原生历史/审批问答带不过来,只配当对照组,不当主力。
- 放弃自研用官方 pi provider:只覆盖「模型可用」,不覆盖 profile 资产复用,与存在理由冲突;留作判据命中后的备胎。
- 维持现状不加护栏:双上游快节奏下碎裂向量已知(patch 行改名静默失效、事件名洗牌),护栏成本远低于每次事故排查。

## 怎么算做完

- P0 四项全部落地并在下一个 dsh/pi-tui 版本升级中实际拦到(或证伪)至少一类碎裂;
- P1 三项按序合入,usage/contextWindow 先行(一个 minor 内);
- 放弃判据写进 AGENTS.md 或本仓 README 的维护者提示节;
- 本件按行动项推进情况逐条移入对应 implemented/ 记录,全部落地后归档。

## 后果

- 接受「逐 dsh release 对齐」的现实,兼容矩阵(实测基线+启动探活)仍是第一道防线;
- P0 落地前不追新 dsh/pi-tui 版本;
- 本件不改变现有代码;行动项排期由后续 issue/决策记录承接。
