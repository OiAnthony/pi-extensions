# Pi Packages

[English](README.en.md)

用于开发和发布 Pi package 的 Bun workspace monorepo。

## 目录结构

- `packages/`：可独立安装的 Pi package。

## 开发

```bash
bun install
bun run test
bun run typecheck
bun run pack:check
```

每个 package 均通过其 `package.json` 中的 `pi` 字段声明 Extension、Skill、Prompt 或 Theme 资源。新增 package 与本地开发流程见 [Development guide](docs/development-guide.md)。

## 发布

需要发版的改动应在同一个 PR 中创建 Changeset：

```bash
bun run changeset
```

选择受影响的 package 与对应的 SemVer 等级，并将生成的 `.changeset/*.md` 文件与实现一起提交。版本 PR 合并后，GitHub Actions 会发布尚未存在的版本。完整发布流程见 [Release process](docs/releasing.md)。
