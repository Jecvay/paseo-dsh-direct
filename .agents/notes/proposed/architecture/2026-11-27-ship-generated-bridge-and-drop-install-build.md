# 决策记录: 随包发布生成的桥接模块，取消安装时构建

Status: proposed

## 问题

官方 Paseo 插件注册表要求：安装插件时若执行会安装依赖的准备命令，产物必须带锁定依赖树的锁文件；缺锁文件是打包阻塞项（[REVIEW.md](https://github.com/getpaseo/plugins/blob/main/REVIEW.md)，2026-11-27）。本仓的 `paseo-plugin.json` 在安装时执行 `npm install --include=dev`，现场安装约 385 个构建依赖；npm 又不发布 `package-lock.json`，所以 `0.2.25` 的 npm 包里没有任何锁文件。

改用 `npm-shrinkwrap.json` + `npm ci` 能补上锁，但 npm 12.2.3 的 `npm ci` 拒绝只含 shrinkwrap 的包：执行 `npm ci` 会报 `EUSAGE: ... can only install with an existing package-lock.json`（2026-11-27 用 npm 12.2.3 实测）。安装时构建因此同时受注册表规则和 npm 版本行为影响。

## 提案

把桥接与版本模块在发布前生成、随仓库提交并放进 npm 包，安装时不再构建：

- `server/generated-bridge.ts` 与 `server/generated-version.ts` 由 `npm run build` 生成；`files` 包含它们，`.gitignore` 不再忽略。
- 删除 `paseo-plugin.json` 的 `build` 和 `package.json` 的 `postinstall`；开发者显式运行 `npm run setup:hooks`。
- CI 与 Publish 用 `verify:generated` 检查提交的生成物与重新构建一致，用 `verify:package` 从 tarball 安装并检查 manifest、桥接与版本。
- Paseo 安装 npm、Git 或本地目录来源时都直接编译随包提供的 TypeScript，不再运行插件级 npm 依赖安装或构建；npm 来源仍由 Paseo 用宿主 npm 获取包本身。

## 考虑过的其他做法

- **shrinkwrap + `npm ci` 保留安装时构建**：改动更小，审查政策也接受带锁的 dev 构建；但 npm 12.2.3 不支持 shrinkwrap，使用该版本执行这条 build 会安装失败，而且每次安装仍要下载几百个包。放弃。
- **只在发布 CI 里临时生成 shrinkwrap**：仓库只保留 `package-lock.json`；同样受 npm 12.2.3 的 `npm ci` 行为影响，手工发布和 tag 兜底容易漏步骤。放弃。
- **保留 `npm install` 并只补锁文件**：安装仍可改写依赖树，审查者无法确认装的就是被审的那棵。放弃。
- **只提交 Git 来源，不修 npm 包**：README 推荐 npm，现网用户主要从 npm 更新；把 npm 产物留在不合规状态与 issue 目标不符。放弃。

## 怎么算做完

- npm tarball 含入口、`server/generated-bridge.ts`、`server/generated-version.ts` 与 `paseo-plugin.json`，且 manifest 无 `build`。
- `verify:generated` 与 `verify:package` 在 CI/Publish 通过。
- 隔离 Paseo 0.17.5 daemon 从本地目录加载候选后为 `running`；发布后用 npm 上精确版本复验。
- 官方注册表以 Providers 分类接收该版本。执行与确认记录见 [issue #104](https://github.com/Jecvay/paseo-dsh-direct/issues/104)。

## 风险

- 生成物是约 70KB 的单行字符串，提交后 diff 较大；一致性检查防止过期。
- 审查者可能认为预生成 bundle 不如源码易审查；包内同时保留 `server/dsh/bridge.ts` 源文件，提交时说明生成方式。
- 注册表审查是否要求截图或额外材料仍未知，不把它写成保证。
