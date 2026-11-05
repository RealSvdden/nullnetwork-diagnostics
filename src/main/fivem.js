'use strict';
// Where FiveM lives on this machine and whether it is running right now.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function defaultAppDir() {
  const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return path.join(local, 'FiveM', 'FiveM.app');
}

function resolvePaths(override) {
  const appDir = (override && override.trim()) || defaultAppDir();
  return {
    appDir,
    crashesDir: path.join(appDir, 'crashes'),
    logsDir: path.join(appDir, 'logs'),
    exists: fs.existsSync(appDir),
  };
}

// tasklist is cheap (~50 ms) and needs no extra privileges. We only care about
// FiveM* images; the game itself is FiveM_b<build>_GTAProcess.exe.
function listProcesses() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const out = [];
        for (const line of stdout.split(/\r?\n/)) {
          if (!line.startsWith('"FiveM')) continue;
          const cells = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
          out.push({ name: cells[0], pid: Number(cells[1]) || 0 });
        }
        resolve(out);
      });
  });
}

function classify(procs) {
  const game = procs.find((p) => /GTAProcess/i.test(p.name)) || null;
  const launcher = procs.find((p) => /^FiveM(\.exe|_ROSLauncher|_b\d+_ROS)/i.test(p.name)) || null;
  return { gameRunning: !!game, launcherRunning: !!launcher, game, launcher, count: procs.length };
}

function latestLog(logsDir) {
  try {
    const files = fs.readdirSync(logsDir)
      .filter((f) => /^CitizenFX_log_.*\.log$/i.test(f))
      .map((f) => { const p = path.join(logsDir, f); return { p, mtime: fs.statSync(p).mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
    return files[0] ? files[0].p : null;
  } catch { return null; }
}

module.exports = { resolvePaths, listProcesses, classify, latestLog, defaultAppDir };
