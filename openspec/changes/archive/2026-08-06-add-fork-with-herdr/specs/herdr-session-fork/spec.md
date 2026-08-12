## Purpose

让 Herdr 环境中的 Pi 用户将当前会话树的 active branch 安全派生为独立 session，并在同一 workspace 的新 tab 中并行继续工作，同时避免多个 Pi 进程写入同一个 session 文件。

## ADDED Requirements

### Requirement: Herdr fork command availability
系统 SHALL 提供 `/fork-with-herdr` 命令，并且仅在 Pi TUI 运行于有效 Herdr pane 环境时执行 fork 操作。

#### Scenario: Valid Herdr environment
- **WHEN** 用户在 `HERDR_ENV=1` 且存在当前 Herdr workspace 和 pane 标识的 Pi TUI 中执行 `/fork-with-herdr`
- **THEN** 系统开始 Herdr fork 流程

#### Scenario: Outside Herdr
- **WHEN** 用户在非 Herdr 环境中执行 `/fork-with-herdr`
- **THEN** 系统显示该命令需要 Herdr 的错误信息
- **THEN** 系统不创建 session、tab 或进程

#### Scenario: Unsupported Pi mode
- **WHEN** `/fork-with-herdr` 在非 TUI 模式中被调用
- **THEN** 系统拒绝执行并且不产生外部副作用

### Requirement: Exact active branch snapshot
系统 SHALL 等待当前 Agent 完全 idle，然后将当前 session 从 root 到 active leaf 的路径复制为独立的持久化 session。派生操作 SHALL NOT 切换或修改源 Pi 的 active session。

#### Scenario: Fork after tree navigation
- **WHEN** 用户通过 `/tree` 切换到一个不是源 session 文件末尾的分支后执行 `/fork-with-herdr`
- **THEN** 派生 session 包含 root 到当前内存 active leaf 的路径
- **THEN** 派生 session 不以源文件的最后一个 entry 推断 fork 路径

#### Scenario: Command invoked while Agent is active
- **WHEN** 用户在 Agent 尚未完全 idle 时调用命令
- **THEN** 系统等待当前运行、重试、压缩和已排队 continuation 全部结束
- **THEN** 系统在等待结束后读取 active leaf 并创建派生 session

#### Scenario: Source session remains active
- **WHEN** 派生 session 创建成功
- **THEN** 源 tab 继续绑定原 session 和原 active leaf
- **THEN** 源 session 不记录由此次 fork 引起的 session replacement

#### Scenario: Session cannot be forked
- **WHEN** 当前 session 没有 active leaf、尚未持久化或 session 文件尚不存在
- **THEN** 系统显示可操作的错误信息
- **THEN** 系统不创建 Herdr tab

### Requirement: Launch fork in a new Herdr tab
系统 SHALL 在当前 Herdr workspace 创建一个使用当前 cwd 的新 tab，并在其 root pane 中启动 Pi 以恢复派生 session。

#### Scenario: Successful launch
- **WHEN** 派生 session 已创建且 Herdr 能够创建 tab 和启动 Pi
- **THEN** 新 tab 使用源 Pi 的 cwd
- **THEN** 新 Pi 使用独立的派生 session 文件启动
- **THEN** 新 Pi 以空编辑器进入 ready 状态
- **THEN** 系统在 Pi ready 后聚焦新 tab

#### Scenario: Session isolation
- **WHEN** 源 Pi 和派生 Pi 同时运行
- **THEN** 两个 Pi 进程写入不同的 session 文件
- **THEN** 两个 Pi 进程仍共享同一个 cwd

#### Scenario: Unique Herdr agent identity
- **WHEN** 系统启动派生 Pi
- **THEN** 系统为其生成符合 Herdr 约束且不与 live agent 冲突的 agent name

### Requirement: Transactional failure handling
系统 SHALL 清理尚未成功启动的 Herdr fork 资源，同时保留已经成功运行的派生 Pi。

#### Scenario: Tab creation fails
- **WHEN** 派生 session 已创建但 Herdr tab 创建失败
- **THEN** 系统删除本次创建且未使用的派生 session 文件
- **THEN** 系统在源 Pi 显示错误

#### Scenario: Pi startup fails
- **WHEN** 新 tab 已创建但 Herdr 无法在其中成功启动 Pi
- **THEN** 系统先关闭本次创建的新 tab
- **THEN** 系统仅在确认新 tab 已关闭后删除未使用的派生 session 文件
- **THEN** 系统在源 Pi 显示错误

#### Scenario: Cleanup cannot prove process termination
- **WHEN** Pi 启动失败且系统无法确认新 tab 已关闭
- **THEN** 系统保留派生 session 文件
- **THEN** 系统报告需要人工检查的部分失败

#### Scenario: Focus fails after successful startup
- **WHEN** 派生 Pi 已进入 ready 状态但新 tab 聚焦失败
- **THEN** 系统保留新 tab、派生 Pi 和派生 session
- **THEN** 系统在源 Pi 显示包含新 tab 标识的警告
