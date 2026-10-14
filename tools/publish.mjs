// Publishes the content of bin/ as a signed, immutable version.
//
//   node tools/publish.mjs check     local dry run: validate files, print hashes (no network, no key)
//   node tools/publish.mjs publish   (CI) upload new files, write manifest, point release BRANCH at it
//   node tools/publish.mjs remove    (CI) remove release BRANCH from releases.json
//   node tools/publish.mjs changelog (CI/optional) only regenerate changelog.json / changelog.html
//
// CI environment: SRC_DIR, PAGES_DIR, BRANCH, COMMIT, COMMIT_MESSAGE, GITHUB_REPOSITORY,
// SIGNING_KEY (Ed25519 PKCS#8 PEM), GH_TOKEN (used by the gh CLI),
// CHANGELOG_DIR (texts of the changelog, always read from the default branch).
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
const CHANGELOG_DIR = process.env.CHANGELOG_DIR || path.join(SRC_DIR, 'changelog');
const CHANGELOG_FORMAT = 1;
// changelog/<version>.md = text for every language, <version>.de.md / <version>.en.md = per language
const CHANGELOG_FILE = /^(\d+|next)(?:\.(de|en))?\.md$/;
// changelog/next*.md inside the pushed branch: text for the version this push creates (stored in its manifest)
const NEXT_NOTES_DIR = path.join(SRC_DIR, 'changelog');

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

// ---------------------------------------------------------------------------------------------
// Changelog: one text per version (changelog/<version>.md on the default branch), independent of
// the branches. Changing a text never creates a new version; only changelog.json is republished.
// ---------------------------------------------------------------------------------------------

function readChangelogTexts() {
  const texts = {};
  const problems = [];
  if (!fs.existsSync(CHANGELOG_DIR)) return { texts, problems };
  for (const name of fs.readdirSync(CHANGELOG_DIR).sort()) {
    if (!name.toLowerCase().endsWith('.md') || name.startsWith('_') || name.toLowerCase() === 'readme.md') continue;
    const match = CHANGELOG_FILE.exec(name);
    if (!match) {
      problems.push(`${name}: file name must be <version>.md, <version>.de.md or <version>.en.md (or next*.md)`);
      continue;
    }
    const text = fs.readFileSync(path.join(CHANGELOG_DIR, name), 'utf8').replace(/\r\n/g, '\n').trim();
    if (!text) {
      problems.push(`${name}: is empty`);
      continue;
    }
    if (match[1] === 'next') continue; // pending text of a branch, handled by publish
    const version = Number(match[1]);
    texts[version] = { ...texts[version], [match[2] || 'default']: text };
  }
  return { texts, problems };
}

// Text the pushed branch brings along for the version it creates (changelog/next.md, next.de.md, next.en.md).
function readNextNotes() {
  const notes = {};
  if (!fs.existsSync(NEXT_NOTES_DIR)) return undefined;
  for (const name of fs.readdirSync(NEXT_NOTES_DIR).sort()) {
    const match = CHANGELOG_FILE.exec(name);
    if (!match || match[1] !== 'next') continue;
    const text = fs.readFileSync(path.join(NEXT_NOTES_DIR, name), 'utf8').replace(/\r\n/g, '\n').trim();
    if (text) notes[match[2] || 'default'] = text;
  }
  return Object.keys(notes).length ? notes : undefined;
}

function readManifests(pagesDir) {
  const dir = path.join(pagesDir, 'manifests');
  const result = {};
  if (!fs.existsSync(dir)) return result;
  for (const name of fs.readdirSync(dir)) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    const m = readJson(path.join(dir, name), {});
    result[Number(match[1])] = { created: m.created, branch: m.branch, commit: m.commit, message: m.message, notes: m.notes };
  }
  return result;
}

// Makes sure every release has a history and a releasedAt date (older releases.json files have none).
// Returns true if releases.json has to be rewritten.
function seedReleaseHistory(index, releases, manifests) {
  let changed = false;
  index.releaseHistory = index.releaseHistory || {};
  for (const [name, entry] of Object.entries(releases.releases)) {
    const history = (index.releaseHistory[name] = index.releaseHistory[name] || []);
    const at = entry.releasedAt || manifests[entry.version]?.created || new Date().toISOString();
    if (!history.length || history[history.length - 1].version !== entry.version) {
      history.push({ version: entry.version, at });
    }
    if (!entry.releasedAt) {
      entry.releasedAt = at;
      changed = true;
    }
  }
  return changed;
}

