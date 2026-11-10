# pi-prompt-prediction

在 OMP 完整轮次结束后预测下一个 prompt，并在输入框显示原生 ghost text。按 Tab 或 → 填入草稿，不自动发送。

仅支持 OMP 的交互式主 session。已在 OMP 18.18.3 验证；不为 Pi、RPC、print 模式或 subagent 发起预测。

## 本地使用

在仓库根目录安装依赖，然后显式加载扩展：

```bash
bun install
omp --extension ./packages/pi-prompt-prediction/extensions/index.ts
```

在 OMP 的 `/settings` 中保持 **Composer Predictions** 关闭。本扩展替代原生预测请求；同时启用会产生重复计费请求。扩展不会修改 OMP 设置。

完成一轮对话后，空输入框会显示预测。输入匹配的前缀时继续显示剩余文本；按 Tab 或 → 接受，再按 Enter 才发送。不匹配的输入会清除预测。

## 模型选择

默认链路为 `@smol → 当前主模型`：

- 优先使用 OMP 原生 `@smol`，遵循当前 OMP 的角色配置和 `--smol`。
- `@smol` 未配置、不可认证、请求失败或输出不可用时，尝试当前主模型。
- 两个角色指向同一 provider/model 时只请求一次。
- 模型明确返回 `NO_PREDICTION` 时停止，不请求下一模型。
- 整条链路共用 15 秒超时；取消或超时不会继续回退。

可在启动时指定已配置 provider 的模型，例如：

```bash
omp --extension ./packages/pi-prompt-prediction/extensions/index.ts --smol <provider/model>
```

将 `<provider/model>` 替换为 OMP 中可用的模型。没有原生模型查询 API 的宿主使用共享 `model-roles.json` 解析 `@smol`；支持的配置格式见 [pi-model-roles](https://github.com/OiAnthony/pi-extensions/tree/main/packages/pi-model-roles#readme)。原生查询 API 存在但未找到 `@smol` 时，直接回退主模型。

## 上下文与费用

`@smol` 请求仅发送当前分支最近的 user/assistant 文本，最多 12 条、合计 24,000 个 UTF-16 code units。不发送图片、thinking 或 tool result。输出上限为 512 tokens；预测文本最长 500 个 UTF-16 code units。

主模型优先使用 OMP 的 `runEphemeralTurn`，复用宿主上下文及其 prompt-cache 机制。不执行工具，不把预测写入对话。实际缓存命中取决于 provider、请求前缀和缓存有效期。宿主缺少此 API 时，使用与 `@smol` 相同的有界文本请求。

每个符合条件的完整轮次最多额外请求两个模型，可能产生费用；不是逐字补全。扩展不把直接请求的 usage 写入 OMP 的统计账本，不能依靠 `/stats` 衡量其全部费用。

已有草稿、待处理消息、未完成的自动续跑或最近 assistant 失败时，不请求预测。输入、开始新轮次、切换模型或 session、分叉、树导航、压缩及关闭 session 时，取消未完成请求。旧 session、旧叶节点和旧模型的迟到结果不会显示。预测只模仿键盘前用户，不应模仿 IRC 或其他 Agent 的转发内容。

本扩展复用 OMP 原生编辑器的显示、前缀匹配、接受和撤销逻辑，并组合已有自定义编辑器 factory。后加载的编辑器扩展仍需组合当前 factory，不能直接替换并丢弃它。

## 开发验证

```bash
bun test packages/pi-prompt-prediction/extensions
bunx tsc --noEmit --project packages/pi-prompt-prediction/tsconfig.json
```

实现参考 [OMP Composer Predictions](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/controllers/composer-prediction-controller.ts) 的完整轮次触发、ghost text 和 `NO_PREDICTION` 约定。
