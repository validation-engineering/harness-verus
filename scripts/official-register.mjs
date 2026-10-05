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
