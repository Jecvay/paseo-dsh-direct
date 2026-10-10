# paseo-dsh-direct

[English](README.md) | 中文

`paseo-dsh-direct` 通过 Direct Provider，把本机的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）接入 [Paseo](https://github.com/getpaseo/paseo)。

## 安装

需要 Paseo 0.11 及以上，并在运行 Paseo daemon 的机器上装好 `dsh`，它的 `major.minor` 要和你装的插件线一致。Paseo 0.8 至 0.10 请安装 `npm:paseo-dsh-direct@0.2.1`。

在 Paseo 里打开 **Settings → Plugins → Install Plugin**，npm 和 Git 两种来源任填一个：

| 你的 dsh | npm | Git |
|---|---|---|
| `0.2.x` | `npm:paseo-dsh-direct` | `https://github.com/Jecvay/paseo-dsh-direct` |
| `0.1.x` | `npm:paseo-dsh-direct@dsh-0.1` | 只能用命令行：`paseo plugin install https://github.com/Jecvay/paseo-dsh-direct --ref release/0.1` |

更多：[兼容性说明](docs/compatibility.md) · [命令行安装、本地目录安装、环境变量](docs/plugin-guide.md)

## 为什么叫 Direct

其他 dsh 接入大多走 ACP，那是一套所有 agent 都能用的通用协议。本插件不走 ACP，直接原生对接 dsh，dsh 的各种行为都能按 Paseo 自己的方式呈现：

- 回复和思考过程流畅地流式输出，不会被切成一段一段。
- 工具审批和 dsh 向你提的问题，显示成 Paseo 自带的审批卡片和问答卡片。
- 已有的 dsh 会话可以导入 Paseo 接着用。
- dsh 的斜杠命令（`/compact`、`/plan` 等）出现在 Paseo 的 `/` 菜单里。

## 版本号

插件版本号的 `major.minor` 跟随它支持的 dsh 线；最后一位是插件自己的发布计数，不跟 dsh 走。按本机的 dsh 版本选装对应线——见上表，完整规则和已实测的 dsh 版本见[兼容性说明](docs/compatibility.md)。

## 使用

新建对话时选择 **DeepSeek Harness**。模型和 preset 来自已配置的 DSH profile。已有原生 DSH 会话可通过 Paseo 的 **Import session** 导入，并保留原生会话标识。

Provider 支持连续正文和思考输出、工具执行与审批、用户问答、模型和 preset 配置、中断及会话恢复。它用插件专用的 `paseo` profile 启动 DSH，不修改 Paseo 或 DSH 核心。

插件使用名为 `paseo` 的 DSH profile。首次启动时，插件用 DSH 官方的 `web` 模板自动创建它（位置是 `~/.dsh/profiles/paseo`；设置了 `$DSH_HOME` 时在其下）。模型路由、默认模型和权限预设写在 `~/.dsh/profiles/paseo/cordis.patch.yml`。可在 Paseo 配置的 `agents.providers.dsh-pi.command` 或 `PASEO_DSH_EXECUTABLE`（后者优先）指定其他 `dsh` 可执行文件，通过 `PASEO_DSH_PROFILE` 改用另一个已存在的 profile；这样指定的 profile 不会被自动创建。如果 Paseo Daemon 默认关闭插件加载，请先在配置中启用 `pluginsEnabled`。

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
paseo plugin install github:Jecvay/paseo-dsh-direct --ref <tag-or-commit>
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
