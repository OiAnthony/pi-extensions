---
"@oipsanthony/pi-tps": patch
---

修正 TTFT 和 generation time 的起点，仅将首个实际 content delta 计为首 token，忽略 stream start 事件。
