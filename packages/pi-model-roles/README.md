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

切换时会在 Powerline 上方短暂显示 Powerline 风格的彩色角色轨道，并在约 3 秒后自动清除。每个角色按循环位置使用稳定颜色，当前角色显示为带左右端帽的反色粗体 Chip。Pi 对同一 `aboveEditor` placement 按 package 注册顺序排列。若同一份 `settings.json` 里 `pi-model-roles` 排在 `pi-powerline-footer` 后面，扩展会在启动时把前者挪到后者正前方，下次启动或 `/reload` 后生效；当前会话不重载。两包分别写在用户和项目配置中时不会改文件。无法认证或不存在的模型会从循环中跳过。

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
