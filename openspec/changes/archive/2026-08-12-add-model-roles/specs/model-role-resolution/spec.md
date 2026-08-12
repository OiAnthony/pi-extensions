## Purpose

为 Pi 插件提供统一、可复用的模型角色配置与解析契约，使多个插件能够通过稳定的 `@role` 引用共享模型选择，并允许直接安装的 extension 通过快捷键切换主 Agent 的自定义角色、模型和可选 thinking level。

## ADDED Requirements

### Requirement: 全局模型角色配置
系统 SHALL 从当前宿主的 agent directory 下 `model-roles.json` 的 `roles` object 加载模型角色。每个有效角色 SHALL 将符合角色名称规则的键映射到一个非空 `provider/modelId[:thinkingLevel]` 或 `@role[:thinkingLevel]` 字符串，角色名称 SHALL 区分大小写。系统 SHALL 接受任意符合名称规则的自定义角色，不得将角色限制为预定义集合。

可选的 `cycleOrder` SHALL 是唯一角色名称组成的 array。省略 `cycleOrder` 时，系统 SHALL 保留 `roles` 的 JSON 声明顺序作为循环顺序；配置 `cycleOrder` 时，交互 extension SHALL 仅考虑其中列出的角色并保持数组顺序。

#### Scenario: 加载任意自定义角色
- **WHEN** `model-roles.json` 包含 `{"roles":{"review":"openai-codex/gpt-5.4:xhigh"}}`
- **THEN** 系统将非内置名称 `review` 识别为指向 `openai-codex/gpt-5.4` 且显式 thinking level 为 `xhigh` 的角色

#### Scenario: 使用声明顺序
- **WHEN** `roles` 依次声明 `small`、`default` 和 `review` 且未配置 `cycleOrder`
- **THEN** 系统以 `small`、`default`、`review` 作为角色循环顺序

#### Scenario: 使用显式循环顺序
- **WHEN** `cycleOrder` 配置为 `["review","small"]`
- **THEN** 交互 extension 只按 `review`、`small` 的顺序考虑角色，而不自动追加其他已配置角色

#### Scenario: 配置缺失或无效
- **WHEN** 配置文件不存在、不是有效 JSON、根值不是 object，或 `roles` 不是 object
- **THEN** 系统使用空角色集合且不阻止插件加载

#### Scenario: 忽略无效条目
- **WHEN** `roles` 包含无效角色名称、空字符串值、非字符串值或不完整模型引用
- **THEN** 系统忽略对应条目并继续加载其他有效角色

### Requirement: 配置加载诊断
系统 SHALL 在加载结果中保留枚举化配置问题，使消费插件能够区分无配置与配置错误。缺失文件 SHALL 视为正常空配置；无效 JSON、无效根结构、无效 `roles` 结构、无效 `cycleOrder` 和无效角色条目 SHALL 产生配置问题，但 SHALL 不阻止其他有效角色加载或插件启动。

#### Scenario: 缺失配置不是错误
- **WHEN** `model-roles.json` 不存在
- **THEN** 系统返回空角色集合且不返回配置问题

#### Scenario: 部分配置无效
- **WHEN** `roles` 同时包含有效角色和无效条目
- **THEN** 系统返回有效角色，并返回能够定位无效条目的配置问题

### Requirement: 模型目标引用语法
系统 SHALL 接受三种模型目标：省略目标、`@<role>[:thinkingLevel]` 角色引用和直接 `provider/modelId[:thinkingLevel]` 引用。角色名称 SHALL 匹配 `[A-Za-z0-9][A-Za-z0-9._-]*`；直接引用 SHALL 仅按第一个 `/` 分隔 provider 和 model ID。系统 SHALL 支持 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 和 `max` thinking level。

#### Scenario: 解析角色引用
- **WHEN** 消费插件请求 `@small` 且 `small` 已配置
- **THEN** 系统解析该角色配置的直接模型引用

#### Scenario: 解析直接模型的 thinking 后缀
- **WHEN** 角色配置为 `openai-codex/gpt-5.4:xhigh` 且完整字符串不是已注册模型标识
- **THEN** 系统将模型解析为 `openai-codex/gpt-5.4`，并将显式 thinking level 解析为 `xhigh`

