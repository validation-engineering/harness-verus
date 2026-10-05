# Contributing

Use Node 22.22 or newer; the recorded local baseline is 22.22.0 on macOS arm64.
Start with the exact runtime and source snapshot described in `docs/build.md`.

```sh
npm run verify
npm test
npm run demo
node scripts/record-validation.mjs
```

Keep official source snapshots unchanged. Add custom functionality as a plugin and test registration, actual execution, cancellation and cleanup. Test failure outcomes; never turn a blocked cleanup into apparent success. Tests must not contact a paid model or read real credentials.

Configuration is JSON. Provider secrets belong to environment variables. Changes to `sources.lock.json` require an intentional source refresh and full revalidation. A successful local run does not establish every platform, full Harness compatibility or publication readiness.
