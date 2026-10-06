// Route only the Node host. Official browser bundles remain unchanged.
import '../official-runtime/node_modules/@cordis-verus/compat-harness/register.js';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

// ESM file-based Node Workers inherit execArgv. Keep the same host routing in those
// environments; explicit execArgv:[] data-verifier Workers remain upstream.
if (!process.execArgv.some((value, index, args) => value === import.meta.url || (value === '--import' && args[index + 1] === fileURLToPath(import.meta.url)))) {
  process.execArgv.push('--import', import.meta.url);
}

// A later official package resolver must never silently reinstate the JS host.
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:')) {
      const path = fileURLToPath(url).replaceAll('\\', '/');
      if (path.includes('/node_modules/@deepseek-ai/cordis/') && /\.[cm]?js$/.test(path)) {
        const error = new Error(`Original Cordis host implementation was loaded despite native routing: ${path}`);
        error.code = 'ERR_CORDIS_ORIGINAL_HOST';
        throw error;
      }
    }
    return nextLoad(url, context);
  },
});

// Keep published implementations intact and coordinate their host entrypoints
// before any default CLI composition can mount them. All use the routed facade.
const [{ installOfficialTransactions }, { Entry, EntryGroup, EntryTree }, { default: Hmr }, { ConfigEditor }] = await Promise.all([
  import('../official-runtime/node_modules/@cordis-verus/compat-loader/harness.js'),
  import('../official-runtime/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js'),
  import('../official-runtime/node_modules/@deepseek-ai/dsh-hmr/lib/index.js'),
  import('../official-runtime/node_modules/@deepseek-ai/dsh-config-editor/lib/index.js'),
]);
installOfficialTransactions({ Entry, EntryGroup, EntryTree, Hmr, ConfigEditor });

// Native modules are ordinary entries in the unchanged official Loader.
const [{ installOfficialRustModules }, { default: Schema }] = await Promise.all([
  import('../src/official-native-modules.mjs'),
  import('../official-runtime/node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
]);
installOfficialRustModules({ EntryTree, Schema });
