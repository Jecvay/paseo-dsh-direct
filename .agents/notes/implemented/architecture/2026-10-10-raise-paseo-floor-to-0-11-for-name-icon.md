# 决策记录: Paseo 兼容下限升到 0.11 以发布 name 与 icon

Status: implemented

## 问题

`paseo-plugin.json` 只有 `id`、`requirements`、`build`，Paseo 的插件列表和注册表页面没有展示名与图标。Paseo 0.11 的清单新增 `name`（展示名）和 `icon`（包内 PNG 相对路径），但 0.8 至 0.10 的 daemon 不认识这两个字段：`@getpaseo/server@0.8.0` 与 `0.10.3` 的 `dist/server/server/plugins/manifest.js` 都用 `z.object({ id, description, requirements, build }).strict()` 解析清单，未知的顶层字段在安装时被拒绝。Paseo 文档（`public-docs/plugins/reference.md`）也写明使用 `name`、`icon`、`media` 的清单需要 Paseo 0.11.0 及以上。

## 决定

`paseo-plugin.json` 带 `name: "DeepSeek Harness"`（与 `server/provider.ts` 的 provider label 一致）和 `icon: "dsh.png"`，`requirements.paseo` 升到 `">=0.11.0"`。`dsh.png` 是由 `dsh.svg` 渲染的 256x256 透明底 PNG，放在仓库根与 SVG 并列，并列入 `package.json` 的 `files`。文档里的兼容下限同步为 0.11；Paseo 0.8 至 0.10 的用户安装 `npm:paseo-dsh-direct@0.2.1`。

## 考虑过的其他做法

1. **保持 `>=0.8.0`，不加 `name` 与 `icon`**：0.8 至 0.10 用户继续能装新版本。代价是插件在 0.11 的界面里没有展示名和图标，且清单与宿主能力长期脱节。
2. **同一份清单保持 `>=0.8.0` 并加 `name`、`icon`**：0.8 至 0.10 的 daemon 会在安装时拒绝整份清单，等于悄悄断掉这些用户，被否决。
3. **分别维护两份清单**：安装流程只读仓库根的 `paseo-plugin.json`，无法按宿主版本选择。

## 后果

- Paseo 0.8 至 0.10 用户无法安装此后的版本，停在 `v0.2.1`（`npm:paseo-dsh-direct@0.2.1`）。
- 仓库多一个二进制资源 `dsh.png`；改动 `dsh.svg` 时要重新渲染。
- npm 包的 `files` 多一项 `dsh.png`，`npm pack --dry-run` 可核对。

## 怎么验证的

解包 `@getpaseo/server@0.8.0` 与 `0.10.3` 核对清单解析为 `.strict()`；`npm pack --dry-run` 列出 `dsh.png` 与 `paseo-plugin.json`；构建、类型检查、测试与文档门禁通过。
