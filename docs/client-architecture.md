# 客户端呈现

Provider 在 Paseo 中显示为 `DeepSeek Harness`，标识为 `dsh-pi`。手机、桌面和 Web 使用 Paseo 原生新建对话、时间线、权限与历史导入界面。

## 原生界面

模型、preset 和权限预设来自 DSH profile 的官方目录，Provider 通过 `catalog` 和 `session.config` 提供选择与当前值。正文、思考、工具执行、审批和用户问答映射为 Paseo 原生事件，无需在前端解析 DSH 日志。

会话历史从 Paseo 的 Import session 入口导入；已有会话继续使用原生 DSH 标识。手机端使用同一个 Daemon 安装的插件，不需要另外安装 DSH 或 npm 包。

## 跨端边界

客户端入口不启动进程、不访问文件系统、不依赖 `window`、`document` 或 HTML 标签。运行时和凭证留在 Daemon 主机。

图标为插件目录中的自包含 SVG。客户端专属扩展需要使用 Paseo 插件 SDK 和 React Native 组件，并通过宿主构建边界检查。

## DSH 界面扩展范围

`paseo` profile 由 DSH 官方 `web` 模板生成，运行时配置和扩展注册照常加载，打开浏览器界面的几行在启动时禁用。注册成功不代表该扩展在 Paseo 中具备功能；依赖浏览器或终端界面的回调与呈现需要另行适配。浏览器端的界面插件、终端菜单、快捷键和主题属于 DSH 自己界面的能力，不会自动转换成 Paseo 手机组件。
