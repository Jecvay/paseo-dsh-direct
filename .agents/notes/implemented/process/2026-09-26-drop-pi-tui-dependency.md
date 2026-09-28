# 决策记录: 去除 pi-tui 依赖的技术评估(完整报告)

Status: implemented

## 问题

paseo-dsh-pi 插件当前通过 `--patch` 注入用户既有 `pi-tui` profile 运行。多角度调研(2026-09-26 四路 subagent)与后续源码核查提出一个问题:插件对 pi-tui 的依赖到底是能力依赖还是巧合依赖?若完全去除,需要补齐什么、代价与收益如何?本报告汇总全部证据,供拍板。

前因:2026-09-26 路线方针调研(见 [路线方针优化提案](../../proposed/process/2026-09-26-roadmap-multi-angle-research.md))发现核心风险是「dsh + pi-tui + paseo SDK」三方上游耦合。随后三问三答逐步逼近本问题:①官方 SDK 为什么不够用;②paseo 接 Claude Code 用的是 SDK 还是 TUI;③那么我们到底需不需要 pi-tui。

## 证据链(全部本机查实)

### E1. dsh 与 pi-tui 的真实分工

dsh(npm @deepseek-ai/dsh)是启动器,自带全部官方零件:`~/.local/share/mise/installs/npm-deepseek-ai-dsh/0.1.7-rc.2/.../node_modules/@deepseek-ai/` 下 dsh-persona、dsh-plan-mode、dsh-tool-bash/fs/web/todo、dsh-compaction-*、dsh-agent-preset、dsh-subagent 等几十个包**随 dsh 安装即在本机,代码逻辑 100% 官方**。cordis 是组合机制:把若干份 YAML patch 按序合成一棵配置树,决定哪些零件装上、参数多少。profile = 一次组装的结果(dsh-base 默认组合 + 追加 bundle + 用户层 patch)。

pi-tui(@xmoon76/dsh-pi-tui,第三方,18 星)的实际内容(读包内文件查实):

- `cordis.patch.yml`(233 行):把 dsh-base 的 ~22 个扩展条目**全部 disabled**——「全关」基线;
- `generated/dsh-presets/{standard,ptc,minimal,cordis}.patch.yml`(各 61–154 行,共 746 行):按 preset 选择性重新开启并配参——`preset-standard` 经官方容器插件 `@deepseek-ai/dsh-agent-preset` 注册,引用的全部是官方包(persona、plan-mode 含一段约 30 行英文 plan 提示词、tool-bash/fs/search/jobs、skill-filesystem、command-goal、compaction 三件套、subagent 组、ask-user、todo、web、present);
- TUI 应用本体(tui-app)——**被我们的 patch 第一条就禁用,零使用**。

即:pi-tui = TUI 程序(我们不用)+ 一份「先全关、再按 preset 开」的装修清单(可复制的死配置)。

### E2. 我们的桥实际消费的是官方服务,不是 pi-tui

桥(server/dsh/bridge.ts,以 Cordis 插件形态注入)inject 并调用的全是 dsh-base 官方服务:agents/sessionQuery/agentPresets/llm/permissionPresets/commands/sessionTitle/attachments/skills/agentDefaultModel;订阅的事件(session/created、session/event 63 类词汇表、agent/assistant-stream、agent/status、approval/request、user-questions/request)也全是官方事件。对 pi-tui 的唯一触碰是 `inject: tuiStartup` + `markSurfaceMounted()` 假握手——为满足 pi-tui ≥0.4.7「无 surface 挂载即退出」的约束,**这是它强加给我们的成本,不是能力**。

### E3. 对照组:paseo 接 Claude Code 的姿势(源码查实)

paseo 的 claude provider(`providers/claude/query.js` 第 1 行)`import { query } from "@anthropic-ai/claude-agent-sdk"`——daemon 进程内直接调官方 Agent SDK,5134 行 agent.js 全部围绕 SDK 概念(canUseTool×2、permissionMode×5、resume×21、commands/skills 走 SDK flat list),无任何 pty/键盘模拟/屏幕解析。**TUI 能力使用率为 0,SDK 占 100%**。原因:Anthropic 把 TUI 的全部体验(流式、审批、命令、技能、计划模式、恢复、MCP)做成了 SDK 可编程接口。

