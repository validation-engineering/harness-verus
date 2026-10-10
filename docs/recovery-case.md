# A failed plugin update, explained and reproduced

English · [简体中文](recovery-case.zh-CN.md)

**An update must not close a service while a failed consumer still needs it for cleanup.**
This case runs an unchanged official DeepSeek Harness AgentLoop, ToolRuntime and
Todo plugin on the Rust-backed runtime. A custom plugin owns a real file service
and a tool that needs that service during teardown. Only the model provider is
scripted; no model account or paid request is needed.

## Run the case

After the compact application's [build and installation](build.md):

```sh
npm run demo:recovery
```

The command verifies installed artifacts first, then runs seven stages:

| Stage | What actually happens | What the reviewer should see |
| --- | --- | --- |
| `initial-turn` | Official AgentLoop calls `todo_write`, `recovery_version`, then `todo_write`. | The persisted tool result says `v1`; the Todo is complete. |
| `update-failed` | Request v2. The old consumer tries to write its final checkpoint, but a directory occupies that file path. | A real filesystem error, `CleanupFailed` on the consumer, and `CommittedConsumers` on the still-open file provider. |
| `update-blocked` | Request v2 again without an explicit cleanup retry. | The request is rejected; the graph and event log are unchanged. No v2 plugin has started. |
| `fault-repaired` | Remove the empty directory obstructing the checkpoint. | Repair changes the external condition, not the retained lifecycle commitment. |
| `retry-succeeded` | Call `retryPluginCleanup('recovery')`. | The checkpoint succeeds using the retained file service; only then does that provider close. Two attempts, one successful checkpoint, one execution of the already-successful marker inverse. |
| `updated-turn` | Explicitly resubmit v2 with `loadPlugin`. | The same official loop calls the v2 tool and completes its Todo. |
| `closed` | Close the Harness. | Native diagnostics contain zero remaining plugins. |

The failed update does not commit or remember v2 as desired state. Cleanup retry
releases the retained old instance; the example then submits the new revision
explicitly. Plugin mutations run at the compact application's quiescent turn
boundary. This case does not update a plugin during a running tool call.

The output directory contains:

- `summary.md` and `report.json`: the stage results, **raw native snapshots**,
  inverse IDs/attempts, nested cleanup errors, and source/artifact hashes.
- `before-update.json`, `after-update.json` and `sessions/`: actual official
  session events and tool results before and after replacement.
- `plugin-events.jsonl`, `journal-v1.jsonl`, `journal-v2.jsonl` and checkpoint
  files: the real I/O and cleanup order.

For automation, use `node scripts/run-recovery-case.mjs --json`. Add
`--output NEW_DIRECTORY` to keep evidence at a chosen path. A failed assertion
exits nonzero and the case retains its failure report; it is not converted into
a successful demo. Every run uses an empty directory, without touching the user's
workspace or existing sessions.

## Reproduce outside the development checkout

An artifact producer with a verified compact build can run:

```sh
npm run reproduce:recovery
```

This produces a `.tar.gz` review bundle and `SHA256SUMS`, extracts it into a fresh
temporary directory outside the repository, runs **fresh `npm ci --ignore-scripts
--offline`**, verifies the installed runtime and build hashes, then executes the
same seven stages. It copies neither `node_modules` nor a sibling core checkout.
The temporary installation is removed after its logs and case evidence have been
saved. The local npm cache supplies pinned registry packages. With a cold cache,
use `npm run reproduce:recovery -- --online`; this permits dependency downloads,
but the model remains scripted.

The command prints the archive and evidence paths. `reproduction.json` records
the platform, exact commands, hashes, installation policy and result. The
validation recorder also runs this independent installation and binds its archive,
logs and case output in [the compact acceptance record](validation-report.json).

Give the archive and its separately obtained checksum to a reviewer. The reviewer
needs **Node 22.22.0, npm and tar** on the archive's platform and architecture;
currently the recorded local case is **macOS ARM64**. No Rust/Verus installation,
source compilation, core checkout or model credential is required:

```sh
# In the directory containing the archive and SHA256SUMS:
shasum -a 256 -c SHA256SUMS
tar -xzf cordis-harness-recovery-darwin-arm64.tar.gz
cd cordis-harness-recovery
node scripts/recovery-evidence.mjs
npm ci --ignore-scripts --include=dev --include=optional --no-audit --no-fund
node scripts/verify-install.mjs
npm run demo:recovery
```

