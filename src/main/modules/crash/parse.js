'use strict';
// Pull the human-readable crash block out of CitizenFX.log and a few vitals
// out of the .dmp.gamelog that FiveM writes next to the dump.
const fs = require('fs');

const DUMP_LINE = /^\[\s*\d+\]\s+\[\s*DumpServer\]\s+\d+\/ ?(.*)$/;

function tailText(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

// Returns { signature, message, stack[], reportId } or null.
function parseCrashBlock(logFile) {
  let text;
  try { text = tailText(logFile, 2 * 1024 * 1024); } catch { return null; }
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('Process crash captured. Crash dialog content:')) { start = i; break; }
  }
  if (start < 0) return null;

  const body = [];
  let reportId = null;
  for (let i = start + 1; i < lines.length && body.length < 80; i++) {
    const m = DUMP_LINE.exec(lines[i]);
    if (!m) { if (lines[i].trim() === '') continue; break; }
    const t = m[1];
    const r = /Crash report service returned (si-[0-9a-f]+)/i.exec(t);
    if (r) { reportId = r[1]; continue; }
    body.push(t);
  }
  while (body.length && body[body.length - 1].trim() === '') body.pop();

  const stackIdx = body.findIndex((l) => /^Stack trace:/i.test(l.trim()));
  const head = stackIdx >= 0 ? body.slice(0, stackIdx) : body;
  const stack = stackIdx >= 0
    ? body.slice(stackIdx + 1).map((l) => l.trim()).filter(Boolean)
    : [];
  const signature = (head[0] || '').trim() || 'Unknown crash';
  const message = head.slice(1).join('\n').trim();
  return { signature, message, stack, reportId };
}

// Returns a small object of vitals from the gamelog, or {}.
function parseGamelog(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').slice(0, 64 * 1024); } catch { return {}; }
  const grab = (re) => { const m = re.exec(text); return m ? m[1].trim() : null; };
  return {
    gameVersion: grab(/^Version\s*:\s*(.+)$/m),
    gameState: grab(/^Game State\s*:\s*(.+)$/m),
    sessionTime: grab(/^System Time \((.+?)\)/m),
    playerPosition: grab(/^Player Position \((.+?)\)/m),
    gameTime: grab(/^Game Time \((.+?)\)/m),
    currentVehicle: grab(/^Current Vehicle\s*:\s*(.+)$/m),
    memoryLoad: grab(/Memory Load\s*:\s*\(\s*(\d+%)\)/),
    streamingVirtualUsed: grab(/Virtual\s*:\s*used\((\d+Mb)\)/),
    peds: grab(/^Peds:\s*(\d+\/\d+)/m),
  };
}

module.exports = { parseCrashBlock, parseGamelog };
