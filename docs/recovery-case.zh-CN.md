# 一次插件更新失败：观察、解释与独立复现

[English](recovery-case.md) · 简体中文

**消费者清理失败时，更新不能提前关闭它仍需要的服务。**
本案例在 Rust 内核之上运行未经修改的官方 DeepSeek Harness AgentLoop、
ToolRuntime 与 Todo 插件。自定义插件包含真实的文件服务，以及清理时仍需使用
该服务的工具。只有模型提供者采用确定性脚本，不需要模型账号，也不产生付费请求。

## 运行案例

完成精简应用的[构建和安装](build.md)后：

```sh
npm run demo:recovery
```

命令先核验安装制品，然后执行七个阶段：

| 阶段 | 实际操作 | 审查者应看到什么 |
| --- | --- | --- |
| `initial-turn` | 官方 AgentLoop 依次调用 `todo_write`、`recovery_version`、`todo_write`。 | 持久化会话中的工具结果为 `v1`，Todo 已完成。 |
| `update-failed` | 请求更新为 v2。旧消费者写入最终 checkpoint，但目标文件位置被一个目录占据。 | 真实文件系统错误；消费者显示 `CleanupFailed`；仍打开的文件服务显示 `CommittedConsumers`。 |
| `update-blocked` | 未显式重试清理，再次请求 v2。 | 更新被拒绝；图和事件日志均不改变，v2 尚未启动。 |
| `fault-repaired` | 移除占据 checkpoint 文件位置的空目录。 | 只修复外部故障，保留的生命周期依赖不因此自动释放。 |
| `retry-succeeded` | 调用 `retryPluginCleanup('recovery')`。 | 借助仍保留的文件服务成功写入 checkpoint，然后服务才关闭。共尝试两次、成功一次；之前已成功的标记 inverse 只执行一次。 |
| `updated-turn` | 通过 `loadPlugin` 显式重新提交 v2。 | 同一个官方循环调用 v2 工具并完成 Todo。 |
| `closed` | 关闭 Harness。 | 原生诊断中剩余插件数量为零。 |

失败的更新没有提交 v2，也没有把它保存为待实现的目标配置。清理重试只释放被保留
的旧实例，随后示例显式提交新版本。插件变更在精简应用的空闲轮次边界执行；
本例没有在工具调用过程中替换插件。

输出目录包含：

- `summary.md` 与 `report.json`：阶段结果、**未经改写的原生快照**、inverse ID
  和尝试次数、嵌套清理错误，以及源码和制品哈希。
- `before-update.json`、`after-update.json` 与 `sessions/`：更新前后的真实官方
  会话事件和工具返回值。
- `plugin-events.jsonl`、`journal-v1.jsonl`、`journal-v2.jsonl` 和 checkpoint
  文件：实际 I/O 结果及清理顺序。

自动化使用 `node scripts/run-recovery-case.mjs --json`；添加
`--output NEW_DIRECTORY` 可指定证据目录。断言失败会以非零状态退出，保留案例
失败记录，不会被包装成演示成功。每次运行要求空目录，不改动用户已有的工作区或会话。

## 脱离开发目录复现

制品提供者完成精简应用构建和核验后，运行：

```sh
npm run reproduce:recovery
```

该命令生成 `.tar.gz` 审查包和 `SHA256SUMS`，将包解压到仓库外的新临时目录，
执行**全新 `npm ci --ignore-scripts --offline` 安装**，核验安装的运行时和构建
哈希，再执行相同的七阶段案例。它不复制 `node_modules`，也不使用相邻的内核
源码目录。保存日志和案例证据后会删除临时安装目录。离线安装依赖本机 npm 缓存；
缓存为空时可运行 `npm run reproduce:recovery -- --online`，允许下载依赖，
模型提供者仍采用脚本。

命令会打印压缩包和证据路径。`reproduction.json` 记录平台、准确命令、哈希、
安装策略与结果。验证记录器也执行这次独立安装，并在[精简应用验收记录](validation-report.json)
中绑定压缩包、日志和案例输出。

将压缩包和通过独立渠道取得的校验和交给审查者。审查者需要 **Node 22.22.0、
npm 和 tar**，系统和架构必须与包匹配；目前记录的本地案例为 **macOS ARM64**。
运行时无需 Rust/Verus、源码编译、内核仓库或模型凭据：

```sh
# 在包含压缩包和 SHA256SUMS 的目录中：
shasum -a 256 -c SHA256SUMS
tar -xzf cordis-harness-recovery-darwin-arm64.tar.gz
cd cordis-harness-recovery
node scripts/recovery-evidence.mjs
npm ci --ignore-scripts --include=dev --include=optional --no-audit --no-fund
node scripts/verify-install.mjs
npm run demo:recovery
```

