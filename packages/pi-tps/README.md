# pi-tps

在 Pi 和 OMP 中显示每个 Prompt 的端到端 token throughput 和 latency，并汇总当前 session branch 的历史数据。

## 安装

Pi：

```bash
pi install npm:@oipsanthony/pi-tps
```

OMP：

```bash
omp install @oipsanthony/pi-tps
```

## 使用

每个 Prompt 完成后，扩展会显示一行摘要：

```text
20.0s · 10.0 tok/s · 3 requests · TTFT 1.2s · in 36K · out 200
```

查看当前 active branch 中所有已完成 Prompt 及 Session 汇总：

```text
/tps
```

统计数据保存在 session 中。切换 session tree 分支后，汇总也会切换到对应 branch。

## TPS 口径

`pi-tps` 只计算一种 TPS：

```text
effective TPS = 本轮所有 Provider 请求的 output tokens 之和 / 完整 Prompt 处理时间
```

Prompt 处理时间从 `before_agent_start` 开始，到 `agent_end` 或 `agent_settled` 结束，因此包含：

- Provider queue、prefill、网络延迟和流式输出
- 一个 Prompt 内的多次 Provider 请求
- Tool、Hook 和 Agent loop 的执行时间

这个指标描述 Agent 完成整轮任务时的实际输出效率，不是模型内部的 decode TPS。扩展不再根据 stream chunk 间隔推测 inference stall，也不会从分母扣除停顿时间。

## 指标

| 指标 | 含义 |
|------|------|
| `duration` | 从 `before_agent_start` 到整轮完成的处理时间 |
| `tok/s` | 本轮累计 output tokens 除以完整处理时间 |
| `requests` | 本轮完成的 Provider 请求数 |
| `TTFT` | 首个 Provider 请求开始到首个非空 content event 的时间 |
| `in` / `out` | 本轮所有 Provider 请求累计报告的 token usage |

TTFT 的首个 content event 可能是 text、thinking 或 tool-call，不一定是用户看到的首个正文字符。

### 本地消息队列边界

用户消息在本地队列中等待、尚未触发 `before_agent_start` 的时间不计入 duration。Pi 和 OMP 当前没有通过这个共同事件提供统一、可靠的原始提交时间；扩展因此使用两个运行时都支持的相同生命周期边界，不通过 Prompt 文本反查时间戳。

OMP 内置 usage 行的 `Δ` 可以继续反映从用户消息时间戳到完成的等待时间。

## 数据与兼容性

扩展会将 request 和 Prompt 的原始 timing、usage、Provider、模型、HTTP status 和 stop reason 写入当前 session。失败请求可能包含 Pi 提供的 error message。数据不会发送到外部服务。

新记录使用 `pi-tps/request/v3` 和 `pi-tps/prompt/v3`。读取历史时仍兼容 v1/v2 记录，并根据原始 output 和 duration 按当前 effective TPS 口径展示。

## Attribution

本 package 包含基于 [`monotykamary/pi-tps`](https://github.com/monotykamary/pi-tps) 和 [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono) 修改的代码。版权与许可证信息见 [NOTICE](NOTICE) 和 [LICENSE](LICENSE)。