function buildChangelog(index, releases, manifests, texts) {
  const versions = {};
  for (const [version, m] of Object.entries(manifests)) {
    versions[version] = {
      created: m.created,
      branch: m.branch,
      commit: m.commit ? String(m.commit).slice(0, 7) : undefined,
      message: m.message || '',
      ...(texts[version] || m.notes ? { text: { ...m.notes, ...texts[version] } } : {}),
    };
  }
  const out = {};
  for (const [name, entry] of Object.entries(releases.releases)) {
    // One entry per version (its latest move to this release), newest first.
    const latest = new Map();
    for (const h of index.releaseHistory?.[name] || []) latest.set(h.version, h.at);
    const list = [...latest].map(([version, at]) => ({ version, at }));
    list.sort((a, b) => b.at.localeCompare(a.at) || b.version - a.version);
    out[name] = { current: entry.version, versions: list };
  }
  return { format: CHANGELOG_FORMAT, versions, releases: out };
}

// Rewrites changelog.json (+ .sig) and changelog.html if anything changed. Returns true if it did.
function writeChangelog(pagesDir, index, releases, key) {
  const manifests = readManifests(pagesDir);
  const { texts, problems } = readChangelogTexts();
  for (const problem of problems) console.warn(`changelog: ${problem}`);
  for (const version of Object.keys(texts)) {
    if (!manifests[version]) console.warn(`changelog: ${version}.md belongs to a version that does not exist (yet), it is shown once the version is published`);
  }
  const data = buildChangelog(index, releases, manifests, texts);
  // The page template is part of the fingerprint, so a changed template is republished as well.
  const fingerprint = sha256(JSON.stringify(data) + sha256(renderChangelogHtml.toString()));
  const file = path.join(pagesDir, 'changelog.json');
  if (index.changelogHash === fingerprint && fs.existsSync(file) && fs.existsSync(path.join(pagesDir, 'changelog.html'))) {
    return false;
  }
  index.changelogSeq = (index.changelogSeq || 0) + 1;
  index.changelogHash = fingerprint;
  const signed = { ...data, seq: index.changelogSeq, updated: new Date().toISOString() };
  writeSigned(file, signed, key);
  fs.writeFileSync(path.join(pagesDir, 'changelog.html'), renderChangelogHtml(signed));
  console.log(`Changelog updated (seq ${index.changelogSeq}, ${Object.keys(data.versions).length} versions).`);
  return true;
}