#### Scenario: 完整模型标识优先
- **WHEN** Model Registry 存在精确标识 `provider/model:high`
- **THEN** 系统将 `provider/model:high` 解析为完整模型标识，不将 `:high` 剥离为 thinking 后缀

#### Scenario: 解析多段 model ID
- **WHEN** 消费插件请求 `openrouter/anthropic/claude-sonnet-4`
- **THEN** 系统使用 `openrouter` 作为 provider，并使用 `anthropic/claude-sonnet-4` 作为 model ID

#### Scenario: 省略模型目标
- **WHEN** 消费插件未配置模型目标
- **THEN** 系统选择触发调用时的当前 Pi 模型

#### Scenario: 解析角色链
- **WHEN** `writer` 配置为 `@small` 且 `small` 配置为 `openai-codex/gpt-5.4-mini`
- **THEN** 系统将 `@writer` 解析为 `openai-codex/gpt-5.4-mini`，并在诊断中保留 `writer`、`small` 的访问顺序

#### Scenario: 检测角色引用循环
- **WHEN** 角色直接引用自身，或多个角色最终再次引用已访问角色
- **THEN** 系统停止解析、记录角色引用循环及已访问角色链，并尝试当前 Pi 模型

#### Scenario: 角色链指向未知角色
- **WHEN** 已配置角色最终引用未配置角色
- **THEN** 系统记录未知终点角色及已访问角色链，并尝试当前 Pi 模型

#### Scenario: 角色引用使用非法 thinking 后缀
- **WHEN** 角色值为 `@small:turbo`
- **THEN** 系统将该值诊断为无效角色引用，而不把 `small:turbo` 当作角色名称

### Requirement: Thinking level 继承、覆盖与消费优先级
角色解析结果 SHALL 携带可选的显式 thinking level。角色链中最靠近请求端的显式 thinking level SHALL 覆盖被引用角色的值；请求端未显式配置时 SHALL 继承链中最近的显式值；整条链均未配置时 SHALL 返回未指定。

对于支持 thinking level 的消费调用，系统 SHALL 按“调用方显式配置、Role 解析值、调用方默认值”的顺序确定请求的最终 thinking level。调用方 SHALL 能区分用户显式配置和自身默认值，不得让默认值提前遮蔽 Role 后缀。

#### Scenario: 继承被引用角色的 thinking level
- **WHEN** `base` 配置为 `openai-codex/gpt-5.4:high` 且 `review` 配置为 `@base`
- **THEN** `@review` 解析为相同模型并继承 `high`

#### Scenario: 外层角色覆盖 thinking level
- **WHEN** `base` 配置为 `openai-codex/gpt-5.4:high` 且 `review` 配置为 `@base:xhigh`
- **THEN** `@review` 解析为相同模型且 thinking level 为 `xhigh`

#### Scenario: 未配置 thinking level
- **WHEN** 角色链中的所有值都没有 thinking 后缀
- **THEN** 解析结果不包含显式 thinking level

#### Scenario: 调用方显式值优先
- **WHEN** Role 解析值为 `max` 且消费调用显式配置 `high`
- **THEN** 消费调用使用 `high`

#### Scenario: 使用 Role thinking level
- **WHEN** 消费调用未显式配置 thinking level、Role 解析值为 `max` 且调用方默认值为 `medium`
- **THEN** 消费调用使用 `max`

#### Scenario: 回退调用方默认值
- **WHEN** 消费调用未显式配置 thinking level 且 Role 解析结果也未指定
- **THEN** 消费调用使用自身既有默认值

### Requirement: Model Registry 与认证解析
系统 SHALL 通过当前上下文的 Model Registry 查找目标模型并解析该模型的认证。系统 SHALL 仅以 `getApiKeyAndHeaders()` 结果的 `ok` 判别字段判断认证成功或失败，不得对成功结果中的 `apiKey` 追加 truthy 判定。成功结果 SHALL 原样保留 registry 返回的 `apiKey`、`headers` 和 `env`，且 SHALL 不持久化这些认证信息。

#### Scenario: 目标模型及认证可用
- **WHEN** Model Registry 能找到目标模型且认证解析成功并包含 API key
- **THEN** 系统返回该模型以及对应的 `apiKey`、`headers` 和 `env`

#### Scenario: Registry 抛出异常
- **WHEN** 模型查找或认证解析抛出异常
- **THEN** 系统将目标模型视为不可用并执行定义的回退，而不向消费插件抛出该异常

