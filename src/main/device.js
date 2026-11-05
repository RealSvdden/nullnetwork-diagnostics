'use strict';
// Per-install identity for the share endpoint. The endpoint hands out a device
// id + secret on first contact; the secret is kept encrypted with the OS user
// keychain (DPAPI on Windows) via Electron's safeStorage and is only ever used
// to sign requests. Changing the endpoint re-registers.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { app, safeStorage } = require('electron');
const { postJson } = require('./uploader');

class Device {
  constructor(store) {
    this.store = store;
    this.file = path.join(store.dir, 'device.json');
    this.cache = null;
  }

  load() {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      let secret = null;
      const enc = safeStorage.isEncryptionAvailable();
      if (raw.secretEnc && enc) secret = safeStorage.decryptString(Buffer.from(raw.secretEnc, 'base64'));
      else if (raw.secretPlain && !enc) secret = raw.secretPlain; // plaintext is only honoured where no keychain exists
      if (raw.deviceId && secret) this.cache = { deviceId: raw.deviceId, secret, endpoint: raw.endpoint, createdAt: raw.createdAt };
    } catch { /* no device yet */ }
    return this.cache;
  }

  save(dev) {
    const out = { deviceId: dev.deviceId, endpoint: dev.endpoint, createdAt: dev.createdAt };
    if (safeStorage.isEncryptionAvailable()) out.secretEnc = safeStorage.encryptString(dev.secret).toString('base64');
    else out.secretPlain = dev.secret; // only on hosts without a keychain; still per-install, still revocable
    fs.writeFileSync(this.file, JSON.stringify(out, null, 2));
    this.cache = dev;
  }

  forget() { try { fs.unlinkSync(this.file); } catch { /* ignore */ } this.cache = null; }

  // Stable but non-identifying: a hash of hostname + machine specs, so staff can
  // tell "same PC registered twice" without learning anything about the PC.
  fingerprint() {
    const cpu = (os.cpus()[0] || {}).model || '';
    return crypto.createHash('sha256').update(`${os.hostname()}|${cpu}|${os.totalmem()}|${os.arch()}`).digest('hex').slice(0, 32);
  }

  async ensure(endpoint) {
    const cur = this.load();
    if (cur && cur.endpoint === endpoint) return cur;
    const res = await postJson(new URL('/v1/register', endpoint), { app: { version: app.getVersion() }, fingerprint: this.fingerprint() });
    if (!res.ok || !res.deviceId || !res.secret) throw new Error(res.error || 'registration failed');
    const dev = { deviceId: res.deviceId, secret: res.secret, endpoint, createdAt: new Date().toISOString() };
    this.save(dev);
    return dev;
  }
}

module.exports = { Device };
