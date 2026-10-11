# 打包与发布验收

[English](releasing.md)

源码工作目录保留 `private: true`，通过经过验证的本地运行时压缩包开展开发。
`scripts/package-release.mjs` 在临时产物目录中生成公开包清单、精确 registry
依赖与生产 shrinkwrap。源码改动始终在当前仓库；临时目录仅用于生成归档产物。

候选包要求已提交的核心源码、匹配的通用 npm 包、四个平台成功的核心安装记录，
以及与当前应用源码一致的官方工作流与精简应用验收。官方 DeepSeek 包版本保持锁定；
打包不会升级上游，也不会重新证明或扩大内核证明范围。

```sh
node scripts/package-release.mjs --core-release /path/to/accepted-core-release
node scripts/check-release.mjs --from-directory target/npm-release --output target/npm-release/local-installation.json
```

首条命令只生成 `candidate.json` 与 npm 压缩包。安装检查在新的消费者目录中真实
执行 npm 安装、已安装的官方 CLI、采用脚本模型提供者的真实 AgentLoop，以及离线
重装；同时检查数据写入包目录之外、修改应用文件会被拒绝。不发起付费模型请求。

将归档与 `candidate.json` 上传到 GitHub 草稿发行版，在该候选包对应的精确提交上
运行 **Published application installation** 工作流。Linux x64、macOS ARM64、
macOS x64、Windows x64 的安装记录必须均通过且对应同一候选字节，才能发布。
用 `npm publish <archive> --access public --ignore-scripts` 上传已验收归档；
npm 可能要求发布者本人完成浏览器认证。然后以 `registry=true` 再运行同一工作流，
核对实际 registry 下载，再公开 GitHub 发行版。不覆盖已存在的版本，不将失败标为通过。

这些跨平台安装检查覆盖官方 CLI 入口与精简工具循环。完整默认 Web、headless、
Loader、HMR、Rust 扩展由独立的 [official-validation-report.json](official-validation-report.json)
记录，并注明实际环境。四份安装记录不代表四个平台都完成完整 Web/headless 验收；
JavaScript 回调、I/O、模型行为也不会因此获得 Verus 证明。

发行入口核对应用文件、精确运行时接口文件及已验收的通用原生清单。哈希说明内容
一致性，不是发布者签名或插件沙箱。发行包默认数据目录是 `~/.harness-verus`，
可用 `HARNESS_VERUS_HOME` 覆盖；开发目录继续使用 `.cordis-harness`。
官方 profile 数据仍优先采用显式的 `DSH_HOME`。