### Requirement: 当前模型回退
对于显式模型或角色目标不存在、格式无效、角色链无效或认证失败的情况，系统 SHALL 尝试当前 Pi 模型。若目标模型就是当前模型，系统 SHALL 不重复认证；若当前模型也不可用，系统 SHALL 返回无可用模型的结果。

#### Scenario: 未知角色回退
- **WHEN** 消费插件请求未配置的 `@small`
- **THEN** 系统将未知角色记录为回退原因并尝试当前 Pi 模型

#### Scenario: 角色模型认证失败
- **WHEN** `@small` 指向的模型存在但认证失败
- **THEN** 系统尝试当前 Pi 模型并记录配置目标不可用

#### Scenario: 配置目标与当前模型相同
- **WHEN** 解析出的配置目标和当前模型具有相同 provider 与 model ID
- **THEN** 系统仅认证并尝试该模型一次

#### Scenario: 没有可用模型
- **WHEN** 配置目标不可用且当前模型不存在或认证也不可用
- **THEN** 系统返回无可用模型并保留失败诊断，而不抛出异常

### Requirement: 可诊断的解析结果
系统 SHALL 返回请求目标、目标来源、已访问角色链、最终模型标识、显式 thinking level 和回退原因，使消费插件能够显示状态和一次性 warning。来源 SHALL 区分角色、直接模型和当前模型；失败原因 SHALL 至少区分无效引用、非法 thinking level、未知角色、角色循环、模型不存在、认证失败和 Registry 异常。

#### Scenario: 角色正常解析
- **WHEN** `@small` 成功解析到配置模型
- **THEN** 结果标识请求值为 `@small`、来源为角色且最终模型为对应 `provider/modelId`

#### Scenario: 回退到当前模型
- **WHEN** 配置目标不可用但当前模型可用
- **THEN** 结果同时保留原请求值、明确的回退原因和当前模型的最终标识

### Requirement: 推荐能力档位文档
中文 README SHALL 提供 `tiny`、`default`、`slow`、`smol`、`turbo` 推荐配置示例。该示例 SHALL 将这些名称描述为可复用的计算特征，而不是固定调用用途；runtime SHALL 不创建内置角色、默认模型映射或默认 `cycleOrder`。

推荐示例 SHALL 使用以下定位：`tiny` 表示低成本和低延迟，`default` 表示日常均衡，`slow` 表示更慢但性能更高的高推理档，`smol` 表示低成本且适合长程执行，`turbo` 表示高 TPS 和高吞吐。示例 SHALL 推荐 `cycleOrder` 为 `tiny`、`default`、`slow`，并说明未列入循环的 `smol` 和 `turbo` 仍可由消费插件显式解析。

#### Scenario: README 提供推荐预设
- **WHEN** 用户查阅 `model-roles.json` 配置说明
- **THEN** README 提供包含 `tiny/default/slow/smol/turbo`、thinking 后缀和 `cycleOrder` 的完整 JSON 示例

#### Scenario: 推荐预设不限制自定义角色
- **WHEN** 用户配置推荐集合之外且名称有效的 Role
- **THEN** 系统与推荐 Role 使用相同规则加载、解析和循环该自定义 Role

#### Scenario: 缺失配置不创建推荐角色
- **WHEN** `model-roles.json` 不存在
- **THEN** 系统仍返回空角色集合，不隐式创建 README 中的推荐 Role

#### Scenario: 循环外 Role 可供插件使用
- **WHEN** `smol` 和 `turbo` 已配置但未列入 `cycleOrder`
- **THEN** 消费插件仍可分别通过 `@smol` 和 `@turbo` 解析对应模型及 thinking metadata

### Requirement: 主 Agent 角色快捷键循环
当 package 被直接安装为 Pi extension 时，系统 SHALL 注册 `Ctrl+P` 作为向前循环角色快捷键，并注册 `Ctrl+Shift+P` 作为向后循环角色快捷键。系统 SHALL 只循环按有效循环顺序可解析、认证成功且可选择的角色，不得用当前模型回退将不可用角色纳入候选，并 SHALL 在两端回绕。作为其他 package 的普通运行时依赖 SHALL 不自动激活这些快捷键。

