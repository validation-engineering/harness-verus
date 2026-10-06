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

## 官方默认应用与配置面板

完成上述构建后，可以直接运行官方 Web/standard 或 headless 组合：

```sh
npm run official:rust -- web --no-open
npm run official:rust -- headless --help
# 开发模式：后台编译 Rust，成功后在同一官方 Web 进程更新
npm run official:rust:watch -- --port 3080 --no-open
```

首次启动在独立的 `DSH_HOME`（默认 `.cordis-harness/official-native`）创建 Web/headless profiles，增加 `rust-module` 与 `rust-dynamic-tool` 两个官方 Loader 条目。再次启动保留已有配置及注释。模型仍需用户配置；启动与编译不会代替用户发送模型请求。watch 入口目前运行 Web profile；普通入口保留官方 CLI 参数。

`cordis:rust-module` 是本项目 preload 注册的 Loader builtin，支持官方配置面板的 schema、禁用/启用及配置更新。配置包含 `path`、`sha256` 和 `plugins: [{ id, factory, config? }]`。不同 Loader 条目分别固定模块身份，子工厂由它们的普通 Fiber 拥有；内部不创建第二个 Driver，也不在 setup 中调用外部 Controller。空 `plugins` 表示不挂载工厂。制品摘要、ABI 和工厂名称在旧代次退休前验证；构造器仍属于可信原生代码执行。

构建输出现在同时发布不可变制品：库放在 `.cache/rust-modules/published/images/<sha256>.<ext>`，配置 manifest 放在 `published/<sha256>.json`。普通构建输出可以覆盖，旧配置引用的内容地址文件保留用于回滚。清单含平台、ABI、库摘要和工厂配置；它验证字节身份，不认证发布者。不要在运行期间删除旧制品。

自己的独立插件可通过 `publishNativeModule({ libraryPath, directory, plugins })` 发布，`readNativeModule(manifestPath, { sha256 })` 复核后得到可放入官方条目的 `config`。API 位于 `src/native-module-artifacts.mjs`，不要求使用示例工厂名称或本项目构建脚本。

宿主可以把实际业务消费者的就绪检查纳入同一次更新：

```js
import { updateOfficialRustModule } from './src/official-loader-api.mjs';
await updateOfficialRustModule(ctx, 'include:rust-module', manifestPath, {
  sha256: manifestSha256,
  readyEntries: ['include:rust-dynamic-tool'],
});
```

该操作通过真实 ConfigEditor 写入 profile patch，与 Loader/HMR/关闭共享 FIFO。候选配置或选定消费者未激活时，尝试在同一事务内恢复旧配置并重新检查；失败带 `OFFICIAL_NATIVE_UPDATE_FAILED` 和 `details.restored`；同一 Loader 事务另有生命周期或持久化错误时，外层聚合错误保留这些字段，并通过 `cause`/`errors` 保留完整故障。清理或持久化失败必须真实报告，不能当作回滚成功。普通面板编辑沿官方 ConfigEditor 合同运行；只有显式列出的 `readyEntries` 才属于上述应用就绪检查，不承诺任意外部消费者或 I/O 的原子回滚。

开发 watcher 使用异步子进程编译，不阻塞 Node 事件循环。构建和应用各自串行；源码在构建期间变化会淘汰候选并重建；失败不提交候选。`watchOfficialRustModule` 允许自定义构建 argv、源码目录及经过验证的 manifest reader。命令由可信宿主代码指定，不从插件配置执行 shell。关闭时先停止准入并排空构建/已开始的应用，再关闭官方 profile。当前没有构建超时或强制成功清理语义。

## Rust 调用同图 JS 服务

独立动态库现在还导出可选工厂 `harness.dynamic-policy-text-analysis`。它声明依赖普通 JS 服务 `textPolicy`，发布 `rustPolicyText.analyze(text)`：Rust 先调用 JS 的 `normalize`，验证返回数据，再计算文本指标；结果新增 `policyRevision`。原来的 `harness.dynamic-text-analysis` 与默认工具输出保持不变。

```rust
// descriptor.inject = vec!["textPolicy".into()]
let normalized = ctx.call("textPolicy", "normalize", json!([text])).await?;
```

