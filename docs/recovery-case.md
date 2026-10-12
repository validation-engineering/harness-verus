# A failed plugin update, explained and reproduced

English · [简体中文](recovery-case.zh-CN.md)

**An update must not close a service while a failed consumer still needs it for cleanup.**
This case runs an unchanged official DeepSeek Harness AgentLoop, ToolRuntime and
Todo plugin on the Rust-backed runtime. A custom plugin owns a real file service
and a tool that needs that service during teardown. The consumer also attempts
lifecycle waits that would retain the service it is waiting to release; those
requests are rejected with an explicit dependency witness. Only the model provider is
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

### Lifecycle waits in the same run

The real consumer calls `provider.dispose()` from managed callbacks. Every attempt
must raise `REENTRANT_MUTATION`, with `operation`, `owner`, `generation`, `target`
and `retained` matching the actual committed file dependency. Each probe records
raw before/after snapshots and requires them to be equal: the refusal cannot
itself change retirement, cleanup or dependency state.

| Callback | Versions / attempts | What is checked |
| --- | --- | --- |
| Setup, from a completed effect's continuation | v1 and v2 | A completed inner invocation must not hide the still-live setup ancestor. |
| An owned task joined by the official tool call | v1 and v2 | A running tool-owned callback cannot await disposal of its retained file provider. The real tool then returns its version. |
| Checkpoint inverse | v1 failed attempt, v1 explicit retry, v2 shutdown | The same refusal applies during restoration, including retry. It does not prevent the checkpoint or later provider release. |

There are **seven rejected waits** across the seven update/recovery stages. After
external shutdown, both plugins and native invocation records must be empty.
`report.json` uses `cordis-harness.recovery-case/v2`; `waitRejections` retains every
observation. The standalone runner and validation recorder reject missing probes,
an incorrect retained-provider witness, changed snapshots or leaked invocation
records. These checks exercise the actual plugin API; they do not fabricate native
commands or replace the scheduler.

The output directory contains:

- `summary.md` and `report.json`: the stage results, **raw native snapshots**,
  inverse IDs/attempts, structured wait rejections, nested cleanup errors, and source/artifact hashes.
- `wait-events.jsonl`: the seven wait attempts, including their complete before/after
  snapshots and the actual errors naming the retained provider.
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
same seven stages and their lifecycle wait checks. It copies neither `node_modules` nor a sibling core checkout.
The temporary installation is removed after its logs and case evidence have been
saved. The local npm cache supplies pinned registry packages. With a cold cache,
use `npm run reproduce:recovery -- --online`; this permits dependency downloads,
but the model remains scripted.

The command prints the archive and evidence paths. `reproduction.json` records
the platform, exact commands, hashes, installation policy and result. The
validation recorder also runs this independent installation and binds its archive,
logs and case output in [the compact acceptance record](validation-report.json).

Give the archive and its separately obtained checksum to a reviewer. The reviewer
needs **Node, npm and tar** on the archive's platform and architecture. Use the
exact Node version in `recovery-bundle.json`; this iteration was tested with
**Node 22.22.0 on macOS ARM64** (package minimum: Node 22.22.0). No Rust/Verus installation,
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

The paper's §4.2.2, Definition 54 and L-Unload (pp.36–37) retain the committed
view during restoration and discard it last. The source identity is the exact
file fingerprint in `sources.lock.json` and the generated report. `baseCommit`
is metadata: an imported development snapshot may include verified, uncommitted
changes. It must not be treated as the identity of those sources.

| Paper / protocol obligation | Executable core contract | Evidence here |
| --- | --- | --- |
| BindingPersistence | `Kernel::begin_cleanup` preserves committed bindings; `finish_cleanup` releases them only through guarded completion. | Failed consumer's committed dependency still names the retained provider. |
| RestorationGuard | A provider relied upon by a committed consumer cannot start restoration. | Provider reports `CommittedConsumers`; its file remains available for the retry, and closes after consumer flush. |
| Report before release | `LifecycleActions` requires the exact accepted cleanup report before release; a failed outcome cannot authorize finish. | Real callback error remains visible; old consumer/provider are retained, then removed after successful explicit retry. |
| Fresh retry and old-ticket rejection | `retry_cleanup` issues a fresh action; `consumed_ticket_never_returns` rejects later use of an old receipt. | The case observes the explicit retry and attempt count. Stale-ticket rejection is checked in the core protocol/regressions; this application case does not forge receipts. |
| Host wait policy supporting dependency retention (§4.2.2, Definition 54, Theorem 70) | `Kernel::check_wait` finds a retained dependency in the target's subtree; `InvocationLedger::check_wait` checks every supplied live scope. | Seven actual calls are rejected without mutation. A completed effect cannot conceal live setup. This is an additional host policy, not a proof of Theorem 73's global progress obligations. |

The bundle includes **19 selected core review files** under
`.vendor/cordis/provenance/review/`, preserving their original paths. Start with:

- `docs/cleanup-protocol.md` and `docs/cases/reentrant-wait.md` (Chinese versions included);
- `crates/cordis-kernel/src/cleanup_protocol.rs`, `wait_guard.rs`,
  `request_ledger.rs` and `invocation_ledger.rs` for executable contracts and proofs;
- `crates/cordis-driver/src/lib.rs` and `packages/compat-cordis/runtime.js` for the
  native command dispatcher and actual JS callback/wait paths;
- `docs/paper-review-guide.md` for the wider paper audit route.

[`core-review.mjs`](../scripts/core-review.mjs) binds every selected file to the
**same development report** recorded for the installed artifacts. Changing a
review source and updating only the bundle manifest still fails validation.
The included toolchain and upstream locks identify the proof toolchain and paper
snapshot. This is a review subset, not a complete source/build/proof closure;
follow the core repository's instructions for an independent Verus run.

The runtime executes the checked Rust functions with proof data erased. The JS
host still decides when callbacks begin/end, supplies outcomes, and preserves
AsyncLocalStorage ancestry. The native ledger verifies the supplied handles;
it cannot detect an ancestor omitted by that host. Integration tests cover these
paths; they are not a whole-host refinement proof. This demo consumes recorded
development artifacts and neither reruns Verus nor expands the proven boundary.

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
