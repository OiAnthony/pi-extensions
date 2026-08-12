# Pi Packages

- This is a Bun `1.3.14` workspace. Run `bun install` at the repository root; the root package has no scripts, CI, lint, or build configuration.
- Each independently publishable package lives in `packages/*`. Its `package.json` `pi` field is the source of truth for Pi resources and entrypoints; `pi-command-history` loads `extensions/index.ts`.

## Verification

- Run a focused test with `bun test packages/<package>/extensions/<file>.test.ts`.
- Type-check a package with `bunx tsc --noEmit --project packages/<package>/tsconfig.json`. The current package uses `NodeNext`, so local TypeScript test imports use `.js` specifiers.

## Pi Constraints

- Project-local extensions load after the project is trusted. Do not claim that `pi --approve` establishes persistent explicit trust unless official documentation verifies that behavior.
- `pi-tps` 必须同时支持 Pi 和 OMP。处理消息生命周期时，不得假设两个运行时都会发出相同的可选事件；测试必须覆盖 Pi 的 `message_end` 路径和 OMP 缺少该事件时的 `turn_end` 回退路径。

## 文档语言

- 仓库文档默认使用简体中文。仅在用户明确要求或目标读者包含非中文用户时提供双语版本。