系统判断当前角色时，无显式 thinking level 的角色 SHALL 只匹配当前模型；带显式 thinking level 的角色 SHALL 同时匹配当前模型和 Pi 最终生效的 thinking level。多个角色同时匹配时，系统 SHALL 使用循环顺序中的第一个角色。

#### Scenario: 正向和反向循环
- **WHEN** 可用循环顺序为 `small`、`default`、`review` 且当前角色为 `default`
- **THEN** `Ctrl+P` 选择 `review`，而 `Ctrl+Shift+P` 选择 `small`

#### Scenario: 首尾回绕
- **WHEN** 当前角色为循环末尾的 `review`
- **THEN** `Ctrl+P` 选择循环开头的角色

#### Scenario: 跳过不可用角色
- **WHEN** 循环顺序包含未知、角色链无效、模型不存在、认证失败或无法选择的角色
- **THEN** 系统跳过这些角色并选择该方向上的下一个可用角色

#### Scenario: 当前状态不匹配角色
- **WHEN** 当前主 Agent 状态不满足任何角色的模型及可选显式 thinking level 匹配条件
- **THEN** 正向循环选择第一个可用角色，反向循环选择最后一个可用角色

#### Scenario: 无后缀角色匹配任意当前 thinking level
- **WHEN** 当前模型匹配某角色且该角色没有显式 thinking level
- **THEN** 系统将该角色视为当前角色，而不要求当前 thinking level 具有特定值

#### Scenario: 多个角色匹配当前状态
- **WHEN** 多个角色解析为相同模型和兼容的 thinking 条件
- **THEN** 系统将循环顺序中的第一个匹配角色视为当前角色

#### Scenario: 没有可用角色
- **WHEN** 循环中没有可用角色
- **THEN** 系统保持当前主 Agent 状态并显示错误通知

#### Scenario: 只有一个可用角色
- **WHEN** 循环中只有一个可用角色
- **THEN** 快捷键选择或保持该角色并显示角色轨道，不产生越界或重复状态

#### Scenario: 普通依赖不激活快捷键
- **WHEN** 另一个 package 仅将 `@oipsanthony/pi-model-roles` 声明为 npm dependency
- **THEN** Pi 不因该传递性依赖加载角色切换 extension

### Requirement: 快捷键应用模型和 thinking level
快捷键切换 SHALL 只修改当前主 Agent。系统 SHALL 先等待 `pi.setModel()` 成功，再为带显式 thinking level 的角色调用 `pi.setThinkingLevel()`；角色未配置显式 thinking level 时 SHALL 不主动调用 `pi.setThinkingLevel()`。系统 SHALL 以 Pi 约束后的最终 thinking level 作为显示状态。

#### Scenario: 切换带 thinking level 的角色
- **WHEN** 快捷键选择 `openai-codex/gpt-5.4:xhigh` 对应角色且模型切换成功
- **THEN** 系统先应用该模型，再请求主 Agent 使用 `xhigh`

#### Scenario: 切换未配置 thinking level 的角色
- **WHEN** 快捷键选择没有 thinking 后缀的角色
- **THEN** 系统应用模型，但不主动覆盖模型切换后的主 Agent thinking level

#### Scenario: 宿主约束 thinking level
- **WHEN** 角色请求的 thinking level 超出目标模型支持范围
- **THEN** 系统接受 Pi 的约束结果，并在角色轨道显示最终生效值

#### Scenario: 模型切换失败
- **WHEN** `pi.setModel()` 返回失败
- **THEN** 系统不调用 `pi.setThinkingLevel()`，不更新活动角色，并保留主 Agent 的原状态

### Requirement: 瞬时角色轨道
快捷键切换 SHALL 在编辑器上方显示单行瞬时角色轨道，列出循环角色、突出当前角色并显示最终生效的 thinking level。角色轨道 SHALL 使用 1 列左侧 padding 与 editor 内容对齐，并在截断时计入该空间。与使用 `aboveEditor` placement 的 powerline 同时启用时，角色轨道 SHALL 位于 powerline 上方，并在自身内容行与 powerline 之间保留 1 个空白行。系统 SHALL 在 `session_start` 预注册稳定 widget；隐藏轨道时 SHALL 返回空内容而不移除 widget，以保持插入顺序且不残留间距。轨道 SHALL 在约 1.5 秒后清除；计时期间连续切换 SHALL 原位更新同一个 widget 并重置清除计时器。

