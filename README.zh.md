# paseo-dsh-direct

[English](README.md) | 中文

`paseo-dsh-direct` 通过 Direct Provider，把本机的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）接入 [Paseo](https://github.com/getpaseo/paseo)。

当前版本为 `0.1.3`。插件注册 Provider `dsh-pi`，在 Paseo 中显示为 **DeepSeek Harness**；插件标识为 `paseo-dsh-direct`。

## 本地安装

当前 alpha 验证组合为 Paseo `0.9.2`、DSH `0.1.7-rc.2`，以及受支持的 Node.js 运行时。运行 Paseo Daemon 的主机需要预先装好 DSH，不需要额外的 DSH 扩展包。

```bash
git clone https://github.com/Jecvay/paseo-dsh-direct.git
cd paseo-dsh-direct
npm ci
npm run build
paseo plugin install "$PWD"
paseo plugin ls
paseo provider models dsh-pi
```

构建后也可以直接安装本地源码：`paseo plugin install /absolute/path/to/paseo-dsh-direct`。从 Git 安装已有远端 ref：

```bash
paseo plugin add Jecvay/paseo-dsh-direct --ref <tag-or-commit>
```

## 版本号

插件版本号的 `major.minor` 跟随它支持的 dsh 线（`0.1.x` 对应 dsh `0.1.*`）；最后一位是插件自己的发布计数，不跟 dsh 走。按本机的 dsh 版本选装对应 tag。

| 插件版本线 | dsh 版本线 |
|---|---|
| `0.1.x` | `0.1.*` |

完整规则和已实测的 dsh 版本见[兼容性说明](docs/compatibility.md)。

## 使用

新建对话时选择 **DeepSeek Harness**。模型和 preset 来自已配置的 DSH profile。已有原生 DSH 会话可通过 Paseo 的 **Import session** 导入，并保留原生会话标识。

Provider 支持连续正文和思考输出、工具执行与审批、用户问答、模型和 preset 配置、中断及会话恢复。它用插件专用的 `paseo` profile 启动 DSH，不修改 Paseo 或 DSH 核心。

插件使用名为 `paseo` 的 DSH profile。首次启动时，插件用 DSH 官方的 `web` 模板自动创建它（位置是 `~/.dsh/profiles/paseo`；设置了 `$DSH_HOME` 时在其下）。模型路由、默认模型和权限预设写在 `~/.dsh/profiles/paseo/cordis.patch.yml`。可通过 `PASEO_DSH_EXECUTABLE` 指定其他 `dsh` 可执行文件，通过 `PASEO_DSH_PROFILE` 改用另一个已存在的 profile；这样指定的 profile 不会被自动创建。如果 Paseo Daemon 默认关闭插件加载，请先在配置中启用 `pluginsEnabled`。

如果原生会话仍被另一个 DSH 客户端（如终端界面）占用，请先在那里释放，再从 Paseo 导入或恢复。

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
