# pi-codex-compaction

为 Pi 提供 Provider-aware 的 Codex Remote Compaction V2。扩展默认支持 Pi 官方 `openai-codex` Provider，也允许在 Pi 的 `models.json` 中为其他模型声明相同的 wire protocol capability。

> Remote Compaction V2 仍是实验协议。checkpoint 包含 Provider 返回的 opaque `encrypted_content`，只能由原 Provider、API、模型和 endpoint 组合安全重放。

## 安装

```bash
pi install npm:@oipsanthony/pi-codex-compaction
```

安装后，官方 OpenAI Codex Provider 无需额外配置。正常使用 `openai-codex` 模型，手动 `/compact` 或 Pi 自动压缩时，扩展会优先尝试 remote compaction。

支持的模型开始 Remote Compaction V2 前会显示临时的 `Starting Codex Remote Compaction V2...` 提示。成功后，扩展会在 session 中保存并渲染 `Codex Remote Compaction V2 completed...` 完成标记；该标记不参与 LLM context，且在 compaction 重绘或重新打开 session 后仍可见。如果已启用 Remote Compaction V2 的请求失败，扩展会显示 fallback warning，随后由 Pi 执行原生 compaction。API 不支持或未配置 `compat.remoteCompaction` 的 Provider/Model 不会显示 remote 或 fallback 提示，直接使用 Pi 原生 compaction。

## 自定义模型

在 `~/.pi/agent/models.json` 的模型 `compat` 中声明 remote compaction capability：

```json
{
  "providers": {
    "custom-codex": {
      "baseUrl": "https://codex-gateway.example.com/v1",
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

`remoteCompaction` 包含一个必填字段和一个可选字段：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `protocol` | `"v2"` | 当前唯一支持的协议版本 |
| `endpoint` | HTTP/HTTPS URL | 可选；覆盖根据 `baseUrl` 和 API 推导的请求地址 |

默认 endpoint 按协议约定推导：

| API | 推导规则 |
| --- | --- |
| `openai-responses` | `{baseUrl}/v1/responses`；`baseUrl` 已以 `/v1` 结尾时不会重复追加 |
| `openai-codex-responses` | `{baseUrl}/codex/responses`；`baseUrl` 已以 `/codex` 或 `/codex/responses` 结尾时不会重复追加 |

`https://gateway.example` 和 `https://gateway.example/v1` 默认都推导为 `https://gateway.example/v1/responses`。扩展会为本次 compaction 构造对应的 transport `baseUrl`，不修改模型的持久配置。

只有网关明确使用无 `/v1` 路由时，才需要覆盖 endpoint：

```json
{
  "remoteCompaction": {
    "protocol": "v2",
    "endpoint": "https://gateway.example/responses"
  }
}
```

配置只声明模型能力，不注册新的 stream 实现。Provider 仍需满足以下条件：

- 模型使用 `openai-responses` 或 `openai-codex-responses` API。
- 注册 Provider 的 `stream()` 支持 Codex payload 和 SSE response。
- Provider 将请求发送到推导或显式声明的精确 `endpoint`。
- Provider 保留扩展传入的 `x-codex-beta-features: remote_compaction_v2` header。
- endpoint 接受末尾的 `{ "type": "compaction_trigger" }` input item，并返回唯一的 `compaction.encrypted_content`。

特殊网关可以显式设置 `endpoint`。该值必须与模型 `baseUrl` 同 origin，且不能包含凭据、query 或 fragment。

### 已有模型

可以通过 `modelOverrides` 为已有模型增加 capability：

```json
{
  "providers": {
    "custom-codex": {
      "modelOverrides": {
        "gpt-example": {
          "compat": {
            "remoteCompaction": {
              "protocol": "v2"
            }
          }
        }
      }
    }
  }
}
```

如果同一 Provider 的所有模型共享相同协议和 endpoint，也可以在 Provider 层设置 `compat.remoteCompaction`。模型级配置更安全，可以避免错误扩大 capability 范围。

## 固定参数

首版使用以下固定运行参数，不维护第二份配置文件：

- Request timeout：300 秒
- Maximum retries：2 次
- Replacement history budget：64K tokens
- Remote failure notification：启用

要停用自定义模型的 remote compaction，请删除该模型的 `compat.remoteCompaction`。要停用官方 Provider 的 remote compaction，请卸载或禁用此扩展。

## 安全与回退

扩展在每次 compaction 时校验实际 Provider、API、模型、`baseUrl`、真实请求 endpoint、HTTP method、beta header、payload 和 SSE output。checkpoint 持久化完整 identity，并用 retained message fingerprint 验证 resume 或 fork 后的上下文。

任一 remote 步骤失败时，扩展返回控制权，由 Pi 执行原生 compaction。Provider、模型、`baseUrl` 或 endpoint 切换后，opaque 历史不会重放；Pi 只保留 fallback marker 和近期消息。

Pi `0.83.0` 会保留 `compat` 中的扩展属性并投影到 `ctx.model`。该扩展依赖此行为；如果未来 Pi 不再保留未知 capability，扩展会停止为自定义模型启用 remote compaction，而不会绕过校验。

## 开发

```bash
bun test packages/pi-codex-compaction/extensions
bunx tsc --noEmit --project packages/pi-codex-compaction/tsconfig.json
```

协议、安全校验、SSE 解析、checkpoint replay 和 lifecycle 以 `@narumitw/pi-codex-compact` 为实现基础，并保留其 MIT attribution。
