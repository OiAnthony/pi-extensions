# pi-fork-with-herdr

`@oipsanthony/pi-fork-with-herdr` 为 Pi 增加 `/fork-with-herdr` 命令。该命令复制当前 session 的 active branch，并在当前 Herdr workspace 的新 tab 中恢复为独立 Pi session。

## 安装

```bash
pi install npm:@oipsanthony/pi-fork-with-herdr
```

也可以直接加载本地 package：

```bash
pi -e ./packages/pi-fork-with-herdr
```

## 使用

在 Herdr 管理的 Pi TUI 中执行：

```text
/fork-with-herdr
```

然后选择：

- `Fork active branch now`：立即复制当前 active branch。
- `Fork next /tree selection`：立即打开 tree selector，并从选中节点创建派生 session。

选择 `Fork next /tree selection` 后，无需再手动执行 `/tree`。该 selector 复用 Pi 的 `TreeSelectorComponent`，支持 filter、折叠、标签和节点预览。选中节点后，插件直接从该节点物化派生 branch，不调用 `navigateTree()`，因此源 session 的 active leaf 和 editor 都保持不变。选择 user 或 custom message 时，派生 branch 截止到该消息之前，与 Pi 原生 `/tree` 的节点边界一致。选择 root user message 会得到空会话，当前不支持 fork。取消 selector 时不会 fork。

命令会等待当前 Agent 完全 idle，然后读取 live session 的 active leaf。它会创建只包含 root 到该 leaf 路径的派生 session，在后台创建使用相同 cwd 的 Herdr tab，并在新 tab 的 root pane 中运行 `pi --session <derived-session-file>`。Herdr 确认新 Pi ready 后，命令才聚焦该 tab。

源 tab 不会切换 session，源 session 也不会被替换或跳转 active leaf。立即 fork 时，插件复制当前内存中的 active branch；tree selection 模式复制选中节点对应的 branch。

## 前置条件

- 必须在 Pi TUI 中运行。
- Pi 必须位于 Herdr 管理的 pane 中，并具有 `HERDR_ENV=1`、`HERDR_WORKSPACE_ID` 和 `HERDR_PANE_ID`。
- 当前 Pi session 必须已经持久化，session 文件必须存在，并且必须具有 active leaf。
- `herdr` CLI 必须可执行，并能连接当前 Herdr session。

## 隔离边界

源 Pi 和派生 Pi 写入不同的 session 文件，因此不会并发修改同一个 Pi session JSONL。两个 Pi 仍使用同一个 cwd；session 隔离不等于工作目录隔离。

两个 Agent 同时修改相同代码、运行会改写文件的命令或执行 Git 操作时，仍可能覆盖彼此的工作。需要文件系统隔离时，请在执行命令前自行创建 Git worktree，并从对应目录启动 Pi。

## 失败处理

- Herdr tab 创建失败时，命令删除尚未使用的派生 session。
- Pi 启动失败时，命令先关闭新 tab；只有 Herdr 确认关闭后才删除派生 session。
- 无法确认 tab 已关闭时，命令保留派生 session，并报告 tab 和 pane ID 供人工检查。
- Pi 已 ready 但 tab 聚焦失败时，命令保留运行中的 tab、Pi 和 session，并报告新 tab ID。
