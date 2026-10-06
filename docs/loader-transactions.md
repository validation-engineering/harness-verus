# 官方 Loader 的显式事务接口

本轮提供一个可选的宿主接口，将原版 Loader 的创建、更新、删除与实际 Include 文件写入放进 native Cordis 的同一 mutation 队列。原版 Loader/Include 源码保持不变，仍使用其模块解析、YAML 表达式和 volatile 配置语义。

默认 native 启动脚本还会安装透明的官方配置协调：ConfigEditor.edit、Include.refresh 和 HMR 配置队列在文件锁与写入前进入同一域事务，并等待生命周期、写入及官方回滚。Settings 等调用 ConfigEditor 的界面自动使用这一边界。下面的显式接口仍适用于宿主拥有的普通 Loader/Include 条目。

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

完成写入队列表示官方文件操作已经返回，不是断电后的物理磁盘持久性证明。直接修改 options、使用无关文件 API 或绕过已接入入口的代码不在这个保证内。官方原地模块替换使用单独的依赖图与缓存恢复协议，与配置事务共用域队列。这个 API 也不认证任意 EntryTree 子类或不同版本的官方私有字段合同。

## 验收

```sh
node --test --test-timeout=60000 tests/official/loader-transactions.test.mjs tests/official/config-transactions.test.mjs
npm run official:check
```

显式接口回归使用真实安装的官方 Loader/Include 和真实临时文件，覆盖：两个 Include 的 FIFO、异步 inverse 与文件写入屏障、关闭等待、文件失败后重试、实际模块 import、根树完整 ID 删除、YAML 表达式保存与新 Context 恢复、volatile 配置不 remount、生命周期重入拒绝、旧 owner 代次拒绝和清理失败时禁止后续修改。阻塞测试由可控 Promise 门触发，不依赖睡眠时长推断顺序。

默认核心测试另检查同步 capture 权限、同域与跨域接纳、方法形状、参数快照边界和类型声明；这些检查不能替代上述官方实现验收。最终[官方验收记录](official-validation-report.json)绑定安装制品、源码和执行日志，普通[应用验收](validation-report.json)继续覆盖真实 AgentLoop 离线 demo。

## 默认官方配置协调

`scripts/official-register.mjs` 先注册唯一 native facade，再加载真实官方 Loader、HMR 与 ConfigEditor 类，调用 `installOfficialTransactions()`，最后由官方 CLI 挂载应用。安装只增加宿主方法边界，不修改官方源码文件。独立 Include、app-boot 内嵌 Include 和打包入口的 `HostResolvedRootInclude` 都沿同一 EntryGroup 初始化路径接入。

ConfigEditor 保留官方的文件锁、配置合并、校验、写入、reconcile 与 rollback。即使没有 HMR 服务也先进行域接纳。HMR 的配置 watch 与手动 `runExclusive()` 共用这一顺序。关闭会等待已接纳请求；服务重启后，旧 ConfigEditor/HMR 对象返回 `STALE_OFFICIAL_SERVICE`。

`change(current, inherited)` 仍是同步配置回调，其观察者身份与协调器分离；插件 setup、cleanup、观察者或它们的异步后代不能借用当前事务的生命周期权限。`hmr.runExclusive(operation)` 是可信宿主发起的操作入口，不是执行不可信 JavaScript 的沙箱。

候选激活失败后，会等待官方回滚完成再拒绝。实际回滚写入失败也如实报告，不会假称恢复成功。清理失败时，后续修改在 options 和文件变化前拒绝，需显式恢复清理。直接操作 JavaScript 对象或任意文件 API 仍由调用者负责。

新配置回归使用真实官方 ConfigEditor/HMR/Timer、临时 profile 和实际文件锁，覆盖排队、关闭、异步刷新、回调权限、成功回滚、实际 rollback rename 失败、清理阻塞恢复和旧服务拒绝。完整实现合同见核心库的[官方配置事务设计](https://github.com/validation-engineering/cordis-verus/blob/main/docs/official-config-transactions.md)。

## 模块更新与后续工作

官方 `Hmr.partialReload()` 已由 native 宿主适配器接入原地模块替换：按已观察的 ESM/CJS 依赖闭包排空旧实例，确认清理后更新缓存和 factory，失败时先清理候选再恢复旧缓存与插件。未确认清理会保留恢复记录；修复并显式重试失败 inverse 后，下次正常 reload 先继续恢复。使用方式、错误与模块边界见[原地 HMR 指南](https://github.com/validation-engineering/cordis-verus/blob/main/docs/official-in-place-hmr.md)。应用 native addon 与无法安全原地替换的宿主模块继续使用隔离路径。`npm run official:watch` 通过 ProcessDomain 运行真实官方 Web/standard，详见[进程监督模式](process-supervisor.md)。

后续继续扩大动态 typed Rust 能力的应用集成和长期运行的资源/历史成本测量。稳定 identity 与 publication 历史不能直接按“活资源泄漏”处理，回收设计需要保持旧 handle 失效保证。跨平台制品、完整发布负控和宿主到论文的 refinement 仍按独立门槛推进。
