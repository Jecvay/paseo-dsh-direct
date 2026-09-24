# paseo-dsh-pi

[English](README.md) | 中文

`paseo-dsh-pi` 通过 Direct Provider，将现有 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `pi-tui` profile 接入 [Paseo](https://github.com/getpaseo/paseo)。

当前版本为 `0.1.0-alpha.1`。插件注册 Provider `dsh-pi`，在 Paseo 中显示为 **DeepSeek Harness (pi-tui)**；插件标识为 `paseo-dsh-pi`。

## 本地安装

当前 alpha 验证组合为 Paseo `0.8.0`、DSH `0.1.7-rc.1`、`@xmoon76/dsh-pi-tui` `0.4.8`，以及受支持的 Node.js 运行时。运行 Paseo Daemon 的主机需要预先安装并配置 DSH 与 `pi-tui` profile。

```bash
git clone https://github.com/Jecvay/paseo-dsh-pi.git
cd paseo-dsh-pi
npm ci
npm run build
paseo plugin install "$PWD"
paseo plugin ls
paseo provider models dsh-pi
```

构建后也可以直接安装本地源码：`paseo plugin install /absolute/path/to/paseo-dsh-pi`。从 Git 安装已有远端 ref：

```bash
paseo plugin add Jecvay/paseo-dsh-pi --ref <tag-or-commit>
```

## 使用

新建对话时选择 **DeepSeek Harness (pi-tui)**。模型和 preset 来自已配置的 DSH profile。已有原生 DSH 会话可通过 Paseo 的 **Import session** 导入，并保留原生会话标识。

Provider 支持连续正文和思考输出、工具执行与审批、用户问答、模型和 preset 配置、中断及会话恢复。它使用 `pi-tui` profile 启动 DSH，不改写用户持久化 profile，也不修改 Paseo 或 DSH 核心。

默认 profile 为 `pi-tui`。可通过 `PASEO_DSH_EXECUTABLE` 指定其他 `dsh` 可执行文件，通过 `PASEO_DSH_PROFILE` 选择其他 profile。如果 Paseo Daemon 默认关闭插件加载，请先在配置中启用 `pluginsEnabled`。

如果原生会话仍被终端 TUI 占用，请先在那里释放，再从 Paseo 导入或恢复。

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
