## Purpose

为 Pi 提供 Provider-aware 的 Remote Compaction V2，在严格校验远程协议和 checkpoint 身份的前提下压缩历史，并在任何不兼容或失败场景中安全回退。

## Requirements

### Requirement: Remote compaction capability discovery
系统 SHALL 默认将 Pi 官方 `openai-codex` Provider 的官方 base URL 视为支持 Remote Compaction V2。对于其他模型，系统 SHALL 仅在模型使用受支持的 Responses API 且 `compat.remoteCompaction.protocol` 明确为 `"v2"` 时启用远程压缩。

#### Scenario: Official Provider needs no additional configuration
- **WHEN** 当前模型来自官方 `openai-codex` Provider，使用 `openai-codex-responses` API 和官方 base URL
- **THEN** 系统启用 Remote Compaction V2，无需用户声明额外 capability

#### Scenario: Custom model explicitly declares capability
- **WHEN** 自定义模型使用受支持的 Responses API，并声明 `compat.remoteCompaction.protocol` 为 `"v2"`
- **THEN** 系统将该模型视为 Remote Compaction V2 候选模型

#### Scenario: Unsupported or undeclared model
- **WHEN** 模型使用不受支持的 API、capability 缺失或 protocol 不是 `"v2"`
- **THEN** 系统不发起远程请求，并允许 Pi 直接执行原生 compaction

### Requirement: Endpoint derivation and validation
系统 SHALL 根据模型 API 和规范化后的 base URL 推导默认 Responses endpoint，并 SHALL 允许 capability 显式覆盖 endpoint。显式 endpoint MUST 使用 HTTP 或 HTTPS、与 base URL 同 origin，且不得包含凭据、query 或 fragment。

#### Scenario: OpenAI Responses endpoint is derived
- **WHEN** `openai-responses` 模型的 base URL 为 `https://gateway.example` 或 `https://gateway.example/v1`
- **THEN** 系统将 endpoint 推导为 `https://gateway.example/v1/responses`

#### Scenario: Codex Responses endpoint is derived
- **WHEN** `openai-codex-responses` 模型的 base URL 未包含 Codex Responses 路径
- **THEN** 系统将 endpoint 推导为该 base URL 下的 `/codex/responses`

#### Scenario: Explicit same-origin endpoint is accepted
- **WHEN** capability 声明合法且与 base URL 同 origin 的 HTTP/HTTPS endpoint
- **THEN** 系统使用该 endpoint 进行本次远程压缩

#### Scenario: Unsafe endpoint is rejected
- **WHEN** 显式 endpoint 跨 origin，或包含凭据、query、fragment，或使用非 HTTP(S) scheme
- **THEN** 系统不启用该模型的远程压缩

### Requirement: Remote Compaction V2 request contract
系统 SHALL 通过已注册 Provider 的 stream transport 向经过校验的普通 Responses endpoint 发送 POST 请求，保留已有 beta features，并合并 `remote_compaction_v2` feature。请求 payload MUST 使用所选模型、包含合法 input array，并在末尾恰好追加一个 `compaction_trigger`。

#### Scenario: Valid request is sent
- **WHEN** 支持的模型触发 compaction，Provider 生成合法 Responses payload
- **THEN** 系统向精确 endpoint 发送 POST，请求包含所选 model、原 input、唯一末尾 `compaction_trigger` 和 `remote_compaction_v2` header

#### Scenario: Provider changes request identity
- **WHEN** Provider 将请求发送到非声明 endpoint、使用非 POST method、遗漏 feature header 或改变 model identity
- **THEN** 系统拒绝该远程结果并回退

#### Scenario: Existing compaction trigger is present
- **WHEN** Provider 生成的 payload 已含 `compaction_trigger`
- **THEN** 系统拒绝重复 trigger，不发送未经验证的远程压缩请求

### Requirement: Remote response validation
系统 SHALL 仅接受完整 SSE 流中带有 `response.completed` 且恰好包含一个有效 `compaction` item 的响应。该 item MUST 包含非空 `encrypted_content`，并满足流和单 item 的大小限制。