Add `--offline` to `npm ci` when its registry packages are cached. Runtime
archives are included. The prebuilt application includes only its used official
source closure and the upstream source manifest, not a complete source checkout.
Build-tool packages are installed to check the recorded build inputs; no compiler
is invoked. Use the repository's build guide for a full rebuild or the official
Web/standard application. Do not run `npm run build` inside this reduced bundle.

The manifest rejects missing, changed, unrecorded or symlinked source files and
binds runtime tarballs and build outputs. Installed artifact verification also
rejects a second upstream Node scheduler and changed native package files.
These hashes establish consistency, not publisher authentication. This is a
**development review bundle**, not a signed release. A fresh local installation
demonstrates portability under the recorded conditions; it is not a claim that
an external person or another platform has reproduced the result. When sharing
results, include the archive checksum, Node/platform/architecture, `report.json`,
session transcripts and any nonzero command logs.

## From the observation to the checked code

This case uses core commit
[`e69a1d5`](https://github.com/validation-engineering/cordis-verus/tree/e69a1d546a13dcf573a1a1e0b8cb692ee416250f).
The exact identity is the file fingerprint in `sources.lock.json` and the generated
report, not the short commit name alone. The paper's §4.2.2, Definition 54 and
L-Unload (pp.36–37) retain the committed view during restoration and discard it
last. The following connects those review obligations to this concrete run:

| Paper / protocol obligation | Executable core contract | Evidence here |
| --- | --- | --- |
| BindingPersistence | `Kernel::begin_cleanup` preserves committed bindings; `finish_cleanup` releases them only through guarded completion. | Failed consumer's committed dependency still names the retained provider. |
| RestorationGuard | A provider relied upon by a committed consumer cannot start restoration. | Provider reports `CommittedConsumers`; its file remains available for the retry, and closes after consumer flush. |
| Report before release | `LifecycleActions` requires the exact accepted cleanup report before release; a failed outcome cannot authorize finish. | Real callback error remains visible; old consumer/provider are retained, then removed after successful explicit retry. |
| Fresh retry and old-ticket rejection | `retry_cleanup` issues a fresh action; `consumed_ticket_never_returns` rejects later use of an old receipt. | The case observes the explicit retry and attempt count. Stale-ticket rejection is checked in the core protocol/regressions; this application case does not forge receipts. |

Read the pinned
[cleanup protocol](https://github.com/validation-engineering/cordis-verus/blob/e69a1d546a13dcf573a1a1e0b8cb692ee416250f/docs/cleanup-protocol.md),
[production protocol dispatcher and proofs](https://github.com/validation-engineering/cordis-verus/blob/e69a1d546a13dcf573a1a1e0b8cb692ee416250f/crates/cordis-kernel/src/cleanup_protocol.rs),
and [paper review guide](https://github.com/validation-engineering/cordis-verus/blob/e69a1d546a13dcf573a1a1e0b8cb692ee416250f/docs/paper-review-guide.md).
The runtime runs the checked Rust functions with proof data erased. The JS host
invokes callbacks and supplies outcomes to that protocol; it is not itself fully
Verus-verified. This demo consumes recorded development artifacts and does not
rerun Verus or expand the proven boundary.

The real-case regression also exposed a Harness integration bug: child disposal
could reject before its parent's structural cleanup had finished reporting the
same failure. An immediate retry could then surface the previous parent's error.
[`PluginManager`](../src/plugin-manager.mjs) now awaits settlement of those
already-issued lifecycle actions, retains all reported errors, and only then
exposes the blocked entry for retry. Settlement does not retry the failed inverse.
[`recovery.test.mjs`](../tests/recovery.test.mjs) checks that the first explicit
retry succeeds after repairing the fault, without an arbitrary delay.

## Scope of the result

This is a complete finite example of update → failure → retained dependency →
diagnosed blocking → repair → retry → working replacement → shutdown. It uses
the compact composition, not the default Web/standard application or official
Loader HMR. The [official acceptance record](official-validation-report.json)
covers those separate workflows.

The producer runs a selected, known filesystem failure before the checkpoint
write succeeds. Retry safety after arbitrary partial external writes, process
crashes, malicious plugins, all host interleavings or arbitrary model output is
not established. The one-shot marker checks that this JS host does not replay
already-successful inverses; it is not a general exactly-once I/O theorem. The
native protocol's finite-prefix safety does not imply fair scheduling or eventual
callback completion. Neither this demonstration nor its reproduction closes the
paper's remaining general refinement, termination or confluence obligations.
