import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Selected review sources, not a stand-alone build or proof closure.
export const coreReviewFiles = [
  'LICENSE', 'NOTICE', 'toolchain.lock.json', 'upstream.lock.json',
  'crates/cordis-kernel/src/lib.rs', 'crates/cordis-kernel/src/action_ledger.rs',
  'crates/cordis-kernel/src/cleanup_protocol.rs', 'crates/cordis-kernel/src/wait_guard.rs',
  'crates/cordis-kernel/src/request_ledger.rs', 'crates/cordis-kernel/src/invocation_ledger.rs',
  'crates/cordis-driver/src/lib.rs', 'crates/cordis-driver/src/protocol.rs',
  'packages/compat-cordis/runtime.js',
  'docs/cleanup-protocol.md', 'docs/cleanup-protocol.zh-CN.md',
  'docs/paper-review-guide.md', 'docs/paper-review-guide.zh-CN.md',
  'docs/cases/reentrant-wait.md', 'docs/cases/reentrant-wait.zh-CN.md',
].sort();
export const reviewDirectory = '.vendor/cordis/provenance/review';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function exportCoreReview({ source, root, development }) {
  const directory = path.join(root, reviewDirectory);
  // This is a generated, dedicated subset. Remove obsolete review files only.
  await rm(directory, { recursive: true, force: true });
  for (const name of coreReviewFiles) {
    const bytes = await readFile(path.join(source, name));
    assert.equal(digest(bytes), development.sha256[name], `Core review source is not verified: ${name}`);
    const destination = path.join(directory, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
}

export async function verifyCoreReview(root, lock) {
  const reportPath = path.join(root, '.vendor/cordis/provenance/development-report.json');
  const bytes = await readFile(reportPath);
  assert.equal(digest(bytes), lock.cordis.developmentReportSha256, 'Core development evidence differs from lock');
  const development = JSON.parse(bytes);
  assert.equal(development.status, 'passed');
  assert.equal(digest(JSON.stringify(development.sha256)), lock.cordis.sourceFingerprint, 'Core source fingerprint differs');
  for (const name of coreReviewFiles) {
    const file = `${reviewDirectory}/${name}`;
    const parts = file.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const stat = await lstat(path.join(root, ...parts.slice(0, i)));
      assert(i === parts.length ? stat.isFile() : stat.isDirectory(), `Nonregular core review source: ${name}`);
    }
    assert.equal(digest(await readFile(path.join(root, file))), development.sha256[name], `Core review source differs from verified evidence: ${name}`);
  }
  return { sourceFingerprint: lock.cordis.sourceFingerprint, files: coreReviewFiles.length };
}