#### Scenario: Valid opaque checkpoint is returned
- **WHEN** SSE 响应完整结束，包含 `response.completed` 和唯一有效的 `compaction.encrypted_content`
- **THEN** 系统接受 opaque item 并用其创建 checkpoint

#### Scenario: Malformed or ambiguous response
- **WHEN** SSE JSON 无效、缺少 `response.completed`、没有 compaction item、存在多个不同 item 或超出大小限制
- **THEN** 系统拒绝响应并回退到 Pi 原生 compaction

### Requirement: Provider-bound checkpoint persistence
系统 SHALL 将 opaque checkpoint 与实际 `provider`、`api`、`modelId`、规范化 `baseUrl` 和 endpoint identity 一同持久化。系统 MUST 同时保存有界 replacement history、近期保留消息 fingerprint、版本和创建时间，且 completion 状态 SHALL 作为不参与 LLM context 的持久 session entry 保存。

#### Scenario: Successful remote compaction is persisted
- **WHEN** Remote Compaction V2 成功
- **THEN** 系统写入完整 identity 和 replacement history，并保存可在 session 重开后显示的 completion entry

#### Scenario: Invalid checkpoint metadata is loaded
- **WHEN** checkpoint 缺字段、版本不支持、identity URL 非法、replacement history 无效或超出预算
- **THEN** 系统不将其用于 opaque 历史重放

### Requirement: Repeated compaction and checkpoint replay
系统 SHALL 在同一 identity 下通过唯一 marker 将已有 opaque replacement history 注入下一次 Provider 请求，并支持 session resume 和 fork 后的重放。注入前 MUST 验证 marker 唯一且 Pi 保留的近期消息与已保存 fingerprint 一致。

#### Scenario: Repeated compaction with matching identity
- **WHEN** 活跃 session 已有合法 checkpoint，当前 Provider identity 完全一致，且保留消息 fingerprint 匹配
- **THEN** 系统用 checkpoint replacement history 替换唯一 marker，再发起新的 Remote Compaction V2

#### Scenario: Resume or fork preserves valid context
- **WHEN** session resume 或 fork 后仍能定位 fallback summary，且保留消息 fingerprint 全部匹配
- **THEN** 系统恢复 marker 投影，并允许相同 identity 重放 opaque 历史

#### Scenario: Provider identity changes
- **WHEN** provider、API、model、base URL 或 endpoint 任一项变化
- **THEN** 系统不得重放 opaque 历史，只保留 fallback marker 和 Pi 保留的近期消息，并向有 UI 的用户显示一次警告

#### Scenario: Marker or retained messages cannot be verified
- **WHEN** marker 不唯一、缺失，或近期消息 fingerprint 不匹配
- **THEN** 系统拒绝 checkpoint 注入并回退

### Requirement: Safe fallback and cancellation
系统 SHALL 在远程认证、Provider 查找、协议校验、网络、超时或 checkpoint 投影失败时将 compaction 控制权返回 Pi。若请求被取消或 session 已切换，系统 SHALL 取消本次 compaction，且不得把结果写入错误 session。

#### Scenario: Remote compaction fails
- **WHEN** 已启用的远程压缩在完成前发生可处理失败
- **THEN** 系统向有 UI 的用户显示 fallback warning，并由 Pi 执行原生 compaction

#### Scenario: Session changes during request
- **WHEN** 远程请求进行中 event signal 被取消或活跃 session ID 改变
- **THEN** 系统丢弃远程结果并取消本次扩展 compaction

#### Scenario: Remote compaction succeeds
- **WHEN** 远程请求、响应和 checkpoint 持久化均成功
- **THEN** 系统返回扩展 compaction 结果，并显示可持久化的完成状态

### Requirement: Fixed safe operating defaults
首版系统 SHALL 使用 300 秒请求超时、最多 2 次重试和 64K token replacement history budget，且 SHALL 不依赖独立扩展配置文件或主动 token 阈值机制。

#### Scenario: User installs the extension
- **WHEN** 用户未提供扩展专用配置
- **THEN** 系统使用固定安全默认值，并仅通过模型 capability 决定是否尝试远程压缩
