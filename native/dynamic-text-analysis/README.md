# Dynamically replaceable Rust text analysis

This independent crate uses only `cordis-plugin-api` and `serde_json`. It does not
embed another Cordis Driver or Node addon. The resident host loads its `cdylib`
examples through the versioned native ABI, keeps each instance bound to its code
revision, and coordinates replacement in its existing lifecycle graph.

The `harness.dynamic-text-analysis` factory exposes `rustDynamicText.analyze(text)`.
It accepts exactly one string and returns UTF-8 byte, Unicode scalar, whitespace
word, and LF/CRLF line counts with `backend: "rust-dynamic"` and `revision`.
The input limit is 128 KiB of UTF-8; the ABI separately caps encoded messages.

Examples `dynamic_text_v1` and `dynamic_text_v2` implement the same service using
separate library images. `dynamic_text_fail` fails setup to exercise candidate
cleanup and restoration. Setup, cleanup and calls each suspend once and wake
through the resident host, exercising the asynchronous ABI without external I/O.

Build with `node scripts/build-rust-modules.mjs --offline` from the project root.
This requires installed approved Cordis artifacts and the matching sibling
`cordis-verus` sources. The build records exact source, SDK, compiler-profile and
artifact hashes; `node scripts/verify-rust-modules.mjs` rechecks that evidence.
Execution and failure-recovery acceptance are recorded separately by app tests.
Native images remain mapped after retirement; physical unloading is unsupported.

The opt-in `harness.dynamic-policy-text-analysis` factory declares the JS service
`textPolicy` and publishes `rustPolicyText.analyze(text)`. The same independent
Rust library awaits `PluginContext::call("textPolicy", "normalize", json!([text]))`,
then validates the response and counts the normalized text. Results also report
`policyRevision`; the original factory and default tool output are unchanged.
Setup and cleanup call the JS provider's `lifecycle` method. Cleanup still uses
the provider committed by that activation, before its JS inverse runs.

See `examples/official/text-policy.mjs`, `rust-policy-text-analysis.mjs`, and
`native-policy-profile.mjs` for a normal JS provider, official tool consumer, and
ready-to-merge official profile entries. The outer native Loader entry also
declares `inject: ["textPolicy"]`, so it waits for the provider even when imports
and setup are asynchronous. Its factory descriptor retains the actual reverse
call authority. Only external dependencies belong on the outer entry; adding
services produced by its own factory children would make it wait for children
that cannot yet be created. Declaration order alone is insufficient: the wrapper requires
every configured native child to activate when its own setup runs.
An already-started JS Promise must actually settle before native cleanup; tool
cancellation does not automatically abort arbitrary JS work.

The optional `harness.dynamic-text-resources` factory publishes
`rustTextResources.chunks(text, chunkCharacters)` and `session()`. Chunks are
pulled lazily at Unicode scalar boundaries (1–4096 scalars, at most 128 KiB input).
The owned session exposes asynchronous `append(string)` and `snapshot()` methods.
It tracks bytes, scalars, words, LF/CRLF lines and chunk count incrementally without
retaining prior text; total admitted text is capped at 128 KiB. All cursor/state
objects and futures remain in this cdylib.

The factory declares the ordinary JS `textResourceAudit` service. The optional
[official profile generator](../../examples/official/native-resource-profile.mjs)
loads its bounded metadata-only provider, the native factory and a real official
ToolRuntime bridge. The outer Loader row also declares this external dependency.
The default text and policy factories remain unchanged. Resource cancellation and
close join issued audit calls before releasing state; an arbitrary JS Promise
cannot be forcibly completed. See the [usage guide](../../docs/native-rust-modules.md).


The optional `harness.dynamic-js-text-pipeline` factory reverses the direction:
`rustJsTextPipeline.analyze(text, chunkCharacters)` opens the declared JS
`textPipeline` service's pull stream, borrowed policy and owned analysis session.
It validates bounded chunks and sink snapshots, retaining only running sizes.
The JS sink accumulates metrics without storing prior text. Capabilities remain
scoped to this Rust action; the action journal drains unclosed resources, while
reported close failures stay visible for lifecycle cleanup retry.

Generate its three official Loader rows with
`node examples/official/native-js-pipeline-profile.mjs`. The tool is
`rust_js_text_analyze`; default chunk size is 1024 Unicode scalar values.
The existing default/policy/resource factories and tools remain available.
User cancellation stops result admission and waits for actual work; retirement
uses framework cancellation and still joins in-flight JS promises. Neither
mechanism promises state rollback, automatic AbortSignal delivery, or physical
library unloading.


The opt-in `harness.dynamic-text-fleet` factory publishes `rustTextFleet`.
Its `create(name)` action retains a runtime `WorkerFactory` in this library and
uses `PluginContext::publish` to allocate a real owned provider child exposing
`rustFleet_<name>.analyze(text)`. Each activation creates a fresh instance.
The manager stores episode-owned `ChildHandle` capabilities across actions;
status, readiness, retirement, actual removal and cleanup retry use the current
action's context. Failed creation or cleanup retains the handle until removal.

`node examples/official/native-fleet-profile.mjs` generates three official Loader
rows. The JS bridge mounts a separate real consumer for each worker and registers
`rust_text_<name>_analyze`; administrative tools create, list and remove workers.
Only the consumer injects its worker service. Removal drains that consumer before
requesting native retirement and joining actual removal. The bounded JS audit
service records metadata rather than text. No JS registry dispatches worker calls.

Initial names default to `notes` and `code`, configurable via the bridge's
`workers` array. That array seeds only a new, unseeded manager. A bridge-only
reload drains its consumers and reconnects the existing catalog, including an
intentionally empty catalog; it does not remove native workers or reseed defaults.
Names use `[a-z][a-z0-9_]{0,31}`; at most 16 workers, including failed entries
awaiting cleanup, can be retained at once. The SDK separately bounds cumulative
child/factory attempts within an activation.

Native replacement defaults to cold startup. Opt in with
`node examples/official/native-fleet-profile.mjs --migrate`, which adds
`state: "migrate"` to the manager recipe. Its pure synchronous checkpoint exports
only a bounded `{ "workers": ["notes", "review"] }` catalog, after real in-flight
work and children drain. Schema `cordis-harness/text-fleet` uses version 1 for v1
and version 2 for v2; v2 accepts both. Restore validates the full DTO before setup
republishes fresh owned children. The JS bridge then joins their readiness and
recreates real tool consumers. Neither ChildHandle values, node IDs, child Rust
memory nor JS resources are serialized. Cleanup preserves the logical catalog;
only a successful user remove deletes a name.

The ordinary official ConfigEditor lifecycle performs capture/restore. The host
update coordinator also pins the original source through required-consumer
validation. Upgrade and rollback both require explicit acceptance of all selected
consumers before releasing that source. If rollback's native provider activates
but a required consumer fails, the update reports incomplete recovery and retains
the original checkpoint for a later attempt. Neither the candidate nor a rejected
rollback can replace it with mutated state. Checkpoints stay in process memory, not profile
YAML, and do not promise persistence, external I/O rollback or physical unload.
The default factory and existing tools remain unchanged. See the
[usage guide](../../docs/native-rust-modules.md) for exact tools and teardown rules.