`PluginContext::call` 接受服务名、方法名和 JSON 参数数组。这里只传有界 JSON；JS 对象、函数和 Rust trait 不跨动态库。依赖按普通 Cordis 生命周期管理，JS provider 更新会退休并重新激活依赖它的 Rust 实例。Rust cleanup 仍可以调用该次激活已经使用的旧 JS provider，随后才执行 provider 的清理。

现成的[JS policy provider](../examples/official/text-policy.mjs)支持 `revision`、`prefix` 与 `uppercase` 配置；[工具桥](../examples/official/rust-policy-text-analysis.mjs)注册 `rust_policy_text_analyze`。下面的命令校验现有构建、发布不可变工厂配置，并输出三个可以加入官方 profile 的条目：

```sh
node examples/official/native-policy-profile.mjs
```

将输出的 `insert` 条目合并到专用 `DSH_HOME/profiles/web/cordis.patch.yml` 或 `headless/cordis.patch.yml`，保留原有 `rust-module` 和 `rust-dynamic-tool` 条目，再用 `npm run official:rust -- web --no-open` 启动。需要先完成 `rust:modules:build`。三个新增条目是 JS provider、`cordis:rust-module` policy 工厂和官方工具桥；原生条目包含 `inject: ["textPolicy"]`，可在默认配置面板修改 JS policy 并观察工具的新 `policyRevision`，不必重编译 Rust。

原生 Loader 外层条目必须同时声明外部依赖，例如 `{ name: "cordis:rust-module", inject: ["textPolicy"], config: ... }`。官方 Loader 会等待该服务就绪后才运行外层 setup；内部 factory 的 `descriptor.inject` 仍负责实际反向调用权限。外层只声明组外服务；不要把同组其他 factory 才会提供的服务并入外层 `inject`，否则父节点会等待尚未创建的子节点。两层声明各有作用，不能依赖条目的排列或文件导入速度。当前包装器要求它创建的子工厂全部 Active；不把缺少外层依赖声明后产生的 Pending child 当作成功激活。工具取消会关闭结果接纳，已进入 JS 的 Promise 仍须实际落地。JS 反向调用不会自动收到 AbortSignal；需要调用者和服务协议自行协作。Provider 更新及关闭都会等待该 Promise，再完成 Rust cleanup 和 JS provider cleanup，不能把发送取消当作清理完成。

`tests/official/native-reverse-services.test.mjs` 使用真实官方 Loader、ConfigEditor 和 ToolRuntime 验证上述依赖更新、旧句柄拒绝、在途取消、关闭顺序和零 native 资源。它不发送模型请求。

## 独立 Rust 流与状态对象

同一个动态库还提供可选工厂 `harness.dynamic-text-resources`，发布 `rustTextResources`：

- `chunks(text, chunkCharacters)` 返回 JS `AsyncIterator`，每次 `next()` 才由 Rust 生成一块，不预取。每块是 `{ text, offsetBytes, revision }`；边界按 Unicode scalar value 划分，不拆 UTF-8 字符，但不保证字素簇完整。输入上限 128 KiB，块大小为 1–4096 个字符。
- `session()` 返回 owned 对象句柄，具有 `call('append', text)`、`call('snapshot')` 和 `close()`。每个会话单独保存累计指标，跨块单词与 CRLF 的统计与原始文本分析一致。追加只处理新字符，不保存先前文本；累计输入同样限制为 128 KiB。

```js
// 此段位于声明 inject: ['rustTextResources'] 的 JS consumer 内。
const stream = ctx.rustTextResources.chunks('Hello 世界\r\nRust 🦀', 4);
const session = ctx.rustTextResources.session();
try {
  for await (const chunk of stream) await session.call('append', chunk.text);
  console.log(await session.call('snapshot'));
} finally {
  // 两者都发起关闭，再等待真实完成；生产桥也会传播清理失败。
  const outcomes = await Promise.allSettled([stream.return(), session.close()]);
  const errors = outcomes.filter(item => item.status === 'rejected').map(item => item.reason);
  if (errors.length) throw new AggregateError(errors, 'Text resource cleanup failed');
}
```

