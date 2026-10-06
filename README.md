# Cordis Harness

用 **Rust / Verus Cordis** 管理生命周期，组合**未改写的官方 DeepSeek Harness 插件**和自有插件的独立 CLI 项目。目标是在真实应用里检验插件兼容性、组合能力和清理语义。

已经接入官方 AgentLoop、AgentRegistry、SessionStore、SystemPrompt、ToolRuntime、SessionProjectionRegistry、Todo 和 DeepSeek API-key provider。自有插件提供文件操作、会话持久化、请求限额及一个简单的 Hello 工具。

这是可运行的开发验证项目，包含自有精简组合与官方发行的宿主替换入口，尚未正式发布。当前已验收 macOS ARM64 / Node 22.22.0；runtime 是固定指纹的未发布开发制品。

## 官方默认 Web 模式

现在另有完整的官方发行安装：保留官方 `dsh web` 入口、Web 界面、默认 `standard` preset、Loader/Include、插件和 JSONL 会话存储，预加载我们的 Rust/Verus Cordis **Node 宿主**。浏览器中的 Cordis 客户端仍为官方 JavaScript 实现。

```sh
npm run official:install -- --offline
npm run official
# 等价：npm run official -- web
```

官方默认端口为 3080，会打开浏览器。服务器参数原样转发：

```sh
npm run official -- web --no-open --port 3080
npm run official -- headless --json "阅读当前项目并概述其用途"
```

真实模型需要用户在官方界面配置账号或 API key。默认数据保存在本项目 `.cordis-harness/official`；显式 `DSH_HOME` 可选择其他目录。验收不会调用付费模型。固定发行包和所有依赖保持原始布局；启动前核对安装字节，并阻止宿主加载原版 JS Cordis 调度器。

默认 Web、完整插件清单、实际 native Context、官方工具和跨进程恢复的验收见[官方模式](docs/official-mode.md)。这证明锁定版本和已测试流程的宿主替换，不代表所有第三方插件或浏览器运行时均已形式验证。

## 在官方模式中组合 JS 与 Rust 插件

下面的入口保留官方默认组合，额外加载 `cordis_greet` 和 `rust_text_analyze`。
Rust 工具通过同一个 native Driver 提供服务；JS 桥使用官方工具 API 注册。

```sh
npm run official:install -- --offline
npm run rust:build -- --offline
npm run official:extensions
# 或使用原版 headless：
npm run official:extensions -- headless --json "统计文本 Hello 世界的字符和字节数"
```

首次启动为 Web/headless 创建官方 profile，默认使用独立数据目录
`.cordis-harness/official-extensions`；已有 profile 文件保留不覆盖。
官方插件面板可以禁用、启用插件，Settings 可以修改问候前缀。
真实模型仍需用户配置；本项目的自动验收使用本机模型 fixture。
示例、配置和验证范围见[官方扩展指南](docs/official-extensions.md)。

默认 UI 的 ConfigEditor、Include 文件刷新和 HMR 配置队列现在统一进入 native 域事务，在文件锁和写入前接纳，并等待生命周期、实际写入及官方回滚完成。宿主还可通过[官方 Loader 事务接口](docs/loader-transactions.md)显式创建、更新和删除条目。官方原地模块 HMR 会在修改缓存前明确拒绝；模块图替换可使用核心库的 Worker/Process 代次路径。真实官方 Web 应用另有可选的进程监督入口：

```sh
npm run official:watch
# 修改 examples/process-plugins/version.mjs 后，打开新进程输出的官方启动链接
```

它保留默认 `standard` 和官方会话存储，先确认旧进程清理，再启动捕获后的插件模块。坏候选清理成功后可恢复旧制品；清理未确认会阻止替换。此模式仅覆盖 Web，重启会断开连接并轮换登录 token；详见[进程监督与插件更新](docs/process-supervisor.md)。

## 精简组合与离线 demo

当前工作目录已经安装、构建完成：

```sh
npm run demo
npm start -- plugins
npm test
```

离线 demo 使用**真实官方 agent/tool 循环**和确定性的 scripted provider，不调用模型 API，也不会理解任意自然语言任务。它在 `.cordis-harness/demos/` 下建立新工作区，读取 README、生成 `DEMO_RESULT.md`、完成 Todo，并持久化会话。终端返回实际工作区和 session id。

