'use strict';
// Persistent settings + incident history. Plain JSON files in userData so the
// player can inspect or wipe them by hand.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const SETTINGS_DEFAULTS = Object.freeze({
  sharePolicy: 'ask',        // 'ask' | 'always' | 'never'
  playerTag: '',             // optional: in-game name / Discord handle
  launchAtStartup: false,
  startMinimized: false,
  keepDays: 14,              // local retention for captures that were shared or declined
  shareEndpoint: '',         // '' -> use app.config.json
  fivemPath: '',             // '' -> auto (%LOCALAPPDATA%\FiveM\FiveM.app)
  notifications: true,
  onboarded: false,
});

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

class Store {
  constructor() {
    this.dir = app.getPath('userData');
    this.settingsFile = path.join(this.dir, 'settings.json');
    this.historyFile = path.join(this.dir, 'history.json');
    this.capturesDir = path.join(this.dir, 'captures');
    this.settings = { ...SETTINGS_DEFAULTS, ...readJson(this.settingsFile, {}) };
    this.history = readJson(this.historyFile, { incidents: [], events: [] });
    this.appConfig = this.loadAppConfig();
    fs.mkdirSync(this.capturesDir, { recursive: true });
  }

  loadAppConfig() {
    // Baked in at build time (extraResources) so players never have to type a URL.
    const candidates = [
      path.join(process.resourcesPath || '', 'app.config.json'),
      path.join(app.getAppPath(), 'app.config.json'),
    ];
    for (const c of candidates) {
      const v = readJson(c, null);
      if (v) return v;
    }
    return { serverName: 'THE LAND LA', shareEndpoint: '', discordInvite: '' };
  }

  get effectiveEndpoint() {
    return (this.settings.shareEndpoint || this.appConfig.shareEndpoint || '').trim();
  }

  setSettings(patch) {
    for (const k of Object.keys(patch)) {
      if (!(k in SETTINGS_DEFAULTS)) continue;
      this.settings[k] = patch[k];
    }
    writeJson(this.settingsFile, this.settings);
    return this.settings;
  }

  // --- incidents -----------------------------------------------------------
  addIncident(inc) {
    this.history.incidents.unshift(inc);
    this.history.incidents = this.history.incidents.slice(0, 200);
    this.saveHistory();
    return inc;
  }
  updateIncident(id, patch) {
    const inc = this.history.incidents.find((i) => i.id === id);
    if (!inc) return null;
    Object.assign(inc, patch);
    this.saveHistory();
    return inc;
  }
  getIncident(id) { return this.history.incidents.find((i) => i.id === id) || null; }
  removeIncident(id) {
    this.history.incidents = this.history.incidents.filter((i) => i.id !== id);
    this.saveHistory();
  }
  addEvent(type, detail) {
    this.history.events.unshift({ at: new Date().toISOString(), type, detail: detail || null });
    this.history.events = this.history.events.slice(0, 100);
    this.saveHistory();
  }
  saveHistory() { writeJson(this.historyFile, this.history); }
}

module.exports = { Store, SETTINGS_DEFAULTS };
