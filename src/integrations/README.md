# DeepSeek Harness application adapters

These adapters depend on the pinned official DeepSeek Harness application
classes. The application owns their implementation, type declarations and tests.

- `deepseek-loader.mjs`: official Loader/Include transactions, ConfigEditor edits,
  ownership checks and installation on the pinned official classes.
- `deepseek-hmr.mjs`: official watcher integration, observed Node module graphs,
  in-process replacement and recovery after actual cleanup.

The modules consume the published Cordis runtime and Loader APIs. They do not
implement another scheduler, change official package files or acquire authority
for arbitrary plugin callbacks. The runtime's domain admission, cleanup and
callback-isolation machinery remains in cordis-verus.

`@validation-engineering/cordis-compat-deepseek` selects compatibility with
`@deepseek-ai/cordis`; it is not this application. The user-facing application
package is `@validation-engineering/harness-verus`.

These are tested host integrations, not Verus-proved application code.
