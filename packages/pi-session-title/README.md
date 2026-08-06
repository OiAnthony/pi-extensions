# @oipsanthony/pi-session-title

为 Pi 自动生成简短会话标题，并同步到 session name、terminal tab/window title 和 Herdr pane metadata。

## 安装

```bash
pi install npm:@oipsanthony/pi-session-title
```

插件只在 TUI 模式自动运行。新 session 完成首轮有效对话后生成标题，默认每新增 4 个完整用户轮次重新评估一次。内置 `/name` 设置的名称始终优先。

## 命令

- `/session-title`：根据当前 active branch 最近的对话重新生成标题。
- `/session-title status`：显示启用状态、名称所有权和模型解析信息。

手动设置精确名称请继续使用 Pi 内置 `/name`。

## 配置

配置文件位于 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-session-title.json`：

```json
{
  "enabled": true,
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

可用 `model` 指定命名模型，例如 `openai-codex/gpt-5.4-mini`。省略时使用触发命名时的 Pi 当前模型；指定模型不可用时回退当前模型。`refreshTurns` 设为 `0` 可关闭周期重评估。

配置修改后执行 `/reload`。

## Herdr

在 Herdr pane 中，插件通过 `pane.report_metadata` 上报 display-only title，source 为 `user:pi-session-title`。它不会调用 `herdr pane rename`，因此不会覆盖用户的手动 pane label。Socket 上报失败时会回退 `herdr pane report-metadata` CLI。

## 开发

```bash
bun test packages/pi-session-title/extensions/index.test.ts
bunx tsc --noEmit --project packages/pi-session-title/tsconfig.json
cd packages/pi-session-title && npm pack --dry-run
```
