// Public download page served at / (diagnostics.nullnetwork.ca). Reads the current
// release from releases/latest.yml so the button always points at the latest build.
const REPO = 'https://github.com/RealSvdden/nullnetwork-diagnostics';

function parseLatest(yml) {
  const get = (k) => { const m = new RegExp(`^${k}:\\s*'?([^'\\n]+)'?`, 'm').exec(yml); return m ? m[1].trim() : null; };
  return { version: get('version'), path: get('path'), sha512: get('sha512'), releaseDate: get('releaseDate') };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function downloadPage(env) {
  let rel = null;
  try {
    const obj = await env.DIAG.get('releases/latest.yml');
    if (obj) rel = parseLatest(await obj.text());
  } catch { /* no release yet */ }
  const file = rel && rel.path ? `/v1/update/${encodeURIComponent(rel.path)}` : null;
  const date = rel && rel.releaseDate ? new Date(rel.releaseDate).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' }) : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nullnetwork Diagnostics</title>
<meta name="description" content="A small open-source app that runs beside FiveM, saves the crash dump when the game crashes, and only shares it with the Nullnetwork team if you say yes.">
<style>
  :root { --bg:#070b14; --text:#eef1f7; --muted:#98a2b6; --faint:#5f6981; --line:rgba(255,255,255,.08); --blue:#4f8cff; --pink:#ff5fa2; --green:#45d483; }
  * { box-sizing: border-box; }
  body { margin:0; font: 16px/1.5 "Segoe UI Variable Text","Segoe UI",Inter,system-ui,sans-serif; color:var(--text); background:var(--bg); min-height:100vh; position:relative; overflow-x:hidden; }
  body::before { content:""; position:fixed; width:720px; height:720px; right:-220px; top:-320px; border-radius:50%; filter:blur(90px); background:radial-gradient(circle, rgba(79,140,255,.22), transparent 62%); pointer-events:none; }
  body::after { content:""; position:fixed; width:620px; height:620px; left:-260px; bottom:-300px; border-radius:50%; filter:blur(90px); background:radial-gradient(circle, rgba(255,95,162,.12), transparent 62%); pointer-events:none; }
  main { position:relative; max-width: 860px; margin: 0 auto; padding: 64px 24px 80px; }
  .brand { display:flex; align-items:center; gap:14px; margin-bottom: 40px; }
  .mark { width:44px; height:44px; border-radius:12px; background:linear-gradient(135deg,#4f8cff,#ff5fa2); display:grid; place-items:center; box-shadow:0 8px 24px rgba(79,140,255,.3); }
  .mark svg { width:26px; height:26px; fill:none; stroke:#fff; stroke-width:2.4; stroke-linecap:round; stroke-linejoin:round; }
  .brand b { letter-spacing:.08em; text-transform:uppercase; font-size:15px; }
  .brand span { display:block; color:var(--muted); font-size:13px; margin-top:-2px; }
  h1 { font-size: clamp(32px, 5vw, 46px); line-height:1.1; letter-spacing:-.02em; margin:0 0 14px; }
  .lead { font-size:18px; color:var(--muted); max-width:620px; margin:0 0 32px; }
  .cta { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin-bottom:12px; }
  .btn { display:inline-flex; align-items:center; gap:10px; height:50px; padding:0 24px; border-radius:14px; font-weight:600; text-decoration:none; color:#fff; background:linear-gradient(180deg,#5b95ff,#3f7cf2); box-shadow:0 10px 28px rgba(79,140,255,.35); }
  .btn.ghost { background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.14); box-shadow:none; color:var(--text); }
  .btn svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .meta { color:var(--faint); font-size:13px; margin-bottom:48px; }
  .meta code { font-family: Consolas, "Cascadia Mono", monospace; font-size:12px; word-break: break-all; color:var(--muted); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:14px; margin-bottom:40px; }
  .card { background:rgba(255,255,255,.03); border:1px solid var(--line); border-radius:16px; padding:20px 22px; }
  .card h3 { margin:0 0 8px; font-size:15px; }
  .card p, .card li { color:var(--muted); font-size:14px; margin:0; }
  .card ul { margin:0; padding-left:18px; }
  h2 { font-size:22px; margin:40px 0 12px; }
  ol, .steps { color:var(--muted); }
  pre { background:rgba(0,0,0,.35); border:1px solid var(--line); border-radius:12px; padding:14px 16px; overflow:auto; font-size:13px; color:var(--text); }
  a { color:var(--blue); }
  .ok { color:var(--green); }
  footer { margin-top:56px; color:var(--faint); font-size:13px; }
</style>
</head>
<body>
<main>
  <div class="brand">
    <div class="mark"><svg viewBox="0 0 24 24"><path d="M3 12h4l2.5-6 4 12 2.5-6H21"/></svg></div>
    <div><b>Nullnetwork</b><span>Diagnostics</span></div>
  </div>

  <h1>When FiveM crashes, send us the dump. Only if you want to.</h1>
  <p class="lead">A small Windows app that sits in your tray beside FiveM. If the game crashes it saves the crash report on your PC and asks whether to share it with the Nullnetwork team. Nothing is sent without your yes. The source is public.</p>

  <div class="cta">
    ${file ? `<a class="btn" href="${file}"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>Download for Windows${rel.version ? ` · v${esc(rel.version)}` : ''}</a>` : `<span class="btn ghost">No release published yet</span>`}
    <a class="btn ghost" href="${REPO}"><svg viewBox="0 0 24 24"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-.9-2.6c3.1-.3 6.4-1.5 6.4-6.9a5.4 5.4 0 0 0-1.5-3.7 5 5 0 0 0-.1-3.7s-1.2-.3-3.9 1.4a13.4 13.4 0 0 0-7 0C6.3 1.5 5.1 1.8 5.1 1.8a5 5 0 0 0-.1 3.7A5.4 5.4 0 0 0 3.5 9.2c0 5.4 3.3 6.6 6.4 6.9a3.4 3.4 0 0 0-.9 2.6V23"/></svg>Source on GitHub</a>
  </div>
  <p class="meta">${rel && rel.version ? `Version ${esc(rel.version)}${date ? ` · released ${esc(date)}` : ''} · Windows 10/11, 64-bit · installer SHA-512 <code>${esc(rel.sha512 || '')}</code>` : 'Releases are published to this page and to GitHub.'}</p>

  <div class="grid">
    <div class="card"><h3>What it does</h3><ul><li>Watches for the FiveM game process</li><li>Saves the crash dump, gamelog and CitizenFX log when the game dies</li><li>Shows you exactly what was saved and asks before sharing</li><li>Keeps a local copy you can open or delete any time</li></ul></div>
    <div class="card"><h3>What sharing sends</h3><ul><li>The crash dump FiveM wrote (a snapshot of the game process memory)</li><li>The game log and the CitizenFX log</li><li>Windows version, CPU, RAM, FiveM build</li><li>Your note and in-game name, only if you add them</li></ul></div>
    <div class="card"><h3>What it never does</h3><ul><li>No sending without a click (unless you opt into "always share")</li><li>No background uploads of anything else</li><li>No reading of your files outside the FiveM crash and log folders</li><li>No tracking, no ads, no accounts</li></ul></div>
  </div>

  <h2>Build it yourself</h2>
  <p class="steps">Prefer to compile it instead of trusting a download? It builds in a couple of minutes with Node.js 20+:</p>
  <pre>git clone ${REPO}.git
cd nullnetwork-diagnostics
npm install
npm start          # run from source
npm run dist       # build the installer into dist\\</pre>
  <p class="steps">The README in the repo explains the upload protocol, what the server stores, and how releases are signed and verified by the in-app updater.</p>

  <footer>Nullnetwork Diagnostics is open source under the MIT license. Crash reports are stored privately and only staff with the Diagnostics permission can read them.</footer>
</main>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=120', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'" } });
}
