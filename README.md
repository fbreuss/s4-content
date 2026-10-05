# s4-content

Mod-Dateien für den Settlers-United-Launcher. `bin/` entspricht exakt dem `bin/`-Ordner des Launchers.

## Veröffentlichen

Dateien in `bin/` ändern, committen, pushen. Jeder Push auf einen Branch geht automatisch live:

- `main` = Stable-Kanal, jeder andere Branch = eigener Kanal (z. B. `preview`)
- Branches mit `wip/`-Präfix werden **nicht** veröffentlicht
- Branch löschen = Kanal entfernen (`main` kann nicht entfernt werden)
- Rollback: `git revert` + Push (gleicher Inhalt = gleiche Revision, nichts wird neu hochgeladen)

Vor dem Push lokal prüfen (optional): `node tools/publish.mjs check`

## Konfiguration (`packages.json`)

- `critical`: Dateien, die auf allen Rechnern identisch sein müssen (ergeben den `criticalHash`)
- `preserve`: Pfade, die der Launcher nie löscht oder überschreibt
- `mirrors`: zusätzliche Download-Quellen (`<basis>/<sha256>`)

## Veröffentlichte Daten

- `https://fbreuss.github.io/s4-content/channels.json` (+ `.sig`): Kanal → Revision
- `https://fbreuss.github.io/s4-content/manifests/<rev>.json` (+ `.sig`): Dateiliste jeder Revision
- Release `rev-<N>`: Dateien, die in Revision N neu dazugekommen sind (benannt nach SHA-256)

Signiert mit Ed25519 (`SIGNING_KEY`-Secret). Neuer Schlüssel: `node tools/keygen.mjs`.
