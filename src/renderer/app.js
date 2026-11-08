'use strict';
/* Renderer: one small state object, re-render on every change. No framework. */
const $ = (id) => document.getElementById(id);
const api = window.nn;

const S = {
  version: '', settings: {}, appConfig: {}, endpointConfigured: false,
  incidents: [], events: [], states: {}, capturesDir: '', capturesBytes: 0, fivemDefault: '',
  view: 'overview', consentId: null, consentBusy: false,
};

const fmtBytes = (n) => { n = Number(n) || 0; if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`; };
const fmtTime = (iso) => { const d = new Date(iso); const today = new Date().toDateString() === d.toDateString(); return (today ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ') + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
const fmtDuration = (ms) => { const m = Math.floor((Number(ms) || 0) / 60000); if (m < 1) return 'just started'; if (m < 60) return `${m} min`; return `${Math.floor(m / 60)} h ${m % 60} min`; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const serverName = () => S.appConfig.serverName || 'the server';
const policyLabel = { ask: 'Ask every time', always: 'Always share', never: 'Never share' };
const statusLabel = { pending: 'Waiting for you', uploading: 'Sharing', shared: 'Shared', declined: 'Not shared', local: 'Kept locally', failed: 'Share failed', purged: 'Files removed' };
const files = (i) => (Array.isArray(i && i.files) ? i.files : []);
// Own-key lookup with a fallback: labels come from state on disk, never from the prototype.
const label = (map, key, fallback) => (typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : fallback);
// Every dynamic value that lands in an HTML template goes through esc(), including the
// output of the formatters above; only fixed markup (ICONS, class names from fixed maps) is raw.

const ICONS = {
  crash: '<svg viewBox="0 0 24 24"><path d="M12 3l9 16H3z M12 10v4 M12 17.5v.5"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>',
  game: '<svg viewBox="0 0 24 24"><path d="M6 9h12a4 4 0 0 1 4 4v1a4 4 0 0 1-4 4h-1l-2-2H9l-2 2H6a4 4 0 0 1-4-4v-1a4 4 0 0 1 4-4z M8 12v3 M6.5 13.5h3 M16 13h.01 M18 15h.01"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5 M12 8v.5"/></svg>',
};

// ------------------------------------------------------------------ views
function show(view) {
  S.view = view;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === view));
  if (view === 'settings') api.invoke('app:capturesBytes').then((b) => { S.capturesBytes = b; $('capturesBytes').textContent = fmtBytes(b); });
}
document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => show(b.dataset.goto)));

// --------------------------------------------------------------- overview
function renderHero() {
  const st = S.states.crash || { phase: 'idle' };
  const ring = $('ring');
  ring.className = 'ring ' + st.phase;
  $('hero').className = 'hero card ' + st.phase;
  $('footDot').className = 'dot ' + st.phase;
  const map = {
    idle: ['Waiting for FiveM', st.launcher ? 'FiveM launcher is open. We start watching once the game loads.' : 'Start the game as usual. We watch quietly from here.'],
    running: ['FiveM is running', `Watching for crashes. If the game goes down, we save the report before you even notice.`],
    closing: ['FiveM closed', 'Checking whether a crash report was written.'],
    capturing: ['Saving crash report', 'FiveM wrote a crash dump. Bundling it with the game log.'],
    nofivem: ['FiveM not found', 'We could not find your FiveM.app folder. Point us to it under Settings.'],
  };
  const [title, sub] = map[st.phase] || map.idle;
  $('heroTitle').textContent = title;
  $('heroSub').textContent = sub;
  $('footText').textContent = title;
  const meta = [];
  if (st.phase === 'running' && st.since) meta.push(`<span class="chip">Session <code>${esc(fmtDuration(Date.now() - st.since))}</code></span>`);
  if (st.process) meta.push(`<span class="chip"><code>${esc(st.process)}</code></span>`);
  meta.push(`<span class="chip">Sharing <code>${esc(label(policyLabel, S.settings.sharePolicy, 'Ask every time'))}</code></span>`);
  $('heroMeta').innerHTML = meta.join('');
}

function renderTiles() {
  const inc = S.incidents;
  const pending = inc.filter((i) => i.share.status === 'pending');
  $('tileCaptures').textContent = inc.length;
  $('tileShared').textContent = inc.filter((i) => i.share.status === 'shared').length;
  $('tilePending').textContent = pending.length;
  $('tilePolicy').textContent = label(policyLabel, S.settings.sharePolicy, 'Ask every time');
  $('navBadge').hidden = pending.length === 0;
  $('navBadge').textContent = pending.length;
  $('endpointBanner').hidden = S.endpointConfigured;

  $('pendingSection').hidden = pending.length === 0;
  $('pendingList').innerHTML = pending.map((i) => `
    <div class="pending-card" data-id="${esc(i.id)}">
      <div class="row-icon crash">${ICONS.crash}</div>
      <div class="row-main">
        <div class="row-title">${esc(i.title)}</div>
        <div class="row-sub">${esc(fmtTime(i.at))} · ${esc(fmtBytes(i.totalBytes))} · ${files(i).length} file${files(i).length === 1 ? '' : 's'}</div>
      </div>
      <div class="row-actions">
        <button class="btn ghost sm" data-act="decline">Not now</button>
        <button class="btn primary sm" data-act="review">Review &amp; share</button>
      </div>
    </div>`).join('');
}

function renderEvents() {
  const el = $('eventList');
  if (!S.events.length) { el.innerHTML = '<div class="empty"><svg><use href="#ic-layers"/></svg>Nothing yet. Start FiveM and play as usual.</div>'; return; }
  const desc = (e) => {
    const d = e.detail || {};
    switch (e.type) {
      case 'game-start': return ['game', 'FiveM started', d.process || ''];
      case 'game-exit': return ['game', 'FiveM closed normally', 'No crash report was written'];
      case 'incident': return ['crash', 'Crash report saved', d.title || ''];
      case 'shared': return ['ok', `Shared with ${serverName()}`, d.ref ? `Reference ${d.ref}` : ''];
      case 'declined': return ['info', 'Report kept on this PC', 'You chose not to share'];
      case 'share-failed': return ['crash', 'Sharing failed', d.error || ''];
      case 'error': return ['crash', 'Something went wrong', d.message || ''];
      default: return ['info', e.type, ''];
    }
  };
  el.innerHTML = S.events.slice(0, 25).map((e) => { const [k, t, s] = desc(e); const icon = Object.hasOwn(ICONS, k) ? k : 'info'; return `
    <div class="row">
      <div class="row-icon ${icon}">${ICONS[icon]}</div>
      <div class="row-main"><div class="row-title">${esc(t)}</div>${s ? `<div class="row-sub">${esc(s)}</div>` : ''}</div>
      <div class="row-time">${esc(fmtTime(e.at))}</div>
    </div>`; }).join('');
}

// --------------------------------------------------------------- captures
function renderCaptures() {
  const el = $('captureList');
  if (!S.incidents.length) { el.innerHTML = '<div class="empty"><svg><use href="#ic-layers"/></svg>No captures yet.</div>'; return; }
  el.innerHTML = S.incidents.map((i) => {
    const share = i.share || {};
    const st = i.purged ? 'purged' : String(share.status || '');
    const pct = share.pct != null ? ` ${Number(share.pct) || 0}%` : '';
    const cls = Object.hasOwn(statusLabel, st) ? st : 'unknown'; // class names only from the fixed set
    const actions = [];
    if (!i.purged && (st === 'pending' || st === 'failed' || st === 'declined' || st === 'local')) actions.push(`<button class="btn primary sm" data-act="review">${st === 'failed' ? 'Retry' : 'Share'}</button>`);
    if (!i.purged) actions.push('<button class="btn ghost sm" data-act="folder">Folder</button>');
    actions.push('<button class="btn link sm danger" data-act="delete">Delete</button>');
    const g = i.game || {};
    return `
    <div class="capture" data-id="${esc(i.id)}">
      <div class="row" data-act="toggle">
        <div class="row-icon crash">${ICONS.crash}</div>
        <div class="row-main">
          <div class="row-title">${esc(i.title)}</div>
          <div class="row-sub">${esc(fmtTime(i.at))} · ${i.purged ? 'files removed' : esc(fmtBytes(i.totalBytes))}${i.note ? ' · ' + esc(i.note) : ''}</div>
        </div>
        <span class="status ${cls}">${esc(label(statusLabel, st, st))}${st === 'uploading' ? esc(pct) : ''}</span>
        <div class="row-actions">${actions.join('')}</div>
      </div>
      <div class="capture-detail">
        <div class="kvs">
          ${g.gameVersion ? `<div class="kv"><span>FiveM build</span><strong>${esc(g.gameVersion)}</strong></div>` : ''}
          ${g.sessionTime ? `<div class="kv"><span>Session</span><strong>${esc(g.sessionTime)}</strong></div>` : ''}
          ${g.playerPosition ? `<div class="kv"><span>Position</span><strong>${esc(g.playerPosition)}</strong></div>` : ''}
          ${g.memoryLoad ? `<div class="kv"><span>Memory load</span><strong>${esc(g.memoryLoad)}</strong></div>` : ''}
          ${i.reportId ? `<div class="kv"><span>FiveM report</span><strong>${esc(i.reportId)}</strong></div>` : ''}
          ${share.ref ? `<div class="kv"><span>Server reference</span><strong>${esc(share.ref)}</strong></div>` : ''}
          ${share.error ? `<div class="kv"><span>Error</span><strong>${esc(share.error)}</strong></div>` : ''}
        </div>
        ${i.message || i.stack?.length ? `<pre>${esc(i.message)}${i.message && i.stack?.length ? '\n\n' : ''}${esc((i.stack || []).join('\n'))}</pre>` : ''}
        ${files(i).length ? `<pre>${files(i).map((f) => `${esc(f && f.name)}  (${esc(fmtBytes(f && f.size))})`).join('\n')}</pre>` : ''}
      </div>
    </div>`;
  }).join('');
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const holder = btn.closest('[data-id]');
  const id = holder && holder.dataset.id;
  switch (btn.dataset.act) {
    case 'toggle': if (!e.target.closest('button')) holder.classList.toggle('is-open'); break;
    case 'review': openConsent(id); break;
    case 'decline': await api.invoke('incident:decline', { id }); break;
    case 'folder': api.invoke('incident:openFolder', { id }); break;
    case 'delete': S.incidents = await api.invoke('incident:delete', { id }); renderAll(); break;
  }
});

// ---------------------------------------------------------------- consent
function openConsent(id) {
  const i = S.incidents.find((x) => x.id === id);
  if (!i) return;
  S.consentId = id; S.consentBusy = false;
  $('consentWhen').textContent = `${new Date(i.at).toLocaleString()} · ${fmtBytes(i.totalBytes)} saved on this PC`;
  $('consentSig').textContent = i.title;
  $('consentMsg').hidden = !i.message;
  $('consentMsg').textContent = i.message || '';
  $('consentFiles').innerHTML = files(i).map((f) => `<li><svg><use href="#ic-file"/></svg><code>${esc(f && f.name)}</code><span>${esc(fmtBytes(f && f.size))}</span></li>`).join('') || '<li class="muted">No files</li>';
  $('consentNote').value = i.note || '';
  $('consentTag').value = S.settings.playerTag || '';
  $('consentAlways').checked = false;
  $('consentShareLabel').textContent = `Share with ${serverName()}`;
  $('consentShare').disabled = !S.endpointConfigured;
  $('consentShare').title = S.endpointConfigured ? '' : 'Sharing is not configured in this build';
  setConsentPhase('ask');
  $('consent').hidden = false;
  $('consentNote').focus();
}
function setConsentPhase(phase, data) {
  $('consentProgress').hidden = phase !== 'uploading';
  $('consentDone').hidden = phase !== 'done';
  $('consentFail').hidden = phase !== 'failed';
  $('consentShare').hidden = phase === 'uploading' || phase === 'done';
  $('consentLater').hidden = phase === 'uploading' || phase === 'done';
  $('consentClose').hidden = phase !== 'done' && phase !== 'failed';
  $('consentLater').disabled = phase === 'uploading';
  if (phase === 'uploading') { $('consentBar').style.width = '0%'; $('consentPct').textContent = 'Uploading 0%'; }
  if (phase === 'done') $('consentRef').textContent = data && data.ref ? `Reference ${data.ref}. Staff can find your report with it.` : 'Your report reached the server.';
  if (phase === 'failed') $('consentErr').textContent = (data && data.error) || 'Unknown error. The report is still saved on this PC; you can retry from Captures.';
}
function closeConsent() { $('consent').hidden = true; S.consentId = null; }
$('consentLater').addEventListener('click', async () => { const id = S.consentId; closeConsent(); if (id) await api.invoke('incident:decline', { id }); });
$('consentClose').addEventListener('click', closeConsent);
$('consentX').addEventListener('click', () => { if (!S.consentBusy) closeConsent(); });
$('consentFolder').addEventListener('click', () => api.invoke('incident:openFolder', { id: S.consentId }));
$('consentShare').addEventListener('click', async () => {
  if (S.consentBusy) return;
  S.consentBusy = true;
  const id = S.consentId;
  if ($('consentAlways').checked) S.settings = await api.invoke('settings:set', { sharePolicy: 'always' });
  setConsentPhase('uploading');
  const res = await api.invoke('incident:share', { id, note: $('consentNote').value.trim(), playerTag: $('consentTag').value.trim() });
  S.consentBusy = false;
  if (S.consentId !== id) return;
  if (res && res.error) setConsentPhase('failed', { error: res.error });
  else setConsentPhase('done', { ref: res && res.share && res.share.ref });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('consent').hidden && !S.consentBusy) closeConsent(); });

// --------------------------------------------------------------- settings
function renderSettings() {
  const s = S.settings;
  document.querySelectorAll('input[name=policy]').forEach((r) => { r.checked = r.value === s.sharePolicy; });
  $('playerTag').value = s.playerTag || '';
  $('launchAtStartup').checked = !!s.launchAtStartup;
  $('startMinimized').checked = !!s.startMinimized;
  $('notifications').checked = s.notifications !== false;
  $('keepDays').value = s.keepDays || 14;
  $('capturesBytes').textContent = fmtBytes(S.capturesBytes);
  $('capturesDir').textContent = S.capturesDir;
  $('capturesDir').title = S.capturesDir;
  $('endpoint').textContent = S.endpoint || 'not configured in this build';
  const st = S.states.crash || {};
  $('fivemPath').textContent = (st.paths && st.paths.appDir) || s.fivemPath || S.fivemDefault;
  $('fivemPath').title = $('fivemPath').textContent;
  $('fivemStatus').textContent = st.phase === 'nofivem' ? 'Folder not found' : st.phase === 'running' ? 'Running' : 'Installed, not running';
  $('fivemStatus').style.color = st.phase === 'nofivem' ? 'var(--red)' : st.phase === 'running' ? 'var(--green)' : '';
  $('aboutVersion').textContent = 'v' + S.version;
  $('footVersion').textContent = 'v' + S.version;
  $('discordBtn').hidden = !S.appConfig.discordInvite;
  $('deviceId').textContent = S.device ? S.device.id : 'not registered yet';
  $('resetDeviceBtn').hidden = !S.device;
  renderUpdate();
}

// ------------------------------------------------------------------ updates
function renderUpdate() {
  const u = S.update || { status: 'idle' };
  const bar = $('updateBar');
  const show = u.status === 'downloading' || u.status === 'ready' || u.status === 'installing';
  bar.hidden = !show;
  if (show) {
    $('updateTitle').textContent = u.status === 'installing' ? `Restarting into version ${u.version}` : u.status === 'ready' ? `Version ${u.version} is ready` : `Updating to version ${u.version}`;
    $('updateSub').textContent = u.status === 'downloading' ? `Downloading ${u.pct}%` : u.status === 'installing' ? 'Back in a few seconds.' : u.waiting ? 'Waiting for the current share to finish, then restarting.' : 'Restarting to finish the update.';
    $('updateProgress').hidden = u.status !== 'downloading';
    $('updateBarFill').style.width = (u.pct || 0) + '%';
    $('updateGo').hidden = u.status !== 'ready' || !u.waiting;
    $('updateGo').textContent = 'Restart now';
    $('updateLater').hidden = true;
  }
  const label = { disabled: 'Updates are only checked in installed builds', idle: 'Not checked yet', checking: 'Checking…', none: 'Up to date', available: `Version ${u.version} available`, downloading: `Downloading ${u.pct}%`, ready: `Version ${u.version} ready to install`, error: `Could not check: ${u.error || 'unknown error'}` }[u.status] || u.status;
  $('updateStatus').textContent = label;
}
$('updateGo').addEventListener('click', () => api.invoke('update:install'));
$('updateLater').addEventListener('click', () => { $('updateBar').hidden = true; });
$('checkUpdateBtn').addEventListener('click', async () => { S.update = await api.invoke('update:check'); renderUpdate(); });
$('resetDeviceBtn').addEventListener('click', async () => { await api.invoke('device:reset'); S.device = null; renderSettings(); });
async function save(patch) { S.settings = await api.invoke('settings:set', patch); renderAll(); }
document.querySelectorAll('input[name=policy]').forEach((r) => r.addEventListener('change', () => save({ sharePolicy: r.value })));
$('playerTag').addEventListener('change', () => save({ playerTag: $('playerTag').value.trim() }));
$('launchAtStartup').addEventListener('change', () => save({ launchAtStartup: $('launchAtStartup').checked }));
$('startMinimized').addEventListener('change', () => save({ startMinimized: $('startMinimized').checked }));
$('notifications').addEventListener('change', () => save({ notifications: $('notifications').checked }));
$('keepDays').addEventListener('change', () => save({ keepDays: Math.min(365, Math.max(1, Number($('keepDays').value) || 14)) }));
$('probeBtn').addEventListener('click', async () => {
  $('probeResult').textContent = 'Testing…';
  const r = await api.invoke('app:probeEndpoint');
  $('probeResult').textContent = r.ok ? `Reachable (HTTP ${r.status}).` : `Not reachable${r.error ? ': ' + r.error : r.status ? ' (HTTP ' + r.status + ')' : ''}.`;
});
$('pickFivemBtn').addEventListener('click', async () => { const p = await api.invoke('app:pickFivemPath'); if (p) { await save({ fivemPath: p }); await boot(false); } });
$('resetFivemBtn').addEventListener('click', async () => { await save({ fivemPath: '' }); await boot(false); });
$('openCapturesBtn').addEventListener('click', () => api.invoke('app:openCaptures'));
$('openCapturesBtn2').addEventListener('click', () => api.invoke('app:openCaptures'));
$('discordBtn').addEventListener('click', () => api.invoke('app:openExternal', S.appConfig.discordInvite));

// ------------------------------------------------------------------ boot
function renderAll() { renderHero(); renderTiles(); renderEvents(); renderCaptures(); renderSettings(); }

async function boot(first) {
  const b = await api.invoke('app:boot');
  Object.assign(S, b);
  renderAll();
  if (first) {
    const pending = S.incidents.find((i) => i.share.status === 'pending');
    if (pending && S.settings.sharePolicy === 'ask') openConsent(pending.id);
  }
}

api.on('module:state', (st) => { S.states[st.module] = st; renderHero(); renderSettings(); });
api.on('incident:new', (inc) => {
  S.incidents = [inc, ...S.incidents.filter((i) => i.id !== inc.id)];
  renderAll();
  if (inc.share.status === 'pending' && S.settings.sharePolicy === 'ask') openConsent(inc.id);
});
api.on('incident:update', (inc) => {
  if (!inc) return;
  S.incidents = S.incidents.map((i) => (i.id === inc.id ? inc : i));
  renderAll();
});
api.on('upload:progress', ({ id, pct }) => {
  const i = S.incidents.find((x) => x.id === id);
  if (i && i.share.status === 'uploading') { i.share.pct = pct; }
  if (S.consentId === id) { $('consentBar').style.width = pct + '%'; $('consentPct').textContent = `Uploading ${pct}%`; }
  else renderCaptures();
});
api.on('events', (ev) => { S.events = ev; renderEvents(); });
api.on('update:state', (st) => { S.update = st; renderUpdate(); });

setInterval(renderHero, 30000); // keep the session timer honest
boot(true);
