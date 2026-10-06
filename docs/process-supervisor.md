# Process updates for official Harness

The opt-in supervisor runs the pinned official Web profile and its default `standard` preset in a new OS process for each module generation. It uses the official exported `runProfile()` function—the same profile boot path called by `runCli()`—with one Rust/Verus Cordis Context graph. Official packages and browser assets remain unchanged.

```sh
npm run official:install -- --offline
npm run official:watch
# Custom source bundle and persistent data/workspace:
npm run official:supervise -- --directory ./my-plugins --home /path/to/harness-data --workspace /path/to/project --port 3080 --watch
```

This entry deliberately supports the Web profile. It does not forward the complete `dsh` launcher grammar; use `npm run official -- ...` for headless, TUI, plugin management, configuration dumps and other normal commands. `--help` lists supervisor options. `--port 0` chooses a new free port for each process, useful for tests. Browser auto-open is disabled.

Open the official launch URL printed by the child. Updates close existing connections and rotate the official authentication token. Open the newly printed URL after each update or recovery; with port `0`, the origin also changes. The supervisor does not keep a reverse proxy, migrate WebSockets or modify the browser client. Stored sessions survive in `DSH_HOME`; an in-progress model/tool turn is subject to ordinary official shutdown and cancellation. Automatic continuation of a turn is not promised.

## Author a captured plugin bundle

Use a dedicated directory containing code and `harness.json`, as in [`examples/process-plugins`](../examples/process-plugins). Do not use the repository, working directory, data directory, credentials directory or logs as the bundle root.

```json
{
  "schemaVersion": 1,
  "plugins": [
    { "id": "process-greeting", "name": "./greeting.mjs" }
  ]
}
```

Each row accepts `id`, a relative `./` module `name`, and optional JSON `config`. IDs must be unique lowercase names. The host adds these rows through an official patch overlay after the normal profile layers, then requires every enabled Loader entry—including every declared candidate plugin—to activate before announcing readiness. It does not silently downgrade missing or failed plugins. Persistent user profile settings and ordinary ConfigEditor operations retain their official behavior.

The bundled example injects the official `webServer` service and registers `/cordis-process-greeting` with a Cordis-owned disposer. Edit `version.mjs` to see a nested module update. Relative ESM/CommonJS/JSON dependencies and native addons must be regular files inside the captured directory; symlinks are rejected. Node built-ins and the routed `@deepseek-ai/cordis` facade are host imports. Other bare dependencies must be materialized into the bundle or bundled ahead of time. Imports into arbitrary mutable files outside the artifact are rejected. The default official plugin installation is a separately verified host dependency, not duplicated into each candidate artifact.

Plugins are trusted code, with normal Node access. Module graph checks are a reproducibility boundary, not a security sandbox: code can still read files, use dynamic execution, make network requests or spawn children. An OS process restart does not prove that arbitrary detached child processes or external effects have been cleaned up.

## Update and failure behavior

The supervisor delegates lifecycle decisions to `ProcessDomain` from `@cordis-verus/compat-loader/process`:

1. Capture candidate bytes, including nested modules, and compare them with the current artifact without evaluating candidate code.
2. Ask the old process to run the **official** shutdown controller. Require a cleanup acknowledgement and a clean process exit before executing any candidate.
3. Start a fresh process from a private copy of the captured candidate. Confirm the actual official Web listener, a single root graph, and the enabled plugin roster.
4. If candidate startup fails and candidate cleanup succeeds, start the previously retained artifact in another fresh process. Report the rejected update even though the old version has recovered.

Recovery restores module/configuration artifact bytes. It does not rewind session files, database migrations, profile edits, network effects or filesystem writes made by a failed plugin. `DSH_HOME` and the workspace are intentionally outside the captured artifact; the launcher canonicalizes these paths and rejects either inside the bundle.

A failed, timed-out or unacknowledged cleanup prevents replacement. The official shutdown controller can exit even on a cleanup error; exit code zero alone is insufficient. The supervisor marks that outcome blocked or abandoned and never reports normal shutdown. The CLI stops automatic updates, reports the uncertainty and explicitly abandons the remaining process boundary when exiting. This is termination, not a successful plugin cleanup acknowledgement.

The watch loop polls the dedicated bundle (750 ms by default, `--interval` adjusts it). One scan/update runs at a time. Events accumulated while loading cause a final rescan, so a save during a replacement is not lost. After a rejected candidate is restored, the same bad digest is not retried until the source changes. Watching stops before disposal. Programmatic `start()` calls coalesce; an exception thrown by an `onReload` observer stops watching and is exposed as `supervisor.observerError`, separately from lifecycle cleanup errors.

## Trust, scope and verification

The normal launcher verifies the installed official/runtime bytes before initial load and each update. `ProcessDomain` pins the trusted host adapter's entry hash; the app separately pins `official-register.mjs`. Host/runtime upgrades require verification and a new supervisor instance. They are not part of a plugin-bundle update.

The real integration test uses an isolated credential-free environment and no model requests:

```sh
npm run official:process:test
```

It starts the real default Web application, exchanges its authentication token, checks the default `standard` preset, creates an official session, replaces a nested module, reconnects to the new process and verifies persisted session listing. It also tests failed-candidate cleanup and recovery from retained bytes, a cleanup failure that prevents candidate execution, and a change made during an active watch replacement. Separate controlled tests cover watcher coordination; they do not substitute for the real application tests. This is HTTP-level integration, not browser automation or release/cross-platform certification.

For core development only, `CORDIS_HARNESS_PROCESS_DOMAIN_SOURCE=/absolute/path/to/compat-loader/process.js` runs an explicit mixed-source preflight. It skips installed verification and the cross-installation facade import fixture; it must not be recorded as installed-artifact acceptance. Normal test commands use the installed package and exercise the real `@deepseek-ai/cordis` import.

The ordinary entry also supports [in-place JavaScript module reload](https://github.com/validation-engineering/cordis-verus/blob/main/docs/official-in-place-hmr.md) within its documented dependency and ownership boundaries. This supervisor provides a separate process boundary for application native addons and full environment replacement. Neither path establishes complete paper refinement, arbitrary third-party compatibility, automatic native ABI migration or zero-downtime updates.
