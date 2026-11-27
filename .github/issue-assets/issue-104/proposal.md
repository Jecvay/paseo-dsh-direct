# Issue #104: 用预生成产物替代安装时构建，满足官方注册表打包要求

Issue: https://github.com/Jecvay/paseo-dsh-direct/issues/104
基线: `b3c58d571b611950c28e29a9e360a99938c0f3e4`；目标线: `main`（插件 `0.2.x` / dsh `0.2.x`）。

**三行摘要**：官方注册表要求安装准备命令若安装依赖，必须带锁定依赖树的锁文件；本仓当前在安装时用 `npm install --include=dev` 现场装 385 个包，npm 包又不带锁文件，会被审查阻塞。改为在发布前生成并提交桥接/版本模块，npm 包直接带可用源码，删除 manifest 的 build 与 postinstall。需要本人批准：合并 `0.2.26`、由既有工作流发布、以及向官方注册表提交该版本。

## 问题

paseo.cafe 在 2026-12-01 停止目录与 `/api/plugins`，官方注册表改为 [paseo.sh/plugins](https://paseo.sh/plugins)。本仓用户文档几乎不依赖 paseo.cafe，只有 `AGENTS.md` 的维护约定和一个仍活跃的路线提案提到它；真正的问题是 npm 产物不满足官方审查要求：

- `paseo-plugin.json` 在安装时执行 `npm install --include=dev`，现场解析并安装约 385 个构建依赖。
- npm 不发布 `package-lock.json`，`0.2.25` 的 tarball 里没有任何锁文件，这次安装没有固定依赖树。
- 官方发布文档要求被安装的依赖树有锁定版本、来源与完整性校验的锁文件；审查政策把“需要锁文件却不附带”列为打包阻塞项。
- 即使改用 `npm-shrinkwrap.json` + `npm ci`，npm 12.2.3 的 `npm ci` 也不接受只含 shrinkwrap 的包：执行 `npm ci` 会报 `EUSAGE: ... can only install with an existing package-lock.json`，依赖安装方式本身也不稳定。
- `0.2.25` 已发布，不能原地修改；修复后的可提交产物必须是新版本。

本次范围是移除安装时构建、让 npm/Git/本地目录三种来源都直接可用、验证打包、更新当前文档并准备官方登记。合并、发布和向第三方提交登记仍需本人逐次确认；不提高 Paseo 或 dsh 的最低版本，不改运行时协议。

### 证据

| 结论 | 证据 | 核实方式 |
|---|---|---|
| 有准备命令安装依赖时，产物必须带锁文件；缺锁是打包阻塞项 | [发布文档](https://paseo.sh/docs/plugins/publishing) 的 “Lock installed dependencies”；[REVIEW.md](https://github.com/getpaseo/plugins/blob/main/REVIEW.md) 的 “concrete packaging blocker” | 2026-11-27 阅读原文 |
| 官方鼓励普通插件省略 build，由 Paseo 原生编译 TypeScript；已有 DSH Provider 以“无 build、直接带源码”通过审查 | [Paseo 插件参考](https://paseo.sh/docs/plugins/reference)；[geoqiao/deepseek-harness](https://github.com/getpaseo/plugins/blob/main/plugins/geoqiao/deepseek-harness.json)、[liuxing7954/dsh-paseo](https://github.com/getpaseo/plugins/blob/main/plugins/liuxing7954/dsh-paseo.json) | 2026-11-27 阅读注册表记录与审查 PR |
| npm 12.2.3 的 `npm ci` 不接受 shrinkwrap-only 包 | npm 12.2.3 在只含 `npm-shrinkwrap.json` 的包上执行 `npm ci --include=dev --ignore-scripts`，退出 1，报 `EUSAGE: ... can only install with an existing package-lock.json` | 2026-11-27 本机实际执行 |
| 当前 npm 产物没有锁文件，安装时现场解析 385 个包 | `npm pack paseo-dsh-direct@0.2.25` 文件列表无锁文件；隔离 Paseo 0.17.5 daemon 安装日志显示 `added 385 packages`，解析出的 `lefthook` 与仓库锁版本不同 | 2026-11-27 本机实际执行 |
| 现有架构允许提交预生成的 TypeScript 模块 | [TypeScript 决策](../../../.agents/notes/implemented/architecture/2026-09-16-adopt-typescript-as-core-language.md) 拒绝的是把 CJS/MJS 预编译产物当作插件入口，不是拒绝生成桥接字符串；Paseo 仍编译 `.ts` | 阅读决定记录与 Paseo 编译器实现 |
| 带 dev 依赖的 `npm ci` 构建可被审查接受（仅作为替代方案证据） | [vokturz/peer-agents PR](https://github.com/getpaseo/plugins/pull/321)、[po-trottier/omp-roles PR](https://github.com/getpaseo/plugins/pull/1471) | 2026-11-27 阅读审查记录 |

## 提案

### 改什么，数据如何流动

1. **发布前生成、随仓库提交**：删除 `.gitignore` 对 `server/generated-bridge.ts` 与 `server/generated-version.ts` 的忽略，运行 `npm run build` 生成并提交这两个文件；`files` 去掉对应的 `!` 排除项，让 npm 包包含它们；`scripts/` 只用于开发，不再随包发布。`dist/dsh-bridge.mjs` 仍只作本地中间产物，不提交、不发布。
2. **去掉宿主类型依赖**：`index.server.ts` 里的 `import("@getpaseo/client").PaseoApi` 换成只描述实际用到的 `providers.refresh` / `providers.listModels` 的本地结构类型，让干净 checkout 没有宿主包时也能编译。
3. **删除安装时构建**：从 `paseo-plugin.json` 删除 `build`；从 `package.json` 删除 `postinstall`，新增显式 `setup:hooks` 供开发者安装 lefthook。npm 包不再声明任何生命周期或准备命令；npm 来源仍由 Paseo 用宿主 npm 获取包本身，Git 与本地目录来源不经过 npm。
4. **防止生成物过期**：`npm run verify:generated` 先用 `git ls-files --error-unmatch` 确认两个生成物已被 Git 跟踪，再运行 `npm run build` 并 `git diff --exit-code` 检查提交内容与源码一致；版本号变化必须同时更新 `generated-version.ts`。CI 与 Publish 只调用这一条，不重复构建。
5. **产物级门禁**：新增 `scripts/verify-package.mjs` 与 `npm run verify:package`。它用 `npm pack --json --ignore-scripts` 打包，断言 tarball 含 `paseo-plugin.json`、`OVERVIEW.md`、入口、`server/generated-*.ts` 与 `server/dsh/bridge.ts` 源码，不含测试、`scripts/` 与 `dist/`；再用 Paseo 的 npm 获取参数把 tarball 装进临时父目录，读取安装后的 `package.json` 与 manifest，断言没有生命周期脚本、没有 `build`、生成桥接非空、版本号与 `package.json` 一致。CI 与 Publish 在发布前都执行。
6. **更新当前事实文档**：`AGENTS.md` 的社区索引改为官方注册表，开发者安装步骤补 `npm run setup:hooks`，发版步骤补“更新版本号后重新生成并提交生成物”；`docs/plugin-guide.md`、`docs/compatibility.md`、`docs/en/compatibility.md`、`docs/server-architecture.md` 改写成“无安装时构建、生成物随包发布”的现行机制；`CHANGELOG.md` 增加 `0.2.26` 条目。
7. **元数据与锁**：`package.json` 与 `paseo-plugin.json` 的 description 统一为一句 `Runs a local DeepSeek Harness (dsh) agent as a native Paseo provider.`。`package.json` 版本升到 `0.2.26`，保留 `package-lock.json` 供开发/CI 使用，不新增 shrinkwrap；路线提案里仍有效的分发计划行从 paseo.cafe 改为官方注册表，历史调研数字不动。

数据流：开发时 `npm run build` 生成桥接字符串和版本模块并提交；发布时 GitHub Actions 用仓库源码构建、检查生成物无差异、验证 tarball，再发到 npm。用户从 Git 或本地目录安装时 Paseo 直接编译随包提供的 TypeScript，不经过 npm；npm 来源仍由 Paseo 用宿主 npm 取包，但不再安装插件依赖或运行构建。

### 施工顺序

1. 删除安装时构建与 postinstall，改 `files`、`.gitignore`，生成并提交两个生成物；改 description 与版本号。
2. 新增 `scripts/verify-package.mjs`，接入 `ci.yml`、`publish.yml` 与 `package.json` scripts。
3. 更新文档、changelog、`AGENTS.md`；跑 `npm ci`、build、生成物 diff、typecheck、test、notes/docs 门禁、`verify:package`。
4. 用隔离 Paseo 0.17.5 daemon 安装干净 clone（无 `node_modules`）确认插件 `running`、provider 可用；发布后再用 npm 上精确 `0.2.26` 在干净 daemon 复验，并用 `github:Jecvay/paseo-dsh-direct --ref v0.2.26` 复验 Git 来源。
5. 生成 SVG 图解、proposal 与 PR，等本人批准合并与发布。
6. 发布核验通过后，用官方表单以 Providers 分类提交 `npm:paseo-dsh-direct@0.2.26`；listing 上线后再把真实链接写进 README 并收尾 issue。

### 兼容与回退

- 不提高 `requirements.paseo`，不改客户端/服务端契约，不触碰用户正在使用的 daemon 或插件。
- Git 与本地目录来源不再需要宿主 npm；npm 来源仍需宿主 npm 取包，但不再安装依赖或构建。安装不再受 npm 11/12 锁文件行为影响，这是比当前更少的前提。
- 失败处理：若生成物与源码不一致或产物门禁失败，保留候选并修复，不回退到安装时 `npm install`；若某个受支持平台无法加载生成物，保留候选并报告实际证据，不发布该版本。
- 旧版本 `0.1.x` 线不在本次范围；其 manifest 与发布物保持原样。

## 考虑过的其他做法

- **shrinkwrap + `npm ci` 继续安装时构建**：审查政策接受带锁的 dev 构建，仓库改动能更小；但 npm 12.2.3 不支持 shrinkwrap，使用该版本执行这条 build 会安装失败，而且每次安装仍要下载约 385 个包。不选。
- **只在发布 CI 里生成 shrinkwrap**：仓库只保留 `package-lock.json`；同样受 npm 12.2.3 的 `npm ci` 行为影响，手工发布与 tag 兜底还会漏掉转换步骤。不选。
- **保留 `npm install`，只补 lock**：安装仍可改写依赖树，审查者无法确认装的就是被审的那棵。不选。
- **只提交 Git 来源、不发布新 npm 版本**：能绕开 npm 锁问题，但 README 推荐 npm，现网用户主要从 npm 更新；把 npm 产物留在不合规状态与 issue 目标不符。不选。
- **继续留在 paseo.cafe**：该目录 2026-12-01 移除，不可行。

## 怎么算做完

- `npm pack --dry-run --ignore-scripts` 的文件列表含 `paseo-plugin.json`、`OVERVIEW.md`、入口、`server/generated-bridge.ts`、`server/generated-version.ts`，不含测试、`scripts/` 与 `dist/`。
- `npm run verify:package` 通过：安装后的 manifest 无 `build`，生成桥接非空，`PLUGIN_VERSION` 与 `0.2.26` 一致。
- `npm ci`、`npm run verify:generated`、四个 typecheck、`npm test`、`verify:notes`、`verify:docs` 全部通过。
- 隔离 Paseo 0.17.5 daemon 安装候选目录后插件为 `running`、provider 可用；发布后用 npm 上精确 `0.2.26` 复验并记录证据。
- PR 图解、proposal、版本材料与 changelog 齐备，CI 通过；本人明确批准合并与发布。
- 发布后 Actions、npm 精确版本、`latest`、远端 tag、tarball 全部核实；随后提交官方注册表并跟踪审查。

## 风险

- 生成物是约 70KB 的单行字符串，提交后 diff 较大；CI 的生成物一致性检查负责防止过期。审查者可能更愿意看源码，因此 tarball 同时保留 `server/dsh/bridge.ts` 源文件。
- 审查者可能认为“预生成 bundle”不易审查，或要求截图等 listing 媒体；这是审查判断，不是已知失败。提交正文会说明生成方式与源码位置，并按反馈补材料。
- 注册表 ID 可能按 `paseo-` 前缀规则变成 `jecvay/dsh-direct`，而不是 npm 包名；README 链接只在 listing 实际上线后写入，不猜 URL。
- 真实桌面/手机界面与注册表审查流程不在本轮可验证范围；注册表是否要求截图或拒绝预生成 bundle 也未知，不把未验证项写成通过。
