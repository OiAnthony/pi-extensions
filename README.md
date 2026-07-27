# Pi Packages

[English](README.en.md)

用于开发和发布 Pi package 的 Bun workspace monorepo。

## 目录结构

- `packages/`：可独立安装的 Pi package。

## 开发

```bash
bun install
bun test packages/<package>/extensions/<file>.test.ts
bunx tsc --noEmit --project packages/<package>/tsconfig.json
```

每个 package 均通过其 `package.json` 中的 `pi` 字段声明 Extension、Skill、Prompt 或 Theme 资源。
