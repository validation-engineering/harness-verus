# Tools in the official composition

The examples in [`examples/official`](../examples/official) are ordinary Cordis plugins loaded by the installed official Loader. They use the original `@deepseek-ai/dsh-tools` API, not the separately built slim CLI bundle. The official AgentLoop, standard preset, permissions, tools, settings, and JSONL persistence remain in place.

## Run the examples

Prepare the official runtime as described in [the build guide](build.md), keeping the matching core checkout beside this repository. Then:

```sh
npm run rust:build -- --offline
npm run rust:verify
npm run official:extensions
# Or: npm run official:extensions -- headless --json "Call cordis_greet for Ada and analyze Hello with rust_text_analyze"
```

Omit `--offline` from the build when Cargo dependencies are not cached. Interactive use requires your own model configuration. The extension launcher defaults to `.cordis-harness/official-extensions`, separate from the ordinary official entry. It initializes new Web/headless profiles with the original bundles plus the two extension entries; existing profile directories and user edits are preserved. Use the official Settings and Plugins panels to configure or enable them. Explicit `DSH_HOME` selects another directory.

The launcher verifies the ordinary official installation before selecting the separately verified addon. `npm run official` keeps its existing runtime selection; no ambient native-binding override is accepted by the extension entry.

## JavaScript tool

[`greeting.mjs`](../examples/official/greeting.mjs) registers `cordis_greet({ name, wait_ms? })`. It returns `{ greeting, backend: "javascript" }`. Names and the configurable prefix are bounded to 200 JavaScript string code units; the optional delay is an integer from 0 through 5,000 milliseconds. The delay makes cancellation observable without network or filesystem access.

`Config.prefix` uses the official Schema `volatile()` API. The official Settings form can update it without restarting the plugin. Execution reads the current value through `config.prefix.get()`. Invalid settings are rejected by the official ConfigEditor before the live value changes. Registrations belong to the plugin context. Its inverse closes admission, aborts pending delays, and awaits all admitted calls before cleanup finishes.

The repository-local [`official-plugin-api.mjs`](../src/official-plugin-api.mjs) imports the ESM entries from the pinned official installation. A separately packaged plugin should import `defineTool` from `@deepseek-ai/dsh-tools` and Schema from `@deepseek-ai/schemastery`, and declare the corresponding official packages as peer dependencies. It must not import the slim `@cordis-harness/app/plugin-api` into this composition or construct another Context.

## Loader configuration

An official profile lives under `$DSH_HOME/profiles/<profile>/`. Its `cordis.patch.yml` can add an extension:

```yaml
- insert:
    - id: cordis-greeting
      name: file:///absolute/path/to/cordis-harness/examples/official/greeting.mjs
```

Use a real absolute file URL or an installed package specifier. Existing profile entries and patches should be retained. The official `initProfile` and `PROFILE_TEMPLATES` APIs can initialize a profile with the shipped Web or headless bundles before adding this user patch.

A `--patch` overlay also works for fixed configuration, but it takes priority over profile edits. For editable settings and enablement, put the insertion in the profile's own patch. Launcher flags precede app flags: `web --patch <file> --no-open`, not `web --no-open --patch <file>`. The slim `harness.config.json` does not configure official profiles.

## Rust tool

[`rust-text-analysis.mjs`](../examples/official/rust-text-analysis.mjs) mounts the `harness.text-analysis` Rust factory and registers `rust_text_analyze({ text })`. The factory must be present in the verified native addon selected before the official Context is created. Loading the bridge with an unextended host fails explicitly.

The bridge mounts a child consumer declaring `rustTextAnalysis` as a dependency. The consumer registers the tool and reads the Rust service through its own context, so the native lifecycle graph orders tool cleanup before provider cleanup. There is one official application Context, not a second Rust application or an RPC subprocess. See the [addon source and build contract](../native/text-analysis/README.md).

The Rust implementation accepts at most 1 MiB of UTF-8 and returns `backend`, `version`, `bytes`, `characters`, `lines`, and `words`. Characters are Unicode scalar values, not grapheme clusters; lines follow Rust `str.lines()`. This bounded pure calculation checks the tool AbortSignal before and after its call; it does not claim to interrupt an arbitrary Rust future midway through execution.

## Executable acceptance

After preparing verified official runtime artifacts:

```sh
node scripts/check-official-extensions.mjs --backend upstream
node scripts/check-official-extensions.mjs --backend native
node scripts/check-official-extensions.mjs --backend native --rust
```

The Rust command additionally requires the verified text-analysis addon and `official-extensions-register.mjs`. An explicit `--register <path>` is a development-only runtime override and is labeled as such in the report. `CORDIS_NATIVE_BINDING` in the launching environment is rejected.

These checks retain the full official composition, adding only the extension entries and a provider/model patch to a loopback HTTP/SSE fixture. They exercise:

- Real headless tool calls and final output; with `--rust`, both JavaScript and Rust tools run.
- Real Web Session API turns on one continuing Session with the default `standard` preset; the existing Agent must observe configuration and tool changes.
- Official Settings rejection of invalid configuration and successful live updates.
- A tool execution failure followed by another successful turn.
- Session cancellation, with the cancelled tool result checked through the official durable JSONL codec.
- Official PluginManager disablement, absence from the next actual model request, and successful use after re-enablement.
- One root Context and complete plugin removal at shutdown, with no forced process termination.

Reports and redacted logs are under `.cache/official-extensions/`; they bind the checked script, plugin inputs, runtime lock, preload, and Rust addon evidence where applicable. The scripts use isolated homes and workspaces, allowlisted environment variables, fake credentials, and loopback model endpoints.

This is HTTP-level Web integration, not automated browser execution or live paid-model testing. Invalid-configuration rejection and recovery from a failed tool call are tested; this does not prove rollback of arbitrary plugin startup/cleanup failures. Full dependency-graph HMR, arbitrary third-party plugins, and complete host refinement remain separate work.
