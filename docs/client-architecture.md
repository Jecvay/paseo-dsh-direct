# 客户端架构

本文档描述 `paseo-dsh-pi` 在 Paseo App 前端运行的客户端结构与跨平台规则。

## 概述

客户端入口为 `index.client.tsx`，由 Paseo 前端在启动时动态加载。客户端代码在 React Native / Expo 统一多端运行时中执行，覆盖桌面端（Electron）、移动端（iOS / Android）以及 Web 端。

## 呈现与配置

1. **品牌与图标**：注册 DeepSeek 官方或定制的矢量图标（SVG），并在 Provider 选择列表、会话卡片与对话头部中正确渲染。
2. **模型与模式交互**：呈现 DSH 支持的模型列表（如 DeepSeek-V4-Flash、DeepSeek-V4-Pro）以及思考深度（`reasoning_effort`）配置。

## 跨端约束

客户端代码必须满足跨端沙箱安全与运行标准：

- **无 Node.js 依赖**：客户端代码不得引入任何 `node:` 内置模块或依赖 Node 运行时的第三方库。
- **DOM API 限制**：全局 `window` 与 `document` 对象在移动端不存在。Web 端特定行为必须置于专用模块并在非 Web 平台提供 Native 回退实现。
