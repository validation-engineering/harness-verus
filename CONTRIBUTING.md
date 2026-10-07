# Contributing

Use Node 22.22 or newer; the recorded local baseline is 22.22.0 on macOS arm64.
Start with the exact runtime and source snapshot described in `docs/build.md`.

```sh
npm run verify
npm test
npm run demo
node scripts/record-validation.mjs
```

For official default workflows and JavaScript/Rust extensions, first prepare
`official:install` as described in the [official-mode guide](docs/official-mode.md),
then build both Rust extension variants and run the official acceptance suite:

```sh
npm run rust:build -- --offline
npm run rust:modules:build -- --offline
npm run official:check
node scripts/record-validation.mjs
```

Omit `--offline` from the build commands if Cargo dependencies are not cached.
Run the compact recorder last: its source fingerprint includes
`docs/official-validation-report.json`. Both reports identify exact source and
artifact inputs; changed inputs need fresh acceptance records.

Keep official source snapshots unchanged. Add custom functionality as a plugin and test registration, actual execution, cancellation and cleanup. Test failure outcomes; never turn a blocked cleanup into apparent success. Tests must not contact a paid model or read real credentials.

Configuration is JSON. Provider secrets belong to environment variables. Changes to `sources.lock.json` require an intentional source refresh and full revalidation. A successful local run does not establish every platform, full Harness compatibility or publication readiness.
