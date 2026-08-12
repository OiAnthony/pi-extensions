# @oipsanthony/pi-session-title

为 Pi 自动生成简短会话标题，并同步到 session name、terminal tab/window title 和 Herdr pane metadata。

## 安装

```bash
pi install npm:@oipsanthony/pi-session-title
```

插件只在 TUI 模式自动运行。新 session 完成首轮有效对话后生成标题，默认每新增 4 个完整用户轮次重新评估一次。内置 `/name` 设置的名称始终优先。

## 命令

- `/session-title`：根据当前 active branch 最近的对话重新生成标题。命令会提示生成开始，并在完成时说明标题已更新或无需变化。
- `/session-title status`：显示启用状态、名称所有权和模型解析信息。

手动设置精确名称请继续使用 Pi 内置 `/name`。

## 配置

配置文件位于 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-session-title.json`：

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

`model` 可使用直接模型（例如 `openai-codex/gpt-5.4-mini`）或全局角色（例如 `@tiny`）。角色配置位于 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/model-roles.json`，格式见 [`@oipsanthony/pi-model-roles`](../pi-model-roles/README.md)。省略 `model` 时使用触发命名时的 Pi 当前模型；角色未知、引用循环、目标不存在或认证失败时，插件显示一次 warning 并回退当前模型。

thinking level 按“本插件显式 `thinkingLevel`、Role 后缀、本插件默认 `minimal`”确定。因此，如需使用 `@slow:xhigh` 等角色档位，请从配置中省略 `thinkingLevel`；显式配置始终优先。

修改本插件或 `model-roles.json` 后执行 `/reload`。`/session-title status` 会显示请求目标、最终模型、最终 thinking level 和当前模型回退状态。`refreshTurns` 设为 `0` 可关闭周期重评估。

## Herdr

在 Herdr pane 中，插件通过 `pane.report_metadata` 上报 display-only title，source 为 `user:pi-session-title`。它不会调用 `herdr pane rename`，因此不会覆盖用户的手动 pane label。Socket 上报失败时会回退 `herdr pane report-metadata` CLI。

## 开发

```bash
bun test packages/pi-session-title/extensions/index.test.ts
bunx tsc --noEmit --project packages/pi-session-title/tsconfig.json
cd packages/pi-session-title && npm pack --dry-run
```
