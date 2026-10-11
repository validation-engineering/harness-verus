# Packages and application integration

[简体中文](package-boundaries.zh-CN.md)

This project corresponds to **DeepSeek Harness**. `cordis-verus` corresponds to
**Cordis**. The application runs official workflows on the replacement runtime.

| Package | Responsibility |
| --- | --- |
| `@validation-engineering/harness-verus` | This application: official CLI, Web/headless composition and plugin integration |
| `@validation-engineering/cordis-compat-deepseek` | Runtime compatibility with `@deepseek-ai/cordis`; maintained in cordis-verus |
| `@validation-engineering/cordis` | Shared Rust-backed Node runtime |
| `@validation-engineering/cordis-loader` | General Loader, domain and native-module facilities |

The former compatibility-library name `@validation-engineering/cordis-harness`
was ambiguous. Its published 0.1.0 archive remains unchanged. New source imports
use `cordis-compat-deepseek`, including the `/register` preload. The internal native
policy remains `harness` and the API contracts are unchanged by the rename.

The concrete official Loader, Include, ConfigEditor and HMR adapters now live in
[`src/integrations`](../src/integrations/). Their runtime, type and official-workflow
tests live here as well. Import application transactions through this package's
`/official-loader-api`; `cordis-loader@0.2.0` no longer exports `/harness`.

The compact demo and official modes share one installed dependency tree. The
unchanged upstream distribution includes browser Cordis; the Node preload routes
host imports to the DeepSeek compatibility package and rejects attempts to load
the original Node scheduler. There is one native Context graph per application.

These names describe the source layout. Consult release notes for versions
actually available on npm. Verus guarantees belong to the kernel's specified
contracts, not arbitrary plugins, module caches or application I/O.
