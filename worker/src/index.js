// Nullnetwork Diagnostics ingest + update host.
//
// Trust model
//  - Nothing in the desktop app is a secret. Each install registers once and
//    gets a device id + secret; the secret is derived from DEVICE_MASTER_KEY
//    (never stored), so a device can be revoked but a leaked row reveals nothing.
//  - Every write is signed: HMAC-SHA256 over method, path, timestamp, nonce and
//    the body hash. Timestamps expire after 5 minutes and nonces are single use,
//    so a captured request cannot be replayed.
//  - Uploads are declared first (manifest with name, size, sha256 per file),
//    then streamed one file per PUT straight into R2, which verifies the hash.
//    Names, sizes, counts, content magic and meta fields are all allow-listed.
//  - Per-device and per-IP rate limits plus daily quotas bound abuse.
//  - There are no read endpoints for captures. The bucket is private; staff
//    read it through the admin panel with its own permissions.
//  - The only public GETs are the download page and the update feed (latest.yml +
//    installers) under a fixed prefix, rate limited, read-only.
import { classify } from './categories.js';
import { downloadPage } from './page.js';

const enc = new TextEncoder();
const MAX_SKEW_SEC = 300;
const OPEN_TTL_SEC = 20 * 60;          // a declared capture must finish within this
const MAX_FILES = 4;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_META_BYTES = 48 * 1024;
const MAX_JSON_BODY = 64 * 1024;
const DAILY_UPLOADS = 12;
const DAILY_BYTES = 512 * 1024 * 1024;
const HOURLY_UPLOADS = 6;              // per device, counted from D1
const HOURLY_REGISTRATIONS = 5;        // per IP bucket, counted from D1
const REVOKE_BLOCK_SEC = 30 * 86400;   // a revoked install blocks its IP bucket from registering again for this long
const BLOCKED_MSG = 'this install has been blocked from sharing';

// name pattern -> { max bytes, magic check }
const FILE_RULES = [
  { re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.dmp$/i, max: 96 * 1024 * 1024, magic: (b) => b.length >= 4 && b[0] === 0x4d && b[1] === 0x44 && b[2] === 0x4d && b[3] === 0x50, type: 'application/octet-stream' },
  { re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.dmp\.gamelog$/i, max: 4 * 1024 * 1024, magic: (b) => isText(b), type: 'text/plain' },
  { re: /^CitizenFX\.log\.gz$/, max: 24 * 1024 * 1024, magic: (b) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b, type: 'application/gzip' },
];
const UPDATE_FILE = /^(latest\.yml|[A-Za-z0-9][A-Za-z0-9._ -]{0,120}\.(exe|blockmap|zip))$/;
const MODULES = new Set(['crash']);

// ------------------------------------------------------------ helpers ---
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
});
const deny = (status, msg) => json({ ok: false, error: msg }, status);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const now = () => Math.floor(Date.now() / 1000);
const dayOf = (t) => Math.floor(t / 86400);
function isText(b) { for (let i = 0; i < Math.min(b.length, 512); i++) { const c = b[i]; if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) return false; } return true; }
function randomHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); }
async function sha256(data) { return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data)); }
async function hmacKey(secret) { return crypto.subtle.importKey('raw', typeof secret === 'string' ? enc.encode(secret) : secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); }
async function hmac(secret, msg) { return crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(msg)); }
function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const int = (v, max) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Math.round(Number(v)))) : null);

async function deviceSecret(env, deviceId) { return b64url(await hmac(env.DEVICE_MASTER_KEY, `device:${deviceId}`)); }

// Every per-IP limit and every stored IP hash keys on a bucket, not the exact address:
// IPv4 is the address itself (/32), IPv6 is its /64 prefix (the usual allocation to
// one subscriber), so an IPv6 host cannot mint fresh identities by rotating the low bits.
// IPv4-mapped IPv6 (::ffff:a.b.c.d) counts as the IPv4 address.
function ipBucket(ip) {
  let raw = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!raw) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return raw;
  const mapped = /^(?:0*:)*:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return mapped[1];
  if (!raw.includes(':')) return raw;
  // Expand :: so the first four hextets are known, then normalise each one.
  const halves = raw.split('::');
  if (halves.length > 2) return raw;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? Math.max(0, 8 - left.length - right.length) : 0;
  const parts = [...left, ...Array(fill).fill('0'), ...right];
  if (parts.length !== 8 || parts.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return raw;
  return `${parts.slice(0, 4).map((h) => parseInt(h, 16).toString(16)).join(':')}::/64`;
}
const clientBucket = (req) => ipBucket(req.headers.get('CF-Connecting-IP'));