[官方资源工具桥](../examples/official/rust-resource-text-analysis.mjs)注册 `rust_resource_text_analyze`，参数为 `text` 和可选 `chunkCharacters`（默认 1024），通过实际流和对象组合返回原有文本统计加 `chunks`。结果是完整工具响应；这里不声称官方聊天 UI 会逐块渲染文本。每次工具调用拥有独立会话，可以并发使用。取消会请求 `return()` / `close()`，工具清理仍等待已经开始的工作完成。

运行下面的命令生成三个附加的官方 Loader 条目，按前一节的方法合并进 Web/headless profile：

```sh
node examples/official/native-resource-profile.mjs
```

它装载 [JS audit provider](../examples/official/text-resource-audit.mjs)、原生资源工厂和工具桥，保留已有默认工具。外层 native 条目的 `inject: ["textResourceAudit"]` 只声明组外依赖。审计服务保存最近 64 条生命周期/大小记录和累计条数，不记录用户文本；可通过 `textResourceAudit.snapshot()` 读取。可信宿主可给 `createTextResourceAudit` 注入异步 sink；持久化配置仅包含可编辑的 `label`，不含函数。

流游标、对象、Future 和 `Arc` 始终属于定义它们的 Rust 库；JS 只得到显式 opaque 句柄与有界 JSON。流一次只接受一个 pull；对象方法可以并发进入，示例对累计状态使用短时 Mutex，顺序敏感的调用应由 consumer 逐一 `await`。拥有者或 provider 退休会停止新请求，等待已开始的方法和其反向 JS 调用，然后运行资源 close、Rust cleanup。已发出的 JS Promise 必须实际落地；关闭失败不会伪装成释放成功，可以对原句柄重试 close。换代不会将旧对象状态迁移至新库，旧句柄不能调用新代次。

`tests/official/native-resources.test.mjs` 覆盖生成的真实 fileURL recipes、官方 ToolRuntime 输出、Unicode/空输入/尺寸边界、pull 背压、对象隔离、提前结束、在途取消、动态库换代、整图关闭、清理失败重试及最终资源计数。测试不调用付费模型；本轮执行结果应以完整官方验证记录为准。

## 独立 Rust 消费 JS 流和对象

另一组可选条目使用 `harness.dynamic-js-text-pipeline` 工厂，方向与上一节相反：JS provider 提供按需文本流、owned 统计会话和 borrowed policy 对象；Rust 在一次 `analyze` action 内打开这些能力，逐块调用 JS 会话的 `append`，校验偏移、大小与最终统计，再返回结果。它仍只使用原来的 Context / Driver，不会创建另一个 JS 调度器。

```rust
let policy = ctx.open_object("textPipeline", "policy", json!([])).await?;
let metadata = policy.call("snapshot", json!([])).await?;
policy.close().await?; // borrowed：释放本次借用，不销毁 provider 的对象

let stream = ctx.open_stream("textPipeline", "chunks", json!([text, 1024])).await?;
let session = ctx.open_object("textPipeline", "session", json!([])).await?;
while let Some(chunk) = stream.next().await? {
    session.call("append", json!([chunk["text"]])).await?;
}
let result = session.call("snapshot", json!([])).await?;
session.close().await?; // owned：等待 JS disposer 完成
stream.close().await?;
```

这段说明 API 形状；[完整 Rust 示例](../native/dynamic-text-analysis/src/reverse_resources.rs)还校验 descriptor ownership、输入/块上限、偏移及返回值，并在 body 失败时尝试两种 close，保留实际清理错误。所有参数为 JSON 数组。`JsStream` / `JsObject` 仅在创建它们的 action 中有效；克隆句柄不会延长 action 生命周期，不可把它们保存到下一次工具调用。

[JS provider](../examples/official/text-pipeline.mjs)通过带 `next()` / `return()` 的异步迭代器提供流，通过 `adaptObject` 显式声明对象方法、owned/borrowed 与 disposer。每次 `session()` 创建独立 sink；sink 只保留指标与词/行边界状态，不存历史文本。流只保留原始输入的游标和当前有界块；Rust 不收集所有块。输入和累计 sink 上限均为 128 KiB，每块 1–4096 个 Unicode scalar values。最近 64 条审计事件只记录生命周期和大小，不包含正文。`textPipeline.inspect()` 提供当前 stream/session 数量及审计摘要。

```sh
node examples/official/native-js-pipeline-profile.mjs
```

