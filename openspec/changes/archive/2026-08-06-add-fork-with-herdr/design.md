## Context

Pi session 是由 `id`/`parentId` 连接的 append-only JSONL 树。当前 active leaf 只存在于 live `SessionManager` 内存中；重新打开 session 文件时，默认 leaf 来自最后一个物理 entry。因此，`pi --fork <session>` 或在新 tab 中先 resume 原 session 都不能保证复制源 Pi 当前通过 `/tree` 选择的分支。

Pi 的命令上下文提供只读 live session 状态和 `waitForIdle()`。公开 `SessionManager` API 可以打开同一源文件的独立 manager，并通过 `createBranchedSession(leafId)` 提取指定路径。Herdr CLI 可以创建 tab，在 root pane 中启动受识别的 Pi agent，并在 agent ready 后聚焦 tab。

仓库已有 `pi-session-title` 的 Herdr 环境检测和 CLI 调用模式，但本能力作为独立 package 交付，避免把进程编排职责加入标题插件。

## Goals / Non-Goals

**Goals:**

- 精确复制 live Pi 当前 active branch，而不是复制整个 session tree 或猜测文件末尾 leaf。
- 让源 Pi 保持原 session，新 Pi 从独立 session 文件启动。
- 通过 Herdr agent surface 启动并验证 Pi ready，再切换用户焦点。
- 对创建过程提供可预测的补偿清理和可诊断错误。
- 保持实现可单元测试，不要求测试连接真实 Herdr server。

**Non-Goals:**

- 不复刻 Pi 内置 `/fork` 的历史用户消息选择器和 prompt 恢复行为。
- 不提供空白 Pi tab 命令。
- 不复制 cwd，不创建 Git branch 或 worktree，也不协调两个 Agent 的代码写入。
- 不覆盖 Pi 内置 `/fork`，不注册默认快捷键。
- 不支持非 TUI 模式或非 Herdr terminal multiplexer。

## Decisions

### 1. 使用 `/fork-with-herdr` 作为唯一命令

命令以 `/fork-*` 与 Pi 内置 fork 能力形成可发现分组，同时明确 Herdr 是承载机制。插件不注册 `/fork`，避免改变用户对内置历史消息 fork 的预期。

备选 `/fork-herdr` 更短，但容易被读成“fork Herdr”；`/herdr-fork` 不符合既定 `/fork-*` 分组。

### 2. 从独立 SessionManager 物化精确 active branch

命令在 `await ctx.waitForIdle()` 后捕获 source session file、session directory、cwd 和 live `leafId`。随后使用独立 `SessionManager.open(sourceFile, sessionDir)` 调用 `createBranchedSession(leafId)`。该调用只改变临时 manager，并创建带 `parentSession` 的新 JSONL，不替换 live AgentSession。

不调用 `ctx.fork()`，因为该 API 会 teardown 并替换当前 tab 的 session。也不使用 `pi --fork sourceFile`，因为 CLI 复制整个物理 session 文件，无法表达 live `leafId`。不采用“新 tab resume 后执行 `/clone`”，因为它会短暂并发打开源文件，而且新进程仍无法得知源进程内存中的 leaf。

### 3. 通过 Herdr tab 与 agent CLI 分两阶段启动

插件通过参数数组执行 Herdr CLI，不拼接 shell command。流程为：

```text
waitForIdle
  → validate source and active leaf
  → create derived session
  → herdr tab create --workspace <id> --cwd <cwd> --no-focus
  → parse tab id and root pane id
  → herdr agent start <unique-name> --kind pi --pane <pane-id>
       -- --session <derived-session-file>
  → herdr tab focus <tab-id>
```

使用 `agent start` 而不是 `pane run`，因为前者验证 pane 可用、识别 Pi agent，并等待其达到可交互 ready 状态。新 tab 先不聚焦，避免用户进入空 tab 或启动失败界面；只有启动成功后才聚焦。

### 4. Herdr agent name 与会话标题分离

agent name 使用 `pi-fork-<short-id>` 形式，满足 Herdr 的 `[a-z][a-z0-9_-]{0,31}` 约束。若发生罕见 live name 冲突，生成新的 suffix 后有限重试。agent name 只用于 Herdr CLI 定位，不改写 Pi session name。复制得到的 session title 和现有 `pi-session-title` 继续负责 pane metadata。

### 5. 使用补偿操作处理跨进程事务

session 文件、Herdr tab 和 Pi 进程无法组成原子事务，因此实现显式记录已创建资源：

```text
derived session ──▶ tab ──▶ ready Pi ──▶ focus
       │              │          │          │
       └─失败删除      └─失败关闭  └─成功保留  └─失败仅警告
```

如果 tab 创建失败，删除派生 session。如果 agent 启动失败，先关闭新 tab；只有确认关闭成功后才删除 session，避免仍存活的 Pi 写入已删除文件。如果 Pi 已 ready，仅聚焦失败，则保留全部资源并报告 tab id。

### 6. 将外部边界封装为可注入依赖

核心编排接收 session fork、Herdr CLI 执行、文件存在/删除和唯一名称生成依赖。extension entry 只负责 Pi API 适配、环境读取与 UI notification。测试使用假响应覆盖成功、前置条件失败、各阶段补偿失败以及 active leaf 精确传递，不启动真实 tab。

## Risks / Trade-offs

- [两个 Pi 共享 cwd，仍可能覆盖代码修改] → README 和成功提示明确 session 隔离不等于工作目录隔离；本 change 不自动创建 worktree。
- [依赖 `SessionManager.createBranchedSession` 的公开行为和 Pi 版本兼容性] → 使用 peer dependency，并通过 package typecheck 和针对分支路径的测试尽早发现 API 漂移。
- [Herdr JSON response shape 或 CLI 参数变化] → 集中解析响应并对缺失 `tab_id`、`root_pane.pane_id` 返回明确错误；不推导 ID。
- [agent start 超时后进程可能仍存活] → 先请求关闭插件创建的 tab，关闭未确认前不删除 session。
- [源 session 在命令等待期间继续变化] → 只在 `waitForIdle()` 完成后读取 file 和 leaf，并在同一个同步准备阶段创建派生 session。
- [派生 session 复制源 session name，两个 tab 初始标题相同] → Herdr agent name 保持唯一；显示标题继续由 session title 机制管理，暂不把 fork 标记写入用户 session name。

## Migration Plan

1. 新增 package，不改变现有 package 或用户配置。
2. 用户显式安装 `@oipsanthony/pi-fork-with-herdr` 后获得命令。
3. 回滚时卸载 package；已创建的派生 session 和 Herdr tab 作为正常用户资源保留。
