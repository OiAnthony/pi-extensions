# 开发指南

本指南说明如何在仓库中新增和维护可独立发布的 Pi package。发布自动化与安全模型见[发布流程](releasing.md)。

## Workspace 约定

- 所有可发布 package 都放在 `packages/<package-name>/`。
- 只在仓库根目录执行 `bun install` 安装依赖。
- 根目录的 `bun.lock` 是 workspace 唯一的 lockfile。
- 每个 package 必须自包含。其 manifest、README、测试、发布文件和许可证应足以独立说明该 package，不依赖仓库专用文档。
- 公开 package 使用 npm scope `@oipsanthony`。

## 新建 Package

Extension package 的起始目录结构：

```text
packages/pi-example/
  extensions/
    index.ts
    index.test.ts
  .npmignore
  README.md
  LICENSE
  package.json
  tsconfig.json
```

`package.json` 只声明 package 实际需要的发布文件与运行时 peer：

```json
{
  "name": "@oipsanthony/pi-example",
  "version": "0.1.0",
  "description": "One sentence describing the Pi package.",
  "type": "module",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/OiAnthony/pi-extensions.git",
    "directory": "packages/pi-example"
  },
  "bugs": {
    "url": "https://github.com/OiAnthony/pi-extensions/issues"
  },
  "homepage": "https://github.com/OiAnthony/pi-extensions/tree/main/packages/pi-example#readme",
  "license": "MIT",
  "keywords": [
    "pi-package"
  ],
  "files": [
    "extensions",
    "LICENSE",
    "package.json",
    "README.md"
  ],
  "scripts": {
    "test": "bun test extensions",
    "typecheck": "tsc --noEmit --project tsconfig.json"
  },
  "publishConfig": {
    "access": "public"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*"
  },
  "pi": {
    "extensions": [
      "extensions/index.ts"
    ]
  }
}
```

只为 package 实际 import 的 Pi package 添加 peer dependency。例如，只有 extension import 了 `@mariozechner/pi-tui` 的公开 API 时，才添加它。保持 `files` 精确，并检查 tarball 内容。资源目录同时包含测试时，用 `.npmignore` 排除测试，例如 `extensions/**/*.test.ts`。

`pi` 字段是 Pi 识别 package 资源的接口。根据 package 实际提供的资源声明 extensions、skills、prompts 或 themes，并保持资源路径相对 package 目录。

公开发布的 Pi package 的 `keywords` 必须包含 `"pi-package"`。Pi package gallery 仅展示带此 keyword 的 package，用户也可通过 npm 的 `keywords:pi-package` 查询发现它。该 keyword 不影响 `pi install` 或资源加载；后者仍由 `pi` 字段或约定资源目录决定。

除非资源有明确例外，TypeScript 资源使用以下 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": [
    "extensions/**/*"
  ],
  "exclude": [
    "node_modules",
    "dist"
  ]
}
```

## 本地开发

提交 PR 前运行仓库级检查：

```bash
bun install
bun run typecheck
bun run test
bun run pack:check
```

`bun run pack:check` 是最终 package 边界检查。它会对所有公开 workspace package 执行 `npm pack --dry-run`，并输出实际 tarball 内容。

需要快速迭代时，直接运行 package script：

```bash
bun run --filter @oipsanthony/pi-example typecheck
bun run --filter @oipsanthony/pi-example test
```

只有发布到 npm 后，才从 npm 在 Pi 中安装 package。开发阶段应从 workspace 路径测试资源，或通过 package 的测试套件验证。

## 准备改动

创建分支，实现改动、测试和 README 更新。任何用户可见的 package 改动都需要 Changeset：

```bash
bun run changeset
```

选择每个受影响 package，并按以下规则选择 SemVer：

- `patch`：兼容修复，或会改变发布产物的文档修正。
- `minor`：兼容的新功能或配置项。
- `major`：不兼容的行为、删除的配置或变更后的公开契约。

将生成的 `.changeset/*.md` 与代码一起提交。不要手动修改 package 版本，不要在常规发布中运行 `npm version`、`npm publish` 或创建 tag。

创建 PR。只有 `verify` check 通过后，PR 才能 squash merge 到 `main`。

## 合并后的行为

包含 Changeset 的 package 改动合并后，GitHub Actions 会创建或更新 `Version Packages` PR。审核其中的版本和 changelog。该 PR squash merge 后，GitHub Actions 会通过 npm OIDC 发布新版本，并创建 package tag 和 GitHub Release。

普通功能 PR 不会直接发布 npm。版本 PR 才是发布审核门禁。

## 新公开 Package 的 Bootstrap

npm 要求 package 已存在后才能配置 Trusted Publisher，因此新 package 需要一次手工 bootstrap。

初始 package PR 已通过审核、尚未合并时：

1. 运行仓库检查并检查 tarball。
2. 使用已认证的 npm maintainer 账号，从 package 分支发布初始版本：

   ```bash
   npm publish --workspace=@oipsanthony/pi-example --access public
   ```

3. 完成 npm 2FA。
4. 将 package 绑定到 release workflow：

   ```bash
   npm trust github @oipsanthony/pi-example \
     --repo OiAnthony/pi-extensions \
     --file release.yml \
     --allow-publish
   ```

5. 在 npm package 设置中选择 `Require 2FA and disallow tokens`。
6. 合并初始 package PR。

bootstrap 后合并是安全的，因为 npm 已包含初始版本。后续版本均遵循 Changeset 和 Version Packages PR 流程。

## 发布故障恢复

不要通过手动修改版本或创建 tag 重试发布。先检查失败的 GitHub Actions run，确认 npm 是否已接受该版本，并阅读[发布流程的故障恢复部分](releasing.md#故障恢复)。

需要恢复时可手动运行 release workflow：

```bash
gh workflow run Release --repo OiAnthony/pi-extensions
```

该 workflow 由当前状态决定行为，可能创建版本 PR 或发布待处理版本。只有在明确 npm 和 Changeset 当前状态后才运行。
