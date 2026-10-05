# Rust text-analysis backend

This user addon registers `harness.text-analysis` with the public `cordis-node`
factory SDK. The existing official Harness host selects its `createDriver()`;
`ctx.rustPlugin('harness.text-analysis')` then mounts a normal Fiber in that graph.
The addon never creates a second Context or Runtime.

The service `rustTextAnalysis.analyze(text)` returns a Promise of:

```json
{"backend":"rust","version":"0.1.0","bytes":24,"characters":17,"lines":2,"words":4}
```

This example is the result for `Hello 世界\r\nRust 🦀\n`. Bytes count UTF-8 bytes;
characters count Unicode scalar values; words use Unicode whitespace; lines use
Rust `str.lines()` (empty text has zero lines, a trailing newline adds no empty
line, and CRLF is a single ending). One string argument is required, with a
1,048,576-byte maximum. Configuration must be `null` or `{}`. The implementation
performs bounded CPU work in the Rust Future; it does not read files, access the
network, retain background work, or need an I/O reactor.

The official JS bridge should load the factory and register the tool from a
consumer that injects `rustTextAnalysis`. That creates a real dependency, so tool
cleanup precedes backend teardown. Do not pass an arbitrary addon path through an
unverified environment override; the explicit extension entry validates this
artifact before selecting it.

## Build and verify

Keep the matching `cordis-verus` checkout next to this repository. The Cargo path
dependency is intentionally explicit because `cordis-node` is not published.
Install the Rust channel pinned by the core `toolchain.lock.json`, Cargo and
Node >=22.22.0. Bootstrap the app and install the official runtime first.

```sh
node scripts/build-rust-addon.mjs --offline
node scripts/verify-rust-addon.mjs
node --test tests/official/rust-addon.test.mjs
```

The builder uses the committed Cargo.lock and the core's pinned Rust toolchain.
It requires the sibling core source hashes to match the app's approved native
source provenance, uses Cargo's actual compiler-artifact path, loads the result,
and checks the declared factory. `.cache/rust-addon/build.json` records source,
lock, platform, Node environment and artifact hashes. No native binary or build
report is committed. `verifyRustAddon()` also checks the installed official-mode
Cordis facade against the approved distribution; a packaged verifier does not
need the sibling Rust checkout. Source or artifact changes require a fresh build.

Validation is local platform evidence. This example does not claim cross-platform
release acceptance or formal proof of arbitrary Rust/JavaScript callbacks.

The addon build uses Cargo release optimization level 3 with debug assertions
and overflow checks retained. The build checks the actual compiler profile and
records it with the binary and source hashes.