已缓存 registry 依赖时，可以给 `npm ci` 添加 `--offline`。运行时压缩包已随包
提供。预构建应用只附带实际使用的官方源码文件及上游源码清单，不是完整源码检出。
安装构建工具包是为了核验记录的构建输入，不会执行编译器。完整重建或运行官方
Web/standard 应用，应使用仓库的构建指南；不要在这个精简包内运行 `npm run build`。

清单拒绝缺失、篡改、未记录或通过符号链接引入的源码，并绑定运行时压缩包和构建
输出。安装核验还拒绝第二个上游 Node 调度器及被改动的原生运行时包。哈希证明
一致性，不证明发布者身份。这是**开发审查包**，不是签名发行版。一次全新本地
安装只证明记录条件下的可搬移性，不代表外部人员或其他平台已经复现。
分享结果时请附上压缩包校验和、Node/系统/架构、`report.json`、会话记录及失败命令日志。

## 从可见现象追溯到已验证代码

案例采用内核提交
[`e69a1d5`](https://github.com/validation-engineering/cordis-verus/tree/e69a1d546a13dcf573a1a1e0b8cb692ee416250f)。
精确身份以 `sources.lock.json` 和生成报告中的文件指纹为准，不能只看短提交号。
论文 §4.2.2、Definition 54 与 L-Unload（第 36–37 页）要求在恢复期间保留
committed view，并在最后丢弃它。具体对应如下：

| 论文／协议义务 | 内核可执行合同 | 本案例证据 |
| --- | --- | --- |
| BindingPersistence | `Kernel::begin_cleanup` 保留已提交绑定；`finish_cleanup` 只在受保护的完成路径中释放。 | 清理失败消费者的已提交依赖仍指向被保留的 provider。 |
| RestorationGuard | 仍被已提交消费者依赖的 provider 不能开始恢复。 | provider 显示 `CommittedConsumers`；重试时文件仍可用，消费者 flush 后才关闭。 |
| 先确认、后释放 | `LifecycleActions` 要求匹配并被接受的清理报告；失败结果不能授权 finish。 | 实际回调错误可见；旧消费者和 provider 保留，显式重试成功后才移除。 |
| 新重试与旧票据拒绝 | `retry_cleanup` 签发新 action；`consumed_ticket_never_returns` 拒绝之后再次使用旧 receipt。 | 本例观察显式重试和尝试次数；旧票据拒绝由内核合同和回归检查，本例不伪造底层票据。 |

审查固定版本的[清理协议](https://github.com/validation-engineering/cordis-verus/blob/e69a1d546a13dcf573a1a1e0b8cb692ee416250f/docs/cleanup-protocol.zh-CN.md)、
[生产协议分发与证明](https://github.com/validation-engineering/cordis-verus/blob/e69a1d546a13dcf573a1a1e0b8cb692ee416250f/crates/cordis-kernel/src/cleanup_protocol.rs)
和[论文审查指南](https://github.com/validation-engineering/cordis-verus/blob/e69a1d546a13dcf573a1a1e0b8cb692ee416250f/docs/paper-review-guide.zh-CN.md)。
运行时执行的是已检查的 Rust 函数，证明数据在编译后擦除。JS 宿主负责调用回调并
向协议报告结果，其自身尚未全部经过 Verus 验证。本演示使用已有开发验收制品，
不重新执行 Verus，也不扩大证明边界。

真实案例还暴露了一个 Harness 衔接问题：子插件的 dispose 可以先返回失败，而
父插件结构清理仍在报告同一次错误，立即重试可能带出旧的父级错误。
[`PluginManager`](../src/plugin-manager.mjs) 现在先等待已发出的生命周期操作
收尾、保留报告的错误，再暴露可重试的阻塞条目。settle 不会重试失败的 inverse。
[`recovery.test.mjs`](../tests/recovery.test.mjs) 检查修复故障后的第一次显式重试
即可成功，不依赖人为延迟。

## 结果范围

这里完成了一条有限的实际执行链：更新 → 失败 → 保留依赖 → 解释阻塞 → 修复 →
重试 → 新版本可用 → 关闭。采用精简组合，不是默认 Web/standard 应用或官方
Loader HMR；后者由[官方验收记录](official-validation-report.json)覆盖。

案例在 checkpoint 成功写入之前注入一种已知文件故障。它没有证明任意部分外部
写入、进程崩溃、恶意插件、所有宿主交错或任意模型输出都可恢复。一次性标记只
检查本 JS 宿主没有重放已成功的 inverse，不是一般的 I/O 恰好一次定理。
内核协议的有限前缀安全也不等于公平调度或任意回调最终完成。本演示及其复现
不会关闭论文剩余的一般 refinement、终止性或合流义务。
