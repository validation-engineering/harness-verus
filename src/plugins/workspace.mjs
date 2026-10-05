import { constants } from 'node:fs';
import { lstat, realpath, open, opendir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineTool } from '../plugin-api.mjs';

export const name = 'workspace-tools';
export const inject = ['tools'];

const DEFAULT_READ_BYTES = 64 * 1024;
const DEFAULT_WRITE_BYTES = 1024 * 1024;
const MAX_LIMIT = 16 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 10_000;

function integer(value, fallback, min, max, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return result;
}

function relativePath(input = '.') {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new Error('path must be a nonempty relative path');
  }
  // Reject Windows spellings on POSIX too, so a saved configuration has one meaning.
  if (path.isAbsolute(input) || path.win32.isAbsolute(input) || input.includes('\\')) {
    throw new Error('absolute paths and backslashes are not allowed');
  }
  const parts = input.split('/');
  if (parts.includes('..')) throw new Error('parent traversal (..) is not allowed');
  return parts.filter(part => part !== '' && part !== '.').join('/') || '.';
}

function utf8PageEnd(bytes, totalRemaining) {
  if (bytes.length === 0 || bytes.length === totalRemaining) return bytes.length;
  let lead = bytes.length - 1;
  while (lead >= 0 && (bytes[lead] & 0xc0) === 0x80) lead--;
  if (lead < 0) return bytes.length; // fatal decoder reports an invalid starting offset.
  const byte = bytes[lead];
  const width = byte < 0x80 ? 1 : byte >= 0xc2 && byte <= 0xdf ? 2
    : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1;
  return lead + width > bytes.length ? lead : bytes.length;
}

/** Local filesystem policy, not an OS sandbox or protection against hostile concurrent mutation. */
export async function createWorkspace(config = {}) {
  if (typeof config.root !== 'string' || config.root.length === 0) {
    throw new Error('workspace.root is required');
  }
  if (config.allowWrite !== undefined && typeof config.allowWrite !== 'boolean') {
    throw new Error('workspace.allowWrite must be a boolean');
  }
  const root = await realpath(config.root);
  if (!(await lstat(root)).isDirectory()) throw new Error('workspace.root must be a directory');
  const maxReadBytes = integer(config.maxReadBytes, DEFAULT_READ_BYTES, 4, MAX_LIMIT, 'maxReadBytes');
  const maxWriteBytes = integer(config.maxWriteBytes, DEFAULT_WRITE_BYTES, 0, MAX_LIMIT, 'maxWriteBytes');
  const lifetime = new AbortController();
  const active = new Set();
  const cleanupErrors = [];
  let closing;

  async function resolve(input, { missingLeaf = false } = {}) {
    const relative = relativePath(input);
    let current = root;
    const parts = relative === '.' ? [] : relative.split('/');
    // Recheck the pinned root itself in case the path was replaced after activation.
    if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) {
      throw new Error('workspace root changed');
    }
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (missingLeaf && index === parts.length - 1 && error.code === 'ENOENT') break;
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error('symbolic links in tool paths are not allowed');
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error('parent path is not a directory');
    }
    return { absolute: current, relative };
  }

  function run(signal, operation) {
    if (lifetime.signal.aborted) return Promise.reject(new Error('workspace plugin is disposed'));
    const combined = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    const work = (async () => {
      combined.throwIfAborted();
      return operation(combined);
    })();
    active.add(work);
    work.then(() => active.delete(work), () => active.delete(work));
    return work;
  }

  return {
    root,
    list(args = {}, signal) {
      return run(signal, async cancellation => {
        const target = await resolve(args.path);
        const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
        const limit = integer(args.limit, 100, 1, 200, 'limit');
        const entries = [];
        const directory = await opendir(target.absolute);
        for await (const entry of directory) {
          cancellation.throwIfAborted();
          if (entries.length === MAX_DIRECTORY_ENTRIES) {
            throw new Error(`directory exceeds ${MAX_DIRECTORY_ENTRIES} entries; choose a narrower path`);
          }
          entries.push({ name: entry.name, type: entry.isDirectory() ? 'directory'
            : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other' });
        }
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        if (offset > entries.length) throw new Error('offset exceeds directory entry count');
        const page = [];
        let size = 0;
        for (const entry of entries.slice(offset, offset + limit)) {
          const bytes = Buffer.byteLength(JSON.stringify(entry));
          if (size + bytes > maxReadBytes) {
            if (page.length === 0) throw new Error('one directory entry exceeds maxReadBytes');
            break;
          }
          page.push(entry);
          size += bytes;
        }
        cancellation.throwIfAborted();
        return { path: target.relative, total: entries.length,
          next: offset + page.length < entries.length ? offset + page.length : null, entries: page };
      });
    },
    read(args, signal) {
      return run(signal, async cancellation => {
        const target = await resolve(args.path);
        const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
        const limit = integer(args.limit, maxReadBytes, 4, maxReadBytes, 'limit');
        cancellation.throwIfAborted();
        const file = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await file.stat();
          if (!before.isFile()) throw new Error('workspace_read requires a regular file');
          if (!Number.isSafeInteger(before.size)) throw new Error('file size exceeds supported range');
          if (offset > before.size) throw new Error('offset exceeds file size');
          const buffer = Buffer.alloc(Math.min(limit, before.size - offset));
          let count = 0;
          while (count < buffer.length) {
            cancellation.throwIfAborted();
            const { bytesRead } = await file.read(buffer, count, buffer.length - count, offset + count);
            if (bytesRead === 0) break;
            count += bytesRead;
          }
          const after = await file.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
            || count !== buffer.length) throw new Error('file changed while reading; retry the page');
          const end = utf8PageEnd(buffer, before.size - offset);
          let content;
          try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, end)); }
          catch { throw new Error('file page is not valid UTF-8, or offset is inside a UTF-8 character'); }
          if (content.includes('\0')) throw new Error('binary text containing NUL is not supported');
          cancellation.throwIfAborted();
          return { path: target.relative, total: before.size, offset,
            next: offset + end < before.size ? offset + end : null, content };
        } finally {
          try { await file.close(); }
          catch (error) { cleanupErrors.push(error); throw error; }
        }
      });
    },
    write(args, signal) {
      return run(signal, async cancellation => {
        if (config.allowWrite !== true) throw new Error('workspace writes are disabled; enable allowWrite explicitly');
        if (typeof args.content !== 'string') throw new Error('content must be a string');
        if (args.content.includes('\0')) throw new Error('content must be UTF-8 text without NUL');
        if (!args.content.isWellFormed()) throw new Error('content contains an unpaired Unicode surrogate');
        const bytes = Buffer.byteLength(args.content);
        if (bytes > maxWriteBytes) throw new Error(`content exceeds maxWriteBytes (${maxWriteBytes})`);
        const target = await resolve(args.path, { missingLeaf: true });
        if (target.relative === '.') throw new Error('workspace_write requires a file path');
        try {
          if (!(await lstat(target.absolute)).isFile()) throw new Error('workspace_write requires a regular file');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        cancellation.throwIfAborted();
        const temporary = path.join(path.dirname(target.absolute), `.cordis-write-${randomUUID()}.tmp`);
        let file;
        let exists = false;
        try {
          file = await open(temporary, 'wx', 0o600);
          exists = true;
          await file.writeFile(args.content, { encoding: 'utf8', signal: cancellation });
          await file.sync();
          await file.close();
          file = undefined;
          await resolve(args.path, { missingLeaf: true });
          cancellation.throwIfAborted();
          await rename(temporary, target.absolute);
          exists = false;
          // rename is the commit point. Cancellation after commit cannot roll back a saved file.
          return { path: target.relative, bytes };
        } finally {
          try {
            if (file) await file.close();
          } catch (error) {
            cleanupErrors.push(error);
            throw error;
          } finally {
            if (exists) {
              try { await unlink(temporary); }
              catch (error) {
                if (error.code !== 'ENOENT') { cleanupErrors.push(error); throw error; }
              }
            }
          }
        }
      });
    },
    close() {
      if (!closing) {
        lifetime.abort(new Error('workspace plugin disposed'));
        closing = (async () => {
          await Promise.allSettled([...active]);
          if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'workspace temporary-file cleanup failed');
        })();
      }
      return closing;
    },
  };
}

