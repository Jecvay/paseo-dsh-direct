# 决策记录: 经 GitHub Actions 与 npm Trusted Publishing 发布

Status: implemented

## 问题

发版最后一步是 `npm publish`。npm 账号开了 Security Key 两步验证，发布必须由人在浏览器里确认；agent 的容器既推不了 tag，也登录不了 npm。发布因此成了一个全靠人手动串起来的步骤，还要在真实终端里用 `script` 包一层伪终端才能拿到确认地址。

## 决定

推送 tag `vX.Y.Z` 触发 `.github/workflows/publish.yml`，由它通过 npm Trusted Publishing（OIDC）发布，不使用长期 `NPM_TOKEN`。工作流先跑构建、类型检查、测试和文档门禁，核对 tag 与 `package.json` 版本一致，再按 tag 提交所在分支选 dist-tag：在 `origin/main` 上发 `latest`，在 `release/<major.minor>` 上发 `dsh-<major.minor>`，都不在则失败。发布带 `--provenance`。不再需要人在浏览器确认。手动的 `script` 加 `--auth-type=web` 流程保留为兜底。

触发以版本号为准：`package.json` 的版本号随 PR 合进 `main` 或 `release/<major.minor>` 时，工作流发现 npm 上还没有这个版本，就发布并用 `GITHUB_TOKEN` 推送 tag `v<版本号>`；版本已发布、tag 已存在时什么也不做。推送 tag 与在 Actions 页面手动运行仍可触发。agent 的会话推不了 tag，这样它合并版本号 PR 就能完成发版，不必等人推 tag。不给发布加 Environment 审批：发版的确认点就是版本号 PR 的合并。

npm 一侧的一次性设置写在 `AGENTS.md` 的「发布到 npm」一节。

## 考虑过的其他做法

1. **继续手动发布**：不需要额外配置，但每次都要人在场，agent 无法完成发版。
2. **在 GitHub secrets 里放 `NPM_TOKEN` 的自动化令牌**：同样能自动发布，但长期令牌泄露即等于能发包；且账号的 2FA 策略要为它放行。
3. **每次推送 `main` 都发布**：发布时机和版本号脱钩，旧线 `release/*` 的 patch 无法按 dist-tag 区分发布。
4. **只认人推的 tag**：多一道人工确认，但 agent 合并版本号 PR 后发版仍要等人，用户不需要这道确认。
5. **另建一个打 tag 的工作流，由 tag 触发发布**：`GITHUB_TOKEN` 推的 tag 不会触发其他工作流；且 Trusted Publisher 只认 `publish.yml`，所以打 tag 和发布放在同一个工作流里。

## 后果

- 发版 = 在 PR 里改版本号与 `CHANGELOG.md` 并合并；发布与打 tag 由 CI 完成，包带 provenance。
- 能往 `main` 或 `release/*` 合并改版本号提交的人（包括 agent）就能发版。
- 每条 `release/*` 分支要带上新版 `publish.yml`，分支推送才会触发；推送事件读取的是该分支上的工作流文件。
- 仓库没有长期 npm 凭证。
- Trusted Publisher 绑定仓库 `Jecvay/paseo-dsh-direct` 与工作流文件名 `publish.yml`，改名工作流文件要同步改 npm 设置。
- 工作流需要 npm 11.5.1 及以上，故在 Node 24 上运行并升级 npm。
