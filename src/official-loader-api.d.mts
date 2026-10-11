export {
  LoaderTransactions, installOfficialTransactions, officialTransaction,
  type OfficialEntryTree, type OfficialHmrTransactions,
} from './integrations/deepseek-loader.mjs';
import type { Context } from '@validation-engineering/cordis-compat-deepseek';

export const nativeModuleSpecifier: 'cordis:rust-module';
export interface NativeModuleUpdate {
  entryId: string;
  manifestPath: string;
  manifestSha256: string;
  fiberId: string;
  readyEntries: string[];
}
export function updateOfficialRustModule(
  ctx: Context, entryId: string, manifestPath: string,
  options?: { sha256?: string; readyEntries?: string[] },
): Promise<NativeModuleUpdate>;

export interface NativeWatchFailure {
  readonly phase: string;
  readonly attempt: number;
  readonly message: string;
  readonly code?: string;
  readonly details?: unknown;
}
export interface NativeWatchOutcome {
  readonly ok: boolean;
  readonly status: 'completed' | 'failed' | 'superseded' | 'closed';
  readonly phase: string;
  readonly attempt: number;
  readonly fingerprint: string | null;
  readonly superseded: number;
  readonly error?: NativeWatchFailure;
}
export interface NativeModuleWatcher {
  start(): Promise<NativeWatchOutcome>;
  buildNow(): Promise<NativeWatchOutcome>;
  close(): Promise<NativeWatchOutcome>;
  snapshot(): Readonly<{
    started: boolean; closed: boolean; closing: boolean; phase: string;
    attempts: number; appliedCount: number; superseded: number;
    observedFingerprint: string | null; appliedFingerprint: string | null;
    lastFailure: NativeWatchFailure | null; observerFailure: NativeWatchFailure | null;
    lastOutcome: NativeWatchOutcome | null;
  }>;
}
export type NativeModuleWatchOptions<T = unknown> = {
  entryId: string;
  readyEntries?: string[];
  cwd: string;
  watchPaths: string[];
  intervalMs?: number;
  artifact(result: Readonly<{ fingerprint: string; buildResult: T; attempt: number }>):
    { manifestPath: string; manifestSha256?: string }
    | PromiseLike<{ manifestPath: string; manifestSha256?: string }>;
  onEvent?(outcome: NativeWatchOutcome): unknown;
} & (
  { build(input: Readonly<{ cwd: string; fingerprint: string; attempt: number }>): T | PromiseLike<T>; command?: never }
  | { command: { file: string; args?: string[]; env?: Record<string, string | undefined> }; build?: never }
);
/** Host-owned watcher; close it before disposing the application Context. */
export function watchOfficialRustModule<T = unknown>(ctx: Context, options: NativeModuleWatchOptions<T>): NativeModuleWatcher;
