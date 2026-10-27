# 客户端呈现

Provider 在 Paseo 中显示为 `DeepSeek Harness`，标识为 `dsh-pi`。手机、桌面和 Web 使用 Paseo 原生新建对话、时间线、权限与历史导入界面。

## 原生界面

模型、preset 和权限预设来自 DSH profile 的官方目录，Provider 通过 `catalog` 和 `session.config` 提供选择与当前值。正文、思考、工具执行、审批和用户问答映射为 Paseo 原生事件，无需在前端解析 DSH 日志。时间线呈现密度由 Paseo 的外观设置（工具调用显示：摘要/完整详情）控制；插件不注册时间线变换（transformer），自己呈现的只有下文的插件时间线卡片。

会话历史从 Paseo 的 Import session 入口导入；已有会话继续使用原生 DSH 标识。手机端使用同一个 Daemon 安装的插件，不需要另外安装 DSH 或 npm 包。

## 设置页

插件在 Paseo 设置里注册 `DeepSeek Harness` 页（`client/settings-screen.tsx`，图标 `Settings`）。SDK 的 `useSettings(DSH_SETTINGS)` 读写 `dsh executable` 与 `dsh profile`，留空表示不设置，环境变量优先。设置定义在 `shared/settings.ts`，改动对新会话生效。设置的取值如何参与选择见 [服务端架构](server-architecture.md)。

`Subagent models` 区域通过插件 RPC 读取当前 DSH profile 的模型目录和原生子代理设置。模型按提供方分组，可搜索名称、ID 和提供方，逐项勾选、全选或清空；全选和清空作用于全部模型，不受搜索过滤影响。目录里消失的已选模型仍显示并可移除。关闭选模开关保留列表；开启时至少选择一个模型。

首次初始化选择当时可用的全部模型；已有配置（包括显式关闭和空列表）不会被覆盖，后续新增模型需要手动选择。部分提供方加载失败会显示提示，其模型恢复后也不会自动加入。保存后仅支持选模的 preset 的新会话生效，已有会话保留原策略。切换 profile 或其他客户端修改设置后，旧草稿不能直接覆盖新值，须放弃修改并刷新。列表与保存使用 TanStack Query；组件只使用 Paseo 跨端设置控件。

## 时间线卡片

插件用 `addTimelineRenderer` 注册三种单行卡片（`client/timeline-cards.tsx`，版本 1，schema 来自 `shared/timeline-cards.ts`，与服务端共用）：`plan-mode`（"Plan mode on/off"）、`permission-preset`（"Permission preset: <名称>"）和 `goal`（"Goal set/edited/paused/resumed/completed/blocked/cleared"，自动续跑显示为 "Goal continued (round N/M)"，设置、编辑和阻塞带目标或原因；`/goal` 命令引起的变更不出卡片，因为 DSH 已在命令输出里显示）。卡片用 `@getpaseo/plugin/client/ui` 的行组件，跟随宿主主题。与设置页的清理函数合并返回。服务端何时发出这些条目见 [服务端架构](server-architecture.md)。

## 跨端边界

客户端入口不启动进程、不访问文件系统、不依赖 `window`、`document` 或 HTML 标签。运行时和凭证留在 Daemon 主机。

图标为插件目录中的自包含 SVG。客户端专属扩展需要使用 Paseo 插件 SDK 和 React Native 组件，并通过宿主构建边界检查。

## DSH 界面扩展范围

`paseo` profile 由 DSH 官方 `web` 模板生成，运行时配置和扩展注册照常加载，打开浏览器界面的几行在启动时禁用。注册成功不代表该扩展在 Paseo 中具备功能；依赖浏览器或终端界面的回调与呈现需要另行适配。浏览器端的界面插件、终端菜单、快捷键和主题属于 DSH 自己界面的能力，不会自动转换成 Paseo 手机组件。
