# paseo-dsh-direct — DeepSeek Harness 的 Paseo Provider Plugin

本项目是为 Paseo（v0.8+）打造的第三方 Provider Plugin，旨在提供对本地 DeepSeek Harness（`dsh`）的原生级直连适配（Direct Provider），使 Paseo 用户（涵盖 iOS、Android、Desktop、Web）能直接驱动本地 DSH 智能体，获得平滑的流式响应、原生思考过程、工具审批与会话生命周期管理体验。

本项目是一个 Paseo 外部扩展插件，不是独立运行的 Agent，不侵入修改 Paseo 核心，也不替代 DSH 自身。

## 核心原则

- **严格遵守 Paseo 0.8 插件规范**：前后端三层分界明确（`server/` 运行于 Daemon 子进程，`client/` 运行于 App 前端，`shared/` 为跨端契约）。客户端代码禁止调用 Node.js 或 DOM 专属 API，必须保证移动端及跨平台兼容。
- **敏感凭证绝不上仓**：API 密钥（如 `DEEPSEEK_API_KEY`）及本地敏感路径仅通过环境变量或 Paseo 凭证系统注入，禁止硬编码或提交入库。
- **直连优先原则**：优先采用 Paseo 的 Direct Provider 接口对接 DSH 内部事件总线/RPC，绕过泛型 ACP 适配器带来的流式 chunk 拆包撕裂与交互能力降级。
- **开源交付标准**：工程与文档保持自包含、清晰规范，原生适配 `paseo plugin add` 安装机制与 [paseo.cafe](https://paseo.cafe) 社区索引。

## 子系统

- **服务端适配器（`server/`）**：Paseo Provider 注册与生命周期管理、DSH 子进程调度与 RPC 通信、流式事件转换（Timeline/Turn），细节见 `docs/server-architecture.md`。
- **客户端呈现（`client/`）**：DSH 品牌资产、模型列表、模式切换选项及前端配置，细节见 `docs/client-architecture.md`。
- **共享契约（`shared/`）**：双端 RPC 协议定义、DSH 交互事件模型与类型。
- 文档总索引：`docs/README.md`。

## 落点与查询:什么写在哪、做过什么去哪查

（本节为所有项目通用，内容固定，不要按项目改写。）

写东西之前先定落点。判据是**时态**——这件事是「现在怎样」还是「为什么这样」：

| 落点 | 装什么 | 时态 | 不装什么 |
|---|---|---|---|
| `docs/` | 现在是怎样的。给人读的说明书，也给别的 agent 读 | 现在时 | **不写变更历史**，不出现「以前」「后来改成」；不写决策理由 |
| `.agents/notes/` | 为什么是这样的。决定、放弃的方案、代价 | 按所在目录 | 不写操作手册 |

**`docs/` 只写当前事实**，因为它是要渲染给人和 agent 看的说明书。说明书里混进「这个功能以前是 X」，读的人不知道现在到底是什么。

**`.agents/notes/` 用目录表示状态、子目录表示分类**——`proposed/` 打算做、`implemented/` 已做完、`rejected/` 决定不做、`archived/` 已过时冻结；每层下再按六类 kind 分档，路径 `{lifecycle}/{kind}/`。空白上下文的 agent 看路径就知道时态与性质，不必读完全文再猜。规则见 `.agents/notes/README.md`，改完跑 `npm run verify:notes`。何时归档、何时删除，判据也在 `README.md`：留下的唯一理由是还能指导未来的工作。

**做过什么，按事件发生地查，不设通用日志**：

- 仓内改动（代码、文档、配置）→ git 项目查 `git log`（commit message 写清做了什么与验证结果）；svn / 无版本控制项目没有 git 历史，记 `.agents/CHANGELOG.md`
- 平台部署 → 部署流水线历史
- **手工仓外事件**（git 与流水线都查不到：手工生产部署/回滚、外部服务配置变更、生产实测证据、跨仓协调）→ git 项目记 `.agents/ops-log.md`（文件不存在则在第一次事件时创建；写入判据一句话：这件事 git 和流水线都查得到吗？查得到就不写）

**引用对应记录用真实路径**，不写「某篇」——记录会搬家，「某篇」修不了也查不出。

**为什么落点都在 `.agents/` 下**：`.agents/` 是 agent 的工作区，装 agent 的工作流程（`skills/`）和 agent 写的记录（`notes/`、日志文件）。顶层留给人和对外产物（`docs/`）。这也是将来把 `docs/` 渲染成文档站时天然的排除边界。

## 日常 ops

```bash
# 依赖安装
npm install

# 门禁与类型检查
npm run verify:notes
npm run verify:docs
```

**本机上线方式**：Paseo 加载的线上插件目录是 `~/src/paseo-dsh-direct-live`，它是固定在某个发布 tag 上的独立 git worktree。主工作树 `~/src/paseo-dsh-direct` 只做开发，不被 Paseo 加载，在上面切分支、改代码不影响线上。发版上线就是在 live worktree 里换到新 tag 再重载：

```bash
cd ~/src/paseo-dsh-direct-live
git checkout <新tag>
npm ci --include=dev
npm run build
paseo plugin reload paseo-dsh-direct
paseo plugin ls
```

插件 `major.minor` 必须和本机 dsh 的版本线一致（见 `docs/compatibility.md`「版本号规则」），换 dsh 版本线时要同时切 live worktree 的 tag，并按兼容性说明完整重启 Paseo daemon。

## 给 agent 的约定

- 动手前先读本文件 + 对应 `docs/`，以其为基准。
- **人读内容先过风格关**：任何给人看的产出（工单标题/评论、PR 文案、文档、报告）落笔前必须回顾对应风格规则（看板产出见 `.agents/skills/gh-board/SKILL.md`「人读内容风格」节），重要产出写完后由 style subagent 专审可读性再定稿。标准：不点开上下文，人能否一眼看懂并做出判断。
- **工作经看板调度**：工单 = GitHub issue，状态机 = [GitHub Projects 看板](https://github.com/users/Jecvay/projects/1)（机制见 `docs/board.md`，操作规约见 `.agents/skills/gh-board/SKILL.md`）。脚本面 `npm run board`。铁律：`待开工` 列只有人能拖进（开工令）；评估只做归并判断不改代码；**防稀碎默认并单**，一轮架构迭代一个 PR（Closes 父单与全部子单）；WIP=1；门禁全绿才开 PR。看板「进行中」有卡时不要在本仓做交互式改动（无头会话在同一工作树上切分支）。
- **方向性的决定要写进 `.agents/notes/`**：无论决定做还是决定不做，都写一篇（规则见 `.agents/notes/README.md`）。「方向性」在本项目指 **改变与 DSH/Paseo 的通信协议机制（如从 Direct 转为 ACP、调整 RPC 协议帧格式）、变更支持的 Paseo SDK 版本兼容性、调整前端/服务端目录边界或引入新的外部运行时依赖**；纯机械改动（错别字、格式、普通 bug 修复）不写。
- **多步骤任务优先用 subagent 派发**：需要拆解成「想清楚再执行」的活，不写文件交接，直接在派发 subagent 的 prompt 里把设计决策全部前置写清楚——任何「执行时再看」都是缺陷。subagent 的产出（反馈、教训）当场读、当场判断是否要落进 `.agents/notes/`，仓外事件按判据记 `.agents/ops-log.md`，不建单独的交接文件。
- **仓外事件当时记**：发生 git 与部署流水线都查不到的事件（手工生产部署/回滚、外部服务配置变更、生产实测证据、跨仓协调），git 项目写 `.agents/ops-log.md`（文件不存在则在此时创建）；svn / 无版本控制项目写 `.agents/CHANGELOG.md`（全量事件史）。仓内改动不记日志——commit message 承担做了什么与验证结果。
- **`docs/` 只写当前事实**：不写「以前如何、现在改成如何」，直接描述现在生效的机制。变更经过与理由的去向见「落点与查询」一节。
- **提交检查自动执行（git 项目）**：本仓用 lefthook 挂 pre-commit 文档门禁（clone 后 `npm install` 完成安装；脚本在 `scripts/verify-*`，分工见 `lefthook.yml`），提交时自动跑笔记结构与文档链接检查。被拦＝骨架不合格，修好再提交；`--no-verify` 只在明确知情的紧急情况使用。svn / 无版本控制项目没有 git 钩子，门禁全靠本条约定执行。
- 若任务与本文件描述冲突，停下向用户确认。
- 用户说「沉淀进本项目 harness / 文档 / skill」等时：核心原则/约定 → 更新本文件；细节/手册/踩坑 → `docs/<topic>.md` 并同步 `docs/README.md` 索引；决定与理由 → `.agents/notes/`；可复用流程 → `.agents/skills/<name>/`。
