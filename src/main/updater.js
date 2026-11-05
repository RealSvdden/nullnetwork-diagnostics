'use strict';
// Update checks against <endpoint>/v1/update (electron-updater "generic"
// provider: latest.yml + the NSIS installer). Nothing downloads or installs
// without the player saying yes in the app.
const { app } = require('electron');
const { EventEmitter } = require('events');

const CHECK_EVERY_MS = 6 * 3600 * 1000;

class Updater extends EventEmitter {
  constructor({ store }) {
    super();
    this.store = store;
    this.state = { status: 'idle', version: null, pct: 0, error: null };
    this.auto = null;
    this.timer = null;
  }

  get enabled() { return app.isPackaged && !!this.store.effectiveEndpoint; }

  start() {
    if (!this.enabled) { this.set({ status: 'disabled' }); return; }
    let autoUpdater;
    try { ({ autoUpdater } = require('electron-updater')); } catch { this.set({ status: 'disabled' }); return; }
    this.auto = autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.setFeedURL({ provider: 'generic', url: new URL('/v1/update', this.store.effectiveEndpoint).toString(), useMultipleRangeRequest: false });
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'available', version: info.version, pct: 0 }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'none', version: null }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', pct: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version, pct: 100 }));
    autoUpdater.on('error', (err) => this.set({ status: 'error', error: String(err && err.message || err).split('\n')[0].slice(0, 200) }));
    setTimeout(() => this.check(), 15000);
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  stop() { clearInterval(this.timer); }

  set(patch) { this.state = { ...this.state, ...patch }; this.emit('state', this.state); }

  async check() {
    if (!this.auto || this.state.status === 'downloading' || this.state.status === 'ready') return this.state;
    try { await this.auto.checkForUpdates(); } catch (err) { this.set({ status: 'error', error: String(err && err.message || err).slice(0, 200) }); }
    return this.state;
  }

  async download() {
    if (!this.auto || this.state.status !== 'available') return this.state;
    this.set({ status: 'downloading', pct: 0 });
    try { await this.auto.downloadUpdate(); } catch (err) { this.set({ status: 'error', error: String(err && err.message || err).slice(0, 200) }); }
    return this.state;
  }

  install() {
    if (!this.auto || this.state.status !== 'ready') return;
    setImmediate(() => this.auto.quitAndInstall(false, true));
  }
}

module.exports = { Updater };