新 checkout 首先准备固定版本的 runtime 和官方源码：

```sh
node scripts/bootstrap.mjs --cordis-source ../cordis-verus --offline
npm run build
npm run verify
npm test
npm run demo
```

缺少公开 npm 依赖缓存时可使用 `--online`。当前还没有公开 runtime 下载服务；`sources.lock.json` 记录核心基准提交、工作树状态和精确源码指纹；只有 `workingTreeDirty: false` 时才可仅按 `baseCommit` 恢复全部输入。安装仍需经过验收的本地制品，精确字节由源码指纹和制品哈希绑定；重新构建需刷新来源锁并重新验收。两个仓库目前均为私有，需要相应访问权限。详见[独立构建](docs/build.md)。

## 使用真实模型

配置 shell 中的 `DEEPSEEK_API_KEY`，不要把密钥写进配置或 Git。示例使用锁定官方源码中的 `deepseek-flash`，实际账户支持哪些模型需由部署方确认：

```sh
npm start -- run "阅读 README，说明这个项目的用途" --config examples/deepseek.config.json
npm start -- chat --config examples/deepseek.config.json
```

示例默认只读；明确添加 `--allow-write` 才启用写文件工具。provider 是官方 Messages SSE 适配器。本机 HTTP fixture 已验证真实请求、工具循环和取消；本项目验收没有调用付费 API。配置细节见 [provider 指南](docs/providers.md)。

## 保存与恢复

```sh
npm start -- run "阅读 README" --config examples/deepseek.config.json --session work-1
npm start -- run "继续分析" --config examples/deepseek.config.json --session work-1 --resume
npm start -- sessions --config examples/deepseek.config.json
npm start -- inspect work-1 --config examples/deepseek.config.json
```

自有 `FileSessions` 实现官方 `SessionPersistence` 接口，恢复走官方 `agents.resume`。快照保留原始事件与序号，不把对话摘要冒充原始历史。完成一个回合和正常退出都会等待持久化屏障。当前采用有大小上限的原子 JSON 快照，不包含官方 JSONL 迁移、自动清理遗留锁或分布式租约恢复；详见[架构与边界](docs/architecture.md)。

## 组合自己的插件

修改 `harness.config.json` 的 `plugins`：

```json
{ "id": "hello", "module": "./plugins/hello.mjs", "config": { "prefix": "你好" } }
```

[Hello 示例](plugins/hello.mjs)展示官方 `defineTool` 的完整注册方式。在交互 CLI 里，agent 空闲时可以：

```text
/plugins
/unload hello
/load hello ./plugins/hello.mjs {"prefix":"你好"}
/reload hello {"prefix":"Welcome"}
```

这些命令改变当前运行中的组合；持久配置请编辑配置文件。重载失败且新实例已完成清理时恢复旧实例；清理失败则保留实例并阻止替换，修复资源后用 `/retry-cleanup <id>` 显式重试。第三方插件是在同一进程运行的可信代码，工作区文件限制不是插件沙箱。

更多接口、分页读文件和生命周期写法见[插件指南](docs/plugins.md)。

## 验证

```sh
npm run verify
npm test
node scripts/record-validation.mjs
# 官方默认组合和 JS/Rust 扩展（先完成 official:install、rust:build）
npm run official:check
```

测试覆盖真实官方循环、跨进程会话恢复、官方 HTTP adapter、插件增删重载、路径/UTF-8/取消边界，以及来源和安装产物被改动后的拒绝行为。[验收记录](docs/validation-report.json)绑定本项目源文件与构建证据；它不是新的 Verus 证明。

2026-10-05 的优化编译和静止图复用已在实际安装的官方组合中验收。本机 Web 完整流程从单次 81.46 秒降至三次中位数 2.59 秒；同期原版为 1.86 秒。测量范围、全部样本及限制见[性能观测](docs/performance.md)。

长期还需要：更多第三方插件、将核心库的 Worker 模块图与 typed Rust 迁移能力接入更多应用场景、跨平台制品、长时间运行与大历史性能、完整宿主 refinement 和发布门禁。默认官方应用尚未自动迁入 Worker，也不宣称原地模块 HMR 完成。
