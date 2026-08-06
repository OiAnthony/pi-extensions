# Pi Packages

用于开发和发布 Pi package 的 Bun workspace monorepo。

## 目录结构

- `packages/`：可独立安装的 Pi package。

## 可安装 Package

- [`@oipsanthony/pi-prompt-translator`](packages/pi-prompt-translator/README.md)：在提交前按需将 Pi editor 中的中文 Prompt 翻译为英文。
- [`@oipsanthony/pi-session-title`](packages/pi-session-title/README.md)：自动生成并同步 Pi session、terminal 和 Herdr pane 标题。
- [`@oipsanthony/pi-codex-compaction`](packages/pi-codex-compaction/README.md)：为受支持的 Provider 提供身份绑定的 Codex Remote Compaction V2。

## 开发

```bash
bun install
bun run test
bun run typecheck
bun run pack:check
```

每个 package 均通过其 `package.json` 中的 `pi` 字段声明 Extension、Skill、Prompt 或 Theme 资源。新增 package 与本地开发流程见[开发指南](docs/development-guide.md)。

## 发布

需要发版的改动应在同一个 PR 中创建 Changeset：

```bash
bun run changeset
```

选择受影响的 package 与对应的 SemVer 等级，并将生成的 `.changeset/*.md` 文件与实现一起提交。版本 PR 合并后，GitHub Actions 会发布尚未存在的版本。完整发布流程见[发布流程](docs/releasing.md)。
