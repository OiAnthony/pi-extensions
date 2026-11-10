---
"@oipsanthony/pi-prompt-prediction": patch
---

修复按 Tab 或 → 接受预测后，Ctrl+C 清空草稿便无法再次补全的问题。清空后可复用同一预测，不增加模型请求；提交、输入不匹配的内容或切换模型、session 后仍清除预测。
