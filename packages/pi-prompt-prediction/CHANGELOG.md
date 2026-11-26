# @oipsanthony/pi-prompt-prediction

## 0.3.1

### Patch Changes

- 09d7cf6: Adapt OMP 19.x composer predictions to `ctx.ui.composer` and an above-editor widget (including pending status), and lazy-load the Pi editor wrapper so OMP does not require `@earendil-works/pi-tui`.

## 0.3.0

### Minor Changes

- 4fe9a1a: 新增 `/prompt-predict` 主动预测命令：编辑器为空且 Agent idle 时可手动请求预测，预测中在 editor 输入区内联显示进度状态且不会被接受；重复执行保留已有结果，`/prompt-predict refresh` 取消旧结果后重新请求。

## 0.2.2

### Patch Changes

- 移除对 `pi-model-roles` 的运行时依赖，让 Pi 在没有原生 `@smol` 解析器时使用当前模型。

## 0.2.1

### Patch Changes

- f1289fe: 修复按 Tab 或 → 接受预测后，Ctrl+C 清空草稿便无法再次补全的问题。清空后可复用同一预测，不增加模型请求；提交、输入不匹配的内容或切换模型、session 后仍清除预测。

## 0.2.0

### Minor Changes

- 50e30e4: 新增 OMP 下一个 Prompt 预测扩展：完整轮次结束后使用 `@smol → 当前主模型` 链生成原生 ghost text，按 Tab 或 → 填入但不发送；支持输入取消、整体超时及过期结果保护。
