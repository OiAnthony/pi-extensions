## 1. 共享模型角色库

- [x] 1.1 创建发布名为 `@oipsanthony/pi-model-roles` 的 `packages/pi-model-roles` package 结构、共享库 exports、Pi extension 入口、TypeScript 配置和中文 README；确保普通 npm 依赖不会传递性启用 extension。
- [x] 1.2 实现基于 `getAgentDir()` 的 `model-roles.json` 加载与规范化，覆盖缺失文件、无效 JSON、任意自定义角色、无效名称和值、可选 `cycleOrder`、多段 model ID 及结构化加载问题。
- [x] 1.3 实现统一模型目标解析 API 和类型，支持省略目标、`@role`、角色链与循环检测、直接模型、`:<thinkingLevel>` 解析、继承和外层覆盖、调用方显式值 > Role 值 > 调用方默认值的纯函数 helper、完整 model ID 优先、候选去重、完整认证透传、当前模型回退及结构化诊断。
- [x] 1.4 为共享库增加聚焦测试，覆盖有效和无效配置、加载问题、声明顺序和 `cycleOrder`、大小写角色、未知角色、角色链、自引用与多角色循环、thinking 继承、覆盖及消费优先级、尾部冒号 model ID、OpenRouter model ID、认证异常、`auth.ok` 判别、回退和无可用模型。
- [x] 1.5 在中文 README 中提供不作为 runtime 默认值的 `tiny/default/slow/smol/turbo` 能力档位示例，推荐 `cycleOrder` 为 `tiny/default/slow`，并说明循环外 Role 仍可供插件解析。

## 2. 主 Agent 角色切换 extension

- [x] 2.1 注册 `Ctrl+P` 和 `Ctrl+Shift+P`，按声明顺序或 `cycleOrder` 向前和向后循环可用角色，并在当前状态不匹配角色时从对应方向的边界开始。
- [x] 2.2 切换时先等待 `pi.setModel()` 成功，再为带显式后缀的角色调用 `pi.setThinkingLevel()`；模型切换失败时保持当前模型、thinking level 和角色状态不变。
- [x] 2.3 使用 `ctx.ui.setWidget()` 实现 powerline 上方的瞬时角色轨道，在 `session_start` 预注册并原位更新稳定 widget，以 1 列左侧 padding 对齐 editor，在轨道与 powerline 之间保留 1 个空白行，突出当前角色、显示最终生效的 thinking level，并重置约 1.5 秒的清除计时器。
- [x] 2.4 增加 extension 聚焦测试，覆盖正反向循环、首尾回绕、任意角色名、无效和不可用角色跳过、零或单候选、thinking 应用、宿主能力约束、切换失败、稳定 widget 注册、placement、水平对齐、垂直间距及原位清理。
- [x] 2.5 在 README 中记录直接安装方式、快捷键和 `cycleOrder`，明确解除冲突绑定、model roles 先于 powerline 的 package 顺序及 `/reload` 前置步骤。

## 3. Session Title 接入

- [x] 3.1 为 `pi-session-title` 添加 `@oipsanthony/pi-model-roles` 运行时 dependency，并用统一解析 API 替换重复的 model reference、registry 查找和认证候选逻辑；区分用户显式 thinking 配置与 `minimal` 默认值，并应用显式值 > Role 后缀 > 默认值的优先级。
- [x] 3.2 调整 `/session-title status` 和一次性 warning，使其准确显示 `@role` 请求、最终模型、最终 thinking level 及角色解析失败后的当前模型回退。
- [x] 3.3 更新 `pi-session-title` 测试，验证角色成功、未知角色、角色模型不可用、与当前模型相同、三层 thinking 优先级及既有直接模型行为。
- [x] 3.4 更新 `pi-session-title` README 的模型配置示例、角色配置路径、reload 和回退说明。

## 4. Prompt Translator 接入

- [x] 4.1 为 `pi-prompt-translator` 添加 `@oipsanthony/pi-model-roles` 运行时 dependency，并用统一解析 API 替换重复的 model reference、registry 查找和认证候选逻辑；Role 指定 thinking 时将其传给 `complete()` options 的 `reasoning`，未指定时保持省略。
- [x] 4.2 保留 translator 的缓存、草稿恢复和通知所有权，并让角色解析失败沿用现有配置模型 warning 语义。
- [x] 4.3 更新 `pi-prompt-translator` 测试，验证角色成功、未知角色、角色认证失败、thinking metadata 传递和省略、完整认证环境透传及既有直接模型行为。
- [x] 4.4 更新 `pi-prompt-translator` README 中 Pi 与兼容宿主的角色文件位置、`@role` 示例和回退说明。

## 5. 发布与验证

- [x] 5.1 添加 changeset，发布 `@oipsanthony/pi-model-roles`，并为两个新增运行时依赖和配置能力的消费插件选择适当版本变更。
- [x] 5.2 运行三个 package 的聚焦 Bun tests 和 TypeScript typecheck，确认共享行为、extension 交互及消费插件集成均通过。
- [x] 5.3 运行 root `bun run pack:check`，确认发布产物包含共享库、extension 入口、文档及正确的运行时 dependency。
- [x] 5.4 运行 `openspec validate add-model-roles --strict`，确认实现后的 spec 与任务状态有效。
