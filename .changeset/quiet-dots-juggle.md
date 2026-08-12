---
"@oipsanthony/pi-tps": patch
---

兼容 Pi 与 OMP 的扩展 API 和消息生命周期差异，避免 OMP 缺少 `message_end` 时 TPS 显示为 `n/a`。
