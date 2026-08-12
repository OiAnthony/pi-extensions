# @oipsanthony/pi-tps

在 Pi 和 OMP 中记录每次请求、每个 Prompt 与当前 Session 的 token throughput 和 latency 指标。

## 安装

```bash
pi install npm:@oipsanthony/pi-tps
```

## 使用

Extension 会在每个 Prompt 完成后显示一行摘要，包括输出 token、active TPS、effective TPS、TTFT、耗时与请求数。

执行以下命令可查看当前 active branch 中所有已完成 Prompt 的汇总：

```text
/tps
```

指标会作为 versioned session entries 持久化。切换 session tree 分支后，统计只恢复当前 active branch 上的数据。

## 指标

- `active TPS`：输出 token 除以 generation time，并扣除检测到的 inference stall。
- `effective TPS`：输出 token 除以完整 Prompt processing time。
- `TTFT`：provider request 开始到首个 content delta 的时间。
- `stall`：相邻 stream update 间超过 500 ms 的间隔。
- `requests`：一个 Prompt 内完成的 provider request 数量。

无法可靠计算的指标显示为 `n/a`。Extension 会拒绝超过 `10,000 tok/s` 的异常测量值。

## 数据边界

Extension 保存 token usage、timing、provider、model、HTTP status 和 stop reason。失败请求可能包含 Pi 提供的 error message。数据写入当前 Pi session，不会发送到外部服务。

## Attribution

本 package 包含基于 `monotykamary/pi-tps` 和 `badlogic/pi-mono` 修改的代码。版权与许可证信息见 [NOTICE](NOTICE) 和 [LICENSE](LICENSE)。
