// Publishes the content of bin/ as a signed, immutable version.
//
//   node tools/publish.mjs check     local dry run: validate files, print hashes (no network, no key)
//   node tools/publish.mjs publish   (CI) upload new files, write manifest, point release BRANCH at it
//   node tools/publish.mjs remove    (CI) remove release BRANCH from releases.json
//
// CI environment: SRC_DIR, PAGES_DIR, BRANCH, COMMIT, COMMIT_MESSAGE, GITHUB_REPOSITORY,
// SIGNING_KEY (Ed25519 PKCS#8 PEM), GH_TOKEN (used by the gh CLI).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FORMAT = 1;
const MAX_ASSETS_PER_RELEASE = 1000;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024 - 1;
const UPLOAD_BATCH = 20;
const PROTECTED_RELEASE = 'main';

const SRC_DIR = process.env.SRC_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = path.join(SRC_DIR, 'bin');

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

// The signature covers the exact bytes of the file; the launcher verifies them before parsing.
function writeSigned(file, obj, key) {
  writeJson(file, obj);
  const signature = crypto.sign(null, fs.readFileSync(file), key);
  fs.writeFileSync(`${file}.sig`, `${signature.toString('base64')}\n`);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function walk(dir, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) result.push(rel);
    else throw new Error(`${rel}: only regular files and directories are allowed`);
  }
  return result;
}

function validatePath(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'invalid path segment';
  if (/[\\:*?"<>|\x00-\x1f]/.test(rel)) return 'invalid character in path';
  return undefined;
}

// A zip must start with a local file header (or be an empty archive) and contain an end-of-central-directory record.
function validateZip(file) {
  const size = fs.statSync(file).size;
  if (size < 22) return 'too small to be a zip';
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    const magic = head.readUInt32LE(0);
    if (magic !== 0x04034b50 && magic !== 0x06054b50) return 'not a zip file';
    const tailSize = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, size - tailSize);
    for (let i = tailSize - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) return undefined;
    }
    return 'zip is truncated (no end of central directory)';
  } finally {
    fs.closeSync(fd);
  }
}

async function collectFiles(config) {
  if (!fs.existsSync(BIN_DIR)) throw new Error('bin/ does not exist');
  const critical = new Set(config.critical || []);
  const errors = [];
  const files = [];

  for (const rel of walk(BIN_DIR).sort()) {
    const abs = path.join(BIN_DIR, rel);
    const size = fs.statSync(abs).size;
    const pathError = validatePath(rel);
    if (pathError) errors.push(`${rel}: ${pathError}`);
    if (size > MAX_FILE_SIZE) errors.push(`${rel}: larger than 2 GB`);
    if (rel.toLowerCase().endsWith('.zip')) {
      const zipError = validateZip(abs);
      if (zipError) errors.push(`${rel}: ${zipError}`);
    }
    files.push({ path: rel, sha256: await sha256File(abs), size, ...(critical.has(rel) ? { critical: true } : {}), abs });
  }

  for (const rel of critical) {
    if (!files.some((f) => f.path === rel)) errors.push(`${rel}: critical file is missing`);
  }
  const lower = new Map();
  for (const f of files) {
    const key = f.path.toLowerCase();
    if (lower.has(key)) errors.push(`${f.path}: conflicts with ${lower.get(key)} (case-insensitive)`);
    lower.set(key, f.path);
  }

  if (errors.length) throw new Error(`Validation failed:\n  ${errors.join('\n  ')}`);
  return files;
}

// Identifies the version relevant for multiplayer: only critical files count.
function criticalHashOf(files) {
  return sha256(files.filter((f) => f.critical).map((f) => `${f.path}\0${f.sha256}\n`).join(''));
}

// Identifies the full content of a version; identical content reuses the existing version.
function contentHashOf(files, preserve) {
  return sha256(JSON.stringify({
    files: files.map((f) => [f.path, f.sha256, !!f.critical]),
    preserve,
  }));
}

function gh(args) {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
    } catch (e) {
      if (attempt >= 4) throw e;
      console.warn(`gh ${args[0]} ${args[1]} failed, retrying (${attempt})...`);
      execFileSync('sleep', [`${attempt * 10}`]);
    }
  }
}

