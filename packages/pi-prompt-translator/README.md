# pi-prompt-translator

在提交前，将 Pi 或 OMP editor 中的中文 Prompt 翻译为英文。翻译只替换当前草稿，不会自动发送消息。

## 安装

Pi：

```bash
pi install npm:@oipsanthony/pi-prompt-translator
```

OMP：

```bash
omp install @oipsanthony/pi-prompt-translator
```

## 使用

在 editor 中输入包含中文的 Prompt，然后按 `Ctrl+Shift+T`。翻译完成后检查英文草稿，再手动提交。

再次按相同快捷键，可以在刚才的中文原文和英文译文之间切换。手动修改草稿后，这组切换关系会重置。

以下内容不会触发翻译：

- 空草稿
- `/` 开头的 slash command
- `!` 或 `!!` 开头的 shell command
- 不包含中文的草稿

扩展会要求模型保留 Markdown、代码块、inline code、命令、路径、URL、标识符和已有英文内容。提交前仍应检查译文。

## 配置

配置文件位于宿主的 agent directory：

- Pi：`~/.pi/agent/pi-prompt-translator.json`
- OMP：`~/.omp/agent/pi-prompt-translator.json`

```json
{
  "model": "@translator",
  "shortcut": "ctrl+shift+t",
  "cache": {
    "enabled": true,
    "maxAgeDays": 90,
    "maxSizeBytes": 10485760
  }
}
```

`model` 支持 `provider/modelId` 或 [`pi-model-roles`](../pi-model-roles) 中的 `@role`。省略该字段时使用当前模型；配置的模型不可用时也会回退当前模型。

`cache` 默认启用，译文保留 90 天，逻辑载荷上限为 10 MiB。设为 `false` 可完全禁用缓存：

```json
{
  "cache": false
}
```

修改 Pi 配置后执行 `/reload`。OMP 不支持 reload 时，请重启当前 session。

## 缓存与调用

缓存文件位于同一 agent directory，文件名为 `pi-prompt-translator.db`。删除该文件即可清空缓存。

只有缓存未命中时才会调用模型并产生相应费用。扩展通过宿主的 Model Registry 使用现有 Provider 认证，不会把 API key 写入配置、session 或缓存。
