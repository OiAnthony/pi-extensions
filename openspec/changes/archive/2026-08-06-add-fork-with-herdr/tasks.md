## 1. Package Setup

- [x] 1.1 创建 `packages/pi-fork-with-herdr` package scaffold，包括 `package.json`、`tsconfig.json` 和 `extensions/index.ts` entrypoint
- [x] 1.2 配置 `@oipsanthony/pi-fork-with-herdr` 的 Pi manifest、peer dependencies、发布文件和聚焦测试脚本

## 2. Fork Preparation

- [x] 2.1 实现 TUI 与 `HERDR_ENV`、workspace、pane 环境前置条件校验，确保失败路径无外部副作用
- [x] 2.2 实现 idle 后 source session、session directory 和 live active leaf 捕获，并处理空或未持久化 session
- [x] 2.3 使用独立 `SessionManager` 按 active leaf 创建带 parent 关系的派生 session，且不替换 live session

## 3. Herdr Orchestration

- [x] 3.1 实现 Herdr CLI 参数数组执行和 JSON response 解析，覆盖 tab create、agent start、tab focus 和 tab close
- [x] 3.2 实现符合 Herdr 命名约束的唯一 `pi-fork-<short-id>` agent name 生成和有限冲突重试
- [x] 3.3 实现 `/fork-with-herdr` 编排：后台创建同 cwd tab、在 root pane 恢复派生 session、ready 后聚焦
- [x] 3.4 实现分阶段补偿：tab 创建失败删除派生 session，agent 启动失败先确认关闭 tab 再删除 session，聚焦失败保留运行资源并告警

## 4. User Experience and Documentation

- [x] 4.1 为全部前置条件、成功、失败和部分失败路径提供简洁英文 Pi notification，错误中保留相关 Herdr tab 或 pane ID
- [x] 4.2 编写中文 README，说明安装、`/fork-with-herdr` 语义、Herdr 前置条件、session 隔离边界和共享 cwd 的并发风险

## 5. Verification

- [x] 5.1 添加单元测试，验证 `/tree` 切换后传入的是 live active leaf，而不是 source 文件最后 entry
- [x] 5.2 添加单元测试，覆盖非 Herdr、非 TUI、空 session、未持久化 session 和 wait-for-idle 行为
- [x] 5.3 添加单元测试，覆盖成功编排、Herdr JSON 缺失字段、agent name 冲突以及每个补偿和部分失败分支
- [x] 5.4 运行 package 聚焦测试和 TypeScript typecheck，并执行 `npm pack --dry-run` 检查发布内容
- [x] 5.5 在 Herdr 中执行受控 smoke test，确认源 tab/session 保持不变、新 tab 恢复独立 session、active branch 正确且启动后获得焦点
