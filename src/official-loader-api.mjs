// Explicit host-side edits for an owned official Loader/Include tree.
// Use the same installed facade instance as the official application.
export { LoaderTransactions, installOfficialTransactions, officialTransaction } from './integrations/deepseek-loader.mjs';
export { nativeModuleSpecifier, updateOfficialRustModule, watchOfficialRustModule } from './official-native-modules.mjs';