function releaseExists(repo, tag) {
  try {
    execFileSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

// Uploads files as assets named <sha256>, split into GitHub releases vN, vN-2, ... of at most 1000 assets.
function uploadObjects(objects, version, index) {
  const repo = env('GITHUB_REPOSITORY');
  const commit = env('COMMIT');
  const stagingRoot = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || '/tmp', 'objects-'));

  for (let chunk = 0; chunk * MAX_ASSETS_PER_RELEASE < objects.length; chunk++) {
    const part = objects.slice(chunk * MAX_ASSETS_PER_RELEASE, (chunk + 1) * MAX_ASSETS_PER_RELEASE);
    const tag = chunk === 0 ? `v${version}` : `v${version}-${chunk + 1}`;
    const staging = path.join(stagingRoot, tag);
    fs.mkdirSync(staging);
    for (const f of part) fs.copyFileSync(f.abs, path.join(staging, f.sha256));

    if (!releaseExists(repo, tag)) {
      gh(['release', 'create', tag, '--repo', repo, '--target', commit, '--title', tag,
        '--notes', `Version ${version} (${env('BRANCH')}, ${commit.slice(0, 7)}): ${process.env.COMMIT_MESSAGE || ''}`,
        '--latest=false']);
    }
    for (let i = 0; i < part.length; i += UPLOAD_BATCH) {
      const batch = part.slice(i, i + UPLOAD_BATCH).map((f) => path.join(staging, f.sha256));
      gh(['release', 'upload', tag, '--repo', repo, '--clobber', ...batch]);
    }
    for (const f of part) {
      index.objects[f.sha256] = {
        url: `https://github.com/${repo}/releases/download/${tag}/${f.sha256}`,
        size: f.size,
      };
    }
  }
}

function loadState(pagesDir) {
  return {
    index: readJson(path.join(pagesDir, 'index.json'), { latestVersion: 0, seq: 0, objects: {}, contentVersions: {} }),
    releases: readJson(path.join(pagesDir, 'releases.json'), { format: FORMAT, seq: 0, releases: {}, mirrors: [] }),
  };
}

function saveReleases(pagesDir, index, releases, key) {
  index.seq += 1;
  releases.format = FORMAT;
  releases.seq = index.seq;
  releases.updated = new Date().toISOString();
  writeSigned(path.join(pagesDir, 'releases.json'), releases, key);
}

async function publish() {
  const pagesDir = env('PAGES_DIR');
  const branch = env('BRANCH');
  const key = crypto.createPrivateKey(env('SIGNING_KEY'));
  const config = readJson(path.join(SRC_DIR, 'packages.json'), {});
  const preserve = config.preserve || [];
  const files = await collectFiles(config);
  const contentHash = contentHashOf(files, preserve);
  const criticalHash = criticalHashOf(files);
  const { index, releases } = loadState(pagesDir);

  let version = index.contentVersions[contentHash];
  if (version) {
    console.log(`Content identical to version ${version}, no upload needed.`);
  } else {
    version = index.latestVersion + 1;
    const seen = new Set();
    const newObjects = files.filter((f) => !index.objects[f.sha256] && !seen.has(f.sha256) && seen.add(f.sha256));
    console.log(`Creating version ${version}: ${files.length} files, ${newObjects.length} new.`);
    uploadObjects(newObjects, version, index);

    const manifest = {
      format: FORMAT,
      version,
      created: new Date().toISOString(),
      branch,
      commit: env('COMMIT'),
      message: process.env.COMMIT_MESSAGE || '',
      contentHash,
      criticalHash,
      preserve,
      files: files.map(({ abs, ...f }) => ({ ...f, url: index.objects[f.sha256].url })),
    };
    writeSigned(path.join(pagesDir, 'manifests', `${version}.json`), manifest, key);
    index.latestVersion = version;
    index.contentVersions[contentHash] = version;
  }

  const mirrors = config.mirrors || [];
  const current = releases.releases[branch];
  if (current?.version === version && JSON.stringify(releases.mirrors) === JSON.stringify(mirrors)) {
    console.log(`Release ${branch} already points to version ${version}.`);
  } else {
    releases.releases[branch] = { version, criticalHash };
    releases.mirrors = mirrors;
    saveReleases(pagesDir, index, releases, key);
    console.log(`Release ${branch} -> version ${version} (criticalHash ${criticalHash.slice(0, 12)}).`);
  }
  writeJson(path.join(pagesDir, 'index.json'), index);
}

async function remove() {
  const pagesDir = env('PAGES_DIR');
  const branch = env('BRANCH');
  if (branch === PROTECTED_RELEASE) throw new Error(`Release ${PROTECTED_RELEASE} cannot be removed.`);
  const key = crypto.createPrivateKey(env('SIGNING_KEY'));
  const { index, releases } = loadState(pagesDir);
  if (!releases.releases[branch]) {
    console.log(`Release ${branch} does not exist.`);
    return;
  }
  delete releases.releases[branch];
  saveReleases(pagesDir, index, releases, key);
  writeJson(path.join(pagesDir, 'index.json'), index);
  console.log(`Release ${branch} removed.`);
}

async function check() {
  const config = readJson(path.join(SRC_DIR, 'packages.json'), {});
  const files = await collectFiles(config);
  for (const f of files) {
    console.log(`${f.critical ? '*' : ' '} ${f.sha256.slice(0, 12)}  ${String(f.size).padStart(10)}  ${f.path}`);
  }
  console.log(`\n${files.length} files OK (* = critical)`);
  console.log(`criticalHash: ${criticalHashOf(files)}`);
  console.log(`contentHash:  ${contentHashOf(files, config.preserve || [])}`);
}

const commands = { check, publish, remove };
const command = commands[process.argv[2]];
if (!command) {
  console.error('Usage: node tools/publish.mjs check|publish|remove');
  process.exit(2);
}
Promise.resolve(command()).catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
