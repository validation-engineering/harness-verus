# Cordis Harness

**Official DeepSeek Harness plugins on a Rust runtime with a Verus-verified lifecycle kernel.**

[简体中文](README.zh-CN.md) · [Build guide](docs/build.md) · [Official mode](docs/official-mode.md) · [Plugin guide](docs/plugins.md) · [Contributing](CONTRIBUTING.md)

Cordis Harness combines unchanged official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugins with custom JavaScript and Rust plugins on [cordis-verus](https://github.com/validation-engineering/cordis-verus). It evaluates Cordis functional alignment in real agent workflows: plugin composition, tool execution, session recovery, configuration changes and cleanup.

The core runtime connects formal constraints to executable lifecycle code; this project supplies application integration evidence. Follow the core's [paper-to-code guide](https://github.com/validation-engineering/cordis-verus/blob/main/docs/paper-review-guide.md) to inspect the verified contracts and their host boundaries. Both projects are part of [Validation Engineering](https://github.com/validation-engineering).

**Status:** Experimental, pre-1.0, with no published release. Recorded local acceptance covers macOS ARM64 and Node 22.22.0. The runtime packages are unpublished development artifacts with exact inputs recorded in [sources.lock.json](sources.lock.json). Both repositories currently require access.

## Features

- **Official application workflows.** Run the official Web and headless entries, default `standard` composition, Loader/Include, frontend and JSONL session storage with the Rust-backed Node Cordis host. Browser-side Cordis remains upstream JavaScript.
- **Original plugins with custom extensions.** Use the official AgentLoop, AgentRegistry, SessionStore, SystemPrompt, ToolRuntime, SessionProjectionRegistry, Todo and DeepSeek API-key provider. Add file tools, request limits and your own plugins.
- **JavaScript and Rust in one lifecycle graph.** Register Rust services and tools alongside JavaScript plugins through the same native Driver. Cleanup failures remain visible and retain the resources needed for explicit recovery.
- **Configuration and plugin updates.** Use supported official configuration transactions and in-place module HMR, optional Web process supervision, or independently built Rust `cdylib` plugins with explicit checkpoint migration.
- **An offline demonstration.** Exercise the real official agent/tool loop using a deterministic scripted provider, without a model API request.

## Getting started

Use Node **22.22.0**, npm and Git. Preparing runtime artifacts also requires the core project's pinned Rust/Verus toolchain; compiling the optional Rust extensions requires the matching core source checkout and Rust toolchain.

Start with the [build guide](docs/build.md) to prepare a development-validated `../cordis-verus` checkout, its three npm runtime archives and the locked official Harness source snapshot. There is currently no public runtime artifact download service.

For a new local build, import those artifacts and explicitly refresh the source lock:

```sh
node scripts/bootstrap.mjs --cordis-source ../cordis-verus --refresh-lock --online
npm run build
npm run verify
npm run demo
```

Use `--offline` instead of `--online` when public npm dependencies are cached. To reuse the exact artifacts already recorded in the lock, omit `--refresh-lock`. Review lock changes and rerun validation after an artifact refresh. Source fingerprints and artifact hashes identify the inputs; a `baseCommit` alone is sufficient to restore source only when `workingTreeDirty` is `false`. Runtime execution does not require the adjacent core checkout.

The demo runs the **real official AgentLoop and tool loop** with a scripted provider. It creates a workspace under `.cordis-harness/demos/`, reads a README, writes `DEMO_RESULT.md`, completes Todo items and persists a session. The terminal reports the workspace and session ID. This deterministic demonstration does not interpret arbitrary natural-language tasks.

## Official Web and headless modes

After the base setup, install the official distribution and start its default Web mode:

```sh
npm run official:install -- --refresh-runtime-lock
npm run official
# Equivalent: npm run official -- web
```

`--refresh-runtime-lock` updates the local runtime archive entries after a deliberate artifact refresh. When those entries already match, use `npm run official:install`; add `-- --offline` if all dependencies are cached. The official source version remains locked.

The default Web port is 3080 and the official CLI opens a browser. Server arguments are forwarded unchanged:

```sh
npm run official -- web --no-open --port 3080
npm run official -- headless --json "Read this project and explain its purpose"
```

Configure your model account or API key in the official application for interactive use. Data defaults to `.cordis-harness/official`; set `DSH_HOME` to choose another directory. The pinned distribution retains its original layout. Startup verifies installed artifacts and prevents the Node host from loading the upstream JavaScript Cordis scheduler.

The [official-mode guide](docs/official-mode.md) describes the default plugin roster, native Context, tools and cross-process session recovery. These checks establish host replacement for the locked version and tested workflows; they do not establish complete third-party plugin compatibility or a formal proof of the application.

## JavaScript and Rust extensions

The extension entry preserves the official default composition and adds `cordis_greet` and `rust_text_analyze`. The Rust tool exposes its service through the same native Driver; a JavaScript bridge registers it through the official tool API.

After base setup and official installation:

```sh
npm run rust:build -- --offline
npm run official:extensions
npm run official:extensions -- headless --json "Count the characters and bytes in Hello world"
```

Use the Rust build command without `--offline` if Cargo dependencies are not cached. First launch creates official Web/headless profiles under `.cordis-harness/official-extensions`, preserving existing profile files. The official plugin panel can disable and enable the extensions, and Settings can change the greeting prefix. Interactive use needs model configuration; automated acceptance uses a local model fixture. See the [extension guide](docs/official-extensions.md) for examples and scope.

## Configuration and reload

The default UI's ConfigEditor, Include refresh and HMR configuration queue share a native domain transaction queue. Admission happens before file locking or writing, and operations wait for lifecycle work, persistence and official rollback. Hosts can also explicitly create, update and remove entries through the [official Loader transaction API](docs/loader-transactions.md).

Supported official in-place module HMR waits for old plugin cleanup before replacing modules and retains the outcome of candidate recovery. Native addon changes or shared host modules that cannot be safely replaced need a Worker or process boundary. An optional supervisor provides process replacement for the actual official Web application:

```sh
npm run official:watch
# Edit examples/process-plugins/version.mjs, then open the new process's startup URL.
```

This mode preserves the default `standard` composition and official session storage. It confirms old-process cleanup before starting the captured plugin modules. If a bad candidate is cleaned up successfully, the previous artifacts can be restored; unconfirmed cleanup blocks replacement. The supervisor supports Web mode only. Restarts disconnect clients and rotate the login token. See [process supervision](docs/process-supervisor.md).

## Native Rust plugin updates

Independently built `cdylib` plugins join the resident Driver through a versioned C ABI. The demo uses the same process and official AgentLoop to replace v1 with v2 and recover from a bad candidate, without relinking the Node addon.

After base setup and official installation:

```sh
npm run rust:modules:build -- --offline
npm run rust:modules:demo
npm run rust:modules:test
npm run official:rust -- web --no-open
npm run official:rust:watch -- --no-open
```

Use the module build command without `--offline` if Cargo dependencies are not cached. The module interface supports JSON services, streams, objects, dynamic child plugins and opt-in bounded logical checkpoints. Each code update requires a newly built library; old library images remain loaded until process exit. Official Loader entries appear in the configuration panel. The Web watcher compiles source in the background, updates immutable artifact configuration through ConfigEditor, and checks tool-consumer readiness. See [native Rust modules](docs/native-rust-modules.md) for loading, migration and provenance rules.

## The compact CLI

The compact composition provides a separate CLI for custom plugin arrangements. It uses `harness.config.json`; the official modes above use their own profiles and storage.

After base setup:

```sh
npm run demo
npm start -- plugins
npm test
```

### Use a model provider

Set `DEEPSEEK_API_KEY` in your shell environment. Keep credentials out of configuration files and Git. The example selects `deepseek-flash` from the pinned official source; confirm model availability for your account.

```sh
npm start -- run "Read README and explain this project's purpose" --config examples/deepseek.config.json
npm start -- chat --config examples/deepseek.config.json
```

The example is read-only by default; add `--allow-write` explicitly to enable file-writing tools. The provider uses the official Messages SSE adapter. Local HTTP fixtures exercise actual request construction, tool loops and cancellation; acceptance makes no paid API requests. See [providers](docs/providers.md).

### Save and resume sessions

```sh
npm start -- run "Read README" --config examples/deepseek.config.json --session work-1
npm start -- run "Continue the analysis" --config examples/deepseek.config.json --session work-1 --resume
npm start -- sessions --config examples/deepseek.config.json
npm start -- inspect work-1 --config examples/deepseek.config.json
```

The compact CLI's `FileSessions` implements the official `SessionPersistence` interface and resumes through `agents.resume`. Snapshots preserve original events and sequence numbers. Turn completion and normal shutdown wait for persistence. Storage uses atomic JSON snapshots with a size limit; it does not implement official JSONL migration, automatic stale-lock cleanup or distributed lease recovery. Official mode retains upstream JSONL storage. See [architecture and boundaries](docs/architecture.md).

### Compose your own plugins

Add an entry to the `plugins` array in `harness.config.json`:

```json
{ "id": "hello", "module": "./plugins/hello.mjs", "config": { "prefix": "Hello" } }
```

The [Hello example](plugins/hello.mjs) demonstrates registration through the official `defineTool` API. In an idle interactive CLI session:

```text
/plugins
/unload hello
/load hello ./plugins/hello.mjs {"prefix":"Hello"}
/reload hello {"prefix":"Welcome"}
```

These commands change the running composition; edit the configuration file to persist changes. Reload refreshes the local `.mjs` entry, without promising transitive dependency HMR. If replacement fails after successful candidate cleanup, it attempts to restore the previous module and configuration through a new activation. Failed cleanup retains the instance and blocks replacement; correct the resource problem and use `/retry-cleanup <id>` to retry.

Third-party plugins are trusted code running in the same process. Workspace file restrictions are not a plugin sandbox. See the [plugin guide](docs/plugins.md) for interfaces, paginated file reads and lifecycle examples.

## Validation scope

With base setup complete:

```sh
npm run verify
npm test
npm run demo
node scripts/record-validation.mjs
```

For official default compositions and JavaScript/Rust extensions, first complete `official:install`, `rust:build` and `rust:modules:build`, then run:

```sh
npm run official:check
node scripts/record-validation.mjs
```

The compact recorder runs last because its source fingerprint includes the official validation report. The [application record](docs/validation-report.json) and [official acceptance record](docs/official-validation-report.json) bind their results to source and artifact inputs. They cover the official agent loop, cross-process recovery, provider transport, plugin updates, cancellation and rejection of altered inputs. Recorded snapshots require fresh validation when their inputs change.

These are application tests. Formal guarantees belong to the core kernel's specified contracts and assumptions; arbitrary plugins, asynchronous host execution, external I/O and model behavior are outside that proof scope. Complete host refinement, broader third-party coverage, cross-platform artifacts and release acceptance remain open.

Performance optimization continues; historical methods and samples remain in the [performance notes](docs/performance.md) for engineering reference.

## Documentation and contributing

| Topic | Guide |
| --- | --- |
| Installation and exact source inputs | [Build](docs/build.md) |
| Official default workflows | [Official mode](docs/official-mode.md) |
| Custom plugins and model providers | [Plugins](docs/plugins.md) · [Providers](docs/providers.md) |
| JavaScript/Rust extensions and native updates | [Extensions](docs/official-extensions.md) · [Native modules](docs/native-rust-modules.md) |
| Configuration and process replacement | [Loader transactions](docs/loader-transactions.md) · [Process supervision](docs/process-supervisor.md) |
| Implementation and limitations | [Architecture](docs/architecture.md) |

Detailed guides are currently primarily in Chinese. Read [CONTRIBUTING.md](CONTRIBUTING.md) for development and review expectations. Compatibility cases, plugin examples and focused fixes are welcome.

## License

[MIT](LICENSE). Upstream components retain their licenses and attribution in [NOTICE](NOTICE) and [third-party/](third-party). Cordis Harness is an independent project, not an official Cordis or DeepSeek release.
