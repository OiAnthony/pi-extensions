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
| `/session-title suggest "标题"` | 立即采用指定标题，后续自动刷新仍可替换它 |
| `/session-title fix "标题"` | 立即采用指定标题，并锁定它，禁止自动刷新替换和显示标题 |
| `/session-title show` | 显示当前标题；固定标题为绿色，其他标题为蓝色 |
| `/session-title hide` | 隐藏当前标题 |

`/session-title suggest "标题"` 和 `/session-title fix "标题"` 都会清理控制字符、Markdown 包装和超过 `maxLength` 的内容。`fix` 的锁定行为与 Pi 内置 `/name` 相同，并默认显示绿色 `● Fixed: 标题`。执行 `show` 后，固定标题显示为绿色 `● Fixed: 标题`，自动或建议标题显示为蓝色 `● Title: 标题`；后续 LLM 更新标题时，已显示的标记也会同步更新。标记使用 widget 而不是 footer status，因为 `pi-powerbar` 等扩展会替换内置 footer，导致 status 文本不再显示。需要重新交给自动命名时，使用 `/session-title` 并确认。

Pi 的 `/resume` 列表把名称渲染为 `warning` 颜色，且扩展无法覆盖单行颜色、名称中的 ANSI 也会被移除，因此锁定状态不会在该列表中用绿色区分。

## 配置

创建 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-session-title.json`：

```json
{
  "enabled": true,
  "model": "@tiny",
  "thinkingLevel": "minimal",
  "timeoutMs": 30000,
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
