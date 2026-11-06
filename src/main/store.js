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
    return { serverName: 'the Nullnetwork team', shareEndpoint: '', discordInvite: '' };
  }

  // The share endpoint (and therefore the update feed) is baked into the build and
  // is never user-editable: a URL a player could be talked into pasting would also
  // decide where "Update now" downloads from. NN_SHARE_ENDPOINT is for development.
  get effectiveEndpoint() {
    const raw = (process.env.NN_SHARE_ENDPOINT || this.appConfig.shareEndpoint || '').trim();
    if (!raw) return '';
    try {
      const u = new URL(raw);
      const devHttp = process.env.NN_SHARE_ENDPOINT && u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !devHttp) return '';
      return u.origin;
    } catch { return ''; }
  }

  // Renderer-supplied settings: only known keys, only the expected shape.
  setSettings(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    for (const k of Object.keys(p)) {
      if (!Object.hasOwn(SETTINGS_DEFAULTS, k)) continue;
      const v = p[k];
      switch (k) {
        case 'sharePolicy': if (['ask', 'always', 'never'].includes(v)) this.settings[k] = v; break;
        case 'playerTag': if (typeof v === 'string') this.settings[k] = v.slice(0, 64); break;
        case 'fivemPath': if (typeof v === 'string' && v.length < 1024 && !v.includes('\0')) this.settings[k] = v; break;
        case 'keepDays': if (Number.isFinite(Number(v))) this.settings[k] = Math.min(365, Math.max(1, Math.round(Number(v)))); break;
        default: if (typeof v === 'boolean') this.settings[k] = v;
      }
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
  // The folder an incident's files live in, or null unless it is a real directory that is
  // a direct child of the captures folder. history.json is plain JSON on disk, so
  // nothing it says may point a delete (or a read) anywhere else; symlinks and
  // junctions are refused as well.
  captureDir(inc) {
    if (!inc || typeof inc.dir !== 'string' || !inc.dir) return null;
    const root = path.resolve(this.capturesDir);
    const dir = path.resolve(root, inc.dir);
    const rel = path.relative(root, dir);
    if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel) || /[\\/]/.test(rel)) return null;
    try { const st = fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) return null; } catch { return null; }
    return dir;
  }
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
