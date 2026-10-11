# 包与应用集成边界

[English](package-boundaries.md)

本项目对应 **DeepSeek Harness**，`cordis-verus` 对应 **Cordis**。应用在替换后的运行时上运行官方工作流。

| 包 | 职责 |
| --- | --- |
| `@validation-engineering/harness-verus` | 完整应用：官方 CLI、Web/headless 组合及插件集成 |
| `@validation-engineering/cordis-compat-deepseek` | 兼容 `@deepseek-ai/cordis` 的运行时接口，由 cordis-verus 维护 |
| `@validation-engineering/cordis` | Rust 支撑的共享 Node 运行时 |
| `@validation-engineering/cordis-loader` | 通用 Loader、域事务和原生模块能力 |

原兼容包名 `@validation-engineering/cordis-harness` 容易与完整应用混淆。已发布的 0.1.0 产物保持原样；新源码使用 `cordis-compat-deepseek`，包括 `/register` 预加载入口。内部原生策略仍为 `harness`，此次改名不改变 API 合同。

依赖官方 Loader、Include、ConfigEditor 和 HMR 具体实现的适配代码已迁入 [`src/integrations`](../src/integrations/)，相应的运行、类型和官方工作流测试也由应用维护。应用事务从本包的 `/official-loader-api` 导入；`cordis-loader@0.2.0` 不再导出 `/harness`。

紧凑演示与官方模式共用同一份依赖安装。未修改的上游分发包仍包含浏览器 Cordis；Node 预加载入口将宿主导入路由到 DeepSeek 兼容接口，并拒绝载入原版 Node 调度器。每个应用使用一个原生 Context 图。

这些名称描述源码布局，实际可安装版本以发布说明为准。Verus 保证来自内核已指定的合同，不覆盖任意插件、模块缓存或应用 I/O。