const relative = { type: 'string', description: 'Path relative to the configured workspace; no .. or symlinks.' };
const offset = { type: 'integer', description: 'Continue from the previous result.next; starts at 0.' };
const nullableInteger = { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true };
const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];

export async function apply(ctx, config) {
  const workspace = await createWorkspace(config);
  ctx.effect(() => () => workspace.close());
  ctx.tools.register(defineTool({
    name: 'workspace_list',
    description: 'List one workspace directory with bounded pagination. Follow next until null. Symlinks are listed but never followed.',
    parameters: { path: relative, offset, limit: { type: 'integer', description: 'Entry count, 1–200; default 100.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', required: true }, total: { type: 'integer', required: true }, next: nullableInteger,
      entries: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        name: { type: 'string', required: true }, type: { type: 'string', required: true, enum: ['file', 'directory', 'symlink', 'other'] },
      } } },
    } }, render },
    isConcurrencySafe: () => true,
    execute: (args, exec) => workspace.list(args, exec.signal),
  }));
  ctx.tools.register(defineTool({
    name: 'workspace_read',
    description: 'Read one bounded UTF-8 text page. total, offset and next are byte offsets. Follow next until null; content is never silently truncated.',
    parameters: { path: { ...relative, required: true }, offset,
      limit: { type: 'integer', description: 'Maximum content bytes, at least 4 and at most configured maxReadBytes.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', required: true }, total: { type: 'integer', required: true },
      offset: { type: 'integer', required: true }, next: nullableInteger, content: { type: 'string', required: true },
    } }, render },
    isConcurrencySafe: () => true,
    execute: (args, exec) => workspace.read(args, exec.signal),
  }));
  ctx.tools.register(defineTool({
    name: 'workspace_write',
    description: 'Atomically save an entire UTF-8 text file within the workspace. Requires explicit allowWrite; parent directory must already exist. Replaces existing contents.',
    parameters: { path: { ...relative, required: true }, content: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', required: true }, bytes: { type: 'integer', required: true },
    } }, render },
    isConcurrencySafe: () => false,
    execute: (args, exec) => workspace.write(args, exec.signal),
  }));
}
