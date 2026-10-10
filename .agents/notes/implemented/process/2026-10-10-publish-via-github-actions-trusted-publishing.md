# 决策记录: 经 GitHub Actions 与 npm Trusted Publishing 发布

Status: implemented

## 问题

发版最后一步是 `npm publish`。npm 账号开了 Security Key 两步验证，发布必须由人在浏览器里确认；agent 的容器既推不了 tag，也登录不了 npm。发布因此成了一个全靠人手动串起来的步骤，还要在真实终端里用 `script` 包一层伪终端才能拿到确认地址。

## 决定

推送 tag `vX.Y.Z` 触发 `.github/workflows/publish.yml`，由它通过 npm Trusted Publishing（OIDC）发布，不使用长期 `NPM_TOKEN`。工作流先跑构建、类型检查、测试和文档门禁，核对 tag 与 `package.json` 版本一致，再按 tag 提交所在分支选 dist-tag：在 `origin/main` 上发 `latest`，在 `release/<major.minor>` 上发 `dsh-<major.minor>`，都不在则失败。发布带 `--provenance`。人只需要推 tag，不再需要在浏览器确认。手动的 `script` 加 `--auth-type=web` 流程保留为兜底。

npm 一侧的一次性设置写在 `AGENTS.md` 的「发布到 npm」一节。

## 考虑过的其他做法

1. **继续手动发布**：不需要额外配置，但每次都要人在场，agent 无法完成发版。
2. **在 GitHub secrets 里放 `NPM_TOKEN` 的自动化令牌**：同样能自动发布，但长期令牌泄露即等于能发包；且账号的 2FA 策略要为它放行。
3. **只在 `main` 触发、不看 tag**：发布时机和版本号脱钩，旧线 `release/*` 的 patch 无法按 dist-tag 区分发布。

## 后果

- 发版 = 改版本号与 `CHANGELOG.md`、打 tag 并推送；发布由 CI 完成，包带 provenance。
- 仓库没有长期 npm 凭证。
- Trusted Publisher 绑定仓库 `Jecvay/paseo-dsh-direct` 与工作流文件名 `publish.yml`，改名工作流文件要同步改 npm 设置。
- 工作流需要 npm 11.5.1 及以上，故在 Node 24 上运行并升级 npm。
