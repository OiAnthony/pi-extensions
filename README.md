# Pi Extensions

个人维护的 [Pi](https://github.com/badlogic/pi-mono) 扩展合集。每个扩展均作为独立 npm package 发布，具体配置和使用方法见对应 package 的 README。

## 扩展

| Package | 功能 |
| --- | --- |
| [`@oipsanthony/pi-codex-compaction`](packages/pi-codex-compaction/README.md) | 为受支持的 Provider 提供身份绑定的 Codex Remote Compaction V2。 |
| [`@oipsanthony/pi-command-history`](packages/pi-command-history/README.md) | 按工作目录跨 Session 保存并浏览命令历史。 |
| [`@oipsanthony/pi-fork-with-herdr`](packages/pi-fork-with-herdr/README.md) | 将当前 Pi Session 分支复制到新的 Herdr tab。 |
| [`@oipsanthony/pi-model-roles`](packages/pi-model-roles/README.md) | 提供共享模型角色解析，并可在 Pi 中循环切换角色。 |
| [`@oipsanthony/pi-prompt-translator`](packages/pi-prompt-translator/README.md) | 在提交前按需将 Pi 或 OMP editor 中的中文 Prompt 翻译为英文。 |
| [`@oipsanthony/pi-session-title`](packages/pi-session-title/README.md) | 自动生成并同步 Pi Session、terminal 和 Herdr pane 标题。 |
| [`@oipsanthony/pi-tps`](packages/pi-tps/README.md) | 统计 Pi 和 OMP 的请求、Prompt 与 Session token throughput 和 latency。 |

## 安装

使用 Pi 安装指定扩展：

```bash
pi install npm:@oipsanthony/<package-name>
```

例如：

```bash
pi install npm:@oipsanthony/pi-session-title
```

## 开发

本仓库是 Bun workspace monorepo。每个 package 均通过其 `package.json` 中的 `pi` 字段声明 Extension、Skill、Prompt 或 Theme 资源。

```bash
bun install
bun run test
bun run typecheck
bun run pack:check
```

新增 package 与本地开发流程见[开发指南](docs/development-guide.md)。

## 发布

需要发版的改动应在同一个 PR 中创建 Changeset：

```bash
bun run changeset
```

选择受影响的 package 与对应的 SemVer 等级，并将生成的 `.changeset/*.md` 文件与实现一起提交。Version Packages PR 合并后，GitHub Actions 会发布尚未存在的版本。完整流程见[发布文档](docs/releasing.md)。