将输出的 `insert` 条目合并到已初始化的 Web/headless profile，再用 `npm run official:rust -- web --no-open` 启动。需先完成本指南开头的构建与官方安装。生成器给出 JS provider、声明外部 `inject: ["textPipeline"]` 的原生工厂和[官方工具桥](../examples/official/rust-js-text-pipeline.mjs)三个 fileURL/builtin 条目，保留既有工具。工具名为 `rust_js_text_analyze`，参数是 `text` 与可选 `chunkCharacters`（默认 1024）；输出包含文本指标、`backend: "rust-js-resources"`、Rust `revision`、JS `providerRevision` 和 `chunks`。配置面板编辑 JS provider 的 `revision` 会重新激活依赖它的 Rust 实例，无需重编译。

普通工具的用户取消关闭结果接纳，并继续等待真实 Rust action 及已调用的 JS 工作完成；它不会自动把 AbortSignal 传给 JS，也不承诺立即停止所有后续 pull。Provider 更新和整图关闭会触发框架对退休 Rust action 的合作取消，同样必须等在途 JS Promise 实际落地，然后关闭资源、Rust 实例与旧 JS provider。

Action journal 自动关闭尚未释放的流/对象，包括提前返回或丢弃 awaiter 的情况。已经报告的显式 close 失败不会在 action 结束时悄悄转成成功：资源保留、工具报错；可在同一 action 内显式重试，或让后续生命周期 cleanup 重试。失败的 disposer 需要保留可重试状态。Borrowed 对象的实际生命周期仍由 provider 拥有，释放借用不运行 owned disposer。动态库/JS provider 换代不迁移旧对象的状态。

`tests/official/native-reverse-resources.test.mjs` 使用真实官方 Loader、ConfigEditor 和 ToolRuntime 验证生成的 profile、双向语言所有权、并发会话隔离、provider 更新、取消的实际排空、关闭顺序、失败 close 保留/重试，以及 JS adapter 表与 native 资源最终为零。验证不发送模型请求，执行结论以本轮官方记录为准。

## 动态发布 Rust 工作插件与官方工具

可选工厂 `harness.dynamic-text-fleet` 发布管理服务 `rustTextFleet`。调用 `create("notes")` 时，Rust 在原来的动态库内创建工厂，通过 `ctx.publish(factory, config).await` 向真实宿主图申请一个拥有独立生命周期的 provider child；该节点提供 `rustFleet_notes.analyze(text)`。工厂每次激活都创建新实例，不把 trait object 或 `Arc` 传给 JS。

[官方工具桥](../examples/official/rust-text-fleet.mjs)随后用同一个 Context 的 `ctx.plugin` 创建独立 consumer，声明 `inject: ["tools", "rustFleet_notes"]`，注册 `rust_text_notes_analyze`。因此一个 worker 对应一个 Rust provider 节点和一个 JS 工具 consumer 节点；没有另一个 runtime，也没有用 JS 服务字典代替 Cordis 的依赖解析。管理工具本身仅依赖 `tools` 和 `rustTextFleet`，不会持有自己要删除的 worker 服务。

```sh
# 先完成本指南开头的构建、官方安装与 rust:modules:build
node examples/official/native-fleet-profile.mjs
```

把输出的 `insert` 条目合并进已初始化的 Web/headless profile，再运行 `npm run official:rust -- web --no-open`。生成器加入 [audit provider](../examples/official/text-fleet-audit.mjs)、声明外部 `inject: ["textFleetAudit"]` 的 native manager 和官方工具桥；默认业务组合保持可用。桥的 `workers` 配置默认是 `["notes", "code"]`，只用于首次连接一个尚未初始化目录的 manager。已初始化或已恢复的目录（包括空目录）不会因桥的配置更新或 HMR 而重新播种；运行中用 create/remove 工具改变名称。首次 worker 在 JS 桥的 setup 中创建，此时 native manager 已经 Active。恢复时 Rust manager 的 setup 只等待 publication 分配，不等待依赖自身私有 anchor 的 child 就绪；桥随后等待真实 worker Active，再挂接 consumer。

