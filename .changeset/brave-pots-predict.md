---
"@oipsanthony/pi-prompt-prediction": minor
---

新增 `/prompt-predict` 主动预测命令：编辑器为空且 Agent idle 时可手动请求预测，预测中在 editor 输入区内联显示进度状态且不会被接受；重复执行保留已有结果，`/prompt-predict refresh` 取消旧结果后重新请求。
