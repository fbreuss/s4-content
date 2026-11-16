# s4-content

Mod files for the Settlers United launcher. `bin/` mirrors the launcher's `bin/` folder exactly.

## Publishing

Change files in `bin/`, commit, push. Every push to a branch goes live automatically:

- Every branch is an **S4 release version** (selectable in the launcher under Settings → S4 Release Version):
  `main` = Stable, every other branch = its own release version (e.g. `preview`)
- Branches with a `wip/` prefix are **not** published
- Deleting a branch removes its release version (`main` cannot be removed)
- Rollback: `git revert` + push (identical content = identical version, nothing is uploaded again)

Optional local check before pushing: `node tools/publish.mjs check`

## Changelog

Two ways to write a text, both end up in the same changelog:

**1. Together with the update (one push)**: put the text into `changelog/next.md` (or `next.de.md` / `next.en.md`) in the
branch you push together with the changed files. The new version gets this text (stored in its manifest). A `next.md` that was
already used by an earlier version is ignored, so a stale file does no harm; delete it whenever you like.

**2. Afterwards / only text (no new version)**: add `changelog/<version>.md` (or `<version>.de.md` / `<version>.en.md`)
on **`main`** and push. The content stays identical, so no version is created; only the changelog is republished.
A text written this way replaces the `next.md` text of that version (per language), so it is also the way to fix typos later.

- Versions without any text show the commit subject as fallback.
- A promotion (e.g. `preview` → `main`) keeps the version number and therefore its changelog entry.
- `node tools/publish.mjs check` validates the file names.

Published (signed with the same key): `changelog.json` (+ `.sig`) with all versions, texts and the history of each release,
and `changelog.html` (tabs per release, search, language switch, `changelog.html#v<N>` links to a version,
`?release=<name>` selects a tab). Every release entry in `releases.json` also has `releasedAt`.

## Configuration (`bin/packages.json`)

- `critical`: files that must be identical on all machines (they make up the `criticalHash`, e.g. balancing and plugin)
- `preserve`: paths the launcher never deletes or overwrites
- `mirrors`: additional download sources (`<base>/<sha256>`)
- `_readme`: explanation only, ignored by the tools

**`critical` is the only place that defines the critical files.** The file lies in `bin/` on purpose, so it is published
and installed into the launcher's `bin/` like every other content file. Three parts work with the same list:

1. `tools/publish.mjs` builds the `criticalHash` of every version from it (stored in the manifest and in `releases.json`).
2. The launcher writes that `criticalHash` to the registry as `ModHash` when it installs a version (nothing to change there).
3. The SettlersUnited plugin (`S4ModVersion.cpp`) reads `packages.json` from the launcher's `bin/` at every game start,
   hashes the listed files on disk the same way and compares the result with `ModHash`. Different = the warning
   "Die Settlers-United-Dateien ... unterscheiden sich von der installierten Version".

So adding or removing a critical file needs **no code change**, just a push. Every player gets the new list with that
version. Requirements:

- Never move `packages.json` out of `bin/` and never keep a second copy in the repository root:
  `publish.mjs` stops with an error then.
- The plugin in `Plugin_SU.zip` must be one that reads `bin/packages.json` (S4ModVersion.cpp, s4-helper branch `stable`
  since 2026-11-16). An older plugin still uses its built-in list (`settlers-united.dll`, `BalanceConfigs.zip`, `Plugin_SU.zip`); with any other list
  it shows the warning at every start.
- A branch without `bin/packages.json` (e.g. an old `Preview`) keeps its own root `packages.json` and old `publish.mjs`
  until it is merged with `main`; a plugin that finds no `bin/packages.json` skips the file check (no warning).

## Published data

- `https://fbreuss.github.io/s4-content/releases.json` (+ `.sig`): release version (branch) → version
- `https://fbreuss.github.io/s4-content/changelog.html` (+ `changelog.json`, `.sig`): changelog
- `https://fbreuss.github.io/s4-content/manifests/<version>.json` (+ `.sig`): file list of every version
- GitHub release `v<N>`: file storage only – the files that were added in version N (named by SHA-256)

Signed with Ed25519 (`SIGNING_KEY` secret). New key pair: `node tools/keygen.mjs`.
