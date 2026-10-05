# Working on cordis-harness

- This repository composes official, pinned DeepSeek Harness plugins on the Rust-backed Cordis runtime. Keep official sources unchanged and record build input provenance.
- Do not replace the official agent loop with a mock. Offline demonstrations may replace only the LLM provider, explicitly identified as scripted.
- Use one @cordis-verus/compat-harness Context graph. Do not import the upstream JavaScript scheduler or create a hidden second runtime.
- Plugin teardown must await in-flight work and report real failures. Tests do not prove arbitrary callbacks or complete Harness compatibility.
- Keep credentials in environment variables, out of transcripts, logs and tracked files. Never make a paid model request as part of tests.
- Validate changes with npm test and the offline CLI demo. Document local prerequisites and the exact tested platform; do not claim release or cross-platform acceptance from a local run.

- The official-mode entry must preserve the published CLI, default Web/standard composition and official Loader. Replace only Node-host Cordis; browser Cordis remains upstream.
- Run `npm run official:check` for official-mode changes after installing verified artifacts. Keep upstream and native outcomes separate, and never silently downgrade missing/failed default plugins.
