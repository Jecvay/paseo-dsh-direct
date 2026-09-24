# 决策记录: 全栈采用 TypeScript 作为核心开发语言

Status: implemented

## 问题

在开发 `paseo-dsh-pi` 插件前，需要明确工程的核心实现语言。插件需要与宿主 Paseo 的前后端沙箱体系进行深层交互，同时需要调度下游的 DeepSeek Harness（`dsh`）及其 `@xmoon76/dsh-pi-tui` profile，并依托 AI 智能体协同编码。

## 决定

工程全面采用 **TypeScript**（TS / TSX）作为唯一核心开发语言：

1. **宿主原生支持**：Paseo 0.8 官方插件规范以 TypeScript 为一等公民。Paseo Daemon 内部集成 `esbuild` 编译器（`compiler.ts`），直接读取并编译 `index.server.ts` 和 `index.client.tsx`，免去用户侧配置预编译打包流水线的负担。
2. **多端沙箱契约**：客户端 `index.client.tsx` 运行于 React Native / Expo 统一多端沙箱，客户端和共享层配置不载入 Node 或 DOM 类型；Paseo 的编译边界检查共同约束跨端依赖。
3. **生态与协同对齐**：上游 Paseo、下游 DeepSeek Harness 与 `dsh-pi-tui` 均为全 TypeScript 工程，共享 Zod Schema 与类型定义最为直接；同时 AI 智能体在 TypeScript 下具有最佳的代码补全与静态错误自检能力。
4. **统一配置**：在仓根维护标准 [tsconfig.json](../../../../tsconfig.json)，作为工程入口，并通过 shared/server/client/scripts 四份配置分别检查对应边界。

## 考虑过的其他做法

1. **采用纯 JavaScript（ESM）**
   - 优点：无需类型注解，开箱即跑。
   - 缺点：无法利用 Paseo 提供的强类型 SDK（`@getpaseo/plugin`、`@getpaseo/protocol`），在三层架构跨端边界传递数据时极易发生字段拼写错误与隐式类型转换问题；且 AI 智能体缺乏编译期类型门禁，难以主动捕获接口漂移。
2. **预编译为 CJS / MJS 发布到 npm**
   - 优点：可以直接输出标准静态产物。
   - 缺点：破坏了 Paseo Git 插件的原生加载模型（Paseo 自带 esbuild 即时编译 Staging 暂存目录源码），增加了繁琐的发布与多包管理成本。

## 后果

- 项目工程结构与 Paseo 0.8 官方推荐脚手架完全对齐，仓根新增 [tsconfig.json](../../../../tsconfig.json)。
- 团队与 AI 智能体编码必须严格遵循类型检查，禁止任意使用 `any` 绕过类型校验。
- 保证了 `shared/` 契约能在服务端与客户端之间共享类型与纯协议定义。

## 怎么验证的

1. 查阅 Paseo 0.8 源码中的 `packages/server/src/server/plugins/compiler.ts`，验证其通过 `esbuild` 原生编译 TypeScript 和 TSX。
2. 仓根创建 [tsconfig.json](../../../../tsconfig.json)，并通过 `npm run verify:notes` 与 `npm run verify:docs` 检查。
