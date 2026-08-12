## Why

Pi 的会话树支持在单个 session 中保留多条分支，但同一 session 文件不适合由多个 Pi 进程并发写入。Herdr 用户需要一种可靠方式，将当前 active branch 派生为独立 session，并直接在新 tab 中并行运行 Pi。

## What Changes

- 新增 Pi package `@oipsanthony/pi-fork-with-herdr`。
- 新增 `/fork-with-herdr` 命令，将当前 active branch 复制为独立 Pi session，并在当前 Herdr workspace 的新 tab 中启动该 session。
- 新 tab 使用当前 Pi 的 cwd；源 tab 和源 session 保持不变。
- 新 tab 在后台创建，Pi ready 后才聚焦；启动失败时清理本次创建的 tab 和未使用的派生 session。
- 命令仅在 Herdr 管理的 Pi TUI 环境中执行，并对未持久化 session、空 session 和 Herdr 启动失败提供明确反馈。
- 不新增空白 Pi tab 命令，不支持从历史用户消息选择 fork 点，也不创建 Git worktree。

## Capabilities

### New Capabilities

- `herdr-session-fork`: 定义从当前 Pi active branch 创建独立 session，并在 Herdr 新 tab 中启动和聚焦该 session 的行为。

### Modified Capabilities

无。

## Impact

- 新增 `packages/pi-fork-with-herdr/` 下的 package manifest、Pi extension、测试和中文 README。
- 运行时依赖 Pi extension API、`SessionManager` 公开 API，以及 Herdr CLI 和注入的 `HERDR_*` 环境变量。
- 不修改 Pi 内置 `/fork`、现有 package 行为、Git 分支或工作目录内容。
