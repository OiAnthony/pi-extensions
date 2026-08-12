## Context

见 [proposal.md](./proposal.md)。当前 `pi-session-title` 与 `pi-prompt-translator` 分别解析 `provider/modelId`、调用 `modelRegistry.find()`、解析认证并回退当前模型。两者均运行在独立发布的 package 中，且 `pi-prompt-translator` 还面向兼容宿主。

Pi 0.84.1 没有 model role 或 model alias API。`models.json` 的 `name` 只用于模型匹配和显示，不能改变 `modelRegistry.find(provider, modelId)` 的精确查找契约。扩展之间虽然可以使用 event bus，但该机制不提供有返回值的服务注册，也会引入加载顺序和独立安装问题。

## Goals / Non-Goals

**Goals:**

- 为独立发布的插件提供无运行时初始化顺序要求的共享解析库。
- 让角色、角色链、直接模型和当前模型走同一套认证、去重、回退与诊断路径。
- 允许用户定义任意角色，并用紧凑的 `:<thinkingLevel>` 后缀配置可由主 Agent 和消费插件复用的计算档位。
- 提供不绑定具体用途的推荐档位示例，同时保持角色集合完全由用户配置。
- 在 package 被直接安装为 Pi extension 时，为主 Agent 提供向前和向后角色循环及瞬时角色轨道。
- 保持现有插件配置和失败行为兼容。
- 通过宿主提供的 agent directory 与 Model Registry 适配认证和兼容宿主。

**Non-Goals:**

- 不修改 Pi 核心 settings schema、Model Registry 或 `/model` UI。
- 不根据任务内容自动选择角色。
- 不让主 Agent 角色控制 timeout、token budget 或 prompt，也不覆盖消费插件显式配置的 thinking level。
- 不内置 `tiny/default/slow/smol/turbo` 或任何其他角色、模型映射和默认循环顺序。
- 不提供模型 fallback list、项目级角色覆盖或运行时角色编辑命令。
- 不接管 Pi 内置 `/model` 选择器，也不拦截 extension 之外的模型或 thinking level 变更。

## Decisions

### 1. 同一 package 同时提供共享库和可选 extension

新增 `@oipsanthony/pi-model-roles`。库入口导出配置加载、引用解析和异步模型解析 API；package 的 `pi.extensions` 另行声明交互入口。用户直接安装 package 时 Pi 加载 extension，消费插件仅将其作为 npm 运行时 dependency 时不会传递性加载 extension。

共享 API 每次解析都显式接收当前 `model` 与 `modelRegistry`，不依赖 extension 加载顺序或全局 singleton。交互入口只持有当前 Pi 会话所需的瞬时循环和 UI 状态。这样消费插件保持独立可用，同时直接安装 package 的用户可以切换主 Agent 角色。

### 2. 使用独立的全局配置文件

配置文件为 `join(getAgentDir(), "model-roles.json")`：

```json
{
  "roles": {
    "tiny": "<provider>/<haiku-or-flash-or-mini>:off",
    "default": "<provider>/gpt-5.6-sol:medium",
    "slow": "@default:xhigh",
    "smol": "<provider>/gpt-5.6-luna:max",
    "turbo": "<provider>/gpt-5.3-codex-spark:low"
  },
  "cycleOrder": ["tiny", "default", "slow"]
}
```

独立文件使 schema 由该 package 所有，避免向 Pi 未声明的 `settings.json` 字段写入数据。第一版只读取全局 agent directory，不读取 `.pi/settings.json`，因此不会绕过 project trust。使用 `getAgentDir()`，不自行推断环境变量或硬编码 `~/.pi`。

备选方案是在 `settings.json` 增加 `modelRoles`，但 Pi 当前不公开扩展 settings schema 或合并后的 settings；插件必须自行重放全局与项目合并及 trust 语义。

### 3. 角色值使用带可选 thinking 后缀的单一字符串

角色值为 `provider/modelId[:thinkingLevel]` 或 `@role[:thinkingLevel]` 字符串。支持的后缀与 Pi 0.84.1 的公开级别一致：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。不增加对象形式，使配置与 oh-my-pi 的 selector 保持一致。

角色引用按配置继续解析，使用 visited set 检测自引用和多角色循环。内层显式 thinking level 随角色链继承，外层显式后缀覆盖继承值；所有层均省略后缀时，解析结果不包含显式 thinking level。循环、未知终点、非法角色后缀或无效终点均产生结构化失败原因，然后进入当前模型回退。

解析直接模型时先使用完整字符串执行精确 Registry 查找，以保护合法地以 `:high` 等文本结尾的 model ID；完整标识不存在时，才将最后一个已知 `:<thinkingLevel>` 解释为后缀。`@role:<thinkingLevel>` 始终按角色后缀解释。第一版不接受逗号列表、数组或隐式内置角色 fallback。角色名称采用 `[A-Za-z0-9][A-Za-z0-9._-]*` 并区分大小写，直接模型引用只在第一个 `/` 处分隔，以支持 OpenRouter model ID。

