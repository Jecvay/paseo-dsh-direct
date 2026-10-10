# 决策记录: 通过 Paseo provider command 启动 dsh，并加漂移防护

Status: implemented

## 问题

插件在加载时一次性解析 `PASEO_DSH_EXECUTABLE`（否则 `dsh`），并且不注册 `command`。用户只能靠启动 Daemon 的环境变量换 dsh，Paseo 配置里的 `agents.providers.dsh-pi.command` 与 `env` 对本插件无效，`status()` 也探测不到 Paseo 实际会用的命令。同时桥接依赖 DSH 内部服务和 web 模板里的五个行名；它们改名或消失时，禁用补丁静默失效，浏览器界面与桥接并存，审批请求被别的行接走而不到达 Paseo（见 [路线调研](../../proposed/process/2026-09-26-roadmap-multi-angle-research.md) 的 P0 护栏）。

## 决定

Provider 注册 `command: ["dsh"]`。Paseo 在 `status` 与 `connect` 请求里带 `launch`（Daemon 解析后的 `command`、`args`、完整的 `env`），插件用它启动 dsh。可执行文件的优先级是：非空的 `PASEO_DSH_EXECUTABLE`，然后 `launch.command`（`launch.args` 排在 dsh 自己的参数前），最后 `dsh`。`launch.env` 是完整环境，直接作为子进程环境的底。`status()` 对请求里的 `launch` 套用同一顺序。

`PASEO_DSH_EXECUTABLE` 保持最高优先级：已有安装靠它指向 dsh，升级后不能改变行为；显式设置的环境变量也是比通用 provider 配置更具体的信号。

漂移防护是两道启动检查，失败即让连接失败并给出可读原因：对 `dsh --profile <profile> --dump-config` 的输出断言被禁用的五行都存在；握手里的可选字段 `missing` 列出 DSH 未提供的服务与方法，插件据此拒绝连接。`protocolVersion` 保持 1。真实 dsh 与真实模型的审批、问答往返测试在无密钥时跳过。

## 考虑过的其他做法

1. **继续只用 `PASEO_DSH_EXECUTABLE`、不注册 `command`**：改动最小；但 Paseo 配置对本插件无效，`status()` 与实际启动可能分叉。
2. **让 `launch.command` 优先于环境变量**：符合 Paseo 的通用约定；但会让已设环境变量的安装在升级后悄悄换了 dsh，被否决。
3. **按 `--patch` 后的合成树做断言**：能同时确认桥接行被插入；但被禁用的行在合成树里的表现没有保证，断言基础 profile 里这些行存在更直接。
4. **静态检测其他监听审批的行**：配置输出只有行 id 和插件名，不含它们监听的事件；Cordis 没有监听者枚举。放弃，改由真实 dsh 的往返测试兜底。
5. **在握手里校验事件名**：Cordis 事件订阅不会因事件不存在而报错，无法检查；只检查服务与方法。

## 后果

- 用户可以在 Paseo 配置里为 `dsh-pi` 设置 `command` 与 `env`；设了 `PASEO_DSH_EXECUTABLE` 时它们的 `command` 被忽略。
- 每次启动桥接多一次 `dsh --dump-config` 子进程。dump 失败或为空时检查放行，因此不会因 dsh 对该参数的行为变化而阻断连接，代价是这种情况下少一层保护。
- dsh 与插件不匹配时更早、更明确地失败；失败信息带 dsh 版本。
- `launch.env` 取代 `process.env` 作为底，Daemon 剥离的父会话变量不再泄漏到 dsh 子进程。
