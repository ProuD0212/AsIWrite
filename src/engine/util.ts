// Small deterministic helpers shared by the engine.

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 seeded PRNG */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function pick<T>(arr: readonly T[], r: number = Math.random()): T {
  return arr[Math.floor(r * arr.length) % arr.length];
}

let idCounter = 0;
export function uid(prefix = 'e'): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/** Shade a #rrggbb color by amount (-1..1). */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (amt >= 0) {
    r += (255 - r) * amt;
    g += (255 - g) * amt;
    b += (255 - b) * amt;
  } else {
    r *= 1 + amt;
    g *= 1 + amt;
    b *= 1 + amt;
  }
  const to = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const WEEK = ['월', '화', '수', '목', '금', '토', '일'];
/** Day 1 is a Monday. */
export function weekdayOf(minutes: number): { label: string; weekend: boolean } {
  const d = Math.floor(minutes / 1440) % 7;
  return { label: WEEK[d], weekend: d >= 5 };
}

/** Format game minutes as "N일차 HH:MM". */
export function formatClock(minutes: number): string {
  const day = Math.floor(minutes / 1440) + 1;
  const m = Math.floor(minutes % 1440);
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${day}일차 ${hh}:${mm}`;
}

/**
 * Phase-1 lexical similarity: Korean character-bigram Dice coefficient.
 * Phase 2 swaps this for MiniLM cosine similarity via the same interface
 * (see engine/semantic.ts).
 */
export function bigrams(s: string): Set<string> {
  const clean = s.replace(/[\s.,!?~"'()[\]\-#]/g, '');
  const out = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2));
  return out;
}

export function diceSimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}
