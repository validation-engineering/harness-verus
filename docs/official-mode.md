# 官方默认模式与 Cordis 宿主替换

固定安装 `@deepseek-ai/dsh@0.2.0-rc.2` 的官方 npm 发行包及其完整依赖。官方的默认使用方式是 `dsh web`，默认 Agent preset 为 `standard`。这个入口调用原版 CLI 的 `runCli()`，不把自有 `chat` CLI 或精简工具组称为官方默认模式。

## 使用

第一次先按 [构建指南](build.md) 准备 Cordis 制品，再安装独立官方运行目录：

```sh
npm run official:install -- --offline
npm run official
```

没有公开依赖缓存时去掉 `--offline`。官方运行目录有自己的 `package.json` 与 `package-lock.json`；固定官方依赖不随主项目开发依赖变动。安装不执行 npm lifecycle 脚本，会检查平台原生制品和 helper 执行权限；缺少资产会明确失败。

`npm run official` 默认转发 `web`，其余参数原样传递：

```sh
npm run official -- web --no-open --port 3080
npm run official -- web --dump-default-config
npm run official -- headless --json "阅读这个项目并解释主要模块"
npm run official -- headless --session-id <真实已有会话ID> "继续上次的工作"
```

界面、模型与权限设置、工具、技能、子代理、插件设置和会话格式均由原版官方产品提供。首次使用可在官方界面配置模型凭据；headless 也沿用官方凭据与设置。自有 `harness.config.json` 仅用于精简 CLI，不配置这个入口。实际文件/终端工具权限遵守官方产品的默认设置。

启动器默认设置 `DSH_HOME=.cordis-harness/official`（绝对解析到本项目），显式传入 `DSH_HOME` 时保留用户选择；工作目录仍是调用者的当前目录。启动输出中的链接携带官方短期认证令牌，应直接在本机打开。正常关闭遵守官方信号与清理流程。

## 实际替换范围

- 官方 Node 插件中的 `@deepseek-ai/cordis` 导入统一映射到 `@cordis-verus/compat-harness`，由 Rust native driver 与 Verus kernel 调度。
- 官方 `cordis-plugin-loader/include/group/timer` 原样运行。我们的简化 `compat-loader` 不冒名替代它们。
- 主进程的 load guard 拒绝重新加载安装目录中的原版 Cordis JavaScript 宿主入口；继承 `execArgv` 的 ESM 文件型 Node Worker 会预加载同一路由。官方显式隔离的 JSONL 数据校验 Worker 原样保留，其中包含打包后的 Cordis 定义，但当前固定版本不创建 Context。此处验证的是主宿主插件图；Node 22 的 `eval` / CommonJS 入口 Worker、显式清空启动参数的 Worker 和自行启动的隔离进程不包含在自动迁移承诺中。
- 官方前端包和浏览器插件保持原样，因此浏览器端 Cordis 仍是 JavaScript。这个方案替换 **Node 宿主核心**。
- 发行包保留真实目录、manifests、YAML、Worker、前端与原生资产；不做改变相对资源路径的扁平重打包。

为原版 Loader 新增的 `Fiber.inertia` 指向真实 native 生命周期阶段。Loader 等待实际启动和清理，不会把还在 `LOADING` 的 include 误判为完成。官方 headless 在插件启动返回后继续运行任务，因此兼容层区分“仍在执行的动作”和“该动作后续的异步回调”：后者可以发起关闭，仍在 journal 中的 effect、inverse 和 owned task 则继续保留自等待检查。过期回调可以记录日志，但不能重新获取服务或资源。

## 可复核的验收

```sh
npm run official:verify
npm run rust:build -- --offline
npm run official:check
node scripts/record-official-validation.mjs --check
```

安装记录由真实 `npm ci` 成功后生成，启动只读校验。篡改、丢失文件、改变锁或更换 native 制品都会要求重新安装；不会靠重写记录把任意目录当成官方产物。升级本地同版本 Cordis 制品需显式：

```sh
npm run official:install -- --refresh-runtime-lock --offline
```

该操作只刷新两个本地 runtime 包，其他官方及第三方解析保持不变。

验收分别运行原版 Cordis baseline 和 native 宿主，保留未经修改的官方入口与默认业务组合；测试通过官方开关关闭 telemetry，并隔离配置和凭据。Web 检查真实 HTTP 登录令牌交换、官方 HTML/JS/CSS、客户端模块、插件清单、默认 presets 和关闭；专用观察器记录实际 native Context 与插件图，关闭后检查清理结果。Headless 仅把模型端点改为本机 HTTP/SSE fixture，执行原版工具并在另一个进程恢复官方持久会话。

插件清单逐条比较顺序、名称、启用状态和激活状态；只有官方目录选择器自动创建的两个 native 插件按模块名对应随机实例 ID，其余 ID 严格一致，原始 ID 全部保存在子报告中。

完整 gate 也验证[官方模式的 JS/Rust 扩展](official-extensions.md)，需要先构建来源匹配的示例 addon。默认启动仍使用随包核心；扩展启动器显式选择已验证的用户 addon。

结果保存在 [官方模式验收记录](official-validation-report.json)，绑定源文件、完整安装与各项执行日志。HTTP 检查与浏览器交互验收分开记录；本机结果不代表跨平台发布、任意插件兼容、任意模型效果或整篇论文 refinement 完成。

## 浏览器检查

自动验收报告的 `browserExecution: false` 表示该脚本检查 HTTP 和真实宿主，不驱动浏览器。交互检查请运行 `npm run official`，在本机打开启动链接，经过预览版说明后可选择“稍后配置”跳过密钥输入：

1. 新会话应显示“标准模式”、工作区、模型和权限选择。
2. “插件”面板应显示官方 Agent 循环、子智能体、终端等设置。
3. 模型未配置时不发送消息；真实模型调用需用户自己的凭据。

同一浏览器检查也已在本机 Chrome 中执行；它仅覆盖界面启动与上述面板，不是浏览器内核的形式化验证或真实模型端到端验收。

独立 Rust 动态插件另有[同进程更新示例](native-rust-modules.md)：默认 addon 常驻，模块通过 C ABI 换代。当前由宿主显式操作，未接入默认 Web 插件面板和 watcher。官方验收还覆盖安装后的 ToolRuntime 调用与精简组合的真实 AgentLoop。
