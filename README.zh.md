# paseo-dsh-direct

[English](README.md) | 中文

面向 [Paseo](https://github.com/getpaseo/paseo) 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）原生直连插件——让你在 Paseo 桌面端、Web、iOS 和 Android 上直接驱动本机 `dsh`，获得流式思考输出、原生计划审批、子代理管理、工具图片展示与实时统计指标。

`Paseo >= 0.11.0` · `dsh 0.2.x` · `npm:paseo-dsh-direct` · [MIT 许可](LICENSE)

## 安装

请先在运行 Paseo daemon 的机器上安装 `dsh`（`0.2.x`），支持 macOS、Linux 和 Windows。Windows 上若 `PATH` 中没有 `dsh`，插件会自动探测已安装的 DSH Desktop 内置 `dsh`。

在 Paseo 中打开 **Settings → Plugins → Install Plugin**，粘贴任一来源：

- **npm（推荐）：** `npm:paseo-dsh-direct`
- **Git：** `https://github.com/Jecvay/paseo-dsh-direct`

更新插件需在 daemon 所在机器上执行以下命令（App 插件菜单没有更新入口）：

```bash
paseo plugin update paseo-dsh-direct --check   # 检查是否有新版本
paseo plugin update paseo-dsh-direct --yes     # 更新到最新版本
```

<details>
<summary>旧版本、开启 <code>pluginsEnabled</code> 与从源码安装</summary>

- **DSH `0.1.x`：** 在 Settings 填写 `npm:paseo-dsh-direct@dsh-0.1`，或用命令行执行 `paseo plugin install https://github.com/Jecvay/paseo-dsh-direct --ref rel/0.1`。
- **Paseo `0.8`–`0.10`：** 安装 `npm:paseo-dsh-direct@0.2.1`。
- **Daemon 未开启插件加载：** 在 Paseo `config.json` 顶层设置 `"pluginsEnabled": true`，然后执行 `paseo daemon reload`。
- **命令行安装指定 Git ref：**
  ```bash
  paseo plugin install github:Jecvay/paseo-dsh-direct --ref <tag-or-commit>
  ```
- **从本地源码安装：**
  ```bash
  git clone https://github.com/Jecvay/paseo-dsh-direct.git
  cd paseo-dsh-direct
  paseo plugin install "$PWD"
  paseo plugin ls
  paseo provider models dsh-pi
  ```

</details>

更多命令行安装方式与环境变量见[开发与验证指南](docs/plugin-guide.md)，完整版本规则与实测矩阵见[兼容性说明](docs/compatibility.md)。

## 为什么叫 Direct

其他 `dsh` 接入方案大多走 ACP，那是一套所有 agent 都能用的通用协议；实际用起来往往会丢掉运行时特性，流式输出、审批和会话体验都不够好用。本插件不走 ACP，直接原生对接 `dsh`，让 `dsh` 的各种行为都能按 Paseo 自己的方式完整呈现：

| 能力 | Paseo 原生体验 |
|---|---|
| **流式输出与思考** | 回复和思考过程按增量流畅输出，不会被切成一段一段；多子代理并发流会自动合并限流，避免 WebSocket / Relay 抖动或卡顿。 |
| **工具、计划与图片** | 工具审批卡、用户问答卡、完整 Markdown 计划审批卡（`Approve` / `Keep planning`）、图片与文件输入，以及工具返回图片（如 `read_image`）的内联渲染。 |
| **原生子代理（Subagents）** | DSH 子代理直接映射到 Paseo 的子会话轨道、侧边面板与父级启动卡片，并支持在设置页按模型筛选子代理可用列表。 |
| **会话与运行时管理** | 导入并恢复本机已有 DSH 会话且保留原生会话 ID。Paseo 0.14+ 支持空闲安全回收，确认无待处理代理、后台任务、目标、收件箱或提醒时才释放进程。 |
| **命令与 MCP** | DSH 斜杠命令（`/compact`、`/plan`、`/goal` 等）与用户技能直接进入 Paseo 的 `/` 菜单；Paseo 的 stdio 与 streamable HTTP MCP 服务器自动挂载进 DSH。 |
| **用量与指标** | 实时 token 与上下文占用表（DSH 0.2.1+ 压缩后立即回落），并提供目标、计划模式、权限与压缩时间线卡片。Paseo 0.17.2+ 在单轮完成后展示模型、耗时、token 与缓存命中率，会话详情展示累计轮次与总量。 |

## 使用与配置

新建对话时选择 **DeepSeek Harness**（Provider ID 为 `dsh-pi`）。本机已有原生 DSH 会话可通过 Paseo 的 **Import session** 导入并续聊。

首次启动时，插件基于 DSH 官方 `web` 模板自动创建独立的 `paseo` profile（位于 `~/.dsh/profiles/paseo`，设置了 `$DSH_HOME` 时在其下），不修改 Paseo 或 DSH 核心。模型路由、默认模型与权限预设写在对应 profile 的 `cordis.patch.yml` 中。

在 Paseo 的 **Settings → DeepSeek Harness** 页面可调整运行配置（改动对新会话或新启动的桥接生效）：

| 设置项 | 作用 |
|---|---|
| **Executable** | 指定 `dsh` 命令或绝对路径；设置 `PASEO_DSH_EXECUTABLE` 时以环境变量优先。 |
| **Profile** | 指定使用的 DSH profile（默认 `paseo`）；设置 `PASEO_DSH_PROFILE` 时优先。显式指定的 profile 不会自动创建。 |
| **Startup timeout** | 启动 `dsh` 后等待桥接就绪信号的秒数（`1`–`600`，默认 `15`）。等待范围与宿主时限详见[服务端架构](docs/server-architecture.md#桥接就绪等待与宿主时限)。 |
| **Subagents** | 通过 **Edit models** 按模型名或提供方搜索并勾选子代理可用模型。首次初始化默认全选，后续新增模型需手动勾选，详见[客户端架构](docs/client-architecture.md#设置页)。 |

**`dsh` 查找顺序：** `PASEO_DSH_EXECUTABLE` → 设置页（`Executable`）→ Paseo 配置 `agents.providers.dsh-pi.command` → `PATH` 中的 `dsh`（Windows 无 `PATH` 命中时自动回退至 DSH Desktop 内置 `dsh`）。

> **提示：** 若原生会话正被其他 DSH 客户端（如终端界面）占用，请先在原客户端释放，再从 Paseo 导入或恢复。

## 版本与兼容性

- 插件版本号的 `major.minor` 跟随支持的 DSH 线（`0.2.x` ↔ `dsh 0.2.*`），`patch` 为插件独立发布计数。
- 最低要求 Paseo `0.11.0`。新宿主特性（`0.14+` 空闲安全回收、`0.17.2+` 回合与会话指标）通过能力协商按需启用，在旧版本 Paseo 上自动降级。

完整版本策略与实测记录见[兼容性说明](docs/compatibility.md)。

## 开发

```bash
npm ci
npm run setup:hooks
npm run verify:generated
npm run typecheck
npm test
npm run verify:package
npm run verify:notes
npm run verify:docs
```

**文档导航：** [文档总索引](docs/README.zh.md) · [兼容性说明](docs/compatibility.md) · [插件开发与验证](docs/plugin-guide.md) · [服务端架构](docs/server-architecture.md) · [客户端架构](docs/client-architecture.md) · [Alpha 验收规范](docs/alpha-acceptance.md)

## 许可

[MIT](LICENSE)
