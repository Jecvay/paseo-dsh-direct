# 决策记录: Paseo SDK 0.9 对齐

Status: implemented

## 问题

插件的 `@getpaseo/*` 开发依赖与可选 peer 依赖固定在 `0.8.0`，而实际运行的宿主 daemon 已升级到 0.9.x（当前 0.9.2）。类型编译目标与真实宿主脱节：0.9 新增的 provider 能力（如 `session.opened` 的 `toolCallId`）无法在开发期看到，peer 声明也与宿主事实不符。

## 决定

`@getpaseo/plugin`（dev）与 `@getpaseo/client` / `@getpaseo/protocol`（optional peer）统一固定为 `0.9.2` 精确版本。`paseo-plugin.json` 的 `requirements.paseo` 保持 `">=0.8.0"` 不变——加载门槛仍由 manifest 声明，SDK 版本只决定编译期类型与打包面。0.8→0.9 对本插件用到的 API 是纯增量（`session.opened` 新增可选字段、`registerSettings` 返回值变化但本插件未使用），0.8 宿主上运行不受影响。

## 考虑过的其他做法

1. **继续固定 0.8.0**：可以工作（0.9 宿主向后兼容），但类型落后于真实宿主，新字段无感知；peer 声明持续失真。
2. **使用 `^0.9` 之类的 semver 范围**：与 [版本管理总策略](2026-09-15-versioning-and-compatibility-strategy.md) 相悖——范围解析在预发布频繁的上游不可靠，且精确版本 + 探活的组合已覆盖需求。

## 后果

- 开发期类型与 0.9.2 宿主一致；宿主契约仍以 manifest `>=0.8.0` 为准。
- 每次升级宿主基线时需要同步评估这三个包（属于既有「实测基线」流程的一部分）。

## 怎么验证的

`npm install` 后 `npm run typecheck` 四个 tsconfig 全部通过，`npm test` 31 个用例全过；在 daemon 0.9.2 + 插件重载后完成真实会话验证（工具卡收敛，见 [ops-log](../../../../.agents/ops-log.md)）。
