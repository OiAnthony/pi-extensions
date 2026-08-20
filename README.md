# pi extensions

这里收录了一些我在使用 [Pi](https://github.com/badlogic/pi-mono) 过程中写的扩展。

Pi 社区已经有不少优秀的 extensions。这个仓库只补充其中尚未覆盖、而我日常工作流确实需要的功能。它们主要跟着我的使用需求迭代，适合时也会支持 [OMP](https://omp.sh/) 或 [Herdr](https://github.com/ogulcancelik/herdr)。

每个扩展都作为独立的 npm package 发布，可以按需安装。

| Package | 功能 | 支持环境 |
|---------|------|----------|
| [pi-codex-compaction](packages/pi-codex-compaction) | 通过 Pi 原有 compaction lifecycle 使用 Codex Remote Compaction V2 | Pi |
| [pi-command-history](packages/pi-command-history) | 按工作目录跨 session 保存并浏览命令历史 | Pi |
| [pi-fork-with-herdr](packages/pi-fork-with-herdr) | 将当前 Pi session branch 复制到新的 Herdr tab | Pi + Herdr |
| [pi-model-roles](packages/pi-model-roles) | 共享模型角色解析，并为主 Agent 提供角色循环切换 | Pi |
| [pi-prompt-translator](packages/pi-prompt-translator) | 提交前按需将 editor 中的中文 Prompt 翻译为英文 | Pi + OMP |
| [pi-session-title](packages/pi-session-title) | 自动生成并同步 session、terminal 和 Herdr pane 标题 | Pi + Herdr |
| [pi-tps](packages/pi-tps) | 统计请求、Prompt 与 Session 的 token throughput 和 latency | Pi + OMP |

## 安装

```bash
pi install npm:@oipsanthony/<package-name>
```

配置和使用方法见各 package 的 README。仓库开发与发布流程见[开发指南](docs/development-guide.md)和[发布文档](docs/releasing.md)。
