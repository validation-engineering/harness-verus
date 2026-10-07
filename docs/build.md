# 独立安装、构建与来源

精简 CLI 从三个真实 npm tarball 安装我们的 Cordis runtime，再把锁定版本的官方 Harness TypeScript 插件构建成一个入口。[官方默认模式](official-mode.md)另使用完整 npm 发行包，保留官方 CLI、前端、Worker、Loader 和 JSONL backend。项目不链接 `cordis-verus/node_modules`，运行时也不需要原研究仓库的绝对路径。

当前验收环境为 macOS arm64、Node 22.22.0、npm 10.9.4。三个 runtime 包仍是未发布的开发制品；随包 native addon 仅在 `sources.lock.json` 记录的平台验收。更换平台需要先在目标平台完成 Cordis 构建与开发验收，再有意更新来源锁。

## 第一次准备

需要一个已完成开发验收、持有三个 npm 制品和锁定官方上游 checkout 的 `cordis-verus` 工作目录。`sources.lock.json` 的 `baseCommit` 记录基准提交；`workingTreeDirty: true` 表示还包含该提交之后的工作区变更，不能仅检出该提交冒充匹配输入。源码指纹和 tarball SHA-256 是精确内容校验依据。

新机器先克隆私有的 `validation-engineering/cordis-verus` 和 `validation-engineering/cordis-harness`，在 `workingTreeDirty: false` 时将核心切换到 `sources.lock.json` 的 `baseCommit`；开发中的 dirty 快照需要保留对应工作区和制品。按核心项目的[贡献指南](https://github.com/validation-engineering/cordis-verus/blob/main/CONTRIBUTING.md)准备锁定工具链与依赖，再按[验收指南](https://github.com/validation-engineering/cordis-verus/blob/main/docs/validation.md)运行 `python3 scripts/record-development.py`。还需准备 `deepseekHarness.revision` 对应的干净官方 checkout，放在核心的 `upstream/deepseek-harness` 或用 `--upstream-source` 指定。重新构建会生成新的本机验收记录，制品也可能不同，首次导入应显式使用 `--refresh-lock` 并重新完成本应用验收；不要求新构建冒充原机器的制品字节。

若已有锁中记录的已验收制品与缓存，可直接：

```sh
node scripts/bootstrap.mjs --cordis-source ../cordis-verus --offline
npm run build
npm run verify
npm test
npm run demo
```

`bootstrap` 首先执行来源仓库的 `record-development.py --check`，并复查记录中的源码、native 输入和包哈希。它不重新运行 Verus，也不把哈希检查称为新证明。接着通过 `git archive` 导出官方干净 checkout；验证 revision、Git tree、archive SHA-256 和完整文件清单；将 tarball 复制到 `.vendor/cordis/`；最后执行 `npm ci --offline --ignore-scripts`。这里创建真实解包的本地依赖，不使用 `npm link`。

首次下载尚未缓存的公开第三方依赖时可显式使用 `--online`。第三方版本仍由 `package-lock.json` 固定，不改变官方源码锁。`--no-install` 仅准备来源和制品；`--upstream-source PATH` 可以指定另一个具有相同锁定 revision/tree 的干净官方 checkout。

来源工作树、包或官方版本变化时，默认 bootstrap 会拒绝覆盖 `sources.lock.json`。检查更新后使用 `--refresh-lock`，重新构建、测试并审查锁文件差异。同版本、同 `file:` 路径的新 tarball 会先删除相应旧 npm 锁条目，再重新解析锁；安装前后严格比较实际 tarball SHA-512 与 npm integrity，最后逐个核对已安装文件。不会通过 `--force` 绕开 integrity。锁刷新失败会恢复原 npm 锁文件并返回失败。核心源码不可用时，可以保存并复制已经验证的 `.vendor/cordis/`、`.cache/upstream/` 和锁文件；运行时不需要核心仓库，但构建需要这些锁定输入。当前尚未提供公开的制品下载服务。

## 目录与边界

| 路径 | 用途 |
| --- | --- |
| `sources.lock.json` | 核心工作树指纹、真实制品 SHA、上游 revision/tree/archive/snapshot SHA |
| `package-lock.json` | 精确 npm 依赖和 registry integrity；本地包路径相对本项目 |
| `.vendor/cordis/` | 三个真实 tarball 与原开发、打包报告，忽略 Git |
| `.cache/upstream/deepseek-harness/` | 原始官方源码快照，忽略 Git，构建前完整校验 |
| `src/upstream.ts` | 需要使用的官方 API 导出；没有重写官方实现 |
| `dist/upstream/plugins.mjs` | esbuild 生成的官方插件入口 |
| `dist/package.json` | 官方 LLM package.json 原始字节，供 attribution 读取真实版本 |
| `dist/build-report.json` | 全部实际源码输入、编译器文件与输出哈希、解析来源 |
| `third-party/` | 原作者许可证和来源声明；构建也输出第三方声明 |

`build` 从快照中的官方 `packages/*/*/src` 和 `vendor/*/src` 解析原始 `@deepseek-ai/` workspace import，拒绝未知包、无法映射的源码出口和跨项目路径。真实 AgentLoop、SessionStore、ToolRuntime、LLM、系统提示、作用域和 Todo 等入口必须出现在构建输入中。官方 Cordis 调度器不能进入 bundle。

所有 `@deepseek-ai/cordis` import 保留为裸模块名。进程先加载：

```sh
node --import @cordis-verus/compat-harness/register src/cli.mjs demo
```

同步 module hook 把官方包名导向唯一的 `@cordis-verus/compat-harness`，后者使用安装在本项目中的 native Cordis。`start`、`demo` 和 `test` 已包含该参数。项目 CLI 与 `createHarness` 入口也会在动态载入官方模块之前自行注册；其他直接导入官方 bundle 的自定义入口需要先注册。构建不内联 compatibility facade，避免复制 Context 身份或破坏 native 文件定位。

LLM 的 attribution 使用 `createRequire(import.meta.url)('../package.json')`。因此保留 `dist/upstream/plugins.mjs` 与 `dist/package.json` 的相对结构，后者必须是官方原始清单。不要将主应用 package.json 放到该位置。精简 bundle 未包含官方 JSONL backend（官方默认模式已保留原版 JSONL 与其 Worker）；精简组合接入带 `new URL('./worker.cjs', import.meta.url)` 的插件时，必须同时构建其 Worker 等资产并纳入输出校验。

## 验证含义

`npm run verify` 重新核对 tarball、安装后的每个 runtime 文件、native SHA、npm 锁文件、Context ESM/CJS/官方别名身份、`harness` profile，以及 bundle 输入和输出。多余的 runtime 包文件、源链接、混入的官方 JS scheduler、过期 bundle 和外部绝对路径均会被拒绝。`pretest`、`predemo` 和 `prestart` 都先执行它。

`tests/bootstrap.test.mjs` 用隔离的真实 npm cache 验证同版本 tarball 替换、拒绝未经确认的更新、离线重装和失败锁回滚。`tests/build.test.mjs` 把独立项目输入复制到临时目录，验证可移植的解包安装，并修改输入、输出、tarball、runtime 文件和锁文件来确认旧证据不能继续通过。它不修改工作目录中的实际构建结果。

这些检查验证来源闭包与本机组装，不证明任意 JavaScript 插件、网络 provider、文件系统或模型行为，也不代表完整 Harness 兼容、全部论文 refinement 或跨平台发布验收。

## 官方模式 Rust 扩展

完成核心导入和 `npm run official:install -- --offline` 后，运行
`npm run rust:build -- --offline`。独立 Cargo crate 位于 `native/text-analysis`，
构建使用相邻 `../cordis-verus` 的匹配 native 源码及锁定工具链，输出仅写入 `.cache/rust-addon`。
`npm run rust:verify` 核对 addon 源码、Cargo.lock、core 来源、已安装 facade、当前平台和实际二进制。
运行时不需要相邻 core checkout；新构建仍需要该源码。
默认使用优化级别 3 的 release 构建，保留 debug assertions 和 overflow checks；实际 Cargo profile 必须通过构建器检查并写入来源证据。

`npm run official:extensions` 在原版 Web/headless profile 中添加 JS/Rust 工具；
普通 `npm run official` 保持使用默认发行 addon。`npm run official:check` 验证两种入口，
原来的精简 CLI `npm test`/demo 不要求构建这个可选 addon。详见[扩展指南](official-extensions.md)。