// Self-contained page: tabs per release, search, #v<version> links. All text is inserted as text nodes.
function renderChangelogHtml(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Settlers United S4 content changelog</title>
<style>
  :root { color-scheme: light dark; --fg:#1d1d1f; --bg:#fff; --muted:#6e6e73; --line:#d2d2d7; --accent:#3b6fd4; }
  @media (prefers-color-scheme: dark) { :root { --fg:#f2f2f2; --bg:#16181d; --muted:#9a9aa3; --line:#33363d; --accent:#7ea6ee; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; }
  main { max-width:960px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:22px; margin:0 0 16px; }
  .bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:16px; }
  .tabs { display:flex; flex-wrap:wrap; gap:6px; }
  button, input, select { font:inherit; color:inherit; background:transparent; border:1px solid var(--line); border-radius:6px; padding:5px 10px; }
  button { cursor:pointer; }
  button.all { margin-right:14px; position:relative; }
  button.all::after { content:""; position:absolute; right:-11px; top:15%; bottom:15%; width:1px; background:currentColor; opacity:.35; }
  button[aria-selected="true"] { border-color:var(--accent); color:var(--accent); }
  input { flex:1; min-width:160px; }
  article { border-top:1px solid var(--line); padding:14px 0; }
  article.hl { background:color-mix(in srgb, var(--accent) 12%, transparent); }
  h2 { font-size:21px; margin:0; }
  h4 { font-size:18px; font-weight:700; line-height:1.3; margin:16px 0 4px; }
  h2 a { color:inherit; text-decoration:none; }
  .meta { color:var(--muted); font-size:13px; margin:2px 0 6px; }
  .tag { display:inline-block; border:1px solid currentColor; border-radius:4px; padding:1px 10px; font-size:14px; font-weight:700; letter-spacing:.02em; margin-right:8px; vertical-align:middle; }
  .tag.on { color:#fff !important; }
  .badge { border:1px solid var(--accent); color:var(--accent); border-radius:10px; padding:1px 10px; font-size:13px; margin-left:6px; vertical-align:middle; }
  p { margin:6px 0; } ul { margin:6px 0; padding-left:22px; } code { background:color-mix(in srgb, var(--muted) 20%, transparent); padding:0 4px; border-radius:3px; }
  .empty { color:var(--muted); padding:24px 0; }
</style>
</head>
<body>
<main>
<h1>S4 content changelog</h1>
<div class="bar">
  <div class="tabs" id="tabs" role="tablist"></div>
  <input id="q" type="search" placeholder="Search version or text" aria-label="Search">
  <select id="lang" aria-label="Language"><option value="en">English</option><option value="de">Deutsch</option></select>
</div>
<div id="list"></div>
</main>
<script type="application/json" id="data">${json}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('data').textContent);
  var tabsEl = document.getElementById('tabs'), listEl = document.getElementById('list');
  var qEl = document.getElementById('q'), langEl = document.getElementById('lang');
  var names = Object.keys(data.releases).sort(function (a, b) { return a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b); });
  var PALETTE = ['#fb8c00', '#1e88e5', '#8e24aa', '#d81b60', '#00897b', '#6d4c41', '#7cb342', '#5e35b1'];
  var color = function (n) { if (n === 'main') return '#43a047'; var o = names.filter(function (x) { return x !== 'main'; }).sort(); return PALETTE[Math.max(0, o.indexOf(n)) % PALETTE.length]; };
  var label = function (n) { return n === 'main' ? 'Stable' : n.charAt(0).toUpperCase() + n.slice(1); };
  var params = new URLSearchParams(location.search);
  var tab = params.get('release') || (names.indexOf('main') >= 0 ? 'main' : names[0]) || 'all';
  langEl.value = params.get('lang') || ((navigator.language || 'en').slice(0, 2) === 'de' ? 'de' : 'en');
  qEl.value = params.get('q') || '';
  var focus = (location.hash.match(/^#v(\\d+)$/) || [])[1];

  function fmt(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(langEl.value === 'de' ? 'de-DE' : 'en-GB', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  function textOf(v) { var t = (data.versions[v] || {}).text || {}; return t[langEl.value] || t.default || t.en || t.de || ''; }
  function inline(parent, s) {
    s.split(/(\\*\\*[^*]+\\*\\*|\`[^\`]+\`)/).forEach(function (part) {
      if (!part) return;
      var el = null;
      if (part.slice(0, 2) === '**' && part.slice(-2) === '**' && part.length > 4) { el = document.createElement('strong'); el.textContent = part.slice(2, -2); }
      else if (part[0] === '\`' && part.slice(-1) === '\`' && part.length > 2) { el = document.createElement('code'); el.textContent = part.slice(1, -1); }
      parent.appendChild(el || document.createTextNode(part));
    });
  }
  function markdown(parent, md) {
    var ul = null, p = null;
    md.split('\\n').forEach(function (line) {
      var item = /^\\s*[-*]\\s+(.*)$/.exec(line);
      var head = /^#+\\s+(.*)$/.exec(line);
      if (head) { ul = null; p = null; var h = document.createElement('h4'); inline(h, head[1]); parent.appendChild(h); return; }
      if (item) { p = null; if (!ul) { ul = document.createElement('ul'); parent.appendChild(ul); } var li = document.createElement('li'); inline(li, item[1]); ul.appendChild(li); }
      else if (!line.trim()) { ul = null; p = null; }
      else { ul = null; if (!p) { p = document.createElement('p'); parent.appendChild(p); } else p.appendChild(document.createElement('br')); inline(p, line.replace(/^#+\\s*/, '')); }
    });
  }
  function rows() {
    if (tab === 'all') return Object.keys(data.versions).map(Number).sort(function (a, b) { return b - a; }).map(function (v) { return { version: v, at: data.versions[v].created }; });
    return ((data.releases[tab] || {}).versions || []);
  }
  function releasesOf(v) {
    return names.map(function (n) { var e = (data.releases[n].versions || []).filter(function (x) { return x.version === v; })[0]; return e ? { name: n, at: e.at } : null; })
      .filter(Boolean).sort(function (a, b) { return a.at.localeCompare(b.at); });
  }
  function render() {
    tabsEl.textContent = '';
    ['all'].concat(names).forEach(function (n) {
      var b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(n === tab));
      b.textContent = n === 'all' ? 'All versions' : label(n);
      if (n === 'all') b.className = 'all';
      b.onclick = function () { tab = n; render(); }; tabsEl.appendChild(b);
    });
    var q = qEl.value.trim().toLowerCase().replace(/^v/, '');
    listEl.textContent = '';
    var shown = 0;
    rows().forEach(function (r) {
      var v = data.versions[r.version] || {}, text = textOf(r.version);
      var haystack = (r.version + ' ' + (v.message || '') + ' ' + text).toLowerCase();
      if (q && haystack.indexOf(q) < 0) return;
      shown++;
      var art = document.createElement('article'); art.id = 'v' + r.version; if (String(r.version) === focus) art.className = 'hl';
      var h = document.createElement('h2'), a = document.createElement('a'); a.href = '#v' + r.version; a.textContent = 'Version ' + r.version; h.appendChild(a);
      if (tab !== 'all' && data.releases[tab].current === r.version) { var cur = document.createElement('span'); cur.className = 'badge'; cur.textContent = 'current'; h.appendChild(cur); }
      var meta = document.createElement('div'); meta.className = 'meta';
      var rel = releasesOf(r.version);
      rel.forEach(function (x) {
        var t = document.createElement('span'), now = data.releases[x.name].current === r.version;
        t.className = 'tag' + (now ? ' on' : ''); t.textContent = label(x.name);
        t.style.color = color(x.name); if (now) t.style.background = color(x.name);
        t.title = label(x.name) + (now ? ' (current) ' : ' (replaced) ') + fmt(x.at);
        meta.appendChild(t); meta.appendChild(document.createTextNode(fmt(x.at) + '  '));
      });
      if (!rel.length) meta.textContent = 'not released (built ' + fmt(v.created) + ')';
      art.appendChild(h); art.appendChild(meta);
      if (text) markdown(art, text); else if (v.message) { var m = document.createElement('p'); m.textContent = v.message; art.appendChild(m); }
      listEl.appendChild(art);
    });
    if (!shown) { var e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No matching versions.'; listEl.appendChild(e); }
    if (focus) { var t = document.getElementById('v' + focus); if (t) t.scrollIntoView(); focus = null; }
  }
  if (focus) { var home = names.filter(function (n) { return releasesOf(Number(focus)).some(function (x) { return x.name === n; }); })[0]; if (home && !params.get('release')) tab = home; else if (!home) tab = 'all'; }
  qEl.oninput = render; langEl.onchange = render; window.onhashchange = function () { focus = (location.hash.match(/^#v(\\d+)$/) || [])[1]; render(); };
  render();
})();
</script>
</body>
</html>
`;
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

    // A next.md that was already used by an earlier version is stale (it stayed in the branch): ignore it.
    let notes = readNextNotes();
    if (notes && Object.values(readManifests(pagesDir)).some((m) => JSON.stringify(m.notes) === JSON.stringify(notes))) {
      console.log('changelog/next*.md was already used by an earlier version, ignored.');
      notes = undefined;
    }
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
      ...(notes ? { notes } : {}),
      files: files.map(({ abs, ...f }) => ({ ...f, url: index.objects[f.sha256].url })),
    };
    writeSigned(path.join(pagesDir, 'manifests', `${version}.json`), manifest, key);
    index.latestVersion = version;
    index.contentVersions[contentHash] = version;
  }

  const mirrors = config.mirrors || [];
  const manifests = readManifests(pagesDir);
  const backfilled = seedReleaseHistory(index, releases, manifests);
  const current = releases.releases[branch];
  const pointerMoves = current?.version !== version;
  const mirrorsChanged = JSON.stringify(releases.mirrors) !== JSON.stringify(mirrors);
  if (pointerMoves) {
    // A version keeps its number and its changelog when it moves between releases (e.g. preview -> stable).
    const releasedAt = new Date().toISOString();
    releases.releases[branch] = { version, criticalHash, releasedAt };
    (index.releaseHistory[branch] = index.releaseHistory[branch] || []).push({ version, at: releasedAt });
  }
  if (pointerMoves || mirrorsChanged || backfilled) {
    releases.mirrors = mirrors;
    saveReleases(pagesDir, index, releases, key);
    console.log(`Release ${branch} -> version ${version} (criticalHash ${criticalHash.slice(0, 12)}).`);
  } else {
    console.log(`Release ${branch} already points to version ${version}.`);
  }
  writeChangelog(pagesDir, index, releases, key);
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
  writeChangelog(pagesDir, index, releases, key);
  writeJson(path.join(pagesDir, 'index.json'), index);
  console.log(`Release ${branch} removed.`);
}

// Regenerates changelog.json / changelog.html from the current state without touching any release.
async function changelog() {
  const pagesDir = env('PAGES_DIR');
  const key = crypto.createPrivateKey(env('SIGNING_KEY'));
  const { index, releases } = loadState(pagesDir);
  const backfilled = seedReleaseHistory(index, releases, readManifests(pagesDir));
  if (backfilled) saveReleases(pagesDir, index, releases, key);
  writeChangelog(pagesDir, index, releases, key);
  writeJson(path.join(pagesDir, 'index.json'), index);
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

  const { texts, problems } = readChangelogTexts();
  if (problems.length) throw new Error(`Changelog problems:\n  ${problems.join('\n  ')}`);
  console.log(`changelog: ${Object.keys(texts).length} versions with text`);
}

const commands = { check, publish, remove, changelog };
const command = commands[process.argv[2]];
if (!command) {
  console.error('Usage: node tools/publish.mjs check|publish|remove|changelog');
  process.exit(2);
}
Promise.resolve(command()).catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
