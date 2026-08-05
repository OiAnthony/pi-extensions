# Pi 自动会话标题插件需求

状态：Draft
工作包名：`@oipsanthony/pi-session-title`
目标目录：`packages/pi-session-title/`

## 1. 背景

Pi 未命名 session 默认以第一条用户消息作为列表标签。消息较长或同时打开多个 session 时，`/resume` 列表和 terminal tab 很难快速区分。

本插件为新 session 生成简短标题，并同步到三个位置：

- Pi session name，用于 `/resume`、session picker 和持久化。
- Terminal tab/window title，用于区分并行打开的 Pi 进程。
- Herdr pane metadata title，用于 Herdr pane border、sidebar 和兼容插件的外层窗口标题。

当前 Pi `0.83.0` 已提供 `session_info_changed`，但 [`pi.setSessionName()` 不立即刷新 terminal title](https://github.com/earendil-works/pi/issues/3686) 的修复尚未包含在该版本中，修复见后续提交 [`c19e64a`](https://github.com/earendil-works/pi/commit/c19e64a444373b558d5d0d44eb4d52877ea07593)。因此 v1 必须同时调用 `pi.setSessionName()` 和 `ctx.ui.setTitle()`，不能只依赖宿主同步。运行在 Herdr pane 中时，还需要通过 Herdr CLI 上报展示元数据。

## 2. 竞品调研

数据统计时间为 2026-08-02。npm 下载量口径为 2026-07-03 至 2026-08-01。带 `*` 的 stars 属于整个 monorepo。

| 项目 | 触发和上下文 | 更新目标 | Stars | npm 月下载 | 可借鉴点与限制 |
|---|---|---|---:|---:|---|
| [`@ryan_nookpi/pi-extension-auto-name`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/auto-name) | 首条 prompt，异步 side call | Session、terminal、status | 20* | 429 | 当前 Pi API，功能贴近目标；在 `before_agent_start` 发起异步调用，需要防止 session 切换竞态 |
| [`pi-title-renamer`](https://github.com/mkioutcc/pi-title-renamer) | 首轮 `agent_end`，首个完整对话 | Terminal，Session 可选 | 0 | 121 | 状态持久化、输出清洗和 title 重放最完整；配置和事件处理偏重 |
| [`pi-session-name`](https://github.com/ttttmr/pi-session-name) | 首条 prompt | Session、terminal、忙闲状态 | 1 | 145 | 行为简单；仍引用旧 `@mariozechner` API |
| [`pi-rename-pane`](https://github.com/wujunchuan/pi-rename-pane) | 首轮回复后 | Session、Herdr pane | 0 | 319 | 对 Herdr pane 有明确支持；与普通 terminal title 不是同一接口 |
| [`@tifan/pi-rename`](https://github.com/tifandotme/pi-extensions/tree/master/packages/pi-rename) | `/rename` 手动生成 | Session、Herdr tab | 14* | 648 | 会屏蔽常见 secret，并保护 Herdr 手动标签；不自动生成首个名称 |
| [`@zhcsyncer/pi-recap`](https://github.com/zhcsyncer/pi-extensions/tree/main/packages/pi-recap) | 多轮会话空闲后生成 recap | Session 可选、Herdr、tmux | 0* | 1,358 | multiplexer 所有权和恢复逻辑完善；自动命名只是 recap 的附带能力 |
| [`pi-tmux-window-name`](https://github.com/default-anton/pi-tmux-window-name) | 首条 prompt | Session、tmux window | 4 | 76 | 分别生成长 session 名和短 tmux 名；使用旧 Pi API |
| [`pi-window-title`](https://github.com/hdkiller/pi-window-title) | 首条 prompt，跟踪工作状态 | Session、tmux window | 0 | 32 | 支持模板和 active/idle 状态；使用旧 Pi API |
| [`pi-sessions`](https://github.com/thurstonsand/pi-sessions) | 首轮命名，每 4 轮重评估 | Session | 5 | 2,065 | 手动名称检测、状态机、超时和批量重命名最成熟；整体 package 远超本需求范围 |
| [`@d3ara1n/pi-session-namer`](https://github.com/d3ara1n/pi-extensions/tree/main/packages/pi-session-namer) | 首条 prompt，轻量 side agent | Session | 10* | 1,248 | 失败时本地回退；依赖额外的 `pi-model-roles` package |
| [`@agnishc/edb-auto-name-session`](https://github.com/agnishcc/pi-extention-monorepo/tree/main/packages/edb-auto-name-session) | 首条 prompt，仅一次 | Session | 17* | 1,119 | 边界清晰；模型固定为 `opencode/big-pickle` |
| [`@xl0/pi-lovely-rename`](https://github.com/xl0/agent-files/tree/master/pi/packages/pi-lovely-rename) | 默认 3 轮后，可按 token 触发 | Session | 3* | 573 | 触发条件可配置；对只需首次命名的场景偏复杂 |
| [`@fyeeme/pi-session-name`](https://github.com/fyeeme/pi-packages/tree/main/pi-session-name) | 首轮结束后，可持续重评估 | Session | 1* | 282 | 手动名称优先和异步二次检查值得复用；不更新 terminal title |
| [`@furbyhaxx/pi-session-naming`](https://github.com/furbyhaxx/pi-session-naming) | 可延迟若干轮，失败后重试 | Session | 1 | 63 | 配置、session browser 和临时标题能力丰富；超出轻量插件范围 |
| [`pi-auto-rename`](https://github.com/victor-software-house/pi-auto-rename) | 首轮回复后 | Session | 2 | 102 | 当前 Pi API，支持选择命名模型；要求 Node 24 |
| [`pi-session-auto-rename`](https://github.com/egornomic/pi-session-auto-rename) | 首轮回复后 | Session | 3 | 97 | 实现直接，功能较少，是 `pi-auto-rename` 的前身 |
| [`pi-session-title`](https://github.com/djdembeck/pi-session-title) | 第一条真实 prompt | Session | 0 | 43 | 兼容旧 Pi 和 OMP；仍引用旧 Pi API |
| [`pi-auto-session-titles`](https://github.com/edxeth/pi-auto-session-titles) | 首条 prompt，可指定专用模型 | Session | 0 | 未发布 | 使用当前 Pi API；只能从 GitHub 安装 |

### Herdr 能力结论

本地 [Herdr](https://github.com/ogulcancelik/herdr) 与相关插件的实现表明：

- Herdr 为受管 pane 注入 `HERDR_ENV=1`、`HERDR_PANE_ID`、`HERDR_SOCKET_PATH` 和可选的 `HERDR_BIN_PATH`。
- `herdr pane rename` 设置的是手动 pane label。自动插件调用它会与用户手动标签争夺所有权，不适合作为默认同步方式。
- Herdr 官方建议并行于 Agent integration 的用户扩展使用 `herdr pane report-metadata --title`。该接口只改变展示，不接管 integration 对 `idle`、`working`、`blocked` 和 session restore 的权威。
- Pi 官方 Herdr integration 的 source 是 `herdr:pi`，agent label 是 `pi`。本插件应使用独立 source `user:pi-session-title`，并通过 `agent = pi` 和 `applies_to_source = herdr:pi` 限定元数据只作用于当前 Pi integration。
- 官方 Pi integration 已使用 `node:net` 通过 `HERDR_SOCKET_PATH` 发送 JSONL request，并采用 500ms 首次超时和 1500ms 单次重试。本插件可复用该零依赖通信模式，以 CLI 作为 fallback。
- `pane.report_metadata` 支持 per-source `seq`。乱序到达且 sequence number 不大于最后已接受值的 report 会被忽略，适合处理 session 切换和并发重放。
- Herdr 会清理 metadata 控制字符并将 title 限制为 80 个字符，但本插件仍应在调用前完成自己的清洗和 48 code point 限制。
- [`herdr-plugin-window-title-sync`](https://github.com/OiAnthony/herdr-plugin-window-title-sync) 优先读取 pane metadata title，并将其同步到最外层 terminal window。它与本插件兼容，但不是本插件的硬依赖。

调研结论：

- 首条 prompt 足以生成可用标题，但在 `before_agent_start` 中生成会与主 Agent 并发，必须处理手动命名和 session 切换竞态。
- 首轮 `agent_settled` 后生成不会拖慢主 Agent，还可以利用第一条 Assistant 文本提高准确度。
- 用户手动设置的名称必须拥有最高优先级，模型调用完成后需要再次检查当前 session 和名称。
- 自动标题状态需要写入 session custom entry，否则 `/reload`、`/resume` 或手动清空名称后可能重复调用模型。
- 周期重命名应按 active branch 的已完成用户轮次计数，并在 `KEEP`、改名和失败后都推进检查点，避免连续重复调用。
- Terminal title、Herdr pane metadata、tmux window 和 Herdr 手动 pane label 是不同能力。v1 处理 Pi session、普通 terminal title 和 Herdr pane metadata，不修改手动 label。

## 3. 产品目标

安装后，用户无需执行命令。新 Pi TUI session 完成首轮对话后，应得到一个简短、可识别且持久化的标题，`/resume` 列表、terminal tab/window 和 Herdr pane 同步显示该标题。用户可选择每完成 n 个新的用户轮次重新评估一次标题。

成功标准：

- 首轮正常对话结束后自动生成一次标题。
- 配置 `refreshTurns = n` 后，每完成 n 个新的用户轮次重新评估标题。
- 自动命名不阻塞主 Agent，也不覆盖用户手动名称。
- `/reload` 和 `/resume` 不会产生计划外的模型调用。
- 模型或认证失败不会影响原会话。
- 多个 Pi session 并行切换时不会把标题写到错误 session。
- Herdr 环境中同步 pane metadata，不覆盖用户手动 pane label。

## 4. 功能需求

### P0-1 自动触发

- 仅在 `ctx.mode === "tui"` 时自动运行，避免在 `print`、`json` 和 `rpc` 模式产生隐藏调用。
- 在第一个有效用户请求对应的 `agent_settled` 后生成初始标题。
- 空文本、图片-only 输入、slash command 和 user bash 不作为首个有效请求。
- 初始命名在第 1 轮最多自动评估一次。`refreshTurns = 0` 时，失败后只允许用户通过命令主动重试；`refreshTurns > 0` 时，失败只会在下一个完整的 n 轮边界再次评估。
- 已存在但不属于插件自动状态的 session name，在 startup、resume、fork 和 reload 时不自动生成。
- `refreshTurns` 默认为 `4`。设置为正整数 n 后，从上次评估检查点开始，每完成 n 个新的用户轮次触发一次周期评估；设置为 `0` 时只生成初始标题。
- 轮次只统计 active branch 中已经完成的 user/assistant exchange。Tree navigation 后按新 active branch 重新计算，不把 abandoned branch 计入。
- 周期评估允许模型返回精确值 `KEEP`。返回 `KEEP`、应用新标题或评估失败后都要把当前 user turn count 记为新检查点。

### P0-2 命名上下文

自动命名使用第一轮的以下内容：

- 第一条用户文本。
- 第一条 Assistant 的可见 text block。

周期评估使用当前标题，以及 active branch 最近最多 8 条 user/assistant text message。必须排除 reasoning、tool call、tool result、图片、system prompt 和 extension metadata。发送给命名模型的文本总长不超过 4,000 个 Unicode code point：初始命名优先保留完整用户请求，周期评估优先保留最近消息。

### P0-3 标题规则

模型输出必须满足：

- 与第一条用户消息使用相同语言。
- 只包含一行纯文本，不含 Markdown、引号、前后空白或解释。
- 描述具体任务，避免 `问题处理`、`代码修改` 等泛化标题。
- 默认不超过 48 个 Unicode code point。

应用前必须移除 ANSI escape、控制字符、Markdown 包装、换行和尾部标点，并按 Unicode code point 截断。清洗后为空时视为失败。

### P0-4 模型选择

- 未配置 `model` 时，使用触发该次命名的 main agent 当前 model。
- 可配置 `provider/modelId`，只按第一个 `/` 分隔，支持 OpenRouter 等包含 `/` 的 model ID。
- 配置模型不存在或认证失败时，回退触发时的 main agent model。
- 配置模型与 main agent model 相同时不得重复尝试。
- 命名调用默认使用 `minimal` thinking level，可通过 `thinkingLevel` 覆盖。
- 单次请求默认超时 5 秒，输出预算默认 40 tokens。
- 插件不保存 API key、headers 或模型响应原文。

### P0-5 Session、terminal 和 Herdr 同步

成功生成标题后按顺序执行：

1. 再次确认当前 session file 与发起请求时一致。
2. 再次确认 session name 与发起请求时一致，且没有发生手动命名。
3. 调用 `pi.setSessionName(title)` 持久化名称。
4. 调用 `ctx.ui.setTitle()` 设置 terminal tab/window title。
5. 运行在 Herdr pane 中时，上报 Herdr pane metadata title。

默认 terminal title 格式为：

```text
π {title} ({cwd})
```

其中 `{cwd}` 为当前工作目录 basename。以下事件应重放当前 session name 对应的 terminal 和 Herdr 标题，不调用模型：

- `session_start`
- `session_info_changed`
- `agent_start`
- `agent_settled`

Herdr 同步要求：

- 仅当 `HERDR_ENV === "1"`、`HERDR_PANE_ID` 和 `HERDR_SOCKET_PATH` 均非空时启用 socket 主通道。
- 使用 `node:net` 连接 `HERDR_SOCKET_PATH`，发送单行 JSON request。首次发送等待 500ms，失败后以 1500ms timeout 重试一次。
- Socket request 使用 `method = "pane.report_metadata"`，显式传递 `pane_id`、`source = "user:pi-session-title"`、`agent = "pi"`、`applies_to_source = "herdr:pi"`、`title` 和单调递增的 `seq`。
- 每个 extension runtime 的 `seq` 以 `Date.now() * 1000` 为基数递增。清除 title 也必须携带新的 `seq`，防止旧异步 report 覆盖新 session。
- Socket 两次发送均失败时 fallback Herdr CLI。命令优先使用 `HERDR_BIN_PATH`，缺失时使用 PATH 中的 `herdr`。
- CLI fallback 使用显式 `HERDR_PANE_ID`，不得依赖 Herdr 当前聚焦 pane，并使用以下契约：

```text
herdr pane report-metadata <pane-id> \
  --source user:pi-session-title \
  --agent pi \
  --applies-to-source herdr:pi \
  --title <title>
```

- 所有同步路径都只使用 display metadata，不调用 `herdr pane rename`。
- `session_start` 发现当前 session 无名称时，通过 socket `clear_title = true` 或相同 source 的 CLI `--clear-title` 清除旧 title，避免 `/new` 后沿用前一个 session。
- `session_shutdown` 仅在 `reason === "quit"` 时清除 title。`reload`、`new`、`resume` 和 `fork` 由 replacement runtime 接管。
- Herdr socket 和 CLI 都不可用、integration 不匹配或 metadata 上报失败时，Pi session 和 terminal title 仍应成功，warning 每个 session 最多显示一次。
- 不安装或调用 `herdr-plugin-window-title-sync`。该插件存在时会自行消费 pane metadata 并更新最外层 terminal title。

### P0-6 手动名称优先

- 内置 `/name`、RPC 或其他 extension 设置的名称都视为用户所有。
- 自动命名请求执行期间，如果 session name 发生变化，丢弃模型结果。
- 自动命名完成后，任何不等于插件最后生成值的 `session_info_changed` 都将 session 标记为 manual lock。
- manual lock 必须跨 `/reload` 和 `/resume` 保留，并暂停初始命名和周期重命名。
- 插件不得自动覆盖 manual lock。

### P0-7 状态持久化与竞态

使用 versioned custom entry 保存以下最小状态：

```json
{
  "version": 1,
  "status": "generated | failed | manual",
  "title": "可选的最后自动标题",
  "lastEvaluatedUserTurnCount": 1,
  "updatedAt": "ISO-8601"
}
```

要求：

- 同一时间最多存在一个命名请求。
- 每次周期评估都捕获触发时的 current title、user turn count、session file 和 session epoch。
- `session_shutdown` 时中止未完成请求。
- 异步调用完成后通过 session file、session epoch、当前名称和 user turn count 检查再写入。
- stale context、provider error、timeout 和空输出都不得抛出到主 Agent loop。
- 自动失败最多显示一次 warning，不使用原始 prompt 作为 terminal 或 Herdr title 回退，避免把长文本或敏感内容暴露到标题。

### P0-8 手动命令

提供不易与现有插件冲突的 `/session-title`：

- `/session-title`：基于当前 branch 最近最多 8 条 user/assistant text message 重新生成标题。
- `/session-title status`：显示 enabled、当前状态、当前名称、配置模型和最终解析模型。
- 精确手动名称继续使用 Pi 内置 `/name`，本插件不重复提供同类命令。

手动生成仍需经过输出清洗和竞态检查，但允许替换插件自己生成的旧标题。若当前名称属于 manual lock，执行 `/session-title` 前必须要求一次确认；确认后 title ownership 交回插件，并从当前 user turn count 重新开始周期计数。

## 5. 配置

全局配置文件：

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-session-title.json
```

建议配置结构：

```json
{
  "enabled": true,
  "thinkingLevel": "minimal",
  "timeoutMs": 5000,
  "maxTokens": 40,
  "maxLength": 48,
  "refreshTurns": 4,
  "terminalTitle": {
    "enabled": true,
    "template": "π {title} ({cwd})"
  },
  "herdr": {
    "enabled": true
  }
}
```

自定义模型时添加：

```json
{
  "model": "openai-codex/gpt-5.4-mini"
}
```

要求：

- 配置缺失、JSON 损坏、字段类型错误或未知字段不得阻止 Pi 启动。
- `model` 可省略；省略时使用 main agent model。
- `refreshTurns` 必须是非负安全整数，默认 `4`。正整数 n 表示每 n 个新用户轮次重新评估，`0` 表示禁用周期评估。
- 无效字段回退默认值。
- Template 仅支持 `{title}` 和 `{cwd}`，渲染后的 terminal title 仍需移除控制字符。
- Herdr metadata source `user:pi-session-title`、agent `pi` 和 integration source `herdr:pi` 是协议常量，不开放配置。
- 修改配置后通过 `/reload` 生效。

## 6. 非目标

v1 不包含：

- 按固定周期以外的智能触发或主题漂移检测。
- 批量处理历史 session。
- Session 搜索、列表、删除或 handoff。
- 直接调用 `tmux rename-window`。
- 调用 `herdr pane rename` 修改手动 pane label，或修改 Herdr tab label。
- 自动安装、配置或刷新 `herdr-plugin-window-title-sync`。
- Busy/idle spinner、footer status 或桌面通知。
- 根据 tool result、Git branch、PR 或 CI 状态生成标题。
- OMP 兼容性承诺。后续只有在 API 和测试成本可控时再加入 `omp` manifest。

## 7. 验收标准

1. 新建 TUI session，发送普通文本请求并完成首轮回复后，session name、terminal title 和 Herdr pane metadata title 都更新为清洗后的标题。
2. 首轮开始前或模型调用期间执行 `/name manual-title`，最终名称保持 `manual-title`，后续周期评估不再运行。
3. `refreshTurns = 3` 时，首次标题在第 1 个已完成用户轮次生成，之后在第 4、7、10 个已完成用户轮次重新评估。
4. 周期评估返回 `KEEP` 时标题不变，检查点推进，下次调用仍需等待完整的 n 轮。
5. `/reload`、`/resume` 和已有 manual lock 的 startup 不产生计划外模型调用，只恢复展示标题。
6. 配置 `model` 省略时使用 main agent 当前 model；配置模型不可用时只回退 main agent model 一次。
7. 命名期间切换 session，旧请求不会修改新 session。
8. 模型返回多行 Markdown、ANSI、控制字符或超长文本时，最终标题符合清洗和长度限制。
9. `print`、`json` 和 `rpc` 模式不自动调用命名模型。
10. Herdr 环境中通过 socket 上报带递增 `seq` 的 `user:pi-session-title` metadata，不修改 manual pane label；socket 失败时 fallback 显式 `HERDR_PANE_ID` 的 CLI，Herdr 完全不可用时 Pi 命名仍成功。
11. 旧 sequence 的延迟 metadata report 不会覆盖较新的 session title。
12. `/new` 后无标题的新 session 不保留前一个 session 的 Herdr metadata title；正常 quit 后清除本 source 的 title。
13. `/session-title` 可以主动重试失败状态，manual lock 场景会先确认。
14. 单元测试覆盖触发判定、轮次计数、KEEP、上下文提取、模型回退、输出清洗、状态恢复、手动覆盖、Herdr socket/CLI 参数、seq 乱序保护和 session 切换竞态。
15. Package 通过 `bun test`、NodeNext typecheck 和 `npm pack --dry-run`，发布内容不包含测试文件。
