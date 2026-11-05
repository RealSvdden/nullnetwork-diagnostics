# Nullnetwork Diagnostics

A small open-source Windows app that runs in the tray beside FiveM. When the game crashes it saves the crash report on your PC and asks whether to share it with the Nullnetwork team. Nothing is sent without your yes.

**Download:** https://diagnostics.nullnetwork.ca · **Releases:** https://github.com/RealSvdden/nullnetwork-diagnostics/releases

Crash capture is the first module. The main process is a module host, so later collectors (packet captures, network telemetry, performance traces) can be added beside it without changing the consent flow, and each one will be visible in this repo before it ships.

## What it does

1. Polls for the FiveM game process every 2 seconds and watches `%LOCALAPPDATA%\FiveM\FiveM.app\crashes` for new `.dmp` files.
2. When a dump appears it waits for FiveM to finish writing it (and the `.dmp.gamelog` beside it), then copies both into a capture folder, gzips the current `CitizenFX_log_*.log` next to them, and writes `report.json`: the crash signature, message and stack parsed from the log's `Process crash captured` block, the FiveM `si-...` report id, a few vitals from the gamelog, and OS / CPU / RAM.
3. Shows a notification and a consent dialog listing exactly what was saved and what sharing sends, with an optional note ("what were you doing?") and name.
4. On yes, uploads through the signed protocol below with a progress bar. Failures stay retryable from the Captures view. "Always share" and "Never share" are settings.

Captures live in `%APPDATA%\Nullnetwork Diagnostics\captures\<timestamp>_<dumpid>\`. Reports you shared or declined are deleted after `keepDays` (default 14); pending ones are kept.

## What it reads and sends

- **Reads:** the FiveM `crashes\` and `logs\` folders, the process list (to see whether FiveM is running), and basic machine facts from the OS (`os.type()`, CPU model, total RAM). Nothing else on disk.
- **Sends, only when you share:** the minidump FiveM wrote (a snapshot of the game process memory, which can include your Windows username in paths), the gamelog, the CitizenFX log, the machine facts above, the FiveM build, and your note and name if you typed them.
- **Never:** no uploads without a click (unless you turn on "Always share"), no telemetry, no accounts, no reading outside those folders. The server stores your IP only as a salted hash.

You can open the capture folder from the app at any time and delete anything in it.

## Build it yourself

```
git clone https://github.com/RealSvdden/nullnetwork-diagnostics.git
cd nullnetwork-diagnostics
npm install
npm start          # run from source
npm run dist       # build dist\Nullnetwork-Diagnostics-Setup-<version>.exe
```

Needs Node.js 20+ on Windows. `npm run dist` also writes `dist\latest.yml` with the installer's SHA-512, which is what the in-app updater verifies. `npm run icons` regenerates `assets/*.png` from `scripts/make-icons.js` (no image tools needed).

Dev helpers:

- `NN_USER_DATA=<dir>` runs against a clean profile (settings, history, captures under that dir).
- `NN_SHARE_ENDPOINT=http://127.0.0.1:8787` points a dev run at a local worker. There is no in-app setting for this on purpose: the endpoint also decides where updates come from, so it is baked into the build (`app.config.json`) and must be https.
- Settings > FiveM > Change folder can point at any folder with `crashes\` and `logs\` subfolders, so you can test by dropping an old `.dmp` in.
- `npm start -- --remote-debugging-port=9222` exposes the renderer to DevTools.

## Layout

```
src/main/main.js            window, tray, notifications, IPC, share flow, retention
src/main/store.js           settings.json + history.json in userData
src/main/fivem.js           FiveM paths + process detection (tasklist)
src/main/device.js          per-install id + secret (Electron safeStorage), registration
src/main/uploader.js        signed upload protocol with real progress
src/main/updater.js         electron-updater wrapper (asks first, never silent)
src/main/modules/crash/     the crash module (watcher + capture + log parsing)
src/preload.js              contextBridge: window.nn.invoke / window.nn.on
src/renderer/               vanilla HTML/CSS/JS, three views + consent dialog
worker/                     Cloudflare Worker: download page, update feed, ingest
docs/SCHEMA.sql             the D1 tables the worker writes
scripts/release.ps1         maintainers: deploy, build, publish
app.config.json             baked into the build: serverName, shareEndpoint, discordInvite
```

## How sharing works (the security model)

The worker in `worker/` is everything the app talks to. It is designed so that nothing in this public repo or in the installer is a secret, and so that the endpoint cannot be used to read reports or to spam them.

- **Per-install identity.** On first share the app calls `POST /v1/register` and gets a device id + secret. The secret is derived server-side from a master key and never stored; the app keeps it encrypted with the Windows user keychain (`safeStorage`). Staff can block an install from sharing again.
- **Every write is signed.** `X-NN-Sig = HMAC-SHA256(secret, method \n path \n ts \n nonce \n bodySha256)`. Timestamps expire after 5 minutes and nonces are single use, so a captured request cannot be replayed or altered.
- **Declared uploads.** `POST /v1/capture` declares the meta and a manifest (name, size, sha256 per file). Each file then goes up with `PUT /v1/capture/:ref/file/:name`, streamed straight into R2, which verifies the sha256; `POST /v1/capture/:ref/complete` closes it. File names, sizes, count, content magic (`MDMP`, gzip, text) and every meta field are allow-listed and length-capped.
- **Limits.** Burst limits per IP and per device at the edge; 5 registrations per IP per hour, 6 uploads per device per hour, 12 per day, 512 MiB per day from the database.
- **No read path.** There is no endpoint that returns a capture. The bucket is private; staff read reports through the admin panel behind its own permissions.
- **Public surface.** `GET /` (this download page), `GET /health`, and `GET /v1/update/<file>` (the update feed), all read-only and rate limited.
- **Pinned endpoint.** The endpoint is compiled into the installer and cannot be changed from the app, so neither uploads nor updates can be redirected by editing a setting.

## Updates

Installed builds check `<shareEndpoint>/v1/update/latest.yml` 15 s after launch and every 6 hours. A newer version shows a banner and a notification; nothing downloads until you click **Update now**, and the restart is a second explicit click. The updater verifies the installer's SHA-512 against `latest.yml`. The same installer and `latest.yml` are attached to each GitHub release so you can compare hashes.

## Releasing (maintainers)

```
cd worker && npm install && npx wrangler login && cd ..
powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -InitSecrets   # first time
```

Only the Cloudflare account that owns the `nullnetwork-diagnostics` worker and bucket can run these: `wrangler deploy` and the `releases/` upload fail for any other login, and installed apps are pinned to `diagnostics.nullnetwork.ca`, which only that account can serve. Anyone can fork and deploy their own copy under their own account, but no existing install will ever contact it. The GitHub release step needs push access to this repository.

Then for each release: bump `version` in `package.json`, commit, and run the script without `-InitSecrets`. It deploys the worker, builds the installer, uploads it with `latest.yml` to the bucket's `releases/` prefix, creates the GitHub release when `gh` is logged in, and verifies the live endpoints. The D1 tables come from the admin panel's migrations (`docs/SCHEMA.sql` is a copy).

## Adding a module

A module is an `EventEmitter` with `start()`, `stop()`, `reconfigure()`, `snapshot()` that emits `state` and `incident`. An incident is `{ id, module, at, title, message, files[], dir, totalBytes, share: { status: 'pending' } }` with its files already written to `dir`. Register it in `startModules()` in `main.js`; the consent dialog, Captures view, upload, retention and the worker's allow-lists are shared. New file types must be added to the worker's `FILE_RULES` before the server will accept them.

## License

MIT. See `LICENSE`.
