# @oipsanthony/pi-prompt-prediction

## 0.2.1

### Patch Changes

- f1289fe: 修复按 Tab 或 → 接受预测后，Ctrl+C 清空草稿便无法再次补全的问题。清空后可复用同一预测，不增加模型请求；提交、输入不匹配的内容或切换模型、session 后仍清除预测。

## 0.2.0

### Minor Changes

- 50e30e4: 新增 OMP 下一个 Prompt 预测扩展：完整轮次结束后使用 `@smol → 当前主模型` 链生成原生 ghost text，按 Tab 或 → 填入但不发送；支持输入取消、整体超时及过期结果保护。
