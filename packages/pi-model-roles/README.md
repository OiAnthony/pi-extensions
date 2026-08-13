# pi-model-roles

为常用模型配置简短角色名，并在 Pi 中用快捷键循环切换。其他扩展也可以使用同一份角色配置解析模型和 thinking level。

## 安装

需要在 Pi 中使用角色切换时安装：

```bash
pi install npm:@oipsanthony/pi-model-roles
```

仅作为其他 extension 的共享依赖时，不需要单独安装。

## 配置

创建 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/model-roles.json`：

```json
{
  "roles": {
    "tiny": "<provider>/<fast-model>:minimal",
    "default": "<provider>/<default-model>:medium",
    "slow": "@default:xhigh"
  },
  "cycleOrder": ["tiny", "default", "slow"]
}
```

角色值支持：

- `provider/modelId[:thinkingLevel]`
- `@role[:thinkingLevel]`

可用 thinking level 为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 和 `max`。

`cycleOrder` 决定快捷键切换顺序。省略时按 `roles` 的声明顺序切换。修改配置后执行 `/reload`。

## 使用

| 快捷键 | 操作 |
|--------|------|
| `Ctrl+P` | 切换到下一个角色 |
| `Ctrl+Shift+P` | 切换到上一个角色 |

切换时，editor 上方会短暂显示角色列表、当前角色和 thinking level。无法认证或不存在的模型会从循环中跳过。

## 快捷键冲突

Pi 默认占用这两个快捷键。请在 `~/.pi/agent/keybindings.json` 中解除内置模型循环绑定：

```json
{
  "app.model.cycleForward": [],
  "app.model.cycleBackward": [],
  "app.models.toggleProvider": "alt+p",
  "app.session.togglePath": "alt+shift+p"
}
```

修改后执行 `/reload`。

## Extension API

其他 extension 可以直接使用角色解析：

```ts
import {
  loadModelRoles,
  resolveModelTarget,
  selectThinkingLevel,
} from "@oipsanthony/pi-model-roles";
```