#### Scenario: 显示并自动清除轨道
- **WHEN** 角色切换成功
- **THEN** 编辑器上方出现突出当前角色的轨道，并在约 1.5 秒无后续切换后消失

#### Scenario: 连续切换原位更新
- **WHEN** 用户在轨道消失前再次切换角色
- **THEN** 系统更新现有轨道而不堆叠或重新插入 widget，并从最后一次切换重新计算清除时间

#### Scenario: 与 editor 左侧对齐
- **WHEN** 角色轨道显示在任意支持宽度的终端中
- **THEN** 轨道内容具有 1 列左侧 padding，且包含 padding 的最终可见宽度不超过 widget 可用宽度

#### Scenario: 与 powerline 保持垂直间距
- **WHEN** 角色轨道显示在 powerline 上方
- **THEN** 轨道内容行与 powerline 之间有 1 个空白行；轨道隐藏后该空白行一并消失

#### Scenario: 显示在 powerline 上方
- **WHEN** model roles package 在使用 `aboveEditor` placement 的 powerline package 之前加载
- **THEN** 角色轨道的稳定 widget 先注册并显示在 powerline 上方

### Requirement: 快捷键冲突前置配置
文档 SHALL 明确 Pi 0.84.1 的 `app.model.cycleForward` 和 `app.model.cycleBackward` 内置绑定会占用 `Ctrl+P` 和 `Ctrl+Shift+P`。文档 SHALL 要求需要角色快捷键的用户在 `~/.pi/agent/keybindings.json` 中将这两个 action 配置为空数组，并在修改后执行 `/reload`。

#### Scenario: 文档提供解除绑定配置
- **WHEN** 用户查阅角色快捷键安装说明
- **THEN** 文档提供两个内置 action 的解除绑定 JSON、配置路径和 `/reload` 步骤，且不声称 extension 能覆盖仍有效的内置绑定

### Requirement: 消费插件兼容性
`pi-session-title` 和 `pi-prompt-translator` SHALL 接受 `@role` 作为各自 `model` 字段的值，同时保持直接模型引用、未配置时使用当前模型和失败通知的现有行为。支持独立 thinking 配置的消费请求 SHALL 使用“调用方显式配置 > Role 后缀 > 调用方默认值”的优先级；没有独立 thinking 配置的消费请求 SHALL 在 Role 指定时传递该值，Role 未指定时保持既有省略行为。

#### Scenario: 现有直接配置继续工作
- **WHEN** 用户继续为任一消费插件配置现有 `provider/modelId`
- **THEN** 插件使用与变更前相同的模型选择和当前模型回退语义

#### Scenario: 配置角色调用模型
- **WHEN** 用户将消费插件的 `model` 配置为可用的 `@small`
- **THEN** 插件使用 `small` 角色对应模型发起自身的模型调用

#### Scenario: Role thinking 作为消费插件默认覆盖
- **WHEN** `pi-session-title` 请求带 thinking 后缀的 `@role` 且用户未在插件配置中显式设置 `thinkingLevel`
- **THEN** 插件使用 Role 的 thinking level，而不是提前使用内置默认值

#### Scenario: 消费插件显式 thinking 优先
- **WHEN** `pi-session-title` 请求带 thinking 后缀的 `@role` 且用户已显式配置插件 `thinkingLevel`
- **THEN** 插件使用用户显式值

#### Scenario: Role 未指定时保持插件默认
- **WHEN** `pi-session-title` 的模型目标和 Role 均未指定 thinking level，且用户也未显式配置
- **THEN** 插件继续使用既有 `minimal` 默认值

#### Scenario: Translator 传递 Role thinking
- **WHEN** `pi-prompt-translator` 请求解析结果包含 Role thinking level
- **THEN** 插件将该值作为 `complete()` options 的 `reasoning` 传递

#### Scenario: Translator 省略未配置 thinking
- **WHEN** `pi-prompt-translator` 请求的模型目标和 Role 均未指定 thinking level
- **THEN** 插件保持既有行为，不向 `complete()` options 添加 `reasoning`

#### Scenario: 配置修改后 reload
- **WHEN** 用户修改全局角色配置并执行宿主 reload
- **THEN** 新插件运行时使用更新后的角色映射
