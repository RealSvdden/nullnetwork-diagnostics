'use strict';
// Update checks against <endpoint>/v1/update (electron-updater "generic"
// provider: latest.yml + the NSIS installer). Updates are automatic: the app
// checks on every launch and every 6 hours, downloads a newer version in the
// background, and restarts into it as soon as nothing is in flight (no upload
// running, no fresh crash waiting for an answer). The installer's SHA-512 is
// verified against latest.yml before anything runs.
const { app } = require('electron');
const { EventEmitter } = require('events');

const CHECK_EVERY_MS = 6 * 3600 * 1000;
const FIRST_CHECK_MS = 3000;        // let the window and tray come up first
const BUSY_RETRY_MS = 30 * 1000;    // re-try the restart while an upload runs
const INSTALL_GRACE_MS = 4000;      // time for the "updating" notice to show

class Updater extends EventEmitter {
  // isBusy(): true while a share is uploading or a new crash is waiting for the
  // player's answer; the restart waits until it returns false.
  constructor({ store, isBusy }) {
    super();
    this.store = store;
    this.isBusy = typeof isBusy === 'function' ? isBusy : () => false;
    this.state = { status: 'idle', version: null, pct: 0, error: null };
    this.auto = null;
    this.timer = null;
    this.installTimer = null;
  }

  // Feed = baked endpoint only, https only (effectiveEndpoint already enforces both).
  get enabled() { return app.isPackaged && /^https:/.test(this.store.effectiveEndpoint); }

  start() {
    if (!this.enabled) { this.set({ status: 'disabled' }); return; }
    let autoUpdater;
    try { ({ autoUpdater } = require('electron-updater')); } catch { this.set({ status: 'disabled' }); return; }
    this.auto = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // a download that is still waiting installs on the next quit anyway
    autoUpdater.allowDowngrade = false;
    autoUpdater.setFeedURL({ provider: 'generic', url: new URL('/v1/update', this.store.effectiveEndpoint).toString(), useMultipleRangeRequest: false });
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, pct: 0 }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'none', version: null }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', pct: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => { this.set({ status: 'ready', version: info.version, pct: 100 }); this.scheduleInstall(); });
    autoUpdater.on('error', (err) => this.set({ status: 'error', error: String(err && err.message || err).split('\n')[0].slice(0, 200) }));
    setTimeout(() => this.check(), FIRST_CHECK_MS);
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  stop() { clearInterval(this.timer); clearTimeout(this.installTimer); }

  set(patch) { this.state = { ...this.state, ...patch }; this.emit('state', this.state); }

  async check() {
    if (!this.auto || this.state.status === 'downloading' || this.state.status === 'ready') return this.state;
    try { await this.auto.checkForUpdates(); } catch (err) { this.set({ status: 'error', error: String(err && err.message || err).slice(0, 200) }); }
    return this.state;
  }

  // Kept for the "Check for updates" button: with autoDownload on, a check that
  // finds something starts the download by itself.
  async download() { return this.check(); }

  // Restart into the downloaded version once the app is idle. Called from the
  // downloaded event and from the renderer's button; re-arms itself while busy.
  scheduleInstall() {
    clearTimeout(this.installTimer);
    if (!this.auto || this.state.status !== 'ready') return;
    if (this.isBusy()) {
      this.set({ status: 'ready', waiting: true });
      this.installTimer = setTimeout(() => this.scheduleInstall(), BUSY_RETRY_MS);
      return;
    }
    this.set({ status: 'installing', waiting: false });
    this.emit('installing', this.state);
    this.installTimer = setTimeout(() => this.auto.quitAndInstall(true, true), INSTALL_GRACE_MS);
  }

  install() { this.scheduleInstall(); }
}

module.exports = { Updater };