// Salted hash of the bucket. IP_SALT is a dedicated secret; the master key is never
// used for this, so a leaked hash table cannot be joined to device secrets.
async function ipHash(env, bucket) {
  if (!env.IP_SALT) throw new Error('IP_SALT is not configured');
  return (await sha256(`${env.IP_SALT}|${bucket || ''}`)).slice(0, 32);
}

async function rateLimit(binding, key) {
  if (!binding) return true; // local dev without the binding
  try { return (await binding.limit({ key })).success; } catch (err) { console.error('ratelimit binding failed', String(err)); return false; }
}

// Verify a signed request. Returns { device } or a Response to send.
async function authenticate(req, env, url, bodyHash) {
  const deviceId = req.headers.get('X-NN-Device') || '';
  const ts = Number(req.headers.get('X-NN-Ts') || 0);
  const nonce = req.headers.get('X-NN-Nonce') || '';
  const sig = req.headers.get('X-NN-Sig') || '';
  if (!/^[0-9a-f]{32}$/.test(deviceId) || !/^[0-9a-f]{32}$/.test(nonce) || !sig) return deny(401, 'unsigned');
  if (!Number.isFinite(ts) || Math.abs(now() - ts) > MAX_SKEW_SEC) return deny(401, 'clock skew; check your system time');

  const expected = b64url(await hmac(await deviceSecret(env, deviceId), `${req.method}\n${url.pathname}\n${ts}\n${nonce}\n${bodyHash}`));
  if (!timingSafeEqual(expected, sig)) return deny(401, 'bad signature');

  const device = await env.DB.prepare('SELECT device_id, revoked, revoked_at, day, day_uploads, day_bytes FROM diag_devices WHERE device_id = ?1').bind(deviceId).first();
  if (!device) return deny(401, 'unknown device');
  if (device.revoked) {
    // The signature proved this is the revoked install, so remember the bucket it is
    // talking from: "reset install id" from the same network cannot register again
    // (see register). The window is anchored at the revoke time, not at this contact.
    const at = device.revoked_at || now();
    await env.DB.batch([
      env.DB.prepare('UPDATE diag_devices SET revoked_at = ?2 WHERE device_id = ?1 AND revoked_at IS NULL').bind(deviceId, at),
      env.DB.prepare('INSERT OR IGNORE INTO diag_revoked_ips (ip_hash, device_id, revoked_at) VALUES (?1, ?2, ?3)').bind(await ipHash(env, clientBucket(req)), deviceId, at),
    ]).catch((err) => console.error('revoked bucket record failed', String(err)));
    return deny(403, BLOCKED_MSG);
  }

  // Single-use nonce (10 minute memory; the skew window is 5).
  try {
    await env.DB.prepare('INSERT INTO diag_nonces (device_id, nonce, ts) VALUES (?1, ?2, ?3)').bind(deviceId, nonce, ts).run();
  } catch { return deny(401, 'replayed request'); }
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM diag_nonces WHERE ts < ?1').bind(now() - 600).run();
  return { device };
}

// Reads at most `limit` bytes of JSON.
async function readJson(req, limit) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > limit) return null;
  const buf = await req.arrayBuffer();
  if (buf.byteLength > limit) return null;
  try { return { raw: buf, value: JSON.parse(new TextDecoder().decode(buf)) }; } catch { return null; }
}

