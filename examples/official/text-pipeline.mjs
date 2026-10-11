import { Schema } from '../../src/official-plugin-api.mjs';
import { adaptObject } from '@validation-engineering/cordis';

export const name = 'cordis-harness-text-pipeline';
export const Config = Schema.object({ revision: Schema.string().min(1).max(100).default('js-pipeline-v1') });
export const MAX_TEXT_BYTES = 128 * 1024;
export const MAX_CHUNK_CHARACTERS = 4096;
const whitespace = /\p{White_Space}/u;
const loneSurrogate = /[\uD800-\uDFFF]/u;
function validateText(text) {
  if (typeof text !== 'string' || loneSurrogate.test(text) || Buffer.byteLength(text) > MAX_TEXT_BYTES) {
    throw new Error('Expected Unicode scalar text of at most 128 KiB');
  }
}

/** Counts new input only. Neither the sink nor its snapshots retain text. */
export function createTextMetrics(revision) {
  let bytes = 0, characters = 0, words = 0, lineBreaks = 0, chunks = 0;
  let previousNonWhitespace = false, endsWithNewline = false;
  const snapshot = () => ({ providerRevision: revision, bytes, characters, words,
    lines: lineBreaks + Number(bytes > 0 && !endsWithNewline), chunks });
  return {
    snapshot,
    append(text) {
      validateText(text);
      const size = Buffer.byteLength(text);
      if (size > MAX_TEXT_BYTES - bytes) throw new Error('Text session exceeds 128 KiB');
      for (const character of text) {
        const nonWhitespace = !whitespace.test(character);
        words += Number(nonWhitespace && !previousNonWhitespace);
        previousNonWhitespace = nonWhitespace;
        endsWithNewline = character === '\n';
        lineBreaks += Number(endsWithNewline);
        characters++;
      }
      bytes += size; chunks++;
      return snapshot();
    },
  };
}

/** A JS stream producer and explicit object owner in the ordinary Cordis graph.
 * Hooks are trusted host integration points, never persisted configuration.
 */
