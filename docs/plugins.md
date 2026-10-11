# Writing and composing plugins

The application loads standard Cordis plugins into its existing Rust-backed Context graph. Its tool registry and agent loop are the pinned official DeepSeek Harness implementations. Custom tools use the same schema validation, execution pipeline and teardown path as official tools.

## Write a plugin

[`plugins/hello.mjs`](../plugins/hello.mjs) is a complete runnable example:

```js
import { defineTool } from '@validation-engineering/harness-verus/plugin-api';

export const name = 'hello';
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  const prefix = config.prefix ?? 'Hello';
  ctx.tools.register(defineTool({
    name: 'hello',
    description: 'Greet a name.',
    parameters: { name: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      return `${prefix}, ${args.name}!`;
    },
  }));
}
```

`defineTool` is the actual official tools implementation. Return the JSON value declared by `output.schema`; `output.render` projects that validated value into model-facing content. Parameters and output use the official schema DSL.

Keep module imports free of resource allocation. Acquire resources in `apply`, register inverses with `ctx.effect(() => async () => { /* cleanup */ })`, observe `exec.signal`, and await admitted work before the inverse resolves. Register through the plugin's own `ctx.tools`: registrations belong to that Context and disappear when its Fiber is disposed. Retaining the root context and registering through it would give the tool the wrong lifetime.

The package self-reference resolves for plugins inside this project's `plugins/` directory. An external npm plugin must make `@validation-engineering/harness-verus/plugin-api` resolvable through its own dependencies or peer dependencies; unrelated directories do not inherit this application's Node resolution paths.

## Compose and reload

Include plugin entries in `harness.config.json`:

```json
{
  "workspace": ".",
  "plugins": [
    { "id": "todo", "module": "official:todo", "config": {} },
    { "id": "workspace", "module": "local:workspace", "config": { "allowWrite": false } },
    { "id": "hello", "module": "./plugins/hello.mjs", "config": { "prefix": "你好" } }
  ]
}
```

This is a configuration fragment; see the [compact CLI guide](compact-cli.md) and [complete configuration](../harness.config.json) for provider, session and limit settings. Relative module paths resolve from the configured plugin base directory; installed npm specifiers are also accepted. Required services must already be available. The application pins the configured workspace root for `local:workspace`, so plugin configuration cannot override it.

The application exposes `app.loadPlugin(entry)`, `app.unloadPlugin(id)` and `app.reloadPlugin(id, config)` at idle agent boundaries. [`PluginManager`](../src/plugin-manager.mjs) mounts each entry as a Fiber and awaits disposal before replacement. Refreshing a local `.mjs` entry does not refresh its entire imported dependency graph. When a failed newcomer finishes cleanup, reload attempts to restore the previous module and configuration by creating a new activation; resources and object identity are not preserved. If cleanup fails, the newcomer remains listed with `cleanupBlocked: true` and the old plugin is not restored alongside it. Resolve the resource failure, then call `app.retryPluginCleanup(id)` (or `/retry-cleanup <id>` in chat). An explicit retry processes the entry's owned plugin subtree from children to parent, and retries only Fibers whose native state records failed cleanup. It does not retry external service consumers owned by other plugin entries; repair those through their own entries. A successful retry removes the blocked entry; load the desired plugin explicitly afterward. Further failed retries retain still-owned resources and report the failure. A disposal call can also report an observer error after native removal has already completed. In that case the manager removes the entry while still returning the error; it does not create an impossible cleanup-retry entry. Use `app.plugins()` to inspect the current state after an error.

Do not register duplicate tool names in the same effective scope.

## Workspace tools

[`workspace.mjs`](../src/plugins/workspace.mjs) accepts `{ root, allowWrite, maxReadBytes, maxWriteBytes }`. The application supplies `root`; direct plugin callers must supply an existing directory. `allowWrite` defaults to `false` and must be boolean. `maxReadBytes` defaults to 65,536 and permits 4 through 16 MiB. `maxWriteBytes` defaults to 1,048,576 and permits 0 through 16 MiB. These limits count content bytes; JSON metadata and escaping add wire bytes.

| Tool | Arguments | Successful value |
| --- | --- | --- |
| `workspace_list` | `path` (default `.`), `offset` (default `0`), `limit` (default `100`, at most `200`) | `{ path, total, next, entries: [{ name, type }] }` |
| `workspace_read` | `path`, `offset` (default `0`), `limit` (default `maxReadBytes`, at least `4`) | `{ path, total, offset, next, content }` |
| `workspace_write` | `path`, `content` | `{ path, bytes }` |

Listing sorts names and bounds each page by entry count and `maxReadBytes`. `total` and `next` count entries. Symlinks are listed but never followed. Directories over 10,000 entries fail explicitly; select a narrower path.

Reading uses **UTF-8 byte offsets** for `total`, `offset` and `next`. Follow `next` until it is `null`. Pages end at character boundaries and preserve a BOM and line endings; the rest of the file is never silently discarded. Invalid UTF-8, binary NUL, an offset inside a character, or a detected change during one page read produces an error. Separate page requests are not one filesystem snapshot; restart if the file changes between pages.

Writing requires `allowWrite: true`, an existing parent directory and well-formed UTF-8 text without NUL. It saves the entire string through an exclusive temporary file in the same directory, syncs and closes it, then renames it into place. Saved files have mode `0600`; replacing a file does not retain old permissions. Failed or pre-commit cancelled writes remove their temporary file. **Rename is the commit point**: later cancellation cannot undo a save, even if the official tool pipeline returns a cancelled result. Independent concurrent writes are last-rename-wins; coordinate read-modify-write workflows in the application.

Disposal closes admission, aborts the plugin lifetime signal and waits for every admitted operation. Failed file-handle or temporary-file cleanup is reported as a cleanup failure. Ordinary completed call errors do not prevent disposal.

Paths must be relative. Absolute paths, `..`, backslashes and symlinks in any path component are rejected; the configured root is canonicalized at activation. This is a filesystem policy, **not an OS sandbox**: hostile concurrent filesystem mutation or hard-link construction can defeat path checks. Use an external sandbox or restricted account/container when stronger isolation is required. No shell or arbitrary command execution is exposed by these tools.

## Validation

[`tests/workspace.test.mjs`](../tests/workspace.test.mjs) uses isolated temporary directories and the real official `ToolRuntime` and `SystemPrompt` on `@validation-engineering/cordis-compat-deepseek`. It covers schemas, byte pagination, Unicode, traversal and symlink checks, write limits, cancellation, disposal, removal and reload, including the `hello` example.

```sh
node --import @validation-engineering/cordis-compat-deepseek/register --test --test-timeout=30000 tests/workspace.test.mjs
```

The tested baseline is Node 22.22.0 on macOS arm64. Tests do not prove arbitrary callbacks, filesystem confinement or cross-platform release readiness.