// Only known meta fields survive, each length-capped.
function sanitizeMeta(m) {
  if (!m || typeof m !== 'object') return null;
  const crash = m.crash && typeof m.crash === 'object' ? m.crash : {};
  const game = m.game && typeof m.game === 'object' ? m.game : {};
  const machine = m.machine && typeof m.machine === 'object' ? m.machine : {};
  const app = m.app && typeof m.app === 'object' ? m.app : {};
  const session = m.session && typeof m.session === 'object' ? m.session : {};
  const stack = Array.isArray(crash.stack) ? crash.stack.slice(0, 64).map((l) => str(l, 200)).filter(Boolean) : [];
  const module = str(m.module, 32);
  if (!MODULES.has(module)) return null;
  return {
    schema: 1,
    module,
    capturedAt: str(m.capturedAt, 40),
    app: { version: str(app.version, 32) },
    machine: { os: str(machine.os, 80), arch: str(machine.arch, 16), cpu: str(machine.cpu, 120), cores: int(machine.cores, 1024), ramGb: int(machine.ramGb, 4096) },
    session: { seconds: int(session.seconds, 10 ** 7), process: str(session.process, 80) },
    crash: { signature: str(crash.signature, 300) || 'Unknown crash', message: str(crash.message, 4000) || '', stack, reportId: str(crash.reportId, 64) },
    game: Object.fromEntries(['gameVersion', 'gameState', 'sessionTime', 'playerPosition', 'gameTime', 'currentVehicle', 'memoryLoad', 'streamingVirtualUsed', 'peds'].map((k) => [k, str(game[k], 120)])),
    note: str(m.note, 600) || '',
    playerTag: str(m.playerTag, 64) || null,
    auto: !!m.auto,
  };
}

function validateManifest(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) return 'file count';
  const seen = new Set(); let total = 0; const out = [];
  for (const f of files) {
    const name = str(f && f.name, 160); const size = int(f && f.size, MAX_TOTAL); const sha = str(f && f.sha256, 64);
    if (!name || size === null || size <= 0 || !/^[0-9a-f]{64}$/.test(sha || '')) return 'bad file entry';
    const rule = FILE_RULES.find((r) => r.re.test(name));
    if (!rule) return `file not allowed: ${name}`;
    if (size > rule.max) return `file too large: ${name}`;
    if (seen.has(name)) return 'duplicate file'; seen.add(name);
    total += size; out.push({ name, size, sha256: sha });
  }
  if (total > MAX_TOTAL) return 'upload too large';
  return out;
}

// Pass-through stream that checks the first bytes against the rule's magic.
function magicGate(body, rule) {
  let head = new Uint8Array(0); let checked = false;
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctrl) {
      if (!checked) {
        const merged = new Uint8Array(head.length + chunk.length); merged.set(head); merged.set(chunk, head.length); head = merged;
        if (head.length >= 8) { checked = true; if (!rule.magic(head)) throw new Error('magic'); }
      }
      ctrl.enqueue(chunk);
    },
    flush() { if (!checked && !rule.magic(head)) throw new Error('magic'); },
  }));
}

async function pruneOpen(env) {
  const stale = await env.DB.prepare("SELECT ref, files_done FROM diag_captures WHERE status = 'open' AND created_at < ?1 LIMIT 20").bind(now() - 3600).all();
  for (const row of stale.results || []) {
    const done = JSON.parse(row.files_done || '[]');
    await Promise.all(done.map((n) => env.DIAG.delete(`captures/${row.ref}/${n}`)));
    await env.DB.prepare('DELETE FROM diag_captures WHERE ref = ?1').bind(row.ref).run();
  }
}

// -------------------------------------------------------------- routes ---
async function register(req, env) {
  const bucket = clientBucket(req);
  if (!(await rateLimit(env.RL_REGISTER, `reg:${bucket}`))) return deny(429, 'too many registrations');
  const body = await readJson(req, 4096);
  if (!body) return deny(400, 'bad body');
  const appVersion = str(body.value.app && body.value.app.version, 32);
  const fingerprint = str(body.value.fingerprint, 64);
  if (fingerprint && !/^[0-9a-f]{16,64}$/.test(fingerprint)) return deny(400, 'bad fingerprint');

  const ipH = await ipHash(env, bucket);
  // A bucket that a staff revoke touched in the last 30 days gets the same answer a
  // revoked install gets, so resetting the install id does not undo the revoke.
  const blocked = await env.DB.prepare('SELECT 1 AS hit FROM diag_revoked_ips WHERE ip_hash = ?1 AND revoked_at > ?2 LIMIT 1').bind(ipH, now() - REVOKE_BLOCK_SEC).first();
  if (blocked) return deny(403, BLOCKED_MSG);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM diag_devices WHERE ip_hash = ?1 AND created_at > ?2').bind(ipH, now() - 3600).first();
  if (recent && recent.n >= HOURLY_REGISTRATIONS) return deny(429, 'too many registrations');

  const deviceId = randomHex(16);
  const t = now();
  await env.DB.prepare(`INSERT INTO diag_devices (device_id, created_at, last_seen_at, ip_hash, country, app_version, fingerprint)
    VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6)`).bind(deviceId, t, ipH, req.cf && req.cf.country || null, appVersion, fingerprint).run();
  return json({ ok: true, deviceId, secret: await deviceSecret(env, deviceId) });
}

