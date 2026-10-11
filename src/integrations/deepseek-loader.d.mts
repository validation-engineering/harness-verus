import type { Context } from '@validation-engineering/cordis-compat-deepseek';

/** Structural surface of the pinned official Harness Loader/Include classes. */
export interface OfficialEntryTree {
  ctx: object;
  root: { tree: OfficialEntryTree; data: unknown[] };
  store: Record<string, { fiber?: object; subtree?: OfficialEntryTree }>;
  entries(): Iterable<unknown>;
  getTasks(): Promise<unknown>[];
  await(): Promise<void>;
  resolve(id: string): unknown;
  resolveGroup(id: string | null): unknown;
  create(options: { name: string; [key: string]: any }, parent?: string | null, position?: number): Promise<string>;
  update(id: string, options: Record<string, any>, parent?: string | null, position?: number): Promise<void>;
  remove(id: string): void;
  write(): void;
}
export class LoaderTransactions {
  constructor(ctx: Context, tree: OfficialEntryTree);
  readonly ctx: Context;
  readonly tree: OfficialEntryTree;
  /** Number of successful create/update/remove operations. */
  readonly revision: number;
  /** Number of admitted operations, including queued or failed operations. */
  readonly requestedRevision: number;
  readonly lastFailure: { revision: number; operation: 'create' | 'update' | 'remove'; error: unknown } | undefined;
  readonly closed: boolean;
  /** Options are structured-cloned at admission. */
  create(options: { name: string; [key: string]: any }, parent?: string | null, position?: number): Promise<string>;
  update(id: string, options: Record<string, any>, parent?: string | null, position?: number): Promise<void>;
  remove(id: string): Promise<void>;
  /** Closes this adapter's admission and drains earlier work; does not dispose the tree. */
  close(): Promise<void>;
}

/** Installs transparent host-only domain coordination before mounting pinned official classes. */
export function installOfficialTransactions(classes: {
  Entry: Function; EntryGroup: Function; EntryTree: Function; Hmr: Function; ConfigEditor: Function;
}): void;

/** Additional structural HMR surface installed on the pinned official service. */
export interface OfficialHmrTransactions {
  /** Current retained cleanup/restoration failure; cleared when its journal recovers. */
  readonly lastReloadFailure: (Error & { code: string; details: { restored?: boolean; cacheChanged?: boolean } }) | undefined;
  /** Canonical file URLs changed since the last admitted batch. */
  readonly stashed: Set<string>;
  /** Joins an existing official transaction or admits through the domain FIFO. */
  partialReload(): Promise<void>;
  runExclusive<T>(operation: () => T | Promise<T>): Promise<T>;
}

/** Admit one host revision around official ConfigEditor/HMR calls and readiness
 * checks. Official methods join this exact coordinator after awaits; lifecycle
 * and config-change callbacks remain observers and cannot borrow its authority.
 * The callback must perform its own application-level restoration on failure.
 */
export function officialTransaction<T>(context: Context, execute: () => T | PromiseLike<T>): Promise<Awaited<T>>;
