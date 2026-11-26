// 📚 배운 문장 — the game learns from its own storyteller while you play.
// Every rewrite that passes the checks is kept as "template → natural line" (names swapped for
// placeholders). Later, when the storyteller is busy, off, or the game runs fast, the same template
// is spoken with a line it learned instead of the bare template. Stored in this browser only.
// (Fine-tuning the model itself inside a browser isn't practical; this is retrieval, not training.)
//
// Every learned line remembers WHICH model wrote it. A line is only reused while a model of the same
// tier or lower is running: a stronger model's lines may stand in for a weaker one, never the reverse
// (Qwen's slightly-off sentence must not show up while you're paying for Gemini).

import { modelTier } from './models';

const KEY = 'asiwrite.phraseBank.v2';
const OLD_KEY = 'asiwrite.phraseBank.v1';
const MAX_KEYS = 1500;
const MAX_VARIANTS = 8;

/** s = the line, m = the model that wrote it ('gemini' · 'groq' · 'gemma4' · 'qwen35' · 'old') */
type Variant = { s: string; m: string };
type Bank = Record<string, { v: Variant[]; t: number }>;
let bank: Bank | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Bank {
  if (bank) return bank;
  try {
    bank = JSON.parse(localStorage.getItem(KEY) || 'null') as Bank | null;
    if (!bank) {
      // v1 kept no author: treat those lines as the lowest tier so they never stand in for a better model
      const old = JSON.parse(localStorage.getItem(OLD_KEY) || '{}') as Record<string, { v: string[]; t: number }>;
      bank = {};
      for (const k in old) bank[k] = { t: old[k].t, v: old[k].v.map((s) => ({ s, m: 'old' })) };
      dirty = Object.keys(bank).length > 0;
    }
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
      localStorage.removeItem(OLD_KEY);
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
  /** remember a rewrite the checks accepted, together with the model that wrote it */
  learn(draft: string, polished: string, speaker: string[], listener: string[], model: string) {
    if (!model) return;
    const b = load();
    const k = normalize(draft, speaker, listener);
    const v = normalize(polished, speaker, listener);
    if (!k || !v || k === v || v.length > 120) return;
    const e = (b[k] ??= { v: [], t: 0 });
    e.t = Date.now();
    const same = e.v.find((x) => x.s === v);
    if (same) {
      if (modelTier(model) > modelTier(same.m)) same.m = model; // a stronger model wrote the same line: upgrade it
    } else {
      e.v.push({ s: v, m: model });
      if (e.v.length > MAX_VARIANTS) {
        // evict the oldest line of the weakest model first
        let worst = 0;
        for (let i = 1; i < e.v.length; i++) if (modelTier(e.v[i].m) < modelTier(e.v[worst].m)) worst = i;
        e.v.splice(worst, 1);
      }
    }
    const keys = Object.keys(b);
    if (keys.length > MAX_KEYS) {
      keys.sort((x, y) => b[x].t - b[y].t);
      for (const old of keys.slice(0, keys.length - MAX_KEYS)) delete b[old];
    }
    dirty = true;
    persist();
  },
  /**
   * A learned line for this template, names filled back in — or null.
   * `model` is what's running now: only lines from that tier or above are used ('' = no model → any).
   */
  recall(draft: string, speaker: string[], listener: string[], model = ''): string | null {
    const b = load();
    const e = b[normalize(draft, speaker, listener)];
    const min = model ? modelTier(model) : 0;
    const ok = e?.v.filter((x) => modelTier(x.m) >= min) ?? [];
    if (!ok.length) return null;
    const line = ok[Math.floor(Math.random() * ok.length)].s;
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
  /** how many lines each model wrote (for the settings panel) */
  byModel(): Record<string, number> {
    const b = load();
    const out: Record<string, number> = {};
    for (const k in b) for (const x of b[k].v) out[x.m] = (out[x.m] ?? 0) + 1;
    return out;
  },
  clear() {
    bank = {};
    dirty = true;
    persist();
  },
};