async function declare(req, env, url) {
  const body = await readJson(req, MAX_JSON_BODY);
  if (!body) return deny(400, 'bad body');
  const auth = await authenticate(req, env, url, await sha256(body.raw));
  if (auth instanceof Response) return auth;
  const { device } = auth;
  const bucket = clientBucket(req);
  if (!(await rateLimit(env.RL_UPLOAD, `up:${device.device_id}`)) || !(await rateLimit(env.RL_UPLOAD, `upip:${bucket}`))) return deny(429, 'too many uploads; try again later');

  const meta = sanitizeMeta(body.value.meta);
  if (!meta) return deny(400, 'bad meta');
  if (JSON.stringify(meta).length > MAX_META_BYTES) return deny(400, 'meta too large');
  const files = validateManifest(body.value.files);
  if (typeof files === 'string') return deny(400, files);
  const total = files.reduce((a, f) => a + f.size, 0);

  // Hourly + daily quotas per device, counted from what was DECLARED (open or complete),
  // so abandoning a capture after the PUTs cannot bypass the caps.
  const t0 = now();
  const usage = await env.DB.prepare(`SELECT
      SUM(CASE WHEN created_at > ?2 THEN 1 ELSE 0 END) AS hour_n,
      SUM(CASE WHEN created_at > ?3 THEN 1 ELSE 0 END) AS day_n,
      SUM(CASE WHEN created_at > ?3 THEN size_bytes ELSE 0 END) AS day_bytes
    FROM diag_captures WHERE device_id = ?1 AND created_at > ?3`).bind(device.device_id, t0 - 3600, t0 - 86400).first();
  if (usage && Number(usage.hour_n) >= HOURLY_UPLOADS) return deny(429, 'too many uploads this hour; try again later');
  if (usage && (Number(usage.day_n) >= DAILY_UPLOADS || Number(usage.day_bytes) + total > DAILY_BYTES)) return deny(429, 'daily sharing limit reached');
  const today = dayOf(t0);

  if (Math.random() < 0.05) await pruneOpen(env);

  const t = now();
  const ref = `${new Date(t * 1000).toISOString().slice(0, 10).replace(/-/g, '')}-${randomHex(6)}`;
  const capturedAt = Date.parse(meta.capturedAt || '') / 1000;
  await env.DB.prepare(`INSERT INTO diag_captures (ref, device_id, module, category, signature, message, report_id, status, created_at, captured_at,
      size_bytes, files, files_done, player_tag, note, game_version, app_version, os, cpu, ram_gb, country, ip_hash, session_seconds, meta)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8, ?9, ?10, ?11, '[]', ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)`)
    .bind(ref, device.device_id, meta.module, classify(meta.crash.signature, meta.crash.message), meta.crash.signature, meta.crash.message, meta.crash.reportId,
      t, Number.isFinite(capturedAt) ? Math.floor(capturedAt) : null, total, JSON.stringify(files), meta.playerTag, meta.note, meta.game.gameVersion,
      meta.app.version, meta.machine.os, meta.machine.cpu, meta.machine.ramGb, req.cf && req.cf.country || null, await ipHash(env, bucket),
      meta.session.seconds, JSON.stringify(meta)).run();
  await env.DB.prepare('UPDATE diag_devices SET last_seen_at = ?2, player_tag = COALESCE(?3, player_tag), app_version = COALESCE(?4, app_version) WHERE device_id = ?1')
    .bind(device.device_id, t, meta.playerTag, meta.app.version).run();
  return json({ ok: true, ref, expiresAt: (t + OPEN_TTL_SEC) * 1000, files: files.map((f) => f.name) });
}

async function loadOpen(env, ref, deviceId) {
  if (!/^\d{8}-[0-9a-f]{12}$/.test(ref)) return null;
  const row = await env.DB.prepare("SELECT ref, device_id, status, created_at, files, files_done FROM diag_captures WHERE ref = ?1").bind(ref).first();
  if (!row || row.device_id !== deviceId || row.status !== 'open' || row.created_at < now() - OPEN_TTL_SEC) return null;
  return { ...row, files: JSON.parse(row.files), filesDone: JSON.parse(row.files_done) };
}

