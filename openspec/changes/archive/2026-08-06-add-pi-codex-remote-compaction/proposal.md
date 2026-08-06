## Why

Pi 缺少一个可同时支持官方 OpenAI Codex Provider 和兼容网关的通用 Remote Compaction 扩展。现有实现要么绑定 ChatGPT OAuth 身份与私有 URL 假设，要么缺少严格的请求、checkpoint 身份校验和可靠回退，难以安全用于自定义 Provider。

## What Changes

- 新增独立发布的 `pi-codex-compaction` package，接管 Pi 的 compaction 生命周期并优先尝试远程压缩。
- 默认支持 Pi 官方 OpenAI Codex Provider；其他模型必须通过 `models.json` 的 `compat.remoteCompaction` 显式声明协议能力。
- 实现 Remote Compaction V2，请求普通 Responses endpoint，附加 `compaction_trigger`，并从 SSE 响应提取 opaque checkpoint。
- 对 Provider、API、模型、base URL、endpoint、请求头、payload 和 SSE 响应进行运行时校验。
- 将 opaque checkpoint 与实际 Provider、API、模型和 endpoint identity 绑定，支持重复压缩、resume 和 fork replay。
- 远程请求失败、身份不兼容或 checkpoint 无效时，安全回退到 Pi 原生 compaction。
- 使用固定安全默认值，不增加独立配置文件、设置菜单或首版主动阈值压缩机制。

## Capabilities

### New Capabilities

- `remote-compaction`: 定义 Remote Compaction 的能力发现、协议交互、checkpoint 生命周期、身份隔离和原生回退行为。

### Modified Capabilities

无。

## Impact

- 新增 `packages/pi-codex-compaction` 及其 Pi extension entrypoint。
- 依赖 Pi 的 compaction lifecycle、registered provider transport、session entry 和 `Model.compat` 投影行为。
- 官方 OpenAI Codex Provider 无需额外配置；自定义 Provider 需要在 `~/.pi/agent/models.json` 声明 `compat.remoteCompaction`。
- Remote Compaction V2 依赖尚未公开稳定承诺的 provider wire contract，后续协议变化可能要求停用或调整该能力。
