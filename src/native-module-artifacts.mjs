import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

const SCHEMA = 'cordis-harness.native-module/v1';
const MANIFEST_LIMIT = 1024 * 1024;
const LIBRARY_LIMIT = 256 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function reject(code, message) { throw Object.assign(new Error(message), { code: `NATIVE_ARTIFACT_${code}` }); }
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function pathOf(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0')) reject('PATH', `${label} must be a nonempty filesystem path`);
  return resolve(value);
}
function extension() {
  const value = { darwin: '.dylib', linux: '.so', win32: '.dll' }[process.platform];
  if (!value) reject('PLATFORM', `Unsupported native module platform: ${process.platform}`);
  return value;
}
function fields(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('SCHEMA', `${label} has invalid fields`);
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) reject('SCHEMA', `${label} has invalid fields`);
}
// Capture plain, finite JSON without invoking configuration accessors. Sorting
// keys makes equivalent object configurations share one manifest identity.
function json(value, depth = 0, seen = new Set()) {
  if (depth > 64) reject('CONFIG', 'Native module JSON exceeds depth 64');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)
    || Object.getOwnPropertySymbols(value).length) reject('CONFIG', 'Native module configuration must contain finite JSON values');
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject('CONFIG', 'Native module configuration must contain plain JSON objects');
  const keys = Object.keys(value);
  if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) reject('CONFIG', 'Native module configuration must contain dense JSON arrays');
  seen.add(value);
  const entries = (array ? keys : keys.sort()).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) reject('CONFIG', 'Native module configuration accessors are not supported');
    return [key, json(descriptor.value, depth + 1, seen)];
  });
  seen.delete(value);
  return array ? entries.map(([, item]) => item) : Object.fromEntries(entries);
}
function recipes(value) {
  if (!Array.isArray(value)) reject('CONFIG', 'Native module plugins must be an array');
  const result = json(value), ids = new Set();
  for (const item of result) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['id', 'factory', 'config', 'state'].includes(key))
      || typeof item.id !== 'string' || !item.id || ids.has(item.id)
      || typeof item.factory !== 'string' || !item.factory
      || (Object.hasOwn(item, 'state') && item.state !== 'migrate')) reject('CONFIG', 'Native module plugins require unique ids, factory names, optional JSON config and optional state: migrate');
    ids.add(item.id);
  }
  return result;
}
function sameFile(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
}
async function regularBytes(file, limit) {
  const initial = await lstat(file, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink()) reject('FILE', `Native artifact must be a regular non-symlink file: ${file}`);
  if (initial.size > BigInt(limit)) reject('SIZE', `Native artifact exceeds ${limit} bytes: ${file}`);
  const input = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || !sameFile(initial, before)) reject('CHANGED', `Native artifact changed before reading: ${file}`);
    // Read at most the declared size plus one byte, even if a concurrent writer
    // keeps appending. Changes invalidate publication instead of capturing a mix.
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await input.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await input.stat({ bigint: true }), current = await lstat(file, { bigint: true });
    if (size !== Number(before.size) || !current.isFile() || !sameFile(before, after) || !sameFile(after, current)) reject('CHANGED', `Native artifact changed while reading: ${file}`);
    return bytes.subarray(0, size);
  } finally { await input.close(); }
}
// Concurrent publication unlinks its temporary hard-link after the final name
// becomes visible, changing ctime without changing content. Retry transient
// metadata changes only for hash-verified published files, never build inputs.
async function publishedBytes(file, limit) {
  for (let attempt = 0; ; attempt++) {
    try { return await regularBytes(file, limit); }
    catch (error) {
      if (error.code !== 'NATIVE_ARTIFACT_CHANGED' || attempt >= 4) throw error;
      await nextTurn();
    }
  }
}
async function directoryOf(directory, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) reject('PATH', `Native artifact directory must not be a symlink: ${directory}`);
  return realpath(directory);
}
async function imageDirectory(root, create = false) {
  const expected = join(root, 'images'), actual = await directoryOf(expected, create);
  if (actual !== expected) reject('PATH', 'Native artifact image directory escapes the manifest directory');
  return actual;
}
async function publishBytes(file, bytes, limit) {
  // link() publishes a fully written file without replacing any existing name.
  // An EEXIST race is accepted only after verifying the existing exact bytes.
  const temporary = join(dirname(file), `.native-${randomUUID()}.tmp`);
  const output = await open(temporary, 'wx', 0o600);
  try {
    try { await output.writeFile(bytes); await output.sync(); await output.chmod(0o444); }
    finally { await output.close(); }
    try { await link(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await publishedBytes(file, limit);
      if (!existing.equals(bytes)) reject('COLLISION', `Existing content-addressed artifact has different bytes: ${file}`);
    }
  } finally { await unlink(temporary); }
}
function result(manifestPath, manifestSha256, manifest, libraryPath) {
  return freeze({ manifestPath, manifestSha256,
    config: { path: libraryPath, sha256: manifest.artifact.sha256, plugins: manifest.plugins } });
}

/** Publish trusted library bytes and captured recipes; this never executes code.
 * The artifact tree must be controlled by the host. Hashes identify bytes, not
 * publisher trust; read-only modes do not prevent its owner from tampering.
 */
export async function publishNativeModule({ libraryPath, directory, plugins } = {}) {
  const source = pathOf(libraryPath, 'libraryPath'), target = pathOf(directory, 'directory');
  const captured = recipes(plugins), suffix = extension();
  if (extname(source) !== suffix) reject('PLATFORM', `Native library must use the ${suffix} extension for ${process.platform}`);
  const bytes = await regularBytes(source, LIBRARY_LIMIT);
  if (!bytes.length) reject('FILE', 'Native library must not be empty');
  const sha256 = digest(bytes), manifest = { schema: SCHEMA, abi: 1, platform: process.platform,
    architecture: process.arch, artifact: { path: `images/${sha256}${suffix}`, sha256 }, plugins: captured };
  const encoded = Buffer.from(`${JSON.stringify(manifest)}\n`);
  if (encoded.length > MANIFEST_LIMIT) reject('SIZE', 'Native module manifest exceeds 1 MiB');
  const root = await directoryOf(target, true), images = await imageDirectory(root, true);
  const image = join(images, `${sha256}${suffix}`), manifestSha256 = digest(encoded);
  const manifestPath = join(root, `${manifestSha256}.json`);
  await publishBytes(image, bytes, LIBRARY_LIMIT);
  await publishBytes(manifestPath, encoded, MANIFEST_LIMIT);
  // Re-read both names so the returned configuration has passed the same reader
  // checks used by the application. No directory crash-durability claim is made.
  return readNativeModule(manifestPath, { sha256: manifestSha256 });
}

/** Verify an immutable manifest and image. A supplied digest pins exact recipes. */
export async function readNativeModule(manifestPath, { sha256 } = {}) {
  const file = pathOf(manifestPath, 'manifestPath');
  if (sha256 !== undefined && !validDigest(sha256)) reject('DIGEST', 'Expected manifest SHA-256 must be lowercase hexadecimal');
  const root = await directoryOf(dirname(file)), canonical = join(root, basename(file));
  const bytes = await publishedBytes(canonical, MANIFEST_LIMIT), manifestSha256 = digest(bytes);
  if (sha256 !== undefined && sha256 !== manifestSha256) reject('DIGEST', 'Native module manifest digest differs from the expected SHA-256');
  if (basename(canonical) !== `${manifestSha256}.json`) reject('DIGEST', 'Native module manifest filename does not match its content SHA-256');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { reject('SCHEMA', 'Native module manifest must contain valid UTF-8 JSON'); }
  fields(manifest, ['schema', 'abi', 'platform', 'architecture', 'artifact', 'plugins'], 'Native module manifest');
  if (manifest.schema !== SCHEMA || manifest.abi !== 1) reject('SCHEMA', 'Unsupported native module manifest schema or ABI');
  if (manifest.platform !== process.platform || manifest.architecture !== process.arch) reject('PLATFORM', 'Native module platform or architecture differs from this process');
  fields(manifest.artifact, ['path', 'sha256'], 'Native module artifact');
  if (!validDigest(manifest.artifact.sha256)) reject('DIGEST', 'Native image SHA-256 must be lowercase hexadecimal');
  const relative = `images/${manifest.artifact.sha256}${extension()}`;
  if (manifest.artifact.path !== relative) reject('PATH', 'Native image path must be its relative content-addressed images path');
  manifest.plugins = recipes(manifest.plugins);
  const images = await imageDirectory(root), libraryPath = join(images, basename(relative));
  const library = await publishedBytes(libraryPath, LIBRARY_LIMIT);
  if (!library.length) reject('FILE', 'Native library must not be empty');
  if (digest(library) !== manifest.artifact.sha256) reject('DIGEST', 'Native library digest differs from the manifest SHA-256');
  return result(canonical, manifestSha256, manifest, libraryPath);
}
