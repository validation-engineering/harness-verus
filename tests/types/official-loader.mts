import { Context } from '@validation-engineering/cordis-compat-deepseek';
const context = new Context();

import { LoaderTransactions, installOfficialTransactions, type OfficialEntryTree } from '@validation-engineering/harness-verus/official-loader-api';
declare const officialTree: OfficialEntryTree;
const transactions = new LoaderTransactions(context, officialTree);
const officialId: string = await transactions.create({ name: 'cordis:probe', config: { enabled: true } });
await transactions.update(officialId, { disabled: undefined });
await transactions.remove(officialId);
await transactions.close();
const revision: number = transactions.revision;
void revision;
// @ts-expect-error New official entries require a module name.
transactions.create({ config: {} });
// @ts-expect-error Revision metadata cannot be assigned by callers.
transactions.revision = 3;

declare const officialClasses: Parameters<typeof installOfficialTransactions>[0];
installOfficialTransactions(officialClasses);
// @ts-expect-error Every pinned official class is required for transparent installation.
installOfficialTransactions({ Entry: class {} });

const ctx = context;
import { officialTransaction } from '@validation-engineering/harness-verus/official-loader-api';
const result: number = await officialTransaction(ctx, async () => 42);
void result;
// @ts-expect-error Only a host operation callback can form an official transaction.
officialTransaction(ctx, 42);

import { nativeModuleSpecifier, updateOfficialRustModule, watchOfficialRustModule } from '@validation-engineering/harness-verus/official-loader-api';
const specifier: 'cordis:rust-module' = nativeModuleSpecifier;
void specifier;
const update = await updateOfficialRustModule(ctx, 'provider', '/path/to/manifest.json', { readyEntries: ['consumer'] });
const id: string = update.fiberId;
void id;
const watcher = watchOfficialRustModule(ctx, {
  entryId: 'provider', cwd: '.', watchPaths: ['native/src'],
  build: async () => ({ manifestPath: '/path/to/manifest.json' }),
  artifact: result => result.buildResult,
});
await watcher.close();
// @ts-expect-error A watcher needs a build callback or a command.
watchOfficialRustModule(ctx, { entryId: 'provider', cwd: '.', watchPaths: ['src'], artifact: () => ({ manifestPath: 'module.json' }) });
// @ts-expect-error Consumer readiness uses entry IDs.
updateOfficialRustModule(ctx, 'provider', 'module.json', { readyEntries: [3] });
