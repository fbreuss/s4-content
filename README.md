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

## Configuration (`packages.json`)

- `critical`: files that must be identical on all machines (they make up the `criticalHash`)
- `preserve`: paths the launcher never deletes or overwrites
- `mirrors`: additional download sources (`<base>/<sha256>`)

## Published data

- `https://fbreuss.github.io/s4-content/releases.json` (+ `.sig`): release version (branch) → version
- `https://fbreuss.github.io/s4-content/manifests/<version>.json` (+ `.sig`): file list of every version
- GitHub release `v<N>`: file storage only – the files that were added in version N (named by SHA-256)

Signed with Ed25519 (`SIGNING_KEY` secret). New key pair: `node tools/keygen.mjs`.
