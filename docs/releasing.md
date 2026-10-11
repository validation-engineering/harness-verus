# Packaging and release acceptance

[简体中文](releasing.zh-CN.md)

The source checkout remains private to npm (`private: true`) and installs the
verified local runtime archives for development. `scripts/package-release.mjs`
creates the public package manifest, exact registry dependencies and production
shrinkwrap in a temporary packaging directory. Development always happens in the
current checkout; that directory is only an archive build output.

A candidate requires a committed core snapshot, matching universal npm archives,
and four successful core installation receipts. It also requires current local
official-workflow and compact-application acceptance records. The application
keeps its official DeepSeek package versions pinned. Packaging neither upgrades
upstream nor reruns or enlarges the kernel proof.

```sh
node scripts/package-release.mjs --core-release /path/to/accepted-core-release
node scripts/check-release.mjs --from-directory target/npm-release --output target/npm-release/local-installation.json
```

The first command writes `candidate.json` and the npm archive. It does not upload
anything. Install checks use a fresh consumer directory, an actual npm install,
the installed official CLI and real AgentLoop with a scripted provider, plus an
offline reinstall. They check that user data stays outside the installed package
and that changed application files are rejected. No paid model call is made.

Upload the archive and `candidate.json` to a GitHub draft release, then run the
**Published application installation** workflow against that exact application
commit. Its Linux x64, macOS ARM64, macOS x64 and Windows x64 receipts must match
the candidate bytes before publication. Publish the exact accepted archive with
`npm publish <archive> --access public --ignore-scripts`; npm may require the
publisher to complete browser authentication. Afterwards, run the same workflow
with `registry=true` to test actual registry downloads before publishing the
GitHub release. Never replace an existing package version or relabel a failed run.

These installation checks cover the official CLI entry and compact tool loop.
Full default Web, headless, Loader, HMR and Rust-extension acceptance has its own
[`official-validation-report.json`](official-validation-report.json), with an
explicit tested environment. Four install receipts do not imply four complete
Web/headless acceptance runs. JavaScript callbacks, I/O and model behavior do not
acquire a Verus proof through packaging.

Published entries verify the shipped application files, exact runtime interface
files and the accepted universal native manifest. Hashes establish consistency
with those records; they are not publisher signatures or a plugin sandbox.
Published installations use `~/.harness-verus` (`HARNESS_VERUS_HOME` overrides it),
while development checkouts retain `.cordis-harness`. `DSH_HOME` takes precedence
for official profile data.
