# pi-command-history

按工作目录保存 Pi 的输入历史。重新打开 Pi 或创建新 session 后，仍可在同一目录中找回之前输入的 Prompt、slash command 和 shell command。

## 安装

```bash
pi install npm:@oipsanthony/pi-command-history
```

也可以临时加载：

```bash
pi -e npm:@oipsanthony/pi-command-history
```

## 使用

| 按键 | 操作 |
|------|------|
| `Up` | 查看更早的输入 |
| `Down` | 查看更新的输入 |

在空 editor 中按 `Up` 开始浏览历史。浏览多行内容时，只有光标位于首行或末行，按键才会切换历史；autocomplete 打开时仍由 Pi 处理 `Up` 和 `Down`。

扩展会去除重复项，每个工作目录最多保留最近 500 条输入。

## 配置

可选配置文件为 `~/.pi/pi-command-history.json`：

```json
{
  "shortcuts": {
    "prev": "up",
    "next": "down"
  },
  "conflictStrategy": "auto",
  "showStatus": "hidden",
  "debug": false
}
```

| 字段 | 可选值 | 说明 |
|------|--------|------|
| `shortcuts.prev` | Pi shortcut | 上一条历史，默认 `up` |
| `shortcuts.next` | Pi shortcut | 下一条历史，默认 `down` |
| `conflictStrategy` | `auto`、`register`、`safe` | 快捷键冲突处理，默认 `auto` |
| `showStatus` | `hidden`、`text`、`full` | footer 状态显示方式，默认隐藏 |
| `debug` | `true`、`false` | 将按键诊断写入 debug log |

`auto` 会避免 Pi 对默认 `Up` 和 `Down` 发出快捷键冲突提示。`safe` 会把冲突的默认按键改为 `Ctrl+Up` 和 `Ctrl+Down`。通常无需修改该选项。

## 数据位置

历史保存在 `~/.pi/folder-history/`。启用 debug 后，日志写入 `~/.pi/pi-command-history-debug.log`，不会记录普通文本输入。

删除全部历史：

```bash
rm -rf ~/.pi/folder-history/
```

## 来源

本 package fork 自 [ross-jill-ws/pi-command-history](https://github.com/ross-jill-ws/pi-command-history)，后续改动由本仓库维护。许可证见 [LICENSE](LICENSE)。
