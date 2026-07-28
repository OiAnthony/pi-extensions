# pi-prompt-translator

在 [Pi](https://github.com/badlogic/pi-mono) 和 [OMP](https://omp.sh/) 的 editor 中按需将中文 Prompt 翻译为英文。翻译完成后只替换 editor 草稿，仍由你审阅、编辑并手动提交。

## 安装

Pi：

```bash
pi install npm:@oipsanthony/pi-prompt-translator
```

OMP：

```bash
omp install @oipsanthony/pi-prompt-translator
```

本地试用：

```bash
pi -e ./packages/pi-prompt-translator
omp --extension ./packages/pi-prompt-translator
```

## 使用

在 Pi 的 TUI editor 中输入包含中文自然语言的 Prompt，按 `ctrl+shift+t`。扩展会优先从本地缓存读取译文；未命中时会将当前 editor 文本替换为 `Translating prompt...`，并在完成后用英文替换该文案，不会弹出 TUI loading。

对于包含中文的草稿，缓存命中或模型成功返回译文时，扩展会去除原文和译文的前后空白；去除前后空白的原文也是缓存键。认证失败、模型调用失败或空响应时，扩展会恢复原始草稿。

草稿处于该扩展刚生成的原文或译文时，重复按同一快捷键会在两者之间切换，不读取缓存也不调用模型。手动修改草稿后，这个切换状态会失效；再次按快捷键会把它当作新的草稿处理。

翻译不会自动提交消息，也不会处理 Agent 输出、历史会话或 shell command。空草稿、以 `/` 开头的 slash command，以及以 `!` 或 `!!` 开头的 shell command 不会调用模型。没有中文自然语言的草稿也保持不变。

翻译提示要求模型原样保留规范化后 Prompt 正文中的 Markdown 结构、代码块、inline code、命令、路径、URL、标识符和已有英文内容。仍应在提交前检查译文。

## 配置

可选配置文件的路径取决于宿主：Pi 使用 `~/.pi/agent/pi-prompt-translator.json`，OMP 使用 `~/.omp/agent/pi-prompt-translator.json`。两个宿主保留独立的模型选择和缓存；修改配置后需要重启当前会话。根值必须是 JSON object；缺失、格式错误或未知字段都会被忽略，不会阻止宿主启动。

```json
{
  "model": "openai/gpt-5.4",
  "shortcut": "ctrl+shift+t",
  "cache": {
    "enabled": true,
    "maxAgeDays": 90,
    "maxSizeBytes": 10485760
  }
}
```

| 字段 | 说明 |
|---|---|
| `model` | 可选的翻译模型，格式为 `provider/modelId`。只按第一个 `/` 分隔，因此 `openrouter/anthropic/claude-sonnet-4` 会使用 Provider `openrouter` 与 model ID `anthropic/claude-sonnet-4`。省略或不可用时回退到当前 Pi 模型。 |
| `shortcut` | 可选快捷键。缺失或空字符串时使用默认值 `ctrl+shift+t`。 |
| `cache` | 可选缓存配置。省略时启用，条目 90 天过期，逻辑载荷上限为 10 MiB；设为 `false` 可禁用缓存。 |

`cache` object 支持以下字段：

| 字段 | 说明 |
|---|---|
| `enabled` | 是否启用缓存，默认 `true`。 |
| `maxAgeDays` | 正整数，译文写入后在指定天数后过期，默认 `90`。 |
| `maxSizeBytes` | 正整数，缓存条目的 UTF-8 逻辑载荷上限，默认 `10485760`，即 10 MiB。超过上限时会从最早写入的条目开始清理。SQLite 数据库文件的物理大小不以此为准。 |

缓存保存在宿主的 agent directory：Pi 为 `~/.pi/agent/pi-prompt-translator.db`，OMP 为 `~/.omp/agent/pi-prompt-translator.db`，与配置文件 `pi-prompt-translator.json` 同名。正常空闲时仅保留该 `.db` 文件；写事务期间 SQLite 会短暂创建 `-journal` 回滚日志，提交后自动删除，不会创建 `-wal` 或 `-shm` 文件。其中的 `translations.source` 是原文主键，直接对应 `translation` 译文；缓存支持同一宿主的多个进程并发读写。数据库繁忙、损坏或不可用时，读取会视为未命中、写入会被跳过，不会阻止新的翻译请求。

停止宿主进程后删除 `pi-prompt-translator.db` 即可清空当前宿主缓存。

扩展通过 Pi Model Registry 使用已配置的 Provider 和认证信息；不会在配置、session 或日志中保存 API Key。只有缓存未命中的翻译会产生所选模型的调用成本。

## 等待与失败

- cache 未命中时，editor 会显示 `Translating prompt...`，不会弹出额外 TUI。
- loading 期间手动修改 editor 后，翻译完成、失败或返回空内容都不会覆盖该修改。
- loading 期间重复按快捷键不会启动第二个翻译请求。
- 配置模型不可用或认证失败时，扩展通知你并尝试当前 Pi 模型。
- 没有可认证模型、调用失败或模型返回空内容时，扩展显示非阻塞通知；editor 仍显示 loading 文案时会恢复原草稿。
- 翻译不会创建 session entry，也不会替你调用 `sendMessage()` 或 `sendUserMessage()`。

## 卸载

```bash
pi remove npm:@oipsanthony/pi-prompt-translator
```
