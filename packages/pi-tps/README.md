# pi-tps

在 Pi 和 OMP 中显示每个 Prompt 的 token throughput 和 latency，并汇总当前 session branch 的历史数据。

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

每个 Prompt 完成后，扩展会显示一行摘要，包括输出 token、active TPS、effective TPS、TTFT、耗时和请求数。

查看当前 active branch 中所有已完成 Prompt 的汇总：

```text
/tps
```

统计数据会保存在 session 中。切换 session tree 分支后，汇总也会切换到对应 branch。

## 指标

| 指标 | 含义 |
|------|------|
| `active TPS` | 模型实际生成期间的 token 速度，扣除检测到的 streaming stall |
| `effective TPS` | 输出 token 除以完整 Prompt 处理时间 |
| `TTFT` | Provider request 开始到第一个 content delta 的时间 |
| `stall` | content stream update 之间至少 500 ms 的停顿 |
| `requests` | 一个 Prompt 内完成的 Provider request 数量 |

当 stream 事件不足或测量结果不可靠时，`active TPS` 会显示 `n/a`。

## 数据

扩展会将 token usage、timing、Provider、模型、HTTP status 和 stop reason 写入当前 session。失败请求可能包含 Pi 提供的 error message。数据不会发送到外部服务。

## Attribution

本 package 包含基于 [`monotykamary/pi-tps`](https://github.com/monotykamary/pi-tps) 和 [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono) 修改的代码。版权与许可证信息见 [NOTICE](NOTICE) 和 [LICENSE](LICENSE)。
