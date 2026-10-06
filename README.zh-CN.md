# Cordis Harness

**在具有 Verus 验证生命周期内核的 Rust 运行时上，组合官方 DeepSeek Harness 插件。**

[English](README.md) · [构建指南](docs/build.md) · [官方模式](docs/official-mode.md) · [插件指南](docs/plugins.md) · [参与贡献](CONTRIBUTING.md)

Cordis Harness 在 [cordis-verus](https://github.com/validation-engineering/cordis-verus) 上组合未改写的官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件与自有 JavaScript、Rust 插件，在真实 Agent 工作流中检验 Cordis 功能对齐：插件组合、工具执行、会话恢复、配置变更和清理。

核心运行时将形式化约束连接到可执行的生命周期代码，本项目提供应用集成证据。通过核心的[论文到代码审查指南](https://github.com/validation-engineering/cordis-verus/blob/main/docs/paper-review-guide.md)，可以检查已验证的合同及其宿主边界。两个项目均属于 [Validation Engineering](https://github.com/validation-engineering)。

**项目状态：** 实验性、尚未达到 1.0，未正式发布。已有本机验收记录覆盖 macOS ARM64 和 Node 22.22.0。运行时包是未发布的开发制品，精确输入记录在 [sources.lock.json](sources.lock.json) 中。目前两个仓库均需要访问权限。

## 功能

- **官方应用工作流。** 使用 Rust 原生 Node Cordis 宿主，运行官方 Web、headless 入口、默认 `standard` 组合、Loader/Include、前端和 JSONL 会话存储。浏览器端 Cordis 仍为上游 JavaScript 实现。
- **原版插件与自有扩展。** 使用官方 AgentLoop、AgentRegistry、SessionStore、SystemPrompt、ToolRuntime、SessionProjectionRegistry、Todo 和 DeepSeek API-key provider，并加入文件工具、请求限额和自有插件。
- **同一生命周期图中的 JavaScript 与 Rust。** 通过同一个 native Driver 注册 Rust 服务和工具，组合 JavaScript 插件。清理失败会明确报告，并保留显式恢复所需的资源。
- **配置与插件更新。** 使用支持范围内的官方配置事务、原地模块 HMR、可选的 Web 进程监督，或具有显式 checkpoint 迁移合同的独立 Rust `cdylib` 插件。
- **离线演示。** 使用确定性的 scripted provider 执行真实官方 agent/tool 循环，不请求模型 API。

## 快速开始

使用 Node **22.22.0**、npm 和 Git。准备运行时制品还需要核心项目锁定的 Rust/Verus 工具链；编译可选 Rust 扩展需要匹配的核心源码 checkout 和 Rust 工具链。

先按[构建指南](docs/build.md)准备已完成开发验收的 `../cordis-verus` 工作目录、其中的三个 npm 运行时包，以及锁定的官方 Harness 源码快照。目前尚无公开的运行时制品下载服务。

首次本机构建时，导入这些制品并显式刷新来源锁：

```sh
node scripts/bootstrap.mjs --cordis-source ../cordis-verus --refresh-lock --online
npm run build
npm run verify
npm run demo
```

已有公开 npm 依赖缓存时，用 `--offline` 替代 `--online`。复用锁中已记录的精确制品时，省略 `--refresh-lock`。刷新制品后应审查锁文件差异并重新验收。源码指纹与制品哈希用于识别精确输入；只有 `workingTreeDirty` 为 `false` 时，才能仅凭 `baseCommit` 恢复源码。运行应用不需要相邻的核心 checkout。

演示使用 scripted provider，执行**真实官方 AgentLoop 和工具循环**。它在 `.cordis-harness/demos/` 下建立工作区，读取 README、生成 `DEMO_RESULT.md`、完成 Todo 并持久化会话。终端返回工作区和 session ID。这是确定性演示，不理解任意自然语言任务。

## 官方 Web 与 headless 模式

完成基础准备后，安装官方发行包并启动默认 Web 模式：

```sh
npm run official:install -- --refresh-runtime-lock
npm run official
# 等价：npm run official -- web
```

有意更新运行时制品后，`--refresh-runtime-lock` 会更新本地运行时包对应的锁条目。条目已经匹配时，使用 `npm run official:install`；所有依赖均已缓存时，可以添加 `-- --offline`。官方源码版本保持锁定。

默认 Web 端口为 3080，官方 CLI 会打开浏览器。服务器参数原样转发：

```sh
npm run official -- web --no-open --port 3080
npm run official -- headless --json "Read this project and explain its purpose"
```

交互使用需要在官方应用中配置模型账号或 API key。默认数据目录为 `.cordis-harness/official`，可通过 `DSH_HOME` 指定其他位置。固定发行包保持原始布局；启动时核对安装制品，并阻止 Node 宿主加载上游 JavaScript Cordis 调度器。

[官方模式指南](docs/official-mode.md)介绍默认插件清单、native Context、工具与跨进程会话恢复。相应检查验证固定版本和已测试流程的宿主替换，不代表所有第三方插件兼容，也不是整个应用的形式化证明。

## JavaScript 与 Rust 扩展

扩展入口保留官方默认组合，加入 `cordis_greet` 和 `rust_text_analyze`。Rust 工具通过同一个 native Driver 提供服务，JavaScript 桥使用官方工具 API 注册它。

完成基础准备和官方安装后：

```sh
npm run rust:build -- --offline
npm run official:extensions
npm run official:extensions -- headless --json "Count the characters and bytes in Hello world"
```

Cargo 依赖尚未缓存时，构建命令去掉 `--offline`。首次启动在 `.cordis-harness/official-extensions` 下创建官方 Web/headless profile，已有 profile 文件保留不覆盖。官方插件面板可以禁用、启用扩展，Settings 可以修改问候前缀。交互使用需要配置模型；自动验收使用本机模型 fixture。示例和范围见[扩展指南](docs/official-extensions.md)。

## 配置与重载

默认 UI 的 ConfigEditor、Include 刷新和 HMR 配置队列共用 native 域事务队列，在文件锁和写入前进行接纳，并等待生命周期工作、持久化及官方回滚完成。宿主也可以通过[官方 Loader 事务接口](docs/loader-transactions.md)显式创建、更新和删除条目。

支持范围内的官方原地模块 HMR 会在旧插件清理后替换模块，并保留候选版本恢复的结果。native addon 变更或无法安全替换的共享宿主模块需要 Worker 或进程边界。实际官方 Web 应用另有可选的进程监督入口：

```sh
npm run official:watch
# 修改 examples/process-plugins/version.mjs，然后打开新进程输出的启动链接。
```

该模式保留默认 `standard` 组合与官方会话存储，确认旧进程清理后再启动已捕获的插件模块。坏候选清理成功后可以恢复旧制品；清理未确认则阻止替换。监督模式仅支持 Web，重启会断开客户端并轮换登录 token。详见[进程监督](docs/process-supervisor.md)。

## Rust 原生插件更新

独立构建的 `cdylib` 插件通过版本化 C ABI 加入常驻 Driver。演示在同一进程中使用官方 AgentLoop 完成 v1 → v2 替换及坏候选恢复，无需重新链接 Node addon。

完成基础准备和官方安装后：

```sh
npm run rust:modules:build -- --offline
npm run rust:modules:demo
npm run rust:modules:test
npm run official:rust -- web --no-open
npm run official:rust:watch -- --no-open
```

Cargo 依赖尚未缓存时，模块构建命令去掉 `--offline`。模块接口支持 JSON 服务、流、对象、动态子插件，以及显式启用的有界逻辑 checkpoint。每次代码更新需要重新构建动态库；旧库映像保留到进程退出。官方 Loader 条目会出现在配置面板中。Web watcher 在后台编译源码，通过 ConfigEditor 更新不可变制品配置，并检查工具消费者就绪。装载、迁移和来源规则见[原生 Rust 模块](docs/native-rust-modules.md)。

## 精简 CLI

精简组合提供用于自有插件编排的独立 CLI，使用 `harness.config.json`；前述官方模式使用各自的 profile 和存储。

完成基础准备后：

```sh
npm run demo
npm start -- plugins
npm test
```

### 使用模型 provider

在 shell 环境中设置 `DEEPSEEK_API_KEY`，不要把凭据写入配置文件或 Git。示例选择锁定官方源码中的 `deepseek-flash`；请确认自己的账户支持该模型。

```sh
npm start -- run "Read README and explain this project's purpose" --config examples/deepseek.config.json
npm start -- chat --config examples/deepseek.config.json
```

示例默认只读，显式添加 `--allow-write` 才启用文件写入工具。provider 使用官方 Messages SSE 适配器。本机 HTTP fixture 检查实际请求构造、工具循环和取消；验收不请求付费 API。详见 [provider 指南](docs/providers.md)。

### 保存与恢复会话

```sh
npm start -- run "Read README" --config examples/deepseek.config.json --session work-1
npm start -- run "Continue the analysis" --config examples/deepseek.config.json --session work-1 --resume
npm start -- sessions --config examples/deepseek.config.json
npm start -- inspect work-1 --config examples/deepseek.config.json
```

精简 CLI 的 `FileSessions` 实现官方 `SessionPersistence` 接口，通过 `agents.resume` 恢复。快照保留原始事件和序号，回合结束及正常退出都会等待持久化。存储采用有大小上限的原子 JSON 快照，不实现官方 JSONL 迁移、自动清理遗留锁或分布式租约恢复。官方模式仍使用上游 JSONL 存储。详见[架构与边界](docs/architecture.md)。

### 组合自己的插件

在 `harness.config.json` 的 `plugins` 数组中加入条目：

```json
{ "id": "hello", "module": "./plugins/hello.mjs", "config": { "prefix": "Hello" } }
```

[Hello 示例](plugins/hello.mjs)展示如何通过官方 `defineTool` API 注册工具。交互 CLI 空闲时可以执行：

```text
/plugins
/unload hello
/load hello ./plugins/hello.mjs {"prefix":"Hello"}
/reload hello {"prefix":"Welcome"}
```

这些命令修改运行中的组合；持久保存需编辑配置文件。重载会刷新本地 `.mjs` 入口，不承诺传递依赖的 HMR。若替换失败且候选版本已成功清理，会尝试用原模块和配置创建新的激活实例。清理失败则保留实例并阻止替换；修复资源问题后，使用 `/retry-cleanup <id>` 重试。

第三方插件是同进程运行的可信代码，工作区文件限制不是插件沙箱。接口、分页读文件和生命周期示例见[插件指南](docs/plugins.md)。

## 验证范围

完成基础准备后：

```sh
npm run verify
npm test
npm run demo
node scripts/record-validation.mjs
```

验证官方默认组合和 JavaScript/Rust 扩展时，先完成 `official:install`、`rust:build` 与 `rust:modules:build`，再执行：

```sh
npm run official:check
node scripts/record-validation.mjs
```

精简组合的记录器最后执行，因为它的源码指纹包含官方验收报告。[应用记录](docs/validation-report.json)与[官方验收记录](docs/official-validation-report.json)将结果绑定到源码和制品输入，覆盖官方 Agent 循环、跨进程恢复、provider 传输、插件更新、取消及对被篡改输入的拒绝行为。记录的输入发生变化后，需要重新验收。

这些是应用测试。形式化保证属于核心内核已规定的合同与前提；任意插件、宿主异步执行、外部 I/O 和模型行为不在该证明范围中。完整宿主 refinement、更多第三方插件覆盖、跨平台制品与发布验收仍有待完成。

性能持续优化，历史测量方法和样本保留在[性能观测](docs/performance.md)中，供工程参考。

## 文档与贡献

| 主题 | 指南 |
| --- | --- |
| 安装与精确来源 | [构建](docs/build.md) |
| 官方默认工作流 | [官方模式](docs/official-mode.md) |
| 自有插件与模型 provider | [插件](docs/plugins.md) · [Providers](docs/providers.md) |
| JavaScript/Rust 扩展与原生更新 | [扩展](docs/official-extensions.md) · [原生模块](docs/native-rust-modules.md) |
| 配置与进程替换 | [Loader 事务](docs/loader-transactions.md) · [进程监督](docs/process-supervisor.md) |
| 实现与限制 | [架构](docs/architecture.md) |

详细指南目前主要使用中文。开发与审查要求见 [CONTRIBUTING.md](CONTRIBUTING.md)，欢迎提交兼容案例、插件示例和范围明确的修复。

## 许可证

[MIT](LICENSE)。上游组件保留各自的许可证，来源声明见 [NOTICE](NOTICE) 和 [third-party/](third-party)。Cordis Harness 是独立项目，不是 Cordis 或 DeepSeek 官方发行版。