// Shape checks + per-device burst limit that run before the nonce write, so a
// loop of garbage requests costs nothing in D1.
async function preflight(req, env, ref) {
  if (!/^\d{8}-[0-9a-f]{12}$/.test(ref)) return deny(404, 'no open capture');
  const dev = req.headers.get('X-NN-Device') || '';
  if (!/^[0-9a-f]{32}$/.test(dev)) return deny(401, 'unsigned');
  if (!(await rateLimit(env.RL_FILES, `file:${dev}`))) return deny(429, 'slow down');
  return null;
}

async function putFile(req, env, url, ref, name) {
  const pre = await preflight(req, env, ref); if (pre) return pre;
  const claimed = (req.headers.get('X-NN-Sha256') || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(claimed)) return deny(400, 'missing sha256');
  const auth = await authenticate(req, env, url, claimed);
  if (auth instanceof Response) return auth;
  const cap = await loadOpen(env, ref, auth.device.device_id);
  if (!cap) return deny(404, 'no open capture');
  const entry = cap.files.find((f) => f.name === name);
  if (!entry) return deny(400, 'file not in manifest');
  if (entry.sha256 !== claimed) return deny(400, 'sha256 differs from manifest');
  if (cap.filesDone.includes(name)) return deny(409, 'already uploaded');
  const len = Number(req.headers.get('Content-Length') || -1);
  if (len !== entry.size) return deny(400, 'size differs from manifest');
  if (!req.body) return deny(400, 'empty body');
  const rule = FILE_RULES.find((r) => r.re.test(name));

  const key = `captures/${ref}/${name}`;
  try {
    // R2 needs a known length; the magic gate re-wraps the body, so pipe it through FixedLengthStream.
    const fixed = new FixedLengthStream(entry.size);
    let pipeErr = null;
    const piping = magicGate(req.body, rule).pipeTo(fixed.writable).catch((e) => { pipeErr = e; });
    await env.DIAG.put(key, fixed.readable, { sha256: claimed, httpMetadata: { contentType: rule.type } });
    await piping;
    if (pipeErr) throw pipeErr;
  } catch (err) {
    await env.DIAG.delete(key).catch(() => {});
    if (/magic/.test(String(err))) return deny(400, 'file content does not match its type');
    console.error('put failed', ref, name, err && err.message || err);
    return deny(400, 'checksum mismatch');
  }
  cap.filesDone.push(name);
  await env.DB.prepare('UPDATE diag_captures SET files_done = ?2 WHERE ref = ?1').bind(ref, JSON.stringify(cap.filesDone)).run();
  return json({ ok: true, name, remaining: cap.files.length - cap.filesDone.length });
}

async function complete(req, env, url, ref) {
  const pre = await preflight(req, env, ref); if (pre) return pre;
  const body = await readJson(req, 1024);
  if (!body) return deny(400, 'bad body');
  const auth = await authenticate(req, env, url, await sha256(body.raw));
  if (auth instanceof Response) return auth;
  const cap = await loadOpen(env, ref, auth.device.device_id);
  if (!cap) return deny(404, 'no open capture');
  const missing = cap.files.filter((f) => !cap.filesDone.includes(f.name));
  if (missing.length) return deny(409, `missing files: ${missing.map((f) => f.name).join(', ')}`);

  const row = await env.DB.prepare('SELECT meta, size_bytes FROM diag_captures WHERE ref = ?1').bind(ref).first();
  const t = now(); const today = dayOf(t);
  await env.DIAG.put(`captures/${ref}/meta.json`, JSON.stringify({ ref, receivedAt: new Date(t * 1000).toISOString(), device: auth.device.device_id, files: cap.files, meta: JSON.parse(row.meta) }, null, 2),
    { httpMetadata: { contentType: 'application/json' } });
  await env.DB.batch([
    env.DB.prepare("UPDATE diag_captures SET status = 'complete', completed_at = ?2 WHERE ref = ?1").bind(ref, t),
    env.DB.prepare(`UPDATE diag_devices SET uploads = uploads + 1, bytes = bytes + ?2, last_seen_at = ?3,
        day_uploads = CASE WHEN day = ?4 THEN day_uploads + 1 ELSE 1 END, day_bytes = CASE WHEN day = ?4 THEN day_bytes + ?2 ELSE ?2 END, day = ?4
      WHERE device_id = ?1`).bind(auth.device.device_id, row.size_bytes, t, today),
  ]);
  return json({ ok: true, id: ref });
}

