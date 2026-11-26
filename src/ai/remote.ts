// Playing from another PC through the share server (lanShare.ts):
// by default the AI runs on the server PC (its GPU), not in this browser. Players can switch to
// "내 브라우저" in the settings. On the server PC itself nothing here is used.

export const isRemotePage = () => typeof location !== 'undefined' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

const WHERE_KEY = 'asiwrite.aiWhere';
export function aiWhere(): 'host' | 'mine' {
  try {
    return localStorage.getItem(WHERE_KEY) === 'mine' ? 'mine' : 'host';
  } catch {
    return 'host';
  }
}
export function setAiWhere(v: 'host' | 'mine') {
  try {
    localStorage.setItem(WHERE_KEY, v);
  } catch {
    /* ignore */
  }
}
/** this browser hands its AI work to the server PC */
export const hostAIMode = () => isRemotePage() && aiWhere() === 'host';

export const hostStatus = { known: false, host: false, story: false, embed: false, label: '', served: 0, hidden: false };
const listeners = new Set<() => void>();
export function onHostStatus(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
let polling = false;
export function watchHost() {
  if (polling || !hostAIMode()) return;
  polling = true;
  const tick = async () => {
    try {
      const r = await fetch('/__ai/status');
      const j = await r.json();
      Object.assign(hostStatus, { known: true, host: !!j.host, story: !!j.story, embed: !!j.embed, label: String(j.label ?? ''), served: Number(j.served ?? 0), hidden: !!j.hidden });
    } catch {
      Object.assign(hostStatus, { known: true, host: false, story: false, embed: false });
    }
    for (const l of listeners) l();
    setTimeout(tick, hostStatus.story && hostStatus.embed ? 15000 : 4000);
  };
  void tick();
}

/** send one AI job to the server PC; resolves to its result or null */
export async function relayJob<T>(kind: 'gen' | 'embed', payload: unknown, timeoutMs = 90000): Promise<T | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch('/__ai/job', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, payload }), signal: ctl.signal });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function f32ToB64(a: Float32Array): string {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToF32(b: string): Float32Array {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return new Float32Array(u.buffer);
}