dsh 的差距正在于此:官方 sdk profile 仅 3 请求+4 通知,无 cancel/审批应答/流式增量/会话查询,且明言无兼容承诺——**dsh 没有等价的完整 SDK 面,这才是我们必须桥接的根因,与 pi-tui 无关**。

### E4. 依赖 pi-tui 的代价(本机事故史)

- 版本硬耦合:pi-tui 逐版精确绑死 dsh(0.4.9 要求 ≥0.1.7-rc.2),它掉队则插件被卡在旧 dsh;
- 两次真实事故均由 pi-tui 挖坑:0.4.7-alpha.2 强制 markSurfaceMounted(桥被迫补假握手)、0.4.8 peer floor 连锁要求 dsh 0.1.7-rc.1(见 .agents/ops-log.md 09-24);
- 18 星第三方包,无 SLA,追不上 dsh 节奏时无解。

### E5. pi-tui 提供而需要补齐的全部内容

1. 一份 preset 清单(~150 行 YAML,standard preset,引用全官方包)——抄/重写,小时级;
2. 用户层配置的容身之所:模型路由(llm-pi-ai 的 CPA an/rs 双路由)、agent-default-model、权限 preset——本来就是用户自己的 YAML,搬目录,分钟级;
3. 「插件会话与用户 TUI 会话同一环境」的性质:配置一处改、历史同一套——自建 profile 后配置需双份维护或共享 patch(可设计);
4. 旧会话兼容:存量会话在 pi-tui 组合下创建,事件流可能引用其注册的技能/命令;新组合下 resume 完整性需实测(WP4,唯一的真验证成本)。

## 决定

