# 发布流程

本仓库通过 Bun workspace 发布公开 npm package。各 package 独立维护语义化版本。发布由 Changeset 和经过审核的版本 PR 驱动，而不是手动创建 Git tag。

## 总览

```text
包含 Changeset 的功能 PR
  -> 合并到 main
  -> 自动创建 Version Packages PR
  -> 合并版本 PR
  -> GitHub Actions 通过 npm OIDC 发布
  -> 创建 Git tag 和 GitHub Release
```

`package.json` 中的版本是 npm 发布的事实来源。npm 接受版本后才会创建 Git tag 和 GitHub Release，因此它们是发布记录，不是发布触发条件。

## 贡献者流程

任何会影响 package 发布的改动，都要在同一个 PR 中创建 Changeset：

```bash
bun run changeset
```

选择每个受影响 package，并按 SemVer 选择升级等级：

- `patch`：兼容的修复。
- `minor`：兼容的新功能。
- `major`：不兼容的行为或 API 变更。

将生成的 `.changeset/*.md` 与实现一起提交。功能 PR 中不要直接修改 package 版本、执行 `npm version`、发布 npm，或创建 release tag。

`CI` workflow 会在每个 PR 和每次 push 到 `main` 时运行。它会安装锁定依赖、检查所有 package 的类型、运行测试，并通过 `npm pack --dry-run` 验证 npm tarball。

## 发布流程

包含 Changeset 的 PR 合并到 `main` 后，`Release` workflow 会创建或更新一个 `Version Packages` PR。该 PR 会应用所选版本并更新 package changelog。

审核生成的版本与 changelog 后，squash merge `Version Packages` PR。它合并后会再次触发 release workflow。此时没有待处理 Changeset，workflow 会发布 npm 中尚不存在的版本。

发布成功后，Changesets 会创建 package 版本 tag 和 GitHub Release。没有待处理 Changeset 或未发布版本的 `main` push 会无操作。`workflow_dispatch` 也执行同一套状态驱动流程，可能创建版本 PR 或发布待处理版本，不是 dry run。

## 安全

每个公开 npm package 都要为 `OiAnthony/pi-packages` 的 `.github/workflows/release.yml` 配置 npm Trusted Publisher。workflow 运行在 GitHub-hosted runner，并拥有 `id-token: write` 权限，因此 npm 会将 GitHub Actions 的 OIDC token 交换为短期发布凭据。

不要向 GitHub secrets 添加 `NPM_TOKEN`。完成 Trusted Publisher 配置后，在 npm 中为每个 package 启用 `Require 2FA and disallow tokens`。这样常规发布只能来自经过审核的 GitHub workflow。

`main` 分支受 GitHub ruleset 保护。所有改动必须经 PR、使用 squash merge、通过 `verify` check、解决 review conversation，并且不能 force push 或删除分支。

## 新 package 的首次发布

npm 要求 package 已经存在，才能配置 Trusted Publisher。因此新增公开 package 时，需要一次手工 bootstrap：

1. 准备并审核 package PR，包括 scoped name、公开 `publishConfig`、repository metadata、测试和发布文件。
2. 在该 PR 合并前，使用已认证的 npm maintainer 终端发布初始版本，并完成 npm 2FA。
3. 使用 `npm trust github` 将该 package 的发布权限绑定到 `OiAnthony/pi-packages` 的 `release.yml`。
4. 在 npm package 设置中启用 `Require 2FA and disallow tokens`。
5. 合并初始 package PR。之后所有版本都走常规 Changeset 流程。

每个 package 只需要 bootstrap 一次。后续版本只能由 release workflow 发布。

## 故障恢复

只在发布失败或中断时手动运行 release workflow：

```bash
gh workflow run Release --repo OiAnthony/pi-packages
```

重试前先检查 npm 中的 package 版本和对应 GitHub Release。npm 版本不可覆盖，必须先定位失败原因，再决定是否创建新版本。
