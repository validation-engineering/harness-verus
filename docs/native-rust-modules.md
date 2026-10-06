# Rust 插件的同进程代码更新

独立 Rust 插件现在可以编译为 `cdylib`，通过 `cordis-plugin-api` 的 C ABI v1 加入常驻 Node Driver。应用保持一个 Context；替换插件时排空旧实例，再激活新代码。无需重新链接宿主 `.node`，也无需退出当前 Node 进程。

本项目提供真实文本分析插件的 v1、v2 和启动失败版。它们只依赖插件 SDK 与 JSON 库，不链接 Cordis Driver。JS 工具桥声明 `tools` 与 `rustDynamicText` 依赖，因此 provider 更新会让旧工具先退出，再按新服务重建。插件源码见 [native/dynamic-text-analysis](../native/dynamic-text-analysis)，精简组合桥见 [plugins/dynamic-text-analysis.mjs](../plugins/dynamic-text-analysis.mjs)，官方工具 API 桥见 [examples/official/rust-dynamic-text-analysis.mjs](../examples/official/rust-dynamic-text-analysis.mjs)。

## 构建与运行

先按 [构建指南](build.md) 准备锁定版本的 sibling `cordis-verus`、运行时制品和官方安装，再执行：

```sh
npm run build
npm run official:install -- --offline
npm run rust:modules:build -- --offline
npm run rust:modules:verify
npm run rust:modules:demo
npm run rust:modules:test
```

构建脚本使用核心锁定的 Rust 工具链，从 Cargo 实际报告取得三版动态库路径，核对优化、断言与溢出检查；还记录插件源码、SDK/core 来源和制品 SHA-256。验证会检查安装后的 Cordis、Harness facade 与模块控制器字节。`--offline` 要求 Cargo/npm 依赖已缓存。

Demo 在同一个应用进程中执行三次真实官方 AgentLoop：v1 工具调用、切换 v2 后调用、失败候选被清理并恢复 v2 后调用。只有模型 transport 是 scripted provider，不理解任意自然语言，也不会调用付费模型。输出包含 PID、代码 revision、工具结果、持久会话、映像诊断与关闭后的 native 插件数量。

`rust:modules:test` 还通过安装后的官方 ToolRuntime 执行工具，并验证旧工具注销及来源/字节漂移拒绝。它是 opt-in 测试，普通 `npm test` 仍只要求基础精简运行时。完整 `npm run official:check` 同时运行这些测试，需要先完成 `rust:build` 和 `rust:modules:build`。

## 宿主 API

```js
import { loadRustModule } from '@cordis-verus/compat-loader/rust-module';

const module = await loadRustModule(ctx, {
  path: '/absolute/path/plugin-v1.dylib',
  sha256: expectedSha256,
  plugins: [{ id: 'analysis', factory: 'harness.dynamic-text-analysis' }],
});
// JS consumer 可经 ctx.inject 声明 rustDynamicText；宿主在业务空闲时换代。
await module.reload({ path: nextLibrary, sha256: nextSha256 });
console.log(module.inspect());
await module.dispose();
```

这是应用宿主的操作。不要在插件 setup、cleanup 或事件回调里获取 reload 权限；同域 FIFO 会把它与其他修改和关闭操作排序。Demo 在 AgentLoop 回合之间更新。控制器管理自己的插件组，官方 Loader 仍管理 JS 工具桥；当前未把原生模块控制器加入默认 Web 插件面板或自动 watcher。

候选装载和 descriptor 校验先进行。实际旧任务、consumer inverse 与 Rust cleanup 都成功后才运行候选 setup。清理失败保留资源并阻止替换；修复外部原因后调用 `retryCleanup()`，随后普通 `reload()` 继续。候选失败且清理成功时，按旧代码和配置创建新的旧版本实例。恢复不等于复原任意外部 I/O 或旧内存对象。第一次加载失败时，错误的 `controller` 字段保留清理入口。

## 首版边界

- C ABI 只传有界 JSON 字节、opaque 整数 ID 和显式 wake callback。Rust trait、`Arc`、Future、`TypeId` 不跨库。
- 支持 sync/async JSON 服务、异步 setup/cleanup、唤醒、合作取消；完整 SDK 中的反向 JS、流/对象与 typed 子插件仍使用静态 addon 路径。
- 旧代码映像保留至进程退出。一个常驻 addon 的共享预算最多容纳 128 次独立映像装载，多个独立 addon 不共用该预算；失败 descriptor 在成功装载后也可能占用映像。诊断显示资源与常驻数量，不代表 RSS 上限。
- 改动 Rust 源码仍须编译新动态库。当前没有自动构建监视器、状态迁移或物理卸载；不能热替换常驻内核/Node binding。
- 原生插件是可信代码。动态加载可能执行构造器；panic abort、越界行为、无限 Future、后台线程和动态依赖均不受 C ABI 隔离保护。需要故障隔离时采用独立进程。

本轮证据来自 macOS ARM64 / Node 22.22.0 的本地执行。FFI、OS loader 和任意插件回调未因此获得 Verus 证明；其他平台仍需独立执行验收。完整 ABI 与恢复合同见[核心原生模块指南](https://github.com/Stool233/cordis-verus/blob/main/docs/native-rust-modules.md)。
