# pi-fork-with-herdr

将当前 Pi session 的 active branch 复制到新的 [Herdr](https://github.com/ogulcancelik/herdr) tab，并在那里启动独立的 Pi session。

## 安装

```bash
pi install npm:@oipsanthony/pi-fork-with-herdr
```

## 前置条件

- Pi 运行在 Herdr 管理的 pane 中。
- `herdr` CLI 可执行并连接到当前 Herdr workspace。
- 当前 Pi session 已保存到磁盘。

## 使用

在 Pi 中执行：

```text
/fork-with-herdr
```

然后选择 fork 方式：

- `Fork active branch now`：复制当前 active branch。
- `Fork next /tree selection`：打开 tree selector，从选中的历史节点创建 branch。

扩展会在后台创建新的 Herdr tab，使用相同的工作目录启动 Pi，并在新 session 准备好后切换过去。源 tab、源 session 和源 session 的 active leaf 不会改变。

## 注意事项

两个 Pi session 使用不同的 session 文件，但共享同一个工作目录。两个 Agent 同时修改相同文件或执行 Git 操作时，仍可能互相影响。需要文件隔离时，请为其中一个 session 使用 Git worktree。

选择 tree root 时无法创建 fork。取消选择不会产生新 session。
