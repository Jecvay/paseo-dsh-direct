# 决策记录: 接受 Paseo 回传的 providerOptions，恢复会话时保留 DSH 历史状态

Status: implemented

## 问题

Paseo 会把本插件在 `session.config` 中声明的 `permissionPreset`（select）与 `planMode`（toggle）持久化进 agent 记录的 `config.providerOptions`，重开会话时原样回传；`validateSessionConfig` 此前拒收任何非空 `providerOptions`，导致存有这两项配置的 `dsh-pi` agent 一律打开失败（报 `DSH does not support session config: providerOptions`）。

报障机器的 91 个 `dsh-pi` agent 中有 67 个因此无法进入历史与对话，取值只有三类：`{"planMode":false}`（63 个）、`{"planMode":true}`（3 个）、`{"permissionPreset":"danger-full-access","planMode":false}`（1 个）。其他插件使用的旧字段（如 kimi/grok 的 `auto_accept`、codex 的 `plan_mode`）与 `dsh-pi` 无关。

## 决定

- `validateSessionConfig` 接受 `permissionPreset`（string）与 `planMode`（boolean）并校验类型；遇到其他键时按 `providerOptions.<key>` 点名拒绝。
- 新建会话以 `{ ...providerOptions, ...settings }` 合成初始设置：显式 `settings` 优先，仅传 `providerOptions` 时也能生效。
- 恢复已有会话（带 `persistence` / `nativeId`）时，`permissionPreset` 与 `planMode` 均以 DSH 原生历史为准，不向桥接下发 `permissionPreset` 或 `/plan`；上报给 Paseo 的 `session.config` 取历史回放后的状态（如 `latestPlanMode(events)`）。
- `server/provider.test.ts` 覆盖带 `persistence` 与历史 `plan/mode` 事件（`true` → `false`）的真实恢复路径（断言透传 `sessionId` 与 `resume: true`、不下发 `permissionPreset` 或 `/plan`、配置跟随历史），以及未知键与两项字段的类型校验。

## 考虑过的其他做法

- **恢复时也按 `providerOptions.planMode` 调 `/plan` 对齐**：在 Paseo 里批准计划后 DSH 会写入 `plan/mode: false`，而 Paseo 存的 `providerOptions.planMode` 仍是 `true`，重开会话会再次下发 `/plan` 覆盖历史；无 `plan` 命令的 preset 还会因 `Unknown command: plan` 直接打开失败——放弃，恢复统一以 DSH 历史为准。
- **忽略任何非空 `providerOptions`**：能打开会话，但新建会话仅通过 `providerOptions` 传入的预设或计划开关会被静默丢弃，未知键与类型错误也无从发现——放弃。
- **把 `providerOptions` 整体映射进 `settings`**：`auto_accept`、`plan_mode` 属于其他插件，做通用映射会把不属于本插件的语义猜进来——放弃，只认本插件声明的两个键。
- **让 Paseo 停止回传**：需改动宿主协议，且存量记录已经落盘，迁移成本远高于在插件侧校验接受——放弃。

## 后果

- 存有 `planMode` 或 `permissionPreset` 的 `dsh-pi` 会话可正常重开，且批准计划退出或原生变更权限后的状态不会被 Paseo 持久化的旧快照覆盖。
- 未声明的 `providerOptions` 键或错误类型会显式失败，并在错误信息中直接指出具体键名。
