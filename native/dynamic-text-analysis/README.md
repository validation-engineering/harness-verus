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