工具及参数如下：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `rust_text_worker_create` | `{ "worker": "review" }` | 发布 Rust worker，等待初始化并挂载工具 consumer，返回真实节点状态和工具名。 |
| `rust_text_review_analyze` | `{ "text": "Hello 世界" }` | 调用该 worker 的实际服务，返回 bytes、characters、words、lines、worker 和 Rust revision。 |
| `rust_text_worker_list` | `{}` | 返回 native ChildHandle 的实际状态及对应 consumer 节点 ID。 |
| `rust_text_worker_remove` | `{ "worker": "review" }` | 先排空并移除工具 consumer，再请求 Rust child 退休并等待实际 Removed。 |

名称必须匹配 `[a-z][a-z0-9_]{0,31}`，同时最多保留 16 个 worker（包括失败后等待清理的条目），文本上限为 128 KiB UTF-8。SDK 另有每次实例激活的累计 child/definition 预算，删除 worker 不等于重置该预算。分析调用可以并发；创建/删除工具串行执行。用户取消关闭结果接纳，并等待已经开始的工作；管理操作已经成功改变图时，不因调用者取消而假装回滚，可以通过 list 查看实际结果。

[完整 Rust manager](../native/dynamic-text-analysis/src/fleet.rs)保存 `ChildHandle`，以当前 action 的 `&ctx` 调用 `status`、`initialized`、`dispose`、`join` 和 `retry_cleanup`。这类句柄属于 manager 的一次激活，可以跨该实例的多个 action；它不同于上一节只在单 action 有效的 JS 资源句柄。`dispose` 只确认退休请求，`join` 才等待实际图删除。失败创建保留已分配的句柄；失败清理保留 child 和 consumer 记录，工具报告错误，再次 remove 会显式重试 cleanup。只有实际 Removed 后才删除记录。JS Map 仅保存真实 consumer Fiber 和状态，Rust Map 仅保存真实 ChildHandle；业务调用仍通过 Context 注入服务。

默认未启用迁移时，更新 native 库或外部 audit provider 会先排空旧工具、worker、manager，再按配置创建初始 worker。动态名称不会自动写入 profile。仅替换 JS 工具桥时，桥排空并移除自己的 consumer，再连接仍由 Rust manager 拥有的 worker；它不会调用业务 remove 或删除名称目录。Native 换代后的 worker 是新节点，旧服务句柄失效。审计保存最近 64 条生命周期和大小记录，不保存正文；`textFleetAudit.snapshot()` 可读取摘要。

`tests/official/native-publications.test.mjs` 通过真实官方 Loader、ConfigEditor 和 ToolRuntime 覆盖生成 profile、真实父子节点、按需工具创建/调用/撤销、原地 native 更新与候选恢复、JS provider 更新、在途调用排空、清理失败重试以及整图关闭后的零资源。执行结论以本轮完整官方验证记录为准，不包含付费模型请求。

## 显式迁移 worker 名称目录

```sh
# 同样先完成基础构建、官方安装与 rust:modules:build
node examples/official/native-fleet-profile.mjs --migrate
```

将生成的 `insert` 条目合并进 profile，使用前述官方启动命令。这个选项只给 manager 的原生 recipe 添加 `state: "migrate"`；不带选项仍是冷启动语义。配置面板也显示此选项。已声明 checkpoint schema 的工厂才能使用它，不能替任意 Rust 内存开启自动迁移。

Fleet 的同步 `checkpoint()` 导出 `{ "workers": ["notes", "review"] }`，schema 为 `cordis-harness/text-fleet`。v1 写出版本 1；v2 写出版本 2，并接受版本 1 和 2。`restore()` 在 setup 前校验整个 DTO 的 schema、版本、名称唯一性与 16 个 worker 上限；不支持的版本会失败，不会静默丢弃状态。DTO 只包含 manager 明确拥有的逻辑目录，不包含 ChildHandle、节点 ID、子插件的 Rust 内存、JS consumer、流或对象句柄。

实际 ConfigEditor 更新先停止旧代次接纳工作，排空调用、consumer、资源与原生子插件，随后捕获 manager 的目录。新实例 restore 后重发布 worker，桥重建独立 consumer，工具恢复相同名称与新的代码。用户 remove 成功才从目录删除名称；框架因 HMR 或依赖更新执行 cleanup 不等于用户删除。恢复后的空目录保持为空，`workers` 配置不会补回已经删除的默认名称。仅桥的 HMR 保留现存 native worker 的节点身份，但仍排空并替换实际工具 consumer。

