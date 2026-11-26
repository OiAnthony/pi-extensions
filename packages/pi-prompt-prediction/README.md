# pi-prompt-prediction

在 Pi 或 OMP 完整轮次结束后预测下一个 prompt：Pi 在输入框内显示灰色预测文本（ghost text），OMP 19.x 在输入框上方以单行预测提示条显示。按 Tab（或空草稿时按 →）填入草稿，不自动发送。

支持 Pi 和 OMP 的交互式主 session，不为 RPC、JSON、print 模式或 OMP subagent 发起预测。Pi 使用 `agent_settled` 等待自动重试和排队消息结束；OMP 使用完整轮次的 `agent_end`。

## 本地使用

在仓库根目录安装依赖，然后显式加载扩展：

```bash
bun install
pi --extension ./packages/pi-prompt-prediction/extensions/index.ts
```

使用 OMP 时，将启动命令换为：

```bash
omp --extension ./packages/pi-prompt-prediction/extensions/index.ts
```

在 OMP 的 `/settings` 中保持 **Composer Predictions** 关闭。本扩展替代原生预测请求；同时启用会产生重复计费请求。扩展不会修改 OMP 设置。

完成一轮对话后，有可用预测时空输入框会显示预测。输入匹配的前缀时继续显示剩余文本；按 Tab 或 → 接受，再按 Enter 才发送。不匹配的输入会清除预测。

Pi 的预测只在编辑器获得焦点、光标位于草稿末尾且补全菜单关闭时显示。预览限于光标所在行，空间不足时截断；接受时填入完整文本，可一次撤销。按 Escape 清除预测。预测遵循 Pi 的 Tab 和向右移动键绑定。

接受预测后，按 Ctrl+C 清空草稿，可再次按 Tab 或 → 填入同一预测，不增加模型请求。输入不匹配的内容、提交 prompt、开始新轮次或切换模型、session 后，原预测不再保留。

## 主动预测

可在编辑器为空且 Agent idle 时使用 `/prompt-predict` 主动触发预测。预测进行中重复执行会被忽略；已有预测时 `/prompt-predict` 保留当前结果，使用 `/prompt-predict refresh` 才会取消旧结果并重新请求。Agent 忙碌、存在待处理消息或没有有效模型时不会发起请求。预测进行中会直接在 editor 输入区以灰色隐式文本显示 `Predicting next prompt…`，不写入草稿，也不会被 Tab 或 → 接受。OMP 已有内置 `/predict` 命令，因此本扩展使用 `/prompt-predict` 避免冲突。

## 模型选择

模型链路按宿主能力决定：

- OMP 优先使用原生 `@smol`，遵循当前 OMP 的角色配置和 `--smol`。
- Pi 没有原生 `@smol` 查询能力时，直接使用当前主模型。
- OMP 的 `@smol` 未配置、不可认证、请求失败或输出不可用时，尝试当前主模型。
- 两个目标指向同一 provider/model 时只请求一次。
- 模型明确返回 `NO_PREDICTION` 时停止，不请求下一模型。
- 整条链路共用 15 秒超时；取消或超时不会继续回退。

可在启动时指定已配置 provider 的模型，例如：

```bash
omp --extension ./packages/pi-prompt-prediction/extensions/index.ts --smol <provider/model>
```

将 `<provider/model>` 替换为 OMP 中可用的模型。Pi 不依赖共享的 `pi-model-roles` 配置，直接使用当前主模型。

## 上下文与费用

直接预测请求仅发送当前分支最近的 user/assistant 文本，最多 12 条、合计 24,000 个 UTF-16 code units。不发送图片、thinking 或 tool result。输出上限为 512 tokens；预测文本最长 500 个 UTF-16 code units。Pi 使用宿主的 `modelRegistry.streamSimple()`，支持扩展注册的 provider。

OMP 的主模型优先使用 `runEphemeralTurn`，复用宿主上下文及其 prompt-cache 机制。不执行工具，不把预测写入对话。实际缓存命中取决于 provider、请求前缀和缓存有效期。宿主缺少此 API 时，包括 Pi，使用相同的有界文本请求。

每个符合条件的完整轮次最多额外请求两个模型，可能产生费用；不是逐字补全。扩展不把直接请求的 usage 写入宿主的统计账本，不能依靠 `/stats` 衡量其全部费用。

已有草稿、待处理消息、未完成的自动续跑或最近 assistant 失败时，不请求预测。输入、开始新轮次、切换模型或 session、分叉、树导航、压缩及关闭 session 时，取消未完成请求。旧 session、旧叶节点和旧模型的迟到结果不会显示。预测只模仿键盘前用户，不应模仿 IRC 或其他 Agent 的转发内容。

OMP 19.x 通过 `ctx.ui.composer`（`addKeyHandler`、`addDecorator`）与 `ctx.ui.setWidget(..., { placement: "aboveEditor" })` 在输入框上方展示单行预测提示条；空草稿时按 Tab 或 → 接受，输入匹配前缀时按 Tab 接受，按 Escape 清除。Pi 仅在 Pi 运行时按需加载编辑器包装，接受前不改动实际草稿，并组合已有自定义编辑器 factory；后加载的编辑器扩展仍需组合当前 factory，不能直接替换并丢弃它。Pi 的自定义编辑器需提供与 `CustomEditor` 相同的焦点、光标位置、补全状态和文本插入能力，否则不显示预测。

## 开发验证

```bash
bun test packages/pi-prompt-prediction/extensions
bunx tsc --noEmit --project packages/pi-prompt-prediction/tsconfig.json
```

实现参考 [OMP Composer Predictions](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/controllers/composer-prediction-controller.ts) 的完整轮次触发、ghost text 和 `NO_PREDICTION` 约定。
