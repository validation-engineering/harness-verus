# 本机性能观测

2026-10-05，在 Apple M4 / macOS arm64 / Node 22.22.0 上，使用实际安装的 npm 制品完成了以下对比。官方 Harness 源码、验收控制器、示例插件和注册入口保持相同；没有通过 `--register` 载入开发源码，也没有调用付费模型。

## 完整流程耗时

这里测量的是 **Web 验收子进程的完整生命周期**：启动、默认 standard 组合、真实 AgentLoop 工具回合、配置拒绝与更新、工具失败恢复、取消、插件禁用与启用、持久化及退出。包含轮询和固定 300 ms 取消等待，不能当作单独的启动时间或吞吐量。

| 组合 | 优化前单次观测 | 优化后三次中位数 | 优化后三次范围 |
| --- | ---: | ---: | ---: |
| 原版 Cordis + JS 扩展（对照） | 1,953 ms | 1,857 ms | 1,846–1,861 ms |
| Rust/Verus Cordis + JS 扩展 | 81,461 ms | 2,589 ms | 2,589–2,627 ms |
| Rust/Verus Cordis + JS/Rust 扩展 | 85,206 ms | 4,686 ms | 4,666–4,715 ms |

本机 JS 扩展流程耗时约减少 96.8%，仍比同期原版对照长约 39%。Rust 扩展流程包含额外的 Rust 工具回合和扩展入口验证，应与自身旧流程比较。其启动与验证开销仍有优化空间。

每轮顺序为原版、native、native-rust，共三轮，串行执行，不预热或丢弃首轮。旧结果各只有一次观测，新结果保留全部三次；不作统计显著性、生产性能或跨平台承诺。

## 用户操作耗时

下表取每轮该 RPC 的最大观测值；新结果为三个最大值的中位数。`Date.now()` 仅提供毫秒计时，每个方法每轮只有一到两次调用。这些数值用于定位交互停顿，不是 p95 或请求尾延迟。

| RPC | native 优化前 | native 优化后 | 同期原版 |
| --- | ---: | ---: | ---: |
| `pluginInventory/list` | 7,679 ms | 40 ms | 39 ms |
| `agentPresets/list` | 2,688 ms | 4 ms | 3 ms |
| `settings/update` | 9,969 ms | 60 ms | 54 ms |
| `pluginManager/setPluginEnabled` | 10,719 ms | 94 ms | 81 ms |

## 改动与语义边界

核心使用优化级别 3 的 release 构建，保留 debug assertions 和 overflow checks。Driver 先按生命周期阶段过滤不可能的动作，再由原有内核 decision 判断合法转换；已解析的 provider 身份在一次 readiness 判断内复用。

JS facade 在一次明确为空的 native drive 和稳定状态同步之后复用静止结果。可能改变图的命令、失败、Rust interop、状态观察器和嵌套 pump 都保守地使结果失效。服务调用仍检查 epoch、lease 和 committed provider；不是缓存旧服务句柄。新增双 profile 回归覆盖异步加载、provider 撤销、清理失败、异常响应和嵌套执行。

本应用的独立 Rust addon 使用相同的优化编译策略，并验证 Cargo 实际报告的 profile。来源锁已指向干净的核心提交 [`b7d7169`](https://github.com/Stool233/cordis-verus/commit/b7d716994010245346a59bced6212f22dee19601)。核心还提供单独的[静止 readiness 基准](https://github.com/Stool233/cordis-verus/blob/b7d716994010245346a59bced6212f22dee19601/docs/benchmarks.md)，用于隔离 facade 改动，不能将该微基准比例推广到完整 Harness。

## 证据与复测

[观测 JSON](performance/2026-10-05-installed-artifacts.json)保留全部进程和 RPC 计时、检查结果、来源锁、制品信息、输入与原报告哈希。为避免重复保存大图，省略了完整 runtime 快照、请求列表和日志；摘要不是原报告字节本身，哈希也不是签名认证。

旧三份报告的哈希逐一匹配 [`feeaecb` 的官方验收记录](https://github.com/Stool233/cordis-harness/blob/feeaecb/docs/official-validation-report.json)。旧来源是记录了精确指纹的 dirty 工作树快照，仅检出其 `baseCommit` 不能恢复完整输入；这里也不保存旧安装树。新数据来自当前安装制品，最终[官方验收记录](official-validation-report.json)另行核对源码、安装树和 Rust addon。

按[构建指南](build.md)准备并验证制品后，可以复测同一流程；完整原始 JSON 和日志输出到 `.cache/official-extensions/`：

```sh
npm run official:verify
npm run rust:verify
mkdir -p .cache/performance/recheck
for round in 1 2 3; do
  for backend in upstream native native-rust; do
    if [ "$backend" = native-rust ]; then
      node scripts/check-official-extensions.mjs --backend native --rust
    else
      node scripts/check-official-extensions.mjs --backend "$backend"
    fi
    cp ".cache/official-extensions/$backend.json" ".cache/performance/recheck/$backend-$round.json"
    cp ".cache/official-extensions/$backend.log" ".cache/performance/recheck/$backend-$round.log"
  done
done
```

复测应使用空闲机器并记录环境，比较全部样本。长时间运行、内存增长、大历史、并发会话、模块图 HMR 和跨平台性能仍需要单独验收。
