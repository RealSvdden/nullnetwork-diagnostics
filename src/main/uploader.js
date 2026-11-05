'use strict';
// Signed upload protocol (see worker/src/index.js):
//   1. POST /v1/capture               declare meta + file manifest (name, size, sha256)
//   2. PUT  /v1/capture/:ref/file/:n  stream each file (R2 verifies the sha256)
//   3. POST /v1/capture/:ref/complete
// Every request carries X-NN-Device / X-NN-Ts / X-NN-Nonce / X-NN-Sig, where the
// signature is HMAC-SHA256(secret, method \n path \n ts \n nonce \n bodySha256).
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function sign(device, method, url, bodyHash) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = b64url(crypto.createHmac('sha256', device.secret).update(`${method}\n${url.pathname}\n${ts}\n${nonce}\n${bodyHash}`).digest());
  return { 'X-NN-Device': device.deviceId, 'X-NN-Ts': String(ts), 'X-NN-Nonce': nonce, 'X-NN-Sig': sig };
}

function request(url, { method, headers, body, bodyStream, bodyLength, onProgress, timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(url, { method, headers: { 'User-Agent': 'Nullnetwork-Diagnostics', ...headers } });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(text); } catch { /* not json */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed || { ok: true });
        else reject(new Error((parsed && parsed.error) || `Server answered ${res.statusCode}`));
      });
    });
    if (body !== undefined) { req.end(body); return; }
    if (!bodyStream) { req.end(); return; }
    let sent = 0;
    bodyStream.on('data', (chunk) => {
      sent += chunk.length;
      if (onProgress) onProgress(sent, bodyLength);
      if (!req.write(chunk)) { bodyStream.pause(); req.once('drain', () => bodyStream.resume()); }
    });
    bodyStream.on('end', () => req.end());
    bodyStream.on('error', (e) => req.destroy(e));
  });
}

async function postJson(url, payload, device) {
  const body = Buffer.from(JSON.stringify(payload));
  const headers = { 'Content-Type': 'application/json', 'Content-Length': body.length };
  if (device) Object.assign(headers, sign(device, 'POST', url, crypto.createHash('sha256').update(body).digest('hex')));
  return request(url, { method: 'POST', headers, body });
}

// files: [{ path }]. Returns { ok, ref }.
async function uploadCapture({ endpoint, device, meta, files, onProgress }) {
  const manifest = [];
  for (const f of files) {
    manifest.push({ name: path.basename(f.path), size: fs.statSync(f.path).size, sha256: await sha256File(f.path), path: f.path });
  }
  const total = manifest.reduce((a, f) => a + f.size, 0);
  const report = (done) => onProgress && onProgress({ sent: done, total, pct: total ? Math.min(100, Math.round(done / total * 100)) : 100 });
  report(0);

  const declared = await postJson(new URL('/v1/capture', endpoint), { meta, files: manifest.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }, device);
  const ref = declared.ref;

  let done = 0;
  for (const f of manifest) {
    const url = new URL(`/v1/capture/${ref}/file/${encodeURIComponent(f.name)}`, endpoint);
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': f.size, 'X-NN-Sha256': f.sha256, ...sign(device, 'PUT', url, f.sha256) };
    const base = done;
    await request(url, { method: 'PUT', headers, bodyStream: fs.createReadStream(f.path, { highWaterMark: 256 * 1024 }), bodyLength: f.size, onProgress: (sent) => report(base + sent), timeoutMs: 15 * 60 * 1000 });
    done += f.size;
    report(done);
  }

  const fin = await postJson(new URL(`/v1/capture/${ref}/complete`, endpoint), {}, device);
  return { ok: true, ref: fin.id || ref };
}

module.exports = { uploadCapture, postJson, sha256File };
