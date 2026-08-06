## Context

参见 `proposal.md` 的动机。Pi 的 compaction lifecycle 允许 extension 在 `session_before_compact` 返回自定义 compaction；registered Provider 的 `stream()` 已处理认证、请求转换、重试和模型 API 差异。设计需在复用该 transport 的同时，验证实际 wire request 和 SSE response，避免 capability 声明或 Provider 转换把 opaque checkpoint 发送到错误身份。

Remote Compaction V2 通过普通 Responses endpoint 接收在 input 末尾附加的 `compaction_trigger`，并以 SSE 返回 `compaction.encrypted_content`。该内容不可检查、不可跨身份转换，只有原 Provider、API、模型和 endpoint 组合可以安全重放。

## Goals / Non-Goals

**Goals:**

- 在不重复实现 Provider 认证和完整 Responses transport 的前提下支持官方和自定义 Provider。
- 将 capability discovery 与运行时协议校验分离，配置只声明候选能力。
- 对每次网络请求、响应和 checkpoint replay 执行 fail-closed 校验。
- 在远程协议不可用时不中断 Pi 的原生 compaction。
- 让重复压缩、resume 和 fork 可以在相同身份下延续 opaque history。

**Non-Goals:**

- 不实现 Legacy `/responses/compact` unary 协议。
- 不实现 ChatGPT OAuth JWT 解析、`chatgpt_account_id` 提取或手工构造 Codex 私有 headers。
- 不增加独立 settings menu、配置文件或运行时可调安全参数。
- 不在 `turn_end` 根据 90% 阈值主动中止长工具循环。
- 不支持跨 Provider、API、模型或 endpoint 迁移 opaque checkpoint。

## Decisions

### 1. 基于 Provider stream transport，而不是直接实现 HTTP client

扩展调用 Pi registered Provider 的 `stream()`，复用其 API key、headers、环境变量、payload 转换、SSE 消费、usage 和重试行为。扩展通过临时 model/transport base URL 将本次请求导向已解析 endpoint，不修改模型的持久配置。

在注入的 `fetch` 包装层中校验最终 URL、HTTP method 和 beta header，并 `tee()` 成两路：一路交给 Provider 正常消费，另一路由扩展独立验证 compaction SSE。`onPayload` 验证 model 和 input，并追加 trigger。

**替代方案：**

- 直接 `fetch`：实现简单，但会复制认证、Codex headers、Provider request mapping、SSE 和 usage 逻辑。
- 采用 `@ogulcancelik/pi-codex-compaction` 的 transport：绑定 ChatGPT Codex URL 与 OAuth JWT account identity，不适用于普通 API-key 网关。

### 2. 官方 Provider 默认启用，自定义模型显式声明

只有官方 `openai-codex`、官方 base URL 和 Codex Responses API 组合默认启用。其他模型必须通过 Pi `Model.compat.remoteCompaction` 声明 `protocol: "v2"`；配置可以提供 endpoint override。

capability 仅用于进入候选路径，不替代运行时校验。若 Pi 未来不再把未知 `compat` 属性投影到最终 Model，自定义模型会自然停用，而不是降级绕过检查。

**替代方案：**

- 按 provider ID allowlist：无法表达自定义网关和模型级差异。
- Provider 级默认开启：错误配置影响面过大，模型级 capability 更安全。

### 3. endpoint 按 API 推导，并限制为同 origin

`openai-responses` 统一解析为 `/v1/responses`；`openai-codex-responses` 解析为 `/codex/responses`。用户只有在网关路由不符合默认规则时才显式覆盖。所有 URL 都规范化，拒绝凭据、query、fragment 和跨 origin endpoint。

该约束避免 capability 将现有 Provider credential 转发到任意 host，同时把“配置身份”和“最终网络身份”纳入同一校验链。

### 4. Remote Compaction V2 使用双重响应验证

Provider 负责其正常 stream lifecycle，扩展同时独立收集原始 SSE。只有在流出现 `response.completed` 且得到恰好一个合法、有大小上限的 opaque compaction item 时才接受结果。重复出现的同一 item 可去重，不同 item 视为歧义并拒绝。

请求侧要求 input 末尾追加唯一 `compaction_trigger`，并合并而非覆盖已有 `x-codex-beta-features`。

### 5. checkpoint 是带完整身份的版本化 session 数据

checkpoint details 保存：

- kind、version、checkpoint ID、protocol 和 createdAt；
- provider、API、modelId、baseUrl 和 endpoint；
- 有 token/byte 上限的 replacement history；
- Pi 保留近期消息的稳定 fingerprint。

replacement history 从最新输入向前保留用户项，超长文本可截断，超限媒体跳过，最后附加 opaque compaction item。fallback summary 和唯一 marker 连接 Pi 可见上下文与 Provider-only opaque history。

completion marker 采用持久 custom session entry，但不参与 LLM context，避免 compaction 重绘或重开 session 后丢失完成状态。

### 6. replay 必须同时通过身份和上下文完整性校验

`context` hook 仅在 checkpoint identity 与当前模型完全一致时将 fallback summary 投影为 marker。`before_provider_request` 再把唯一 marker 替换为 replacement history。重复压缩也通过同一投影路径构造 prior checkpoint payload。

fork 或 resume 时，fallback summary 的位置和后续保留消息 fingerprint 必须匹配。任何 identity 或上下文差异都停止 opaque replay，保留 Pi fallback summary 和近期消息。

### 7. fallback 使用 Pi lifecycle 的未接管语义

在 `session_before_compact` 中，支持模型的远程流程若失败则返回 `undefined`，让 Pi 继续原生 compaction；取消或 session ownership 变化返回 `{ cancel: true }`，防止过期结果写入其他 session。

固定参数为 300 秒 timeout、2 次重试和 64K token replacement budget。首版不暴露第二份配置，减少安全参数漂移。

## Risks / Trade-offs

- [Remote Compaction V2 wire contract 未稳定公开] → 严格校验请求和 SSE，协议不匹配时回退 Pi；通过 capability gate 控制影响范围。
- [Pi 可能停止保留未知 `compat` 属性] → 自定义模型 fail closed；官方 Provider 仍通过明确身份判断，升级 Pi 时运行 capability 测试。
- [Provider 的 stream 实现可能不暴露 payload 或原始 SSE body] → 拒绝远程结果并回退，不尝试猜测 Provider 行为。
- [Opaque item 无法跨身份迁移] → checkpoint 持久化完整 identity，模型切换时警告并只使用 fallback summary 与近期消息。
- [replacement history 增加 session 体积] → 同时施加 token、byte、单 item 和媒体大小限制。
- [没有 mid-tool-loop 主动压缩] → 首版只接入 Pi 既有 compaction 触发点；有真实长工具循环需求后再单独设计阈值机制。
- [较长 timeout 可能延迟原生 fallback] → 保留 event abort 和 session ownership 检查，固定有限重试，避免无限等待。

## Migration Plan

1. 新增独立 package 和 Pi extension entrypoint，不修改其他 package 的运行行为。
2. 发布后，官方 OpenAI Codex Provider 用户安装扩展即可使用；自定义 Provider 用户逐模型增加 capability。
3. 先验证手动 `/compact`、重复 compaction、resume、fork、Provider 切换和故障回退，再扩大使用范围。
4. 回滚时卸载或禁用扩展；自定义模型也可删除 `compat.remoteCompaction` 立即停用远程路径。已有 checkpoint 将退化为 fallback summary 和 Pi 保留的近期消息，不做 opaque 数据迁移。
