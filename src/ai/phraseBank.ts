// 📚 배운 문장 — the game learns from its own storyteller while you play.
// Every rewrite that passes the checks is kept as "template → natural line" (names swapped for
// placeholders). Later, when the storyteller is busy, off, or the game runs fast, the same template
// is spoken with a line it learned instead of the bare template. Stored in this browser only.
// (Fine-tuning the model itself inside a browser isn't practical; this is retrieval, not training.)

const KEY = 'asiwrite.phraseBank.v1';
const MAX_KEYS = 1500;
const MAX_VARIANTS = 6;

type Bank = Record<string, { v: string[]; t: number }>;
let bank: Bank | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Bank {
  if (bank) return bank;
  try {
    bank = JSON.parse(localStorage.getItem(KEY) || '{}') as Bank;
  } catch {
    bank = {};
  }
  return bank;
}
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!dirty || !bank) return;
    dirty = false;
    try {
      localStorage.setItem(KEY, JSON.stringify(bank));
    } catch {
      /* storage full: keep in memory */
    }
  }, 4000);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** names → placeholders: {S} the speaker, {L} the listener (full or given name) */
function normalize(text: string, speaker: string[], listener: string[]): string {
  let t = text.trim();
  for (const n of [...listener].sort((a, b) => b.length - a.length)) if (n.length >= 2) t = t.replace(new RegExp(esc(n), 'g'), '{L}');
  for (const n of [...speaker].sort((a, b) => b.length - a.length)) if (n.length >= 2) t = t.replace(new RegExp(esc(n), 'g'), '{S}');
  return t;
}

export const phraseBank = {
  /** remember a rewrite the checks accepted */
  learn(draft: string, polished: string, speaker: string[], listener: string[]) {
    const b = load();
    const k = normalize(draft, speaker, listener);
    const v = normalize(polished, speaker, listener);
    if (!k || !v || k === v || v.length > 120) return;
    const e = (b[k] ??= { v: [], t: 0 });
    e.t = Date.now();
    if (!e.v.includes(v)) {
      e.v.push(v);
      if (e.v.length > MAX_VARIANTS) e.v.shift();
    }
    const keys = Object.keys(b);
    if (keys.length > MAX_KEYS) {
      keys.sort((x, y) => b[x].t - b[y].t);
      for (const old of keys.slice(0, keys.length - MAX_KEYS)) delete b[old];
    }
    dirty = true;
    persist();
  },
  /** a learned line for this template, names filled back in — or null */
  recall(draft: string, speaker: string[], listener: string[]): string | null {
    const b = load();
    const e = b[normalize(draft, speaker, listener)];
    if (!e?.v.length) return null;
    const line = e.v[Math.floor(Math.random() * e.v.length)];
    // use the same form of the listener's name the template used (full name or given name)
    const l = listener.find((n) => n.length >= 2 && draft.includes(n)) ?? listener[0] ?? '';
    const s = speaker[0] ?? '';
    if (/\{L\}/.test(line) && !l) return null;
    return line.replace(/\{L\}/g, l).replace(/\{S\}/g, s);
  },
  get size() {
    const b = load();
    let n = 0;
    for (const k in b) n += b[k].v.length;
    return n;
  },
  clear() {
    bank = {};
    dirty = true;
    persist();
  },
};
