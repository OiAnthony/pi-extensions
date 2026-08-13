# pi-session-title

在 Pi 完成首轮对话后自动生成简短标题，并同步到 session name、terminal tab/window title 和 Herdr pane。

## 安装

```bash
pi install npm:@oipsanthony/pi-session-title
```

扩展只在 Pi TUI 中自动运行。默认每新增 4 个完整用户轮次重新检查一次标题。通过 Pi 内置 `/name` 设置的名称不会被自动覆盖。

## 命令

| 命令 | 操作 |
|------|------|
| `/session-title` | 根据当前对话重新生成标题 |
| `/session-title status` | 查看启用状态、当前名称和使用的模型 |

需要直接指定名称时，请使用 Pi 内置 `/name`。

## 配置

创建 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-session-title.json`：

```json
{
  "enabled": true,
  "model": "@tiny",
  "thinkingLevel": "minimal",
  "timeoutMs": 5000,
  "maxTokens": 40,
  "maxLength": 48,
  "refreshTurns": 4,
  "terminalTitle": {
    "enabled": true,
    "template": "π {title} ({cwd})"
  },
  "herdr": {
    "enabled": true
  }
}
```

`model` 支持 `provider/modelId` 或 [`pi-model-roles`](../pi-model-roles) 中的 `@role`。省略时使用当前 Pi 模型；配置的模型不可用时也会回退当前模型。

`thinkingLevel` 会覆盖角色中配置的 thinking level。需要沿用角色设置时，请省略该字段。

`refreshTurns` 设为 `0` 可关闭周期性重评估。`terminalTitle.template` 支持 `{title}` 和 `{cwd}`。修改配置后执行 `/reload`。

## Herdr

在 Herdr pane 中，扩展只同步 display title，不会覆盖用户手动设置的 pane label。Herdr 不可用时，Pi session name 和 terminal title 仍会正常更新。
