# 客户端呈现

Provider 在 Paseo 中显示为 `DeepSeek Harness`，标识为 `dsh-pi`。手机、桌面和 Web 使用 Paseo 原生新建对话、时间线、权限与历史导入界面。

## 原生界面

模型、preset 和权限预设来自 DSH profile 的官方目录，Provider 通过 `catalog` 和 `session.config` 提供选择与当前值。正文、思考、工具执行、审批和用户问答映射为 Paseo 原生事件，无需在前端解析 DSH 日志。

会话历史从 Paseo 的 Import session 入口导入；已有会话继续使用原生 DSH 标识。手机端使用同一个 Daemon 安装的插件，不需要另外安装 DSH 或 npm 包。

## 设置页

插件在 Paseo 设置里注册 `DeepSeek Harness` 页（`client/settings-screen.tsx`，图标 `terminal`），用 SDK 的 `useSettings(DSH_SETTINGS)` 读写两项文本设置：`dsh executable` 与 `dsh profile`，留空表示不设置。每项下方提示对应环境变量优先于它，改动对新会话生效。设置定义在 `shared/settings.ts`，服务端与客户端共用同一份；表单行、输入框和保存按钮来自 `@getpaseo/plugin/client/ui`。设置的取值如何参与选择见 [服务端架构](server-architecture.md)。

## 时间线卡片

插件用 `addTimelineRenderer` 注册三种单行卡片（`client/timeline-cards.tsx`，版本 1，schema 来自 `shared/timeline-cards.ts`，与服务端共用）：`plan-mode`（"Plan mode on/off"）、`permission-preset`（"Permission preset: <名称>"）和 `goal`（"Goal set/edited/paused/resumed/completed/blocked/cleared"，自动续跑显示为 "Goal continued (round N/M)"，设置、编辑和阻塞带目标或原因；`/goal` 命令引起的变更不出卡片，因为 DSH 已在命令输出里显示）。卡片用 `@getpaseo/plugin/client/ui` 的行组件，跟随宿主主题。与设置页的清理函数合并返回。服务端何时发出这些条目见 [服务端架构](server-architecture.md)。

## 跨端边界

客户端入口不启动进程、不访问文件系统、不依赖 `window`、`document` 或 HTML 标签。运行时和凭证留在 Daemon 主机。

图标为插件目录中的自包含 SVG。客户端专属扩展需要使用 Paseo 插件 SDK 和 React Native 组件，并通过宿主构建边界检查。

## DSH 界面扩展范围

`paseo` profile 由 DSH 官方 `web` 模板生成，运行时配置和扩展注册照常加载，打开浏览器界面的几行在启动时禁用。注册成功不代表该扩展在 Paseo 中具备功能；依赖浏览器或终端界面的回调与呈现需要另行适配。浏览器端的界面插件、终端菜单、快捷键和主题属于 DSH 自己界面的能力，不会自动转换成 Paseo 手机组件。
