'use strict';
// Nullnetwork Diagnostics - main process.
// Hosts diagnostic modules (crash today; pcap and friends later), owns the
// window + tray, and is the only place that talks to the share endpoint.
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeImage, dialog } = require('electron');
const { Store } = require('./store');
const { CrashModule } = require('./modules/crash');
const { uploadCapture } = require('./uploader');
const { Device } = require('./device');
const { Updater } = require('./updater');
const fivem = require('./fivem');

const APP_ID = 'network.nullnetwork.diagnostics';
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const HIDDEN_FLAG = '--hidden';

// NN_USER_DATA lets you run against a clean profile (dev/testing) without touching your real one.
if (process.env.NN_USER_DATA) app.setPath('userData', process.env.NN_USER_DATA);

if (!app.requestSingleInstanceLock()) { app.quit(); }

app.setAppUserModelId(APP_ID);

let store;
let device;
let updater;
let win = null;
let tray = null;
let quitting = false;
const modules = new Map();
const moduleStates = {};

// ---------------------------------------------------------------- window ---
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 1000, minHeight: 680,
    show: false,
    backgroundColor: '#070b14',
    title: 'Nullnetwork Diagnostics',
    icon: path.join(ASSETS, 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#070b14', symbolColor: '#98a2b6', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function openExternal(url) {
  try { const u = new URL(url); if (u.protocol === 'https:') shell.openExternal(url); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ tray ---
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  tray.setToolTip('Nullnetwork Diagnostics');
  tray.on('click', () => (win && win.isVisible() ? win.hide() : showWindow()));
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const crash = moduleStates.crash || {};
  const pending = store.history.incidents.filter((i) => i.share.status === 'pending').length;
  const phaseLabel = {
    idle: 'Waiting for FiveM', running: 'FiveM is running', closing: 'FiveM closed - checking',
    capturing: 'Saving crash report', nofivem: 'FiveM not found',
  }[crash.phase] || 'Idle';
  tray.setImage(nativeImage.createFromPath(path.join(ASSETS, pending ? 'tray-alert.png' : 'tray.png')));
  tray.setToolTip(`Nullnetwork Diagnostics - ${phaseLabel}${pending ? ` - ${pending} waiting for you` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: phaseLabel, enabled: false },
    ...(pending ? [{ label: `${pending} crash report${pending > 1 ? 's' : ''} waiting for your decision`, click: showWindow }] : []),
    { type: 'separator' },
    { label: 'Open', click: showWindow },
    { label: 'Open captures folder', click: () => shell.openPath(store.capturesDir) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

// --------------------------------------------------------------- modules ---
function startModules() {
  const crash = new CrashModule({ store });
  crash.on('state', (s) => {
    moduleStates.crash = { ...s, phase: s.paths.exists ? s.phase : 'nofivem' };
    broadcast('module:state', moduleStates.crash);
    broadcast('events', store.history.events);
    refreshTray();
  });
  crash.on('incident', onIncident);
  crash.on('error', (err) => { store.addEvent('error', { module: 'crash', message: String(err && err.message || err) }); broadcast('events', store.history.events); });
  modules.set('crash', crash);
  crash.start();
  moduleStates.crash = { ...crash.snapshot(), phase: crash.paths.exists ? crash.snapshot().phase : 'nofivem' };
}

function onIncident(inc) {
  store.addIncident(inc);
  store.addEvent('incident', { module: inc.module, id: inc.id, title: inc.title });
  broadcast('events', store.history.events);
  const policy = store.settings.sharePolicy;
  if (policy === 'always' && store.effectiveEndpoint) {
    inc.share = { status: 'uploading', pct: 0 };
    store.saveHistory();
    broadcast('incident:new', inc);
    shareIncident(inc.id, { note: '', auto: true }).catch(() => { /* status already recorded */ });
    notify('FiveM crashed', `Crash report saved and shared with ${store.appConfig.serverName}. Thank you.`);
  } else if (policy === 'never') {
    inc.share = { status: 'local' };
    store.saveHistory();
    broadcast('incident:new', inc);
    notify('FiveM crashed', 'Crash report saved on this PC only (sharing is off).');
  } else {
    broadcast('incident:new', inc);
    notify('FiveM crashed', `Crash report saved. Would you like to share it with ${store.appConfig.serverName}?`, true);
    showWindow();
  }
  refreshTray();
}

function notify(title, body, clickOpens) {
  if (!store.settings.notifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(ASSETS, 'icon.png') });
  if (clickOpens) n.on('click', showWindow);
  n.show();
}

async function shareIncident(id, { note = '', playerTag, auto = false } = {}) {
  const inc = store.getIncident(id);
  if (!inc) throw new Error('Unknown capture');
  const endpoint = store.effectiveEndpoint;
  if (!endpoint) {
    store.updateIncident(id, { share: { status: 'failed', error: 'Sharing is not configured in this build.' } });
    broadcast('incident:update', store.getIncident(id));
    throw new Error('no endpoint');
  }
  if (playerTag !== undefined && playerTag !== store.settings.playerTag) store.setSettings({ playerTag });
  store.updateIncident(id, { note, share: { status: 'uploading', pct: 0 } });
  broadcast('incident:update', store.getIncident(id));

  let report = {};
  try { report = JSON.parse(fs.readFileSync(path.join(inc.dir, 'report.json'), 'utf8')); } catch { /* fine */ }
  const meta = { ...report, note, playerTag: store.settings.playerTag || null, sharedAt: new Date().toISOString(), auto };
  const files = fs.readdirSync(inc.dir).filter((f) => f !== 'report.json').map((f) => ({ path: path.join(inc.dir, f) }));

  try {
    const dev = await device.ensure(endpoint);
    const res = await uploadCapture({
      endpoint, device: dev, meta, files,
      onProgress: (p) => broadcast('upload:progress', { id, ...p }),
    });
    store.updateIncident(id, { share: { status: 'shared', at: new Date().toISOString(), ref: res.ref } });
    store.addEvent('shared', { id, ref: res.ref });
  } catch (err) {
    store.updateIncident(id, { share: { status: 'failed', error: String(err.message || err) } });
    store.addEvent('share-failed', { id, error: String(err.message || err) });
    broadcast('incident:update', store.getIncident(id));
    refreshTray();
    throw err;
  }
  broadcast('incident:update', store.getIncident(id));
  broadcast('events', store.history.events);
  refreshTray();
  return store.getIncident(id);
}

function purgeOld() {
  const keepMs = Math.max(1, Number(store.settings.keepDays) || 14) * 86400000;
  const now = Date.now();
  for (const inc of store.history.incidents) {
    if (inc.purged || inc.share.status === 'pending' || inc.share.status === 'uploading') continue;
    if (now - Date.parse(inc.at) < keepMs) continue;
    try { fs.rmSync(inc.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    inc.purged = true; inc.files = []; inc.totalBytes = 0;
  }
  store.saveHistory();
}

function capturesSize() {
  let total = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else total += fs.statSync(p).size; } };
  try { walk(store.capturesDir); } catch { /* ignore */ }
  return total;
}

function probeEndpoint(endpoint) {
  return new Promise((resolve) => {
    let url; try { url = new URL('/health', endpoint); } catch { return resolve({ ok: false, error: 'Not a valid URL' }); }
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.get(url, { timeout: 8000 }, (res) => { res.resume(); resolve({ ok: res.statusCode < 400, status: res.statusCode }); });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

// ------------------------------------------------------------------- IPC ---
function bootPayload() {
  return {
    version: app.getVersion(),
    settings: store.settings,
    appConfig: { serverName: store.appConfig.serverName, discordInvite: store.appConfig.discordInvite || '' },
    endpoint: store.effectiveEndpoint,
    endpointConfigured: !!store.effectiveEndpoint,
    incidents: store.history.incidents,
    events: store.history.events,
    states: moduleStates,
    capturesDir: store.capturesDir,
    capturesBytes: capturesSize(),
    fivemDefault: fivem.defaultAppDir(),
    device: (() => { const d = device.load(); return d ? { id: d.deviceId, since: d.createdAt } : null; })(),
    update: updater.state,
  };
}

ipcMain.handle('app:boot', () => bootPayload());
ipcMain.handle('settings:set', (_e, patch) => {
  const before = { ...store.settings };
  const after = store.setSettings(patch || {});
  if (after.launchAtStartup !== before.launchAtStartup || after.startMinimized !== before.startMinimized) {
    app.setLoginItemSettings({ openAtLogin: !!after.launchAtStartup, args: after.startMinimized ? [HIDDEN_FLAG] : [] });
  }
  if (after.fivemPath !== before.fivemPath) {
    const m = modules.get('crash'); if (m) m.reconfigure();
  }
  if (after.keepDays !== before.keepDays) purgeOld();
  if (after.shareEndpoint !== before.shareEndpoint) { updater.stop(); updater.start(); }
  refreshTray();
  return after;
});
ipcMain.handle('incident:share', (_e, { id, note, playerTag }) => shareIncident(id, { note, playerTag }).catch((err) => ({ error: String(err.message || err) })));
ipcMain.handle('incident:decline', (_e, { id }) => {
  const inc = store.updateIncident(id, { share: { status: 'declined', at: new Date().toISOString() } });
  store.addEvent('declined', { id });
  broadcast('incident:update', inc); broadcast('events', store.history.events); refreshTray();
  return inc;
});
ipcMain.handle('incident:openFolder', (_e, { id }) => { const inc = store.getIncident(id); if (inc && fs.existsSync(inc.dir)) shell.openPath(inc.dir); });
ipcMain.handle('incident:delete', (_e, { id }) => {
  const inc = store.getIncident(id);
  if (inc) { try { fs.rmSync(inc.dir, { recursive: true, force: true }); } catch { /* ignore */ } store.removeIncident(id); }
  refreshTray();
  return store.history.incidents;
});
ipcMain.handle('app:openExternal', (_e, url) => openExternal(url));
ipcMain.handle('app:openCaptures', () => shell.openPath(store.capturesDir));
ipcMain.handle('app:capturesBytes', () => capturesSize());
ipcMain.handle('app:pickFivemPath', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Pick your FiveM.app folder', properties: ['openDirectory'], defaultPath: fivem.defaultAppDir() });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('app:probeEndpoint', (_e, endpoint) => probeEndpoint(endpoint || store.effectiveEndpoint));
ipcMain.handle('window:hide', () => win && win.hide());
ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:download', () => updater.download());
ipcMain.handle('update:install', () => updater.install());
ipcMain.handle('device:reset', () => { device.forget(); return null; });

// ------------------------------------------------------------------ boot ---
app.whenReady().then(() => {
  store = new Store();
  device = new Device(store);
  updater = new Updater({ store });
  updater.on('state', (st) => { broadcast('update:state', st); if (st.status === 'available') { notify('Update available', `Nullnetwork Diagnostics ${st.version} is ready to install. Open the app to update.`, true); } });
  startModules();
  purgeOld();
  createWindow();
  createTray();
  const startHidden = process.argv.includes(HIDDEN_FLAG) && store.settings.startMinimized;
  if (!startHidden) win.once('ready-to-show', () => win.show());
  setInterval(purgeOld, 6 * 3600 * 1000);
  updater.start();
});

app.on('second-instance', showWindow);
app.on('window-all-closed', (e) => { /* stay alive in the tray */ });
app.on('before-quit', () => { quitting = true; for (const m of modules.values()) m.stop(); if (updater) updater.stop(); });
