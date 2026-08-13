# @oipsanthony/pi-tps

## 0.1.5

### Patch Changes

- d3604c3: 对不可靠的吞吐量样本做门控，避免把短流或不完整测量报为可用 TPS。

## 0.1.4

### Patch Changes

- f8a5343: 精简并重写面向用户的安装、使用、配置和限制说明。

## 0.1.3

### Patch Changes

- 74df898: Update package repository metadata after renaming the monorepo to pi-extensions.

## 0.1.2

### Patch Changes

- e7ee89b: 兼容 Pi 与 OMP 的扩展 API 和消息生命周期差异，避免 OMP 缺少 `message_end` 时 TPS 显示为 `n/a`。

## 0.1.1

### Patch Changes

- 6843cfd: 修正 TTFT 和 generation time 的起点，仅将首个实际 content delta 计为首 token，忽略 stream start 事件。
