---
name: require-pr-before-main-push
description: "该仓库向 main 提交变更必须先走 PR，不得直接推送"
condition: "\\bgit push origin main\\b"
scope: "tool"
---

不要对 `main` 执行直接 push。先创建包含待提交变更的分支、推送该分支、创建以 `main` 为 base 的 PR，并在 required check 通过后按仓库允许的 merge strategy 合并。