**插件不依赖 pi-tui。** 插件默认启动名为 `paseo` 的 DSH profile,由 DSH 官方 `web` 模板生成(bundle = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`)。pi-tui 贡献的只是「一张可复制的配置清单 + 一个别人替你追版本的幻觉」,不贡献任何被执行的逻辑;带来的却是版本硬绑死、假握手技术债和两次已发生的事故源。

- **profile**:官方 `dsh-web-app` 自己就把 standard/ptc/minimal/cordis 四个 preset 挂进组合树,这四个文件与 pi-tui 的 `generated/dsh-presets/*.patch.yml` 逐字节相同,所以不需要自建 bundle 或镜像 preset。官方 acp/headless bundle 不带 preset,因此选 web 模板。
- **自动创建**:`launchDshBridge` 启动前检查 `$DSH_HOME/profiles/<profile>`(解析方式照 `@deepseek-ai/dsh-home-paths`:非空 `DSH_HOME` 优先,否则 `~/.dsh`)。缺失且 profile 为默认 `paseo` 时执行一次 `dsh --profile paseo --from-default-profile web --dump-config` 创建;`PASEO_DSH_PROFILE` 显式指定的 profile 缺失直接报错并给出创建命令。
- **运行时 patch**:禁用 `web-startup`、`webserver`、`web-runtime`、`connection` 四行,再插入桥。preset 行和会话、工具行不动。
- **桥**:inject 不含 `tuiStartup`,不调用 `markSurfaceMounted`;`appReady`/`appExit` 由 DSH 启动器提供,要求保留。
- **命名**:Provider 显示名为「DeepSeek Harness」;包名 `paseo-dsh-pi` 与 Provider id `dsh-pi` 不变,避免弄坏已装的 Paseo 配置和已有 agent。
- **用户层配置**:模型路由(`llm-pi-ai` 的 CPA-an/CPA-rs)、`agent-default-model`、`permission` 写在 `~/.dsh/profiles/paseo/cordis.patch.yml`,插件不写它。

上游耦合由三方(dsh + pi-tui + paseo SDK)收敛为两方;插件自包含可分发,不再要求用户装第三方 profile。与 [路线方针](../../proposed/process/2026-09-26-roadmap-multi-angle-research.md) 的放弃判据③④(「自建 profile 去掉第三方依赖」)直接衔接。

### 实际做法与报告的差异

报告原提 WP1「自建 app bundle + 抄 standard preset」。实际改用官方 `web` 模板:preset 本来就是官方的、web-app 已自带,自建 bundle 只会多一份要追版本的副本。

- **禁用行比预计多**:原设想只禁 `web-startup`,不够时加禁 `webserver`、`web-runtime`。实测只禁 `web-startup` 时 DSH 启动审计报 `webserver`、`connection` 两个必需行未激活而退出;加禁 `webserver`、`web-runtime` 后仍因 `connection`(必需,依赖 `webRuntime`)退出。DSH 启动审计明确忽略被禁用的必需行,所以最终清单多了 `connection`。其余依赖这几行的浏览器端插件行停在等待状态,只在 stderr 打一条提示。
- **旧会话兼容(WP4)按用户决定不做处理、不测试**:pi-tui 组合下创建的历史会话在 `paseo` profile 下 resume 的完整性没有结论。
- **本机 pi-tui profile 保留**:用户终端仍在用 `~/.dsh/profiles/pi-tui`,插件不再触碰它;其用户层配置(第 43 行起的模型路由、默认模型、权限四段)原样复制进 `paseo` profile。复制过来的 `llm-deepseek` 行因包名与官方行不符被 DSH 跳过,这在 pi-tui 下同样发生,行为不变。
- **WP3 alpha 验收全量重跑未在本次做**:本次只跑了 smoke(目录、真实模型回合、恢复)与端口检查,其余验收项留待按 [Alpha 验收规范](../../../../docs/alpha-acceptance.md) 复测。

## 考虑过的其他做法

- 维持现状(留 pi-tui):零迁移成本;接受三方耦合与事故史,且每次 pi-tui 行为变化都波及桥(反向被依赖方绑架)。
- 迁 dsh 官方 sdk profile:协议面太窄(无 cancel/审批/流式),功能净减,见路线方针调研结论,仅列观察项。
- 迁 dsh acp profile:官方正门但丢 steer/流式/命令/问答,同样仅观察项。
- 自建 app bundle + 镜像 standard preset(报告原提 WP1):完全自控组合;但 preset 本来就是官方 dsh-web-app 自带的同一批文件,自建只多一份要逐版追的副本。
- 双轨并存(pi-tui 桥默认 + 自建 profile 可选):PASEO_DSH_PROFILE 已支持切换,但双轨=双份维护+测试矩阵翻倍,alpha 阶段不建议;正确顺序是单轨迁移,迁移期内 pi-tui 桥作回退备份。

## 后果

- dsh-base 与 dsh-web-app 的 schema 变化直接由本仓吸收(pi-tui 作者先行踩坑的一面消失,但事故史证明它更多是坑源而非盾牌)。web 模板改动行 id 或新增必需行时,启动会大声失败(启动审计列出未激活的必需行),按报错调整禁用清单;
- 插件与用户终端的 pi-tui 不再共用一份配置:模型路由等用户层配置在两个 profile 里各一份,改一处不会同步到另一处;
- 插件分发力解锁:不要求用户安装特定第三方 profile;
- 用户本人的 pi-tui 终端使用完全不受影响(插件不再触碰该 profile)。

## 怎么验证的

- `npm run smoke:bridge -- --prompt` 在默认 `paseo` profile 下通过:10 个模型、默认 preset `standard`、真实模型回合、关闭后 resume 历史完整。
- smoke 期间每 0.2 秒采样 dsh 子进程及其子进程的 `ss -ltnp`,无任何 TCP 监听,也无浏览器进程。
- `dsh --profile paseo --patch <插件生成的 patch.json> --dump-config`:四个 preset 行启用、`paseo-dsh-bridge` 行存在、四个 web 行 disabled。
- 单元测试覆盖 DSH home 解析、patch 构成、默认 profile 自动创建一次、显式 profile 缺失报错。
