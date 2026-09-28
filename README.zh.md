# paseo-dsh-direct

[English](README.md) | 中文

`paseo-dsh-direct` 通过 Direct Provider，把本机的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）接入 [Paseo](https://github.com/getpaseo/paseo)。

## 安装

前提：运行 Paseo Daemon 的机器上装好 `dsh` 并在 `PATH` 里，版本 `major.minor` 与下表匹配。

在 Paseo 里：**Settings → Plugins → Install Plugin**，粘贴下面任意一种来源——npm 和 Git 是同一个插件的两条等价路径：

| dsh 版本线 | npm 来源 | Git 来源 |
|---|---|---|
| `0.2.x` | `npm:paseo-dsh-direct` | `https://github.com/Jecvay/paseo-dsh-direct` |
| `0.1.x` | `npm:paseo-dsh-direct@dsh-0.1` | 见下方说明 |

Install Plugin 输入框没有 ref/分支字段，所以 Git 来源总是装 `main` 分支（当前 `0.2.x` 线）。要从 Git 装 `0.1` 线，改用命令行：`paseo plugin install https://github.com/Jecvay/paseo-dsh-direct --ref v0.1.3`。

完整版本号规则见[兼容性说明](docs/compatibility.md)；命令行安装、开发用的本地目录安装、环境变量见[安装与使用](docs/plugin-guide.md)。

## 为什么是 Direct

插件是 Paseo 的 **Direct Provider**，不经通用 ACP 适配层——它直接对接 dsh 自己的内部事件总线和 RPC 服务（`server/dsh/bridge.ts`，一个按行分帧的 JSON-RPC 2.0 桥接，细节见[服务端架构](docs/server-architecture.md)）。这带来：

- 正文和思考的流式输出用稳定 item id 和累计快照传给 Paseo，由 Paseo 自己切出增量，不经通用适配层预先拆好的 token 碎片。
- 工具审批和用户问答以原生 Paseo 交互卡片呈现，直接走 dsh 自己的审批与问答服务。
- 已有的原生 dsh 会话通过 Paseo 的 **Import session** 导入和恢复，保留真实的 dsh 会话 id 和历史。
- dsh 自己的斜杠命令和技能（`/compact`、`/plan` 等）直接出现在 Paseo 的 `/` 目录里，实时读自正在运行的 dsh profile。

## 版本号

插件版本号的 `major.minor` 跟随它支持的 dsh 线；最后一位是插件自己的发布计数，不跟 dsh 走。按本机的 dsh 版本选装对应线——见上表，完整规则和已实测的 dsh 版本见[兼容性说明](docs/compatibility.md)。

## 使用

新建对话时选择 **DeepSeek Harness**。模型和 preset 来自已配置的 DSH profile。已有原生 DSH 会话可通过 Paseo 的 **Import session** 导入，并保留原生会话标识。

Provider 支持连续正文和思考输出、工具执行与审批、用户问答、模型和 preset 配置、中断及会话恢复。它用插件专用的 `paseo` profile 启动 DSH，不修改 Paseo 或 DSH 核心。

插件使用名为 `paseo` 的 DSH profile。首次启动时，插件用 DSH 官方的 `web` 模板自动创建它（位置是 `~/.dsh/profiles/paseo`；设置了 `$DSH_HOME` 时在其下）。模型路由、默认模型和权限预设写在 `~/.dsh/profiles/paseo/cordis.patch.yml`。可通过 `PASEO_DSH_EXECUTABLE` 指定其他 `dsh` 可执行文件，通过 `PASEO_DSH_PROFILE` 改用另一个已存在的 profile；这样指定的 profile 不会被自动创建。如果 Paseo Daemon 默认关闭插件加载，请先在配置中启用 `pluginsEnabled`。

如果原生会话仍被另一个 DSH 客户端（如终端界面）占用，请先在那里释放，再从 Paseo 导入或恢复。

## 从源码安装

用于本地开发，或不走 Settings 界面直接安装：

```bash
git clone https://github.com/Jecvay/paseo-dsh-direct.git
cd paseo-dsh-direct
npm ci
npm run build
paseo plugin install "$PWD"
paseo plugin ls
paseo provider models dsh-pi
```

构建后也可以直接安装本地源码：`paseo plugin install /absolute/path/to/paseo-dsh-direct`。命令行还能指定 Settings 界面给不了的 Git ref：

```bash
paseo plugin install https://github.com/Jecvay/paseo-dsh-direct --ref <tag-or-commit>
```

## 开发

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run verify:notes
npm run verify:docs
```

参阅[文档索引](docs/README.md)、[兼容性说明](docs/compatibility.md)、[插件开发与验证](docs/plugin-guide.md)和 [Alpha 验收规范](docs/alpha-acceptance.md)。

## 许可

[MIT](LICENSE)
