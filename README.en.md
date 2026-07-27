# Pi Packages

[简体中文](README.md)

A Bun workspace monorepo for developing and publishing Pi packages.

## Layout

- `packages/` contains independently installable Pi packages.

## Development

```bash
bun install
bun test packages/<package>/extensions/<file>.test.ts
bunx tsc --noEmit --project packages/<package>/tsconfig.json
```

Each package declares its Extension, Skill, Prompt, or Theme resources through the `pi` field in its `package.json`.
