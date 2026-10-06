// Explicit host-side edits for an owned official Loader/Include tree.
// Use the same installed facade instance as the official application.
export { LoaderTransactions, installOfficialTransactions, officialTransaction } from '../official-runtime/node_modules/@cordis-verus/compat-loader/harness.js';
export { nativeModuleSpecifier, updateOfficialRustModule, watchOfficialRustModule } from './official-native-modules.mjs';
