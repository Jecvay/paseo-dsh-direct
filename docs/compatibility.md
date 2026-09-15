# 兼容性与版本管理

本文档描述 `paseo-dsh-pi` 与宿主环境（Paseo）及下游运行时（`dsh`、`@xmoon76/dsh-pi-tui`）的基准版本配对、版本约束与线上更新机制。

决策依据与方案选型理由见 [三方依赖版本管理与启动探活机制](../.agents/notes/implemented/architecture/2026-09-15-versioning-and-compatibility-strategy.md)。

## 运行时基准

当前经过完整端到端测试并锁定的依赖基准如下：

| 角色 | 组件 | 当前验证基准版本 | 协议与形态 |
|---|---|---|---|
| 宿主应用 | Paseo | `0.8.0`（`>=0.8.0`） | Direct Provider 进程沙箱（`index.server.ts` + `index.client.tsx`） |
| 下游前端/Bundle | `@xmoon76/dsh-pi-tui` | `0.4.6`（稳定版） | npm 全局或 profile 安装扩展 |
| 下游智能体核心 | DeepSeek Harness (`dsh`) | `0.1.5-rc.1` / `0.1.5-rc.2` | stdio 双向通信管道与 JSON-RPC 事件流 |

## 宿主版本契约与更新机制

### 1. 宿主兼容性拦截

插件在 [paseo-plugin.json](../paseo-plugin.json) 中声明要求的 Paseo 最低版本：

```json
{
  "id": "paseo-dsh-pi",
  "requirements": {
    "paseo": ">=0.8.0"
  }
}
```

Paseo Daemon 启动与加载插件时，通过 `@getpaseo/protocol` 的兼容性断言校验当前宿主版本。若宿主低于声明的范围，Paseo 拒绝载入并向用户提示升级。

### 2. 插件热更新与 Staging 隔离

用户通过 Paseo 命令行更新本插件：

```bash
paseo plugin update paseo-dsh-pi
```

Paseo 采用暂存隔离机制执行更新：
1. 在暂存目录（Staging）下拉取最新代码并校验 `requirements.paseo`；
2. 执行 `paseo-plugin.json` 中配置的构建准备命令（`build`）；
3. 校验并打包服务端和客户端 bundle；
4. 构建通过后热替换旧进程并重载；若构建或校验失败，旧版本保持正常运行不受影响。

## 下游运行时管理机制

DSH 与 `dsh-pi-tui` 处于高频 prerelease 迭代期，Node semver 对带标签的预发布版本（如 `0.1.5-rc.1`、`0.1.6-alpha.1`）不执行跨标签的通配匹配。插件采用以下两项机制保障运行：

### 1. 启动期探活（Startup Check）

服务端拉起 `dsh` 子进程后，在进入正式会话前先发起版本探测命令或读取启动握手信息：

- **基准兼容**：若探测到的版本属于已知验证集合（如 `0.4.6` TUI 配对 `0.1.5-rc.1` / `rc.2` 核心），静默完成握手进入就绪状态。
- **过旧版本拦截**：若版本低于最低要求（如 `< 0.1.5` 导致缺失核心事件字段），向 Paseo 发射友好的通知卡片，告知用户升级命令：
  ```bash
  npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs,fs-ext @deepseek-ai/dsh@0.1.5-rc.2
  ```
- **前瞻版本放行**：若检测到更高的新版本，插件默认放行并在日志中标记，避免无谓阻塞。

### 2. 错误捕获与降级

子进程若因参数变更或协议不匹配抛出非零退出，服务端将其捕获为 `failed` 状态的 Turn，阻止前端界面挂起并保留调试日志。

## 发布渠道与版本控制

- **主线跟踪（Main）**：日常 bug 修复与向前兼容更新提交至 `main` 分支。使用 `paseo plugin add <git-url>` 的用户通过 `paseo plugin update` 获取最新代码。
- **版本锁定（Git Tag）**：针对明确的基线版本发布 Git Tag（如 `v0.1.0`）。生产环境用户可通过指定 `--ref` 安装锁定版本：
  ```bash
  paseo plugin add <git-url> --ref v0.1.0
  ```
