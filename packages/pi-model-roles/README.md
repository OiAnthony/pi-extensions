# @oipsanthony/pi-model-roles

为 Pi extension 提供共享的模型角色配置、认证解析和当前模型回退。直接安装此 package 时，还可用快捷键循环切换主 Agent 的角色。

## 安装

仅作为其他 extension 的共享库时，将 package 声明为普通 npm dependency；这不会传递性启用角色切换 extension。

需要为主 Agent 启用角色快捷键时直接安装：

```bash
pi install npm:@oipsanthony/pi-model-roles
```

## 配置

配置文件位于 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/model-roles.json`。以下能力档位只是一组可复制示例，runtime 不会创建内置角色、默认模型或默认 `cycleOrder`：

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

- `tiny`：低成本、低延迟。
- `default`：日常质量、速度和成本均衡。
- `slow`：速度较慢但性能更高的高推理档位。
- `smol`：低成本且适合长程执行。
- `turbo`：高 TPS、高吞吐。

角色名称可自定义并区分大小写。角色值支持 `provider/modelId[:thinkingLevel]` 和 `@role[:thinkingLevel]`。可用 thinking level 为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。

省略 `cycleOrder` 时，快捷键按 `roles` 的声明顺序循环。配置后只循环数组中的角色；未列入示例循环的 `smol` 和 `turbo` 仍可由插件通过 `@smol` 和 `@turbo` 解析。修改配置后执行 `/reload`。

## 快捷键

- `Ctrl+P`：向前循环角色。
- `Ctrl+Shift+P`：向后循环角色。

Pi 0.84.1 的内置模型循环、session selector 和 scoped models selector 会占用这些快捷键。启用角色快捷键前，先在 `~/.pi/agent/keybindings.json` 解除模型循环绑定，并将 selector 操作改绑到其他按键：

```json
{
  "app.model.cycleForward": [],
  "app.model.cycleBackward": [],
  "app.models.toggleProvider": "alt+p",
  "app.session.togglePath": "alt+shift+p"
}
```

修改后执行 `/reload`。extension 没有移除内置快捷键的 API，因此不能覆盖仍有效的内置绑定而不产生冲突提示。此配置保留了 `/scoped-models` 中按 provider 批量切换和 session selector 路径显示切换功能，快捷键分别改为 `Alt+P` 和 `Alt+Shift+P`。

角色轨道使用编辑器上方的稳定 widget。Pi 按 package 加载顺序排列同一位置的 widget，因此同时使用 `pi-powerline-footer` 时，应让 model roles 先加载：

```json
{
  "packages": [
    "npm:@oipsanthony/pi-model-roles",
    "npm:pi-powerline-footer"
  ]
}
```

这样角色轨道显示在 powerline 上方，并在两者之间保留 1 个空白行；轨道消失时不会残留间距。修改 package 顺序后执行 `/reload`。

## 共享 API

```ts
import {
  loadModelRoles,
  resolveModelTarget,
  selectThinkingLevel,
} from "@oipsanthony/pi-model-roles";
```

`resolveModelTarget()` 返回最终模型、完整认证环境、Role chain、thinking metadata、回退状态和结构化诊断。它不会保存 API key，也不会显示 UI 通知。