解析器返回 thinking metadata。消费插件使用统一优先级：调用方显式配置的 thinking level 优先于角色后缀，角色后缀优先于调用方默认值。这样显式插件策略保持兼容，而未显式配置的调用可以复用 `@smol:max`、`@turbo:low` 等完整计算档位。共享库 SHALL 提供足够 metadata 和纯函数 helper，使消费插件不必重复实现该优先级。

`pi-session-title` 当前的 `minimal` 是默认值而非始终显式的用户选择；迁移后，用户显式 `thinkingLevel` 继续优先，否则使用角色后缀，角色也未配置时才使用 `minimal`。`pi-prompt-translator` 当前没有独立 thinking 配置；迁移后，将角色后缀作为 `complete()` options 的 `reasoning` 传递，角色未指定时继续省略该参数。两者均不把角色 thinking 应用到主 Agent。

### 4. 一个解析入口承担认证与回退

核心异步入口接收可选目标、当前模型、Model Registry 和已加载角色配置，按以下候选顺序解析：

1. `@role` 递归解析后的配置模型，或直接 `provider/modelId`。
2. 当前模型，但仅在其 identity 与第一候选不同的情况下追加。

每个候选先精确查找，再调用 `getApiKeyAndHeaders()`。认证结果以 Pi 返回值的 `auth.ok` 判别字段为准；成功结果原样传递 `apiKey`、`headers` 和 `env`，不对 `apiKey` 再做 truthy 判定。Registry 异常转换为失败诊断，不抛给消费插件。

省略目标直接使用当前模型，不算回退。未知角色不会静默转成名为 `default` 的角色；它记录 typo 可见的失败原因后回退当前模型。`@default` 只引用明确配置的 `default` 角色。

### 5. 配置加载和解析均返回结构化诊断，不在库内显示 UI

加载结果包含有效角色及配置问题；缺失文件视为正常空配置，无效 JSON、无效结构和无效条目则保留枚举化问题。解析结果包含请求值、来源、角色名、已访问角色链、最终 `provider/modelId`、显式 thinking level、认证、是否回退及枚举化失败原因。共享库不调用 `ctx.ui.notify()`；消费插件继续负责现有一次性 warning 和 status 文案，交互 extension 则拥有自己的角色轨道和快捷键错误通知。

这样共享层可以独立测试，也不会把不同插件的通知频率和用户体验绑定在一起。

### 6. 提供能力档位预设，但不内置角色

README SHALL 将以下角色作为主推荐示例：

- `tiny`：低成本、低延迟的小模型档位。
- `default`：日常质量、速度和成本均衡档位。
- `slow`：沿用 oh-my-pi 语义，表示更慢但性能更高的主力模型高推理档位。
- `smol`：低成本、允许较长执行时间的长程任务档位。
- `turbo`：高 TPS、高吞吐档位。

这些名称描述计算特征，不绑定 Session Title、Plan、Worker 或搜索摘要等调用用途。文档可以展示这些消费映射，但 runtime SHALL 不创建内置角色；配置缺失时仍返回空角色集合。推荐 `cycleOrder` 仅包含 `tiny`、`default`、`slow`，说明 `smol` 和 `turbo` 即使不在快捷循环中仍可被任意消费插件通过 `@role` 解析。

### 7. 采用 oh-my-pi 已验证的 selector 和角色循环交互

oh-my-pi 在 `45e12e5b` 的 model role 实现验证了自定义角色、角色间接引用、thinking selector、循环保护、来源追踪和快捷键角色轨道的实际价值。本变更采用 `:<thinkingLevel>`、向前/向后循环、跳过不可用角色和 powerline 上方的瞬时角色轨道，但保持 Pi extension API 和本 package 的配置边界。

无 `cycleOrder` 时，交互 extension 按 `roles` 的 JSON 声明顺序循环所有有效自定义角色；配置 `cycleOrder` 后，只按数组中列出的唯一角色循环，并跳过未知、无效、无法解析、认证失败或无法选择的角色。候选筛选不得使用当前模型回退冒充配置角色成功。`Ctrl+P` 向前，`Ctrl+Shift+P` 向后，两端循环。切换时先等待 `pi.setModel()` 成功，再对包含显式后缀的角色调用 `pi.setThinkingLevel()`；未配置后缀时不主动设置 thinking level。

