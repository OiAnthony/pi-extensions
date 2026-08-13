# pi-codex-compaction

在 Pi 的原有 compaction 流程中使用 Codex Remote Compaction V2。压缩结果由 Provider 生成并保存在 session 中，恢复 session、fork 或继续压缩时可以复用。

> [!WARNING]
> Remote Compaction V2 仍是实验协议。生成的 checkpoint 只能由相同的 Provider、API、模型和 endpoint 重放。

## 安装

```bash
pi install npm:@oipsanthony/pi-codex-compaction
```

## 使用

安装后无需配置。使用 Pi 官方 `openai-codex` 模型时，手动执行 `/compact` 或触发 Pi 自动压缩，扩展会优先尝试 remote compaction。

压缩开始和完成时会显示提示。remote compaction 失败时，扩展会显示 warning，并由 Pi 继续执行原生 compaction。切换到不支持的模型时，Pi 直接使用原生 compaction。

## 自定义 Provider

自定义模型需要使用 `openai-responses` 或 `openai-codex-responses` API，并在 `~/.pi/agent/models.json` 中声明 capability：

```json
{
  "providers": {
    "custom-codex": {
      "baseUrl": "https://gateway.example.com/v1",
      "api": "openai-responses",
      "apiKey": "$CUSTOM_CODEX_API_KEY",
      "models": [
        {
          "id": "gpt-example",
          "compat": {
            "remoteCompaction": {
              "protocol": "v2"
            }
          }
        }
      ]
    }
  }
}
```

默认请求地址会根据 API 和 `baseUrl` 推导。只有网关使用非标准路由时才需要指定 `endpoint`：

```json
{
  "remoteCompaction": {
    "protocol": "v2",
    "endpoint": "https://gateway.example.com/responses"
  }
}
```

`endpoint` 必须与模型的 `baseUrl` 同源，且不能包含凭据、query 或 fragment。Provider 还必须支持 Codex compaction payload、SSE response 和 `remote_compaction_v2` beta header。

也可以通过 Provider 的 `modelOverrides` 为已有模型添加相同的 `compat.remoteCompaction` 配置。

## 数据与限制

扩展会将当前对话发送到所选 Provider 的 Responses endpoint。Provider 返回的 opaque `encrypted_content` 会保存在本地 Pi session 中，并在后续兼容请求中重放。

切换 Provider、API、模型、`baseUrl` 或 endpoint 后，已有 checkpoint 不会重放。近期未压缩消息仍可继续使用，但 opaque 历史不会转换为文本摘要。

实现基于 `@narumitw/pi-codex-compact`，许可证与 attribution 见 [LICENSE](LICENSE)。