const plain = (body, status) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

// One byte range (RFC 9110 14.1.2) against a known size. Returns { offset, length },
// null when the header is absent or must be ignored (other unit, several ranges,
// malformed, end before start: the whole file is served with 200), or 'unsatisfiable'.
// A suffix range (bytes=-N) is the last min(N, size) bytes; bytes=-0 is unsatisfiable.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const a = m[1] === '' ? null : Number(m[1]);
  const b = m[2] === '' ? null : Number(m[2]);
  if ((a !== null && !Number.isSafeInteger(a)) || (b !== null && !Number.isSafeInteger(b))) return null;
  if (a === null) {
    if (b === 0 || size === 0) return 'unsatisfiable';
    const length = Math.min(b, size);
    return { offset: size - length, length };
  }
  if (a >= size) return 'unsatisfiable';
  const end = b === null ? size - 1 : Math.min(b, size - 1);
  if (end < a) return null;
  return { offset: a, length: end - a + 1 };
}

async function serveUpdate(req, env, file) {
  if (!UPDATE_FILE.test(file)) return plain('not found', 404);
  if (!(await rateLimit(env.RL_PUBLIC, `upd:${clientBucket(req)}`))) return plain('slow down', 429);
  const key = `releases/${file}`;
  const head = await env.DIAG.head(key);
  if (!head) return plain('not found', 404);
  const isYml = file.endsWith('.yml');
  // Content-Type is fixed by extension, never taken from the object: latest.yml is text,
  // everything else is an opaque download. Installers are versioned names, so immutable.
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'ETag': head.httpEtag,
    'Last-Modified': head.uploaded.toUTCString(),
    'Content-Type': isYml ? 'text/yaml; charset=utf-8' : 'application/octet-stream',
    'Cache-Control': isYml ? 'public, max-age=60, must-revalidate' : 'public, max-age=3600, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  if (!isYml) headers.set('Content-Disposition', `attachment; filename="${file}"`);
  const range = parseRange(req.headers.get('Range'), head.size);
  if (range === 'unsatisfiable') { headers.set('Content-Range', `bytes */${head.size}`); return new Response(null, { status: 416, headers }); }

  // Only the two cache validators are honoured; If-Match failing would need a 412, not a 304.
  const onlyIf = new Headers();
  for (const h of ['If-None-Match', 'If-Modified-Since']) if (req.headers.has(h)) onlyIf.set(h, req.headers.get(h));
  const obj = await env.DIAG.get(key, { onlyIf, ...(range ? { range } : {}) });
  if (!obj) return plain('not found', 404);
  if (!('body' in obj)) return new Response(null, { status: 304, headers });
  if (obj.size !== head.size || obj.httpEtag !== head.httpEtag) return plain('release changed, try again', 503); // re-uploaded between head and get
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    headers.set('Content-Length', String(range.length));
  } else headers.set('Content-Length', String(head.size));
  return new Response(req.method === 'HEAD' ? null : obj.body, { status: range ? 206 : 200, headers });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!env.DEVICE_MASTER_KEY || !env.IP_SALT) return deny(503, 'not configured');
    try {
      if (p === '/health') return plain('ok', 200);
      if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/diagnostics' || p === '/download')) return downloadPage(env);
      if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/v1/update/')) {
        let file; try { file = decodeURIComponent(p.slice('/v1/update/'.length)); } catch { return new Response('not found', { status: 404 }); }
        return serveUpdate(req, env, file);
      }
      if (req.method === 'POST' && p === '/v1/register') return register(req, env);
      if (req.method === 'POST' && p === '/v1/capture') return declare(req, env, url);
      let m;
      if (req.method === 'PUT' && (m = /^\/v1\/capture\/([^/]+)\/file\/([^/]+)$/.exec(p))) return putFile(req, env, url, m[1], decodeURIComponent(m[2]));
      if (req.method === 'POST' && (m = /^\/v1\/capture\/([^/]+)\/complete$/.exec(p))) return complete(req, env, url, m[1]);
      return deny(404, 'not found');
    } catch (err) {
      console.error('diag worker error', err && err.stack || err);
      return deny(500, 'internal error');
    }
  },
};
