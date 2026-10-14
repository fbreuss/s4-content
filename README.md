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

## Configuration (`packages.json`)

- `critical`: files that must be identical on all machines (they make up the `criticalHash`, e.g. balancing and plugin)
- `preserve`: paths the launcher never deletes or overwrites
- `mirrors`: additional download sources (`<base>/<sha256>`)

## Published data

- `https://fbreuss.github.io/s4-content/releases.json` (+ `.sig`): release version (branch) → version
- `https://fbreuss.github.io/s4-content/changelog.html` (+ `changelog.json`, `.sig`): changelog
- `https://fbreuss.github.io/s4-content/manifests/<version>.json` (+ `.sig`): file list of every version
- GitHub release `v<N>`: file storage only – the files that were added in version N (named by SHA-256)

Signed with Ed25519 (`SIGNING_KEY` secret). New key pair: `node tools/keygen.mjs`.