每次切换在编辑器上方显示单行角色轨道，使用 1 列左侧 padding 与 editor 内容对齐，并在轨道与后续 powerline 之间保留 1 个空白行；轨道突出当前角色并在约 1.5 秒后清除。截断计算先扣除水平 padding，空白行不包含内容，避免窄终端溢出。角色轨道在 `session_start` 预注册稳定的 `aboveEditor` widget；后续切换只更新组件状态，隐藏时返回空内容，不调用 `setWidget()` 重新插入。Pi 对同一 placement 的 widget 使用插入顺序且不提供 priority，因此与 powerline 同时使用时，model roles package 必须先于 powerline package 加载，角色轨道才能稳定显示在 powerline 上方。连续切换更新同一组件并重置计时器。判断当前角色时，无显式 thinking level 的角色只匹配模型，带显式 thinking level 的角色同时匹配模型和 Pi 最终生效的 thinking level；多个角色匹配时使用循环顺序中的第一个。若当前状态不匹配任何候选，则向前和向后切换均从各自方向的边界候选开始。

Pi 0.84.1 已将 `Ctrl+P` 和 `Ctrl+Shift+P` 绑定到 `app.model.cycleForward` 与 `app.model.cycleBackward`，extension shortcut 不能覆盖仍存在的内置绑定。README 必须要求用户在 `~/.pi/agent/keybindings.json` 中解除这两个 action 后执行 `/reload`：

```json
{
  "app.model.cycleForward": [],
  "app.model.cycleBackward": []
}
```

不复制以下能力：

- 内置角色目录和角色专属默认模型链，因为共享库不拥有消费插件的任务语义。
- 逗号或数组 fallback list、模糊模型匹配和 provider 排序，因为 Pi `modelRegistry.find()` 的精确 identity 更适合作为跨插件契约。
- 项目配置合并、runtime override 和角色编辑 UI，因为 Pi 0.84.1 未向第三方共享库公开等价的 settings 合并与 project trust API。
- keyless provider sentinel，因为 Pi 的本地 OpenAI-compatible provider 仍要求配置 dummy API key，认证应遵循 `getApiKeyAndHeaders()`。

### 8. 消费插件逐步迁移但一次发布完成

`pi-session-title` 和 `pi-prompt-translator` 都改用共享入口，并删除各自重复的 model reference parser、thinking 优先级和认证候选逻辑。它们保留自己的结果类型、调用超时、模型请求和 UI 行为。`pi-session-title` 需要区分用户显式 thinking 配置与默认值；`pi-prompt-translator` 将角色 thinking metadata 传给现有 `complete()` options 的 `reasoning`，未指定时保持省略。

两个插件的 `package.json` 增加 workspace dependency，发布产物通过普通 npm dependency 安装共享库。README 在原有 `model` 字段说明中加入 `@role`，并链接共享配置格式。

## Risks / Trade-offs

- [多个插件各自加载同一小型 JSON 文件] → 文件只在插件初始化或 reload 时同步读取，数据量很小，不引入共享可变缓存。
- [角色被删除或拼写错误后自动使用当前模型，可能产生非预期成本] → 返回明确 fallback reason，并沿用消费插件现有 warning。
- [角色链可能产生循环或过长的间接关系] → 使用 visited set 终止循环，并在诊断中保留已访问链；不设置任意深度上限。
- [共享库升级可能同时影响多个插件] → 保持 API 小且以行为测试覆盖；消费插件分别保留集成测试。
- [独立配置文件增加一个持久配置实体] → 该文件替代多个插件重复保存具体模型，且删除文件即可完整回滚到当前模型行为。
- [第一版没有项目级角色] → 保持全局模型策略和 project trust 边界清晰；出现明确需求后再设计宿主支持的可信项目覆盖。
- [快捷键与 Pi 内置模型循环冲突] → 文档明确解除两个内置 action 是启用快捷键的前置条件；未解除时不声称 extension 可以覆盖 Pi 绑定。
- [模型 ID 的尾部文本可能与 thinking 后缀相同] → 完整 Registry identity 优先，只有完整标识不存在时才剥离已知后缀。
- [目标模型不支持配置的 thinking level] → 主 Agent 使用 Pi 的 `setThinkingLevel()` 进行能力约束并显示最终生效级别；独立消费请求沿用其模型 API 的既有 reasoning 处理和错误路径。
- [推荐预设中的模型名称不一定存在于用户 Registry] → 预设只作为带 `<provider>` 占位符的文档示例，runtime 不加载或解析示例值。
- [Role thinking 改变未显式配置的消费请求] → 只在调用方未显式配置时使用角色后缀，并以调用方既有默认值作为最后回退；迁移测试覆盖三层优先级。

## Migration Plan

1. 发布同时包含共享 API 和 extension 入口的 package，并在同一 changeset 中更新两个消费插件依赖及文档。
2. 现有用户无需创建角色文件；直接模型和省略模型继续工作。
3. 需要共享角色的用户创建 `model-roles.json`，将插件 `model` 改为 `@role` 后执行 `/reload` 或重启兼容宿主。
4. 需要快捷键切换主 Agent 的用户直接安装 package，解除 Pi 的两个内置模型循环绑定，并执行 `/reload`。
5. 回滚时卸载 extension 或恢复内置 keybinding；将消费插件 `model` 恢复为直接模型或删除该字段。删除角色文件不会影响 Pi 的模型注册和认证数据。
