# 官方 Loader 的显式事务接口

本轮提供一个可选的宿主接口，将原版 Loader 的创建、更新、删除与实际 Include 文件写入放进 native Cordis 的同一 mutation 队列。原版 Loader/Include 源码保持不变，仍使用其模块解析、YAML 表达式和 volatile 配置语义。

这一步补齐的是可调用、可验收的事务边界。默认 Settings、PluginManager 和 ConfigEditor 继续运行原来的调用链；它们不会因为存在这个导出就自动取得整条文件事务保证。

## 使用

先按[构建指南](build.md)准备匹配的核心制品并运行 `npm run official:install -- --offline`。使用正在运行的官方 native Context 和宿主拥有的 Include 文件：

```js
import { LoaderTransactions } from '@cordis-harness/app/official-loader-api';

// ctx 是已启动的官方应用 Context；custom 是本宿主拥有的 Include 条目。
const tree = ctx.loader.resolve('custom').subtree;
const edits = new LoaderTransactions(ctx, tree);
await edits.update('greeting', { config: { prefix: 'Welcome' } });
const id = await edits.create({ name: './my-plugin.mjs', config: {} });

// create 保留官方返回的完整 ID；从 root Loader 解析或删除。
const rootEdits = new LoaderTransactions(ctx, ctx.loader);
await rootEdits.remove(id);
await edits.close();
```

本仓库脚本也可从 `src/official-loader-api.mjs` 导入；该入口指向官方安装目录中的同一 facade，避免与精简 CLI 的 runtime 实例混用。单独使用核心包时，导入 `@cordis-verus/compat-loader/harness`。

从外部宿主操作调用这些方法，不要在插件 setup、cleanup 或当前 mutation 中等待新的全局事务。插件初始化期间创建和等待自己的 child 仍使用 `ctx.plugin()`。参数在接纳请求时做 structured clone；函数等不可克隆值在接纳前拒绝。Include 被移除或重启后，旧对象返回 `STALE_LOADER`，应为新 subtree 创建新适配器。

## 保证与失败

- 每个请求在修改 options 和文件之前进入同域 FIFO。多个事务对象、其他已接入的 Loader/Fiber revision 和 Context 关闭共用该队列。
- 等待旧/新 Fiber、官方 Loader 任务和实际 Include 写队列。当前采用整条 Loader 图的保守屏障，兄弟 Include 的待处理写入和失败也会影响完成。
- 关闭 Context 会等待已接纳的写入；关闭开始后，新 revision 在修改前拒绝。`edits.close()` 只停止该对象的新请求并等待屏障，不卸载整个应用。
- `OFFICIAL_PERSISTENCE_FAILED` 明确报告文件写入失败及原因。内存配置或插件效果可能已改变，不声称回滚；后续显式修改可以重试官方写队列。
- 清理失败保持阻塞，只有实际清理恢复后才接受新 revision。原本缺少依赖的 Pending 状态仍遵循官方语义；请求完成不表示所有插件都 Active。

完成写入队列表示官方文件操作已经返回，不是断电后的物理磁盘持久性证明。直接绕过接口修改同一 tree、`Include.refresh()`、ConfigEditor 的外层文件锁/写入/回滚、HMR 队列以及模块缓存尚未统一接入。这个 API 也不认证任意 EntryTree 子类或不同版本的官方私有字段合同。

## 验收

```sh
node --test --test-timeout=60000 tests/official/loader-transactions.test.mjs
npm run official:check
```

10 项回归使用真实安装的官方 Loader/Include 和真实临时文件，覆盖：两个 Include 的 FIFO、异步 inverse 与文件写入屏障、关闭等待、文件失败后重试、实际模块 import、根树完整 ID 删除、YAML 表达式保存与新 Context 恢复、volatile 配置不 remount、生命周期重入拒绝、旧 owner 代次拒绝和清理失败时禁止后续修改。阻塞测试由可控 Promise 门触发，不依赖睡眠时长推断顺序。

默认核心测试另检查同步 capture 权限、同域与跨域接纳、方法形状、参数快照边界和类型声明；这些检查不能替代上述官方实现验收。最终[官方验收记录](official-validation-report.json)绑定安装制品、源码和执行日志，普通[应用验收](validation-report.json)继续覆盖真实 AgentLoop 离线 demo。

## 长期方案下一步

优先把 ConfigEditor 的外层持久化与恢复、Include.refresh 和 HMR 的异步续程接到同一个接纳边界，避免把权限自动传播给任意插件回调。随后扩大模块依赖图更新、动态 typed Rust 能力和长期运行的资源/历史成本测量。稳定 identity 与 publication 历史尚不能按“活资源泄漏”处理，回收设计需要保持旧 handle 失效保证。跨平台制品、完整发布负控和宿主到论文的 refinement 仍按独立门槛推进。
