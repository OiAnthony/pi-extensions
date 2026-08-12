## Why

多个插件都需要选择独立于主 Agent 的模型，但当前各自重复实现 `provider/modelId` 解析、认证和当前模型回退。统一的模型角色配置可以让用户只维护一次模型映射，并让插件通过稳定的 `@role` 代号选择模型。

## What Changes

- 新增共享库 `@oipsanthony/pi-model-roles`，从 Pi agent directory 加载全局模型角色配置。
- 定义任意自定义角色和 `@<role>` 模型引用语法，允许角色复用另一个角色，并继续支持现有 `provider/modelId` 和省略模型的配置方式。
- 支持在模型或角色引用后使用 `:<thinkingLevel>` 后缀；角色链继承 thinking level，外层后缀可以覆盖继承值，消费插件可按统一优先级复用该 metadata。
- 在中文文档中提供 `tiny/default/slow/smol/turbo` 能力档位预设，作为可复制示例而非硬编码角色或运行时默认值。
- 统一解析 Model Registry、认证信息和当前 Pi 模型回退，并返回可用于诊断的解析结果。
- 为无效配置、未知角色和角色引用循环返回结构化诊断，而不阻止插件加载。
- 将 package 同时作为可选 Pi extension 发布；直接安装后可使用 `Ctrl+P` 和 `Ctrl+Shift+P` 按声明顺序或 `cycleOrder` 循环切换主 Agent 的角色、模型和可选 thinking level，并在 powerline 上方显示与其保持 1 行间距的瞬时角色轨道。
- 在 `pi-session-title` 和 `pi-prompt-translator` 中接入共享解析器，删除重复的模型解析逻辑。
- 为角色解析、thinking level 及消费优先级、推荐预设、快捷键切换、认证失败、未知角色、OpenRouter 多段 model ID 和兼容行为增加测试及中文文档。

## Capabilities

### New Capabilities
- `model-role-resolution`: 定义全局模型角色配置、`@role` 引用解析、thinking level、认证、回退和主 Agent 角色切换行为。

### Modified Capabilities

无。

## Impact

- 新增 workspace package `packages/pi-model-roles`，以 `@oipsanthony/pi-model-roles` 发布，既导出共享库 API，也声明可直接安装的 Pi extension，并成为消费插件的运行时依赖。
- 修改 `packages/pi-session-title` 和 `packages/pi-prompt-translator` 的模型配置解析及文档。
- 新增 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/model-roles.json` 配置接口。
- 不修改 Pi 核心或 `models.json`；只有直接安装并触发 extension 快捷键时才改变当前主 Agent 的模型和可选 thinking level，普通运行时依赖不会自动启用该行为。
