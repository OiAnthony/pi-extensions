---
name: pi-package-release
description: 检查、准备并跟进 Changesets 型 Pi package 仓库的发布。用户提到 release、publish、发版、版本升级、Changeset、Version Packages PR、npm Trusted Publishing、新 package 首次发布、发布失败恢复或核对 npm/GitHub 发布状态时使用；即使用户只说“发布”“bump version”或“把这些包发出去”，也应使用本 Skill。
license: MIT
compatibility: 需要 Git；远端跟进需要 gh；npm 发布与 Trusted Publisher 配置需要 npm CLI 和 maintainer 权限。
---

# Pi Package Release

把发布视为状态驱动流程。先读取仓库中的事实来源，再执行当前阶段需要的最小动作。

## 目标状态

发布完成需要同时满足：

- 目标版本已存在于 npm。
- 对应 package Git tag 指向已审核的版本提交。
- GitHub Release 已创建。
- 发布 workflow 成功。
- 没有被遗漏的目标 package 或待处理外部动作。

不要用单一信号代表全部完成。CI 成功不等于 npm 已发布，npm 已发布也不等于 GitHub Release 已创建。

## 1. 提取仓库契约

先读取当前工作区，不依赖记忆推断流程：

```bash
git status --short --branch -uall
git remote -v
git branch --show-current
```

然后按存在情况读取：

- `AGENTS.md`、`README.md` 和发布文档。
- 根 `package.json`、workspace 配置与 lockfile。
- `.changeset/config.json` 和待处理 `.changeset/*.md`。
- CI 与 release workflow。
- 受影响 package 的 `package.json`、changelog 和发布文件列表。

从这些文件确定默认分支、package manager、验证命令、版本工具、发布命令、认证方式和分支保护规则。仓库命令与本 Skill 示例冲突时，以仓库为准。

## 2. 冻结发布范围

比较目标基线到当前 `HEAD`，列出所有变更 package：

```bash
git diff --name-status <base>..HEAD
git log --oneline <base>..HEAD
```

对每个 package 记录：

| 字段 | 含义 |
|---|---|
| package | npm package name |
| current | 本地 `package.json` 版本 |
| registry | npm 已发布版本或 `404` |
| change | fix、feature、breaking、docs 或仅内部变更 |
| changeset | 是否被待处理 Changeset 覆盖 |
| path | 常规发布或首次 bootstrap |

同一 package 有多个改动时取最高 SemVer 等级。内部依赖变化可能由 Changesets 根据配置追加 bump，不要只检查直接修改的 package。

## 3. 选择发布路径

### 常规发布

package 已存在于 npm 时，使用 Changesets 流程：

1. 检查用户可见变更是否有 Changeset。
2. 检查 Changeset 是否覆盖所有受影响 package。
3. 使用仓库规则判定 `patch`、`minor` 或 `major`。
4. 将 Changeset 与实现放入同一个功能 PR。
5. 不在功能 PR 中手动修改 package 版本、运行 `npm version` 或创建 tag。

Changeset 缺失或等级错误时，可以在用户要求准备发布或修复流程时修改；纯检查请求只报告问题。

### 新 package bootstrap

当 `npm view <name> version --json` 返回 `404` 时，先读取仓库的新 package 发布文档。若仓库采用 npm Trusted Publishing，通常需要一次 bootstrap：

1. 验证 scoped name、`publishConfig.access`、repository metadata、许可证和 tarball 内容。
2. 确认功能 PR 已通过审核和 CI，但尚未合并。
3. 使用 npm maintainer 凭据发布初始版本。
4. 将 package 绑定到指定 GitHub repository 和 release workflow。
5. 按仓库安全策略启用 npm 2FA 与 token 限制。
6. 读取 npm 状态，确认初始版本和 Trusted Publisher 配置后再合并功能 PR。

`npm publish`、`npm trust github` 和 npm 安全设置是外部高影响操作。只有用户在当前对话中明确授权后才能执行。无法读取 npm 网页安全设置时，将其列为待人工确认项，不要猜测成功。

新 package 是否需要 Changeset 取决于仓库流程。若初始版本在功能 PR 合并前已 bootstrap，通常不为首次发布额外 bump；但同一 PR 中 bootstrap 之后又有应发布的新变更时，应按仓库约定添加 Changeset。

## 4. 验证候选版本

运行仓库声明的完整验证。Changesets 型 Bun workspace 常见命令为：

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run pack:check
bunx changeset status
```

检查每个 tarball，而不只看命令退出码：

- 必要入口、README 和 LICENSE 已包含。
- 测试、临时文件、凭据和本地配置未意外包含。
- `pi` manifest 指向 tarball 中真实存在的资源。
- 内部运行时依赖可以在独立安装中解析。

验证失败时停止发布。区分代码失败、环境失败和外部服务失败，不要通过跳过检查获得绿色结果。

## 5. 功能 PR 与 Version PR

创建或更新 PR 前，重新检查 `HEAD` 和工作区。只包含当前发布范围的改动。

功能 PR 合并后：

1. 观察 release workflow 是否创建或更新 Version Packages PR。
2. 检查 Version PR 中的版本、changelog、Changeset 删除和内部依赖更新。
3. 等待 required checks 成功。
4. 只有用户明确授权时才合并 PR。

不要自行运行 `changeset version` 后绕过仓库自动生成的 Version PR，除非仓库文档明确要求手工版本流程。

## 6. 发布与验收

Version PR 合并后，跟踪 release workflow 到终态。发布成功后逐包读取：

```bash
npm view <package>@<version> --json
git ls-remote --tags origin '<package>@<version>'
gh release view '<package>@<version>' --repo <owner/repo>
```

同时确认 npm `dist-tags` 指向预期版本。若 package 有多个发布通道，明确检查 stable、next 或 beta，不能混用。

最终报告使用如下结构：

```text
status: released / ready for version PR / blocked
scope: <packages and versions>
verification: <commands and results>
npm: <published or missing>
git tags: <present or missing>
GitHub releases: <present or missing>
remaining: <manual or blocked actions>
```

## 7. 故障恢复

发布失败后先读取实际状态，再决定动作：

1. 检查 workflow 中失败的具体步骤。
2. 逐包查询 npm，识别是否部分发布成功。
3. 检查已创建的 tag 和 GitHub Release。
4. 检查 Changeset 与 Version PR 是否已消费。
5. 根据仓库文档选择重跑 workflow 或创建后续修复版本。

npm 版本不可覆盖。不要删除或重建已发布版本，不要仅因 workflow 显示失败就 bump 全部 package。手工触发 release workflow 不是 dry run，执行前需要用户明确授权。

## 操作边界

以下读取和本地验证可以直接执行：状态检查、diff、测试、typecheck、dry-run pack、Changeset 状态、npm 与 GitHub 公开状态查询。

以下动作需要当前对话中的明确授权：创建或合并 PR、push、手工 npm 发布、配置 Trusted Publisher、修改 npm 安全设置、手工触发 workflow、创建或删除 tag、创建 GitHub Release。
