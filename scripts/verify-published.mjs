// Installation integrity checks; these do not rerun Verus or certify plugins.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageManifest, projectRoot } from '../src/distribution.mjs';

const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
function safe(name) {
  assert(typeof name === 'string' && name && !isAbsolute(name) && !name.includes('\\') &&
    !name.split('/').some(part => !part || part === '.' || part === '..'), `Unsafe release path: ${name}`);
  return name;
}
async function checkFiles(root, entries) {
  assert(entries && Object.keys(entries).length, 'Missing release file hashes');
  const canonical = await realpath(root);
  for (const [name, expected] of Object.entries(entries)) {
    const file = join(root, safe(name));
    const inside = relative(canonical, await realpath(file));
    assert(!isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep), `Release path escapes package: ${name}`);
    assert((await lstat(file)).isFile(), `Release file is not a regular file: ${name}`);
    assert.equal(await hash(file), expected, `Installed release file changed: ${name}`);
  }
}
export async function verifyPublished() {
  assert(!Object.hasOwn(process.env, 'CORDIS_NATIVE_BINDING'), 'Published entry requires its packaged native runtime');
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert(major > 22 || major === 22 && minor >= 22, 'Node >=22.22.0 is required');
  const release = await json(join(projectRoot, 'release-manifest.json'));
  assert.equal(release.schema, 'harness-verus.release/v1');
  assert.equal(release.name, '@validation-engineering/harness-verus');
  assert.equal(release.name, packageManifest.name);
  assert.equal(release.version, packageManifest.version);
  assert.equal(packageManifest.private, undefined);
  await checkFiles(projectRoot, release.files);
  const names = ['@validation-engineering/cordis', '@validation-engineering/cordis-compat-deepseek', '@validation-engineering/cordis-loader'];
  assert.deepEqual(Object.keys(release.runtime.packages).sort(), names);
  for (const name of names) {
    const root = dirname(fileURLToPath(import.meta.resolve(name)));
    const manifest = await json(join(root, 'package.json'));
    const expected = release.runtime.packages[name];
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, expected.version, `Unexpected runtime version: ${name}`);
    assert.equal(packageManifest.dependencies[name], expected.version);
    await checkFiles(root, expected.files);
  }
  const { selectNativeArtifact } = await import('@validation-engineering/cordis/native-artifacts');
  const native = selectNativeArtifact();
  assert.equal(native.manifestSha256, release.runtime.nativeManifestSha256, 'Native bundle differs from the accepted core release');
  const officialRoot = resolve(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/lib/bin.js'))), '..');
  const official = await json(join(officialRoot, 'package.json'));
  assert.equal(official.version, release.officialVersion);
  assert.equal(packageManifest.dependencies['@deepseek-ai/dsh'], official.version);
  return { version: release.version, target: native.entry.target, coreCommit: release.runtime.sourceCommit, officialVersion: official.version };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyPublished()));
}
