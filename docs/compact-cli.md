# Compact CLI

The compact composition provides a separate CLI for custom plugin arrangements. It uses `harness.config.json`; the [official modes](official-mode.md) use their own profiles and storage.

Complete the [build guide](build.md) first. From the repository root:

```sh
npm run demo
npm start -- plugins
npm test
```

## Use a model provider

Set `DEEPSEEK_API_KEY` in your shell environment. Keep credentials out of configuration files and Git. The example selects `deepseek-flash` from the pinned official source; confirm model availability for your account.

```sh
npm start -- run "Read README and explain this project's purpose" --config examples/deepseek.config.json
npm start -- chat --config examples/deepseek.config.json
```

The example is read-only by default; add `--allow-write` explicitly to enable file-writing tools. The provider uses the official Messages SSE adapter. Local HTTP fixtures exercise actual request construction, tool loops and cancellation; acceptance makes no paid API requests. See [providers](providers.md).

## Save and resume sessions

```sh
npm start -- run "Read README" --config examples/deepseek.config.json --session work-1
npm start -- run "Continue the analysis" --config examples/deepseek.config.json --session work-1 --resume
npm start -- sessions --config examples/deepseek.config.json
npm start -- inspect work-1 --config examples/deepseek.config.json
```

The compact CLI's `FileSessions` implements the official `SessionPersistence` interface and resumes through `agents.resume`. Snapshots preserve original events and sequence numbers. Turn completion and normal shutdown wait for persistence. Storage uses atomic JSON snapshots with a size limit; it does not implement official JSONL migration, automatic stale-lock cleanup or distributed lease recovery. Official mode retains upstream JSONL storage. See [architecture and boundaries](architecture.md).

Snapshot commits sync the temporary file before renaming it into place. Linux and macOS also sync the parent directory. Windows skips the unsupported directory sync, so this backend does not promise that rename metadata survives sudden power loss there. File writes, file syncs and rename failures still reject persistence on every platform; successful normal shutdown must leave a readable snapshot and release its writer lease.

## Compose your own plugins

Add an entry to the `plugins` array in `harness.config.json`:

```json
{ "id": "hello", "module": "./plugins/hello.mjs", "config": { "prefix": "Hello" } }
```

The [Hello example](../plugins/hello.mjs) demonstrates registration through the official `defineTool` API. In an idle interactive CLI session:

```text
/plugins
/unload hello
/load hello ./plugins/hello.mjs {"prefix":"Hello"}
/reload hello {"prefix":"Welcome"}
```

These commands change the running composition; edit the configuration file to persist changes. Reload refreshes the local `.mjs` entry, without promising transitive dependency HMR. If replacement fails after successful candidate cleanup, it attempts to restore the previous module and configuration through a new activation. Failed cleanup retains the instance and blocks replacement; correct the resource problem and use `/retry-cleanup <id>` to retry.

Third-party plugins are trusted code running in the same process. Workspace file restrictions are not a plugin sandbox. See the [plugin guide](plugins.md) for interfaces, paginated file reads and lifecycle examples.
