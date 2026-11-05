'use strict';
// Crash module: watches the FiveM game process and its crashes folder. When a
// new .dmp appears it bundles dump + gamelog + CitizenFX.log into a capture
// folder and hands the host an incident. The host decides about sharing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { EventEmitter } = require('events');
const { app } = require('electron');
const fivem = require('../../fivem');
const { parseCrashBlock, parseGamelog } = require('./parse');

const POLL_MS = 2000;
const EXIT_GRACE_MS = 25000;    // after the game vanishes, how long we wait for a late dump
const SETTLE_MS = 1500;         // dump size must be stable this long before we touch it
const GAMELOG_WAIT_MS = 6000;   // give FiveM a moment to write the .gamelog beside the dump

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

class CrashModule extends EventEmitter {
  constructor({ store }) {
    super();
    this.id = 'crash';
    this.store = store;
    this.paths = fivem.resolvePaths(store.settings.fivemPath);
    this.state = { phase: 'idle', game: null, since: null, graceUntil: null };
    this.seen = new Set();
    this.pending = new Map(); // dmp path -> timer
    this.watcher = null;
    this.timer = null;
    this.stopped = false;
    this.lastGame = null;        // last classify() result
    this.crashedThisSession = false;
  }

  start() {
    this.stopped = false;
    this.primeSeen();
    this.watchDir();
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } }
    for (const t of this.pending.values()) clearTimeout(t);
  }

  reconfigure() {
    this.stop();
    this.paths = fivem.resolvePaths(this.store.settings.fivemPath);
    this.start();
  }

  primeSeen() {
    // Dumps that already exist belong to the past; only new ones become incidents.
    try {
      for (const f of fs.readdirSync(this.paths.crashesDir)) {
        if (f.toLowerCase().endsWith('.dmp')) this.seen.add(path.join(this.paths.crashesDir, f));
      }
    } catch { /* folder may not exist yet */ }
  }

  watchDir() {
    const dir = this.paths.crashesDir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    try {
      this.watcher = fs.watch(dir, { persistent: false }, (_ev, file) => {
        if (file && file.toLowerCase().endsWith('.dmp')) this.noticeDump(path.join(dir, file));
      });
      this.watcher.on('error', () => { this.watcher = null; });
    } catch { this.watcher = null; }
  }

  async tick() {
    if (this.stopped) return;
    const procs = await fivem.listProcesses();
    const c = fivem.classify(procs);
    const prev = this.state.phase;
    this.lastGame = c;

    // 'capturing' is transient; leave it to capture() to resume the right phase.
    if (c.gameRunning) {
      if (prev === 'idle' || prev === 'closing') {
        this.state = { phase: 'running', game: c.game, since: Date.now(), graceUntil: null };
        this.crashedThisSession = false;
        this.store.addEvent('game-start', { process: c.game.name });
        this.emitState();
      }
    } else if (prev === 'running') {
      this.state = { ...this.state, phase: 'closing', graceUntil: Date.now() + EXIT_GRACE_MS };
      this.emitState();
    } else if (prev === 'closing' && Date.now() > this.state.graceUntil && this.pending.size === 0) {
      this.state = { phase: 'idle', game: null, since: null, graceUntil: null };
      if (!this.crashedThisSession) this.store.addEvent('game-exit', null);
      this.emitState();
    } else if (prev === 'idle' && c.launcherRunning && !this.state.launcher) {
      this.state.launcher = true; this.emitState();
    } else if (prev === 'idle' && !c.launcherRunning && this.state.launcher) {
      this.state.launcher = false; this.emitState();
    }

    // Belt and braces: fs.watch can miss events on some drives, so scan too.
    this.scanDir();
  }

  scanDir() {
    let files;
    try { files = fs.readdirSync(this.paths.crashesDir); } catch { return; }
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.dmp')) continue;
      const p = path.join(this.paths.crashesDir, f);
      if (!this.seen.has(p) && !this.pending.has(p)) this.noticeDump(p);
    }
  }

  noticeDump(dmp) {
    if (this.seen.has(dmp) || this.pending.has(dmp)) return;
    this.pending.set(dmp, null);
    this.state = { ...this.state, phase: 'capturing' };
    this.emitState();
    this.settle(dmp, -1, Date.now());
  }

  settle(dmp, lastSize, firstSeen) {
    let size = -1;
    try { size = fs.statSync(dmp).size; } catch { /* still being created */ }
    const hasGamelog = fs.existsSync(dmp + '.gamelog');
    const stable = size > 0 && size === lastSize;
    const waitedEnough = Date.now() - firstSeen > GAMELOG_WAIT_MS;
    if (stable && (hasGamelog || waitedEnough)) {
      this.pending.delete(dmp);
      this.seen.add(dmp);
      this.capture(dmp).catch((err) => this.emit('error', err));
      return;
    }
    if (Date.now() - firstSeen > 120000) { // give up waiting, take what we have
      this.pending.delete(dmp); this.seen.add(dmp);
      this.capture(dmp).catch((err) => this.emit('error', err));
      return;
    }
    this.pending.set(dmp, setTimeout(() => this.settle(dmp, size, firstSeen), SETTLE_MS));
  }

  async capture(dmp) {
    const id = ts() + '_' + path.basename(dmp, '.dmp').slice(0, 8);
    const dir = path.join(this.store.capturesDir, id);
    fs.mkdirSync(dir, { recursive: true });

    const files = [];
    const add = (name, abs) => { files.push({ name, size: fs.statSync(abs).size }); };

    const dmpOut = path.join(dir, path.basename(dmp));
    await fs.promises.copyFile(dmp, dmpOut); add(path.basename(dmp), dmpOut);

    let game = {};
    if (fs.existsSync(dmp + '.gamelog')) {
      const out = path.join(dir, path.basename(dmp) + '.gamelog');
      await fs.promises.copyFile(dmp + '.gamelog', out); add(path.basename(out), out);
      game = parseGamelog(out);
    }

    let crash = null;
    const log = fivem.latestLog(this.paths.logsDir);
    if (log) {
      crash = parseCrashBlock(log);
      const out = path.join(dir, 'CitizenFX.log.gz');
      try {
        await pipeline(fs.createReadStream(log), zlib.createGzip({ level: 6 }), fs.createWriteStream(out));
        add('CitizenFX.log.gz', out);
      } catch { /* log may be locked; dump alone still helps */ }
    }

    const sessionSeconds = this.state.since ? Math.round((Date.now() - this.state.since) / 1000) : null;
    const report = {
      schema: 1,
      module: 'crash',
      id,
      capturedAt: new Date().toISOString(),
      app: { name: app.getName(), version: app.getVersion() },
      machine: {
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        cpu: (os.cpus()[0] || {}).model || null,
        cores: os.cpus().length,
        ramGb: Math.round(os.totalmem() / 1024 ** 3),
      },
      session: { seconds: sessionSeconds, process: this.state.game ? this.state.game.name : null },
      crash: crash || { signature: 'Unknown crash', message: '', stack: [], reportId: null },
      game,
      files,
      source: { dump: dmp, log },
    };
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));

    const incident = {
      id,
      module: 'crash',
      at: report.capturedAt,
      title: report.crash.signature,
      message: report.crash.message,
      stack: report.crash.stack,
      reportId: report.crash.reportId,
      game,
      files,
      dir,
      totalBytes: files.reduce((a, f) => a + f.size, 0),
      share: { status: 'pending' },
      note: '',
    };
    this.crashedThisSession = true;
    const gameUp = this.lastGame && this.lastGame.gameRunning;
    this.state = { ...this.state, phase: gameUp ? 'running' : (this.state.graceUntil ? 'closing' : 'idle') };
    this.emitState();
    this.emit('incident', incident);
  }

  emitState() {
    this.emit('state', this.snapshot());
  }

  snapshot() {
    return {
      module: 'crash',
      phase: this.state.phase,
      since: this.state.since,
      launcher: !!this.state.launcher,
      process: this.state.game ? this.state.game.name : null,
      paths: this.paths,
      pendingDumps: this.pending.size,
    };
  }
}

module.exports = { CrashModule };
