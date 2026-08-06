## 1. Package and capability foundation

- [x] 1.1 Create the publishable `packages/pi-codex-compaction` package, Pi extension entrypoint, metadata, license, and TypeScript configuration
- [x] 1.2 Implement official OpenAI Codex Provider detection and explicit `compat.remoteCompaction` capability parsing for custom models
- [x] 1.3 Implement URL normalization, API-specific endpoint derivation, same-origin enforcement, and explicit endpoint validation
- [x] 1.4 Add focused tests for official defaults, supported APIs, malformed capability declarations, endpoint derivation, and unsafe URLs

## 2. Remote Compaction V2 protocol

- [x] 2.1 Implement payload validation, unique checkpoint-marker rewriting, and exactly-one `compaction_trigger` insertion
- [x] 2.2 Implement beta feature header merging without overwriting existing features
- [x] 2.3 Route requests through the registered Provider stream transport while validating the final URL, POST method, model identity, headers, and input
- [x] 2.4 Implement bounded SSE inspection that requires `response.completed` and exactly one valid opaque compaction item
- [x] 2.5 Add protocol and transport tests for valid requests, retries, aborts, malformed payloads, wrong endpoints, missing headers, invalid SSE, ambiguous items, and size limits

## 3. Checkpoint persistence and replay

- [x] 3.1 Define and validate the versioned checkpoint schema with provider, API, model, base URL, endpoint, replacement history, retained-message fingerprints, and timestamps
- [x] 3.2 Build bounded replacement history with text truncation, media limits, and the opaque compaction item as the final entry
- [x] 3.3 Implement fallback summary, unique marker projection, retained-message fingerprint verification, and same-identity replay
- [x] 3.4 Add checkpoint tests for creation, parsing, corruption, budget enforcement, repeated compaction, resume, fork, context mismatch, and identity changes

## 4. Pi compaction lifecycle

- [x] 4.1 Intercept `session_before_compact`, resolve Provider authentication, build the active context, invoke Remote Compaction V2, and return a Pi compaction result
- [x] 4.2 Return control to Pi native compaction on remote failure, and cancel safely when the signal aborts or session ownership changes
- [x] 4.3 Inject checkpoint history through `context` and `before_provider_request` hooks only when identity and marker validation succeed
- [x] 4.4 Persist a completion session entry outside LLM context and show bounded start, completion, fallback, and model-switch notifications
- [x] 4.5 Add lifecycle tests for supported and unsupported models, success, fallback, cancellation, repeated compaction, session resume/fork, completion persistence, and Provider/model switching

## 5. Documentation and verification

- [x] 5.1 Document installation, official Provider defaults, custom `models.json` capability configuration, endpoint rules, fixed parameters, security boundaries, and fallback behavior in Simplified Chinese
- [x] 5.2 Preserve upstream MIT attribution and document the implementation basis and experimental protocol risk
- [x] 5.3 Run `bun test packages/pi-codex-compaction/extensions` and fix all failures
- [x] 5.4 Run `bunx tsc --noEmit --project packages/pi-codex-compaction/tsconfig.json` and fix all type errors
