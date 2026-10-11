# 决策记录: Windows 上不经 shell 启动 dsh，并支持 DSH Desktop

Status: implemented

## 问题

Windows 上 `dsh` 只以 `.cmd` / `.ps1` 包装脚本存在：npm 生成 `dsh.cmd` / `dsh.ps1`，官方 DSH Desktop 的 Manage dsh Command… 注册的是 `resources\runtime\cli\bin\dsh.cmd`。插件用不带 shell 的 `spawn` 启动 dsh，Node 不按 PATHEXT 找 `.cmd`，得到 `spawn dsh ENOENT`；把 `PASEO_DSH_EXECUTABLE` 指到 `.cmd` 时，Node 18.20.2 / 20.12.2 起（CVE-2024-27980）拒绝直接 spawn，得到 `EINVAL`；指到 `.ps1` 时，npm 的 PowerShell 包装脚本见 stdin 是管道就等 EOF，桥接等 `bridge.ready`，双方互等到超时（[issue #48](https://github.com/Jecvay/paseo-dsh-direct/issues/48)）。装了 DSH Desktop 而没注册命令的用户，插件完全找不到 dsh。

## 决定

`resolveDshLaunch` 定优先级不变，其后的 `resolveDshSpawn`（`server/dsh-spawn.ts`）给出最终的 `command` / `args` / `env`，四处 spawn 都走它。非 Windows 原样透传。Windows 上识别出包装脚本时，执行包装脚本自己执行的那条命令：

- npm 布局：`node <包装脚本目录>\node_modules\@deepseek-ai\dsh\lib\bin.js`，旁边有 `node.exe` 时用它。
- DSH Desktop 布局：`DeepSeek Harness.exe --expose-internals <app.asar>\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`，环境加 `ELECTRON_RUN_AS_NODE=1`。`cli.js` 调用的是与 npm dsh 相同的 `runCli`，`bin.js` 逐字节相同，版本与 Desktop 一致，共用 DSH home。

Paseo 在调用插件前就按 `PATH` 解析注册的 `command`，找不到即报错，插件内的回退轮不到。所以 Windows 上 `PATH` 里没有 `dsh`、Desktop 装在默认位置 `%LOCALAPPDATA%\Programs\DeepSeek Harness` 时，插件注册的 `command` 是 `DeepSeek Harness.exe`（`defaultDshCommand`，加载时定一次）；不经 Paseo 的启动在 `dsh` 找不到时也回退到这个位置。`PATH` 上的 dsh 始终优先：Desktop 的命令注册是可选的，npm dsh 与 Desktop 是两套运行时、插件状态互不相通，静默改用 Desktop 会换掉用户选的那套。真实 `.exe`、识别不出的布局原样透传。平台与文件存在判断以参数注入，Windows 分支在任何平台都有单元测试。

## 考虑过的其他做法

1. **`spawn` 带 `shell: true`**：一行改动；但参数拼进命令行、失去转义，`kill()` 只杀到 `cmd.exe`，真正的 dsh 成为孤儿。评审否决。
2. **Paseo 插件 SDK 的 `spawnProcess` / `terminateProcess`**（`@getpaseo/plugin/server`）：SDK 文档说它们处理 Windows `.cmd` 启动器，并在 Windows 上杀整棵进程树；但它对 `.cmd` 与无扩展名命令走 shell，参数转义交给 SDK；`.ps1` 的 stdin 互等问题仍在；也让启动路径依赖 SDK 的这部分行为。没有采用，保留不经 shell 的直接启动。
3. **解析包装脚本内容取出真实命令**：对布局变化更有弹性；但 npm 与 Desktop 的包装脚本格式不同、都带 `%~dp0` 等 cmd 语法，解析器比按固定布局查文件复杂得多。按布局查文件，识别不出就透传。
4. **Desktop 优先于 `PATH` 上的 dsh**：对只装 Desktop 的用户无差别；对两者都装的用户会悄悄换运行时，否决。
5. **不支持 Desktop，只让用户设 `PASEO_DSH_EXECUTABLE`**：改动更小；但 Desktop 注册的 `dsh.cmd` 照样 `EINVAL`，用户无路可走。
6. **只在 `resolveDshSpawn` 里回退到 Desktop、注册保持 `dsh`**：不动注册；但 Paseo 先解析 `command`、找不到就不调用插件，回退在 Paseo 里永远不生效（实测 `dsh not found on PATH`）。
7. **只靠文档让用户在 Desktop 里打开 Manage dsh Command…**：零代码；但只装了 Desktop 的用户仍需一步额外操作才能用。

## 后果

- Windows 上 npm 装的 dsh、Desktop 注册的 dsh、仅安装了 Desktop 三种情况都无需配置即可启动；mise 等工具的 `.exe` shim 按真实可执行文件透传。
- 插件依赖 npm 包与 Desktop 安装目录的布局（`node_modules\@deepseek-ai\dsh\lib\bin.js`、`resources\app.asar\...\dsh-desktop-host\lib\cli.js`）。布局变化时退回原样透传，即回到 `ENOENT` / `EINVAL`，不会启动错的东西。
- Desktop 的 `cli.js` 用 koffi 注册控制台 Ctrl-C 处理器；以管道 stdio、隐藏窗口启动时行为正常（见下），但这依赖 Desktop 的实现。

## 怎么验证的

Windows 11（10.0.26300），Node 24.21.0（mise），dsh 0.2.0-rc.2（npm 与 Desktop 内置版本相同）：

- `npm run smoke:bridge` 在三种 `PATH` 下通过（profile `paseo`、4 个模型、preset `standard`、会话列表）：npm `dsh.cmd`（解析为 `node.exe bin.js`）、仅 Desktop 安装（解析为 `DeepSeek Harness.exe`）、mise shim `dsh.exe`（透传）。
- 每种情况各起一次桥接，`close()` 之后、以及只杀直接子进程之后，用 `Win32_Process` 核对进程树无残留。
- `PASEO_DSH_EXECUTABLE` 指向真实 `.exe` 时原样透传，优先于 Desktop 回退。
- Paseo 0.11.2 Daemon，不设环境变量：0.2.4 在 `PATH` 只有 npm `dsh.cmd` 时 `provider diagnostic dsh-pi` 报不可用（Paseo 解析为 `...\dsh.CMD`）；本修复在同一 `PATH`、Desktop 注册的 `dsh.cmd`、仅装 Desktop、mise shim 四种情况下均为 Ready、4 个模型；插件 reload 与 `daemon stop` 后无残留 dsh 进程。
