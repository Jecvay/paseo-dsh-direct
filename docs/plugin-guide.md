# 插件开发与验证

## 开发环境

使用 Node.js 22.19+ 或 24+、npm、Paseo 0.11.0 以上，以及已安装的 DSH。具体实测版本与边界见 [兼容性说明](compatibility.md)。

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run verify:notes
npm run verify:docs
```

`build` 编译 DSH 桥接并生成供服务端导入的源码模块，因此必须先于类型检查、测试和本地安装运行。生成物不提交到 Git；Git 来源的安装和更新由 Paseo manifest 构建命令重新生成，本地目录安装前须自行构建。CI 执行同一组检查。

## 目录与导入

- `index.server.ts` 注册 Provider，`server/` 包含 Node 端实现。
- `server/dsh/` 在 DSH 子进程内部执行，通过官方 `ctx` 服务访问运行时。
- `index.client.tsx` 和 `client/` 仅使用跨端接口，不能调用 Node 或 DOM API。
- `shared/` 只包含跨端类型与纯协议定义。
- `scripts/` 是开发与构建工具，不由前端导入。

Paseo 编译器检查客户端、服务端和共享模块边界。分层 TypeScript 检查用于尽早发现类型错误；仅有 TypeScript 文件后缀不能保证跨端兼容。

## Provider 事件约束

1. `send()` 接收请求，结果通过 `onEvent()` 发出；响应携带对应的 request id。
2. `catalog` 描述创建会话前的模型与模式选择；`session.config` 表示该会话实际提交的配置。
3. 用户消息回填 `clientMessageId`，与 `session.prompt_result` 对应。
4. 正文与思考使用稳定 item id 和累计文本快照。Paseo 根据前后快照切片，不应向同一个 item 发互不关联的 token。
5. 每个 started turn 恰好有一个终态；进程崩溃也必须终结活动回合、工具和交互。
6. Provider 只声明实际实现的能力；不支持的输入明确失败，不静默丢弃图片、配置或交互。

## 本机安装

在项目目录完成构建和检查后执行：

```bash
paseo plugin install "$PWD"
paseo plugin ls
paseo provider models dsh-pi
```

若已启用的插件仍显示 `disabled`，请在 Paseo 的 `config.json` 中将 `pluginsEnabled` 设为 `true`，然后执行 `paseo daemon reload`。保留配置文件中的其他字段。

插件和 Provider 是两个标识：插件管理使用 `paseo-dsh-direct`，会话操作使用 `dsh-pi`。本地源码更新后重新构建，并执行：

```bash
paseo plugin reload paseo-dsh-direct
```

Git 安装通过 `paseo plugin update paseo-dsh-direct` 更新。安装固定版本时使用已发布的 Git tag 或 commit；本地构建成功不代表远端已存在同名 tag。

## 运行配置

默认启动 `dsh --profile paseo`，使用 Daemon 可见的 DSH home（`$DSH_HOME`，未设置时为 `~/.dsh`）与凭证。`paseo` profile 不存在时，插件先执行一次 `dsh --profile paseo --from-default-profile web --dump-config` 创建它。模型路由、默认模型和权限预设写在该 profile 的 `cordis.patch.yml`。可在启动 Daemon 的环境中设置：

| 环境变量 | 用途 |
|---|---|
| `PASEO_DSH_EXECUTABLE` | DSH 可执行文件路径，默认 `dsh` |
| `PASEO_DSH_PROFILE` | 改用另一个已存在的 profile，默认 `paseo`；这里指定的 profile 缺失时直接报错，不自动创建 |

Paseo 提供的会话环境变量传入该会话的 DSH 子进程。已有历史恢复优先保留原生模型、preset、思考和权限配置；恢复后可通过 Paseo 的会话配置主动调整。

`npm run smoke:bridge` 构建桥接并验证真实 profile 的目录、历史读取和关闭，不调用模型；`paseo` profile 不存在时会先创建它。`npm run smoke:bridge -- --prompt` 额外创建测试会话、调用模型并恢复历史，会产生模型用量。

## 测试数据

单元测试使用合成协议帧、临时目录和可控的子进程。真实 profile 检查只读查询既有历史；模型、工具、中断和恢复测试使用专用会话。

DSH 会话写锁由原生运行时拥有。不要删除 `.lock` 文件来强行恢复正在另一个客户端使用的会话，也不要把生成的新 session id 当成恢复原会话的替代。

手工部署与生产实测按照根 [AGENTS.md](../AGENTS.md) 记录在 `.agents/ops-log.md`。发布前逐项核对 [Alpha 验收规范](alpha-acceptance.md)。

## 官方参考

- [Paseo Provider 开发指南](https://paseo.sh/docs/plugins/providers)
- [Paseo Direct Provider 示例](https://github.com/getpaseo/paseo/tree/main/plugin-examples/provider-direct)
- [DSH 0.2.0-rc.1 源码](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.1)