export function createTextPipeline({ onEvent, beforePull, beforeAppend, beforeClose } = {}) {
  return { name, Config, async apply(ctx, config) {
    const streams = new Set(), sessions = new Set(), active = new Set(), recent = [];
    let closing = false, policyAlive = true, sequence = 0, nextId = 0;
    const record = async (type, details = {}) => {
      const event = Object.freeze({ type, providerRevision: config.revision, sequence: ++sequence, ...details });
      recent.push(event); if (recent.length > 64) recent.shift();
      await onEvent?.(event);
    };
    const track = action => {
      const result = Promise.resolve().then(action);
      active.add(result);
      const finish = () => active.delete(result);
      result.then(finish, finish);
      return result;
    };
    const admit = () => { if (closing) throw new Error('Text pipeline is closing'); };
    await record('provider-setup');
    const policy = { async snapshot() {
      if (!policyAlive) throw new Error('Text policy owner is closed');
      await record('policy-read');
      return { providerRevision: config.revision, maxTextBytes: MAX_TEXT_BYTES, maxChunkCharacters: MAX_CHUNK_CHARACTERS };
    } };
    ctx.provide('textPipeline', {
      policy() {
        admit();
        return adaptObject(policy, { typeName: 'TextPipelinePolicy', methods: ['snapshot'], ownership: 'borrowed' });
      },
      chunks(text, chunkCharacters) {
        admit(); validateText(text);
        if (!Number.isSafeInteger(chunkCharacters) || chunkCharacters < 1 || chunkCharacters > MAX_CHUNK_CHARACTERS) {
          throw new Error('chunkCharacters must be an integer from 1 through 4096');
        }
        const id = ++nextId;
        let cursor = text[Symbol.iterator](), offsetBytes = 0, pending, attempt, closed = false, stopped = false;
        const stream = {
          next() {
            if (closed || stopped) return Promise.resolve({ done: true, value: undefined });
            if (pending) return Promise.reject(new Error('Text stream already has a pending pull'));
            pending = track(async () => {
              await record('stream-next-start', { id, offsetBytes });
              await beforePull?.({ id, offsetBytes, providerRevision: config.revision });
              if (stopped) {
                await record('stream-next-end', { id, done: true });
                return { done: true, value: undefined };
              }
              let text = '';
              for (let index = 0; index < chunkCharacters; index++) {
                const item = cursor.next();
                if (item.done) break;
                text += item.value;
              }
              const start = offsetBytes;
              offsetBytes += Buffer.byteLength(text);
              await record('stream-next-end', { id, done: text.length === 0, offsetBytes });
              return text.length ? { done: false, value: { text, offsetBytes: start } } : { done: true, value: undefined };
            });
            const current = pending;
            const finish = () => { if (pending === current) pending = undefined; };
            current.then(finish, finish);
            return current;
          },
          return() {
            if (closed) return Promise.resolve({ done: true, value: undefined });
            if (attempt) return attempt;
            stopped = true;
            attempt = track(async () => {
              await record('stream-return-start', { id });
              const outcomes = await Promise.allSettled([
                Promise.resolve().then(() => beforeClose?.({ kind: 'stream', id, providerRevision: config.revision })),
                ...(pending ? [pending] : []),
              ]);
              if (outcomes[0].status === 'rejected') throw outcomes[0].reason;
              await record('stream-close', { id });
              cursor = undefined; closed = true; streams.delete(stream);
              return { done: true, value: undefined };
            });
            const current = attempt;
            const finish = () => { if (attempt === current) attempt = undefined; };
            current.then(finish, finish);
            return current;
          },
          [Symbol.asyncIterator]() { return this; },
        };
        streams.add(stream);
        return stream;
      },
      session() {
        admit();
        const id = ++nextId, metrics = createTextMetrics(config.revision), calls = new Set();
        let closed = false, stopped = false, attempt;
        const call = action => {
          if (closed || stopped) return Promise.reject(new Error('Text session is closed'));
          const pending = track(action); calls.add(pending);
          const finish = () => calls.delete(pending);
          pending.then(finish, finish);
          return pending;
        };
        const target = {
          append(text) { return call(async () => {
            validateText(text);
            await record('object-append-start', { id, bytes: Buffer.byteLength(text) });
            await beforeAppend?.({ id, bytes: Buffer.byteLength(text), providerRevision: config.revision });
            const value = metrics.append(text);
            await record('object-append-end', { id, bytes: value.bytes });
            return value;
          }); },
          snapshot() { return call(() => metrics.snapshot()); },
        };
        const resource = { close() {
          if (closed) return Promise.resolve();
          if (attempt) return attempt;
          stopped = true;
          attempt = track(async () => {
            await Promise.allSettled([...calls]);
            await record('object-close-start', { id });
            await beforeClose?.({ kind: 'object', id, providerRevision: config.revision });
            await record('object-close', { id });
            closed = true; sessions.delete(resource);
          });
          const current = attempt;
          const finish = () => { if (attempt === current) attempt = undefined; };
          current.then(finish, finish);
          return current;
        } };
        sessions.add(resource);
        return adaptObject(target, { typeName: 'JsTextAnalysisSession', methods: ['append', 'snapshot'], ownership: 'owned', dispose: () => resource.close() });
      },
      async lifecycle(phase, nativeRevision) {
        if (!['setup', 'cleanup'].includes(phase) || typeof nativeRevision !== 'string' || nativeRevision.length > 100) throw new Error('Invalid native lifecycle');
        await record(`native-${phase}`, { nativeRevision });
        return null;
      },
      inspect() { return { providerRevision: config.revision, streams: streams.size, sessions: sessions.size,
        policyAlive, total: sequence, recent: recent.map(event => ({ ...event })) }; },
    });
    ctx.effect(() => async () => {
      closing = true;
      // Retry any failed releases. The provider owns every acquired referent and
      // must not report success while a failed asynchronous close remains live.
      const pending = [...active];
      const outcomes = await Promise.allSettled([
        ...[...streams].map(stream => stream.return()), ...[...sessions].map(session => session.close()), ...pending,
      ]);
      const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
      if (errors.length) throw new AggregateError(errors, 'Text pipeline resources did not drain');
      policyAlive = false;
      await record('policy-owner-close');
      await record('provider-cleanup');
    });
  } };
}
export const apply = createTextPipeline().apply;