`updateOfficialRustModule()` 和构建 watcher 在真实 `officialTransaction` 内固定原代 checkpoint 来源，直到原生条目及 `readyEntries` 中的消费者全部就绪才显式提交。候选 setup 或必要消费者失败时，尝试恢复旧代码、旧配置与原始目录；恢复也必须通过全部就绪检查才能提交并报告 `details.restored: true`。如果恢复后的原生条目 Active，但必要消费者再次拒绝，结果仍是 `restored: false`，原始 checkpoint 保留供修复后下一次更新使用。候选和未验收恢复实例添加的名称都不能替换原始来源；事务 `release()` 本身不代表验收成功。直接通过官方 ConfigEditor 更新原生条目同样启用其原生生命周期的捕获/恢复；需要将其他消费者纳入成功条件时，使用协调器的 `readyEntries`。

Checkpoint 只在当前进程内保存，既不写入 YAML，也不提供跨进程持久化或任意外部 I/O 回滚。插件的 checkpoint/restore 是同步逻辑转换，不执行异步工作、图变更或服务调用；资源句柄先真实清理，不能序列化并带到新实例。SDK 与宿主检查有界 JSON、声明的版本及生命周期，插件仍负责其 DTO 的业务含义。

`tests/official/native-migration.test.mjs` 覆盖真实生成 profile、普通 ConfigEditor 更新、候选失败、修改候选目录后消费者拒绝的恢复、恢复消费者再次拒绝后的原始来源保留与重试、在途调用排空、空目录、桥单独文件 HMR，以及 watcher 的同一 apply 路径。测试通过真实 ToolRuntime 调用重建后的工具，并检查节点身份、同 PID/Driver 和关闭后的资源归零；执行结果以本轮官方记录为准。

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

这是低层应用宿主操作。不要在插件 setup、cleanup 或事件回调里获取 reload 权限；同域 FIFO 会把它与其他修改和关闭操作排序。原有 Demo 在 AgentLoop 回合之间更新。官方 Loader 集成使用上面的普通插件入口，独立 Controller API 仍可用于自定义宿主；两者各自拥有自己的插件组。

候选装载和 descriptor 校验先进行。实际旧任务、consumer inverse 与 Rust cleanup 都成功后才运行候选 setup。清理失败保留资源并阻止替换；修复外部原因后调用 `retryCleanup()`，随后普通 `reload()` 继续。候选失败且清理成功时，按旧代码和配置创建新的旧版本实例。恢复不等于复原任意外部 I/O 或旧内存对象。第一次加载失败时，错误的 `controller` 字段保留清理入口。

## 首版边界

- C ABI 只传有界 JSON 字节、opaque 整数 ID 和显式 wake callback。Rust trait、`Arc`、Future、`TypeId` 不跨库。
- 支持 sync/async JSON 服务、异步 setup/cleanup、唤醒、合作取消、声明依赖的异步反向 JS JSON 调用、Rust-owned 流和对象，以及单 action 内反向消费 JS 流/显式对象。同库命名子插件与运行时工厂 publication 通过真实宿主 child 管理；静态 typed adapter 的任意 `Arc<T>` / `TypeId` 不跨 ABI。
- 旧代码映像保留至进程退出。一个常驻 addon 的共享预算最多容纳 128 次独立映像装载，多个独立 addon 不共用该预算；失败 descriptor 在成功装载后也可能占用映像。诊断显示资源与常驻数量，不代表 RSS 上限。
- 改动 Rust 源码仍须编译新动态库。已提供官方 Web 构建监视器及显式逻辑 checkpoint 迁移；不支持任意内存快照或物理卸载，不能热替换常驻内核/Node binding。
- 原生插件是可信代码。动态加载可能执行构造器；panic abort、越界行为、无限 Future、后台线程和动态依赖均不受 C ABI 隔离保护。需要故障隔离时采用独立进程。

本轮证据来自 macOS ARM64 / Node 22.22.0 的本地执行。FFI、OS loader 和任意插件回调未因此获得 Verus 证明；其他平台仍需独立执行验收。完整 ABI 与恢复合同见[核心原生模块指南](https://github.com/validation-engineering/cordis-verus/blob/main/docs/native-rust-modules.md)。
