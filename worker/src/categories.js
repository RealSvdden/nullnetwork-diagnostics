// Crash categories derived from the FiveM crash signature / message.
// Mirrored in the admin panel (src/lib/diagnostics.ts) — keep the two in sync.
export const CATEGORIES = [
  'streaming-asset', 'graphics-driver', 'launcher', 'game', 'fivem-runtime', 'hang', 'plugin', 'memory', 'system', 'other',
];

export function classify(signature, message) {
  const s = `${signature || ''}\n${message || ''}`;
  const t = s.toLowerCase();
  if (/inflate\(\)|streaming file|compcache:|failed to load asset|\.y(ft|dr|td|bn|map|typ)\b/.test(t)) return 'streaming-asset';
  if (/stopped responding|watchdog|hang|not responding/.test(t)) return 'hang';
  if (/libglesv2|d3d1[12]|dxgi|nvwgf2um|amdxc64|atidxx|igd\d+|gpu|directx|graphics/.test(t)) return 'graphics-driver';
  if (/fivem_roslauncher|roslauncher|launcher/.test(t)) return 'launcher';
  if (/out of memory|err_mem|pool .* full|memory allocation|bad_alloc|pagefile/.test(t)) return 'memory';
  if (/\.asi\b|scripthook|reshade|enb/.test(t)) return 'plugin';
  if (/citizen-|adhesive|corert|citizengame|cfx|scripting|netlibrary|resource/.test(t)) return 'fivem-runtime';
  if (/gta5_b\d+\.exe|gta5\.exe|gtaprocess|rage/.test(t)) return 'game';
  if (/ntdll|kernelbase|kernel32|user32|win32u|msvcp|vcruntime|ucrtbase/.test(t)) return 'system';
  return 'other';
}
