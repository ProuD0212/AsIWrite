// 소문/사건 (rumors & events) with a live trend ranking.
//
// Rumors are born naturally from what happens (fights, friendships, comfort,
// lightning, new shops…) or are whispered in by the player. They live in the
// heads of the Wills who know them, spread through conversation, and their
// "heat" rises when retold and cools over time — the trend board ranks heat.

import { hashString } from './util';

export interface Rumor {
  id: string;
  text: string; // already phrased as hearsay: "…대"
  tag: string; // #해시태그
  about: string[]; // entity ids it concerns
  sentiment: number; // -1..1 (how it colours opinions of `about`)
  heat: number;
  peak: number;
  knownBy: string[];
  origin: 'natural' | 'player';
  kind?: 'struggle' | 'fight' | 'bond' | 'care' | 'event' | 'gossip' | 'romance';
  /** news the subject tells about themselves (a birthday, a lottery win) — they may spread it */
  selfTold?: boolean;
  /** a confided secret (a crush): whose secret it is, and who they told */
  secretOf?: string;
  confidant?: string;
  born: number; // game minutes
  lastTold: number;
}

export interface TrendRow {
  rumor: Rumor;
  rank: number;
  delta: number | 'new';
}

const POS = /(친해|사귀|화해|축하|당첨|웃|고마|칭찬|멋지|최고|착하|도와|구해|생겼|데뷔|합격|승진|결성|새로)/;
const NEG = /(싸|다툼|말다툼|도둑|거짓|몰래|망했|해고|잘렸|무너|번개|힘들|울|사고|미워|배신|소리 ?질|한계)/;

export function guessSentiment(text: string): number {
  const p = POS.test(text) ? 1 : 0;
  const n = NEG.test(text) ? 1 : 0;
  return (p - n) * 0.6;
}

/** "#민수_영희_싸움" — subjects + one keyword. */
export function makeTag(text: string, names: string[]): string {
  const kw =
    (text.match(/(싸움|말다툼|화해|열애설|사귀|절친|번개|새 ?가게|개업|첫 출근|데뷔|당첨|위로|한계|모임|결성|이사|비밀)/)?.[1] ?? '')
      .replace(/사귀/, '열애설')
      .replace(/\s/g, '');
  const parts = [...names.slice(0, 2).map((n) => n.replace(/\s|«|»/g, '')), kw].filter(Boolean);
  if (!parts.length) parts.push(...text.replace(/[^가-힣a-zA-Z0-9 ]/g, '').split(' ').filter(Boolean).slice(0, 2));
  return '#' + parts.join('_').slice(0, 24);
}

/** Turn a plain statement into hearsay: "민수가 이겼다" → "민수가 이겼대". */
export function hearsay(text: string): string {
  const t = text.trim().replace(/[.!?]+$/, '');
  if (/(대|래|더라|다더라|ㄴ대|라던데|다던데)$/.test(t)) return t;
  if (t.endsWith('이다')) return t.slice(0, -2) + '이래';
  if (t.endsWith('였다') || t.endsWith('었다') || t.endsWith('았다') || t.endsWith('했다') || t.endsWith('렸다') || t.endsWith('졌다')) return t.slice(0, -1) + '대';
  if (t.endsWith('는다')) return t.slice(0, -2) + '는대';
  if (t.endsWith('다')) return t.slice(0, -1) + '대'; // 한다→한대, 좋다→좋대, 있다→있대
  return t + '래';
}

export class RumorMill {
  rumors: Rumor[] = [];
  private snaps = new Map<string, { prev: Map<string, number>; cur: Map<string, number>; at: number }>();

  add(r: Omit<Rumor, 'id' | 'peak' | 'lastTold' | 'heat'> & { heat?: number }): Rumor | null {
    // de-dupe: same subjects + same tag within a while just heats the old one
    const dup = this.rumors.find((x) => x.tag === r.tag && r.born - x.born < 240);
    if (dup) {
      dup.heat += 8;
      dup.peak = Math.max(dup.peak, dup.heat);
      for (const k of r.knownBy) if (!dup.knownBy.includes(k)) dup.knownBy.push(k);
      return dup;
    }
    const heat = r.heat ?? 10 + r.knownBy.length * 3;
    const rumor: Rumor = { ...r, id: `r_${hashString(r.text + r.born).toString(36)}`, heat, peak: heat, lastTold: r.born };
    this.rumors.push(rumor);
    if (this.rumors.length > 80) {
      this.rumors.sort((a, b) => b.heat - a.heat);
      this.rumors.length = 60;
    }
    return rumor;
  }

  /**
   * Heat cools with a ~3 game-hour half-life (a trend is what people talk about NOW: an old rumor
   * everyone already knows has nobody left to tell, so it sinks); cold old rumors are forgotten.
   */
  tick(dtMinutes: number, now: number) {
    const k = Math.pow(0.5, dtMinutes / 180);
    for (const r of this.rumors) r.heat *= k;
    this.rumors = this.rumors.filter((r) => r.heat >= 1.5 || now - r.born < 120);
  }

  /** Something the speaker knows and the listener doesn't (hottest first). */
  pickToTell(speakerId: string, listenerId: string): Rumor | undefined {
    let best: Rumor | undefined;
    for (const r of this.rumors) {
      if (!r.knownBy.includes(speakerId) || r.knownBy.includes(listenerId) || (r.about.includes(speakerId) && !r.selfTold)) continue;
      // unpleasant talk goes around BEHIND someone's back — never to their face
      if (r.sentiment < 0 && r.about.includes(listenerId)) continue;
      if (!best || r.heat > best.heat) best = r;
    }
    return best;
  }

  tell(r: Rumor, listenerId: string, now: number) {
    if (!r.knownBy.includes(listenerId)) r.knownBy.push(listenerId);
    r.heat += 6;
    r.peak = Math.max(r.peak, r.heat);
    r.lastTold = now;
  }

  forget(entityId: string) {
    for (const r of this.rumors) r.knownBy = r.knownBy.filter((x) => x !== entityId);
  }

  /**
   * Ranked list for one scope (global or a group). Rank deltas compare with a
   * per-scope snapshot refreshed every 30 game minutes.
   */
  trends(now: number, opts: { key: string; filter?: (r: Rumor) => boolean; score?: (r: Rumor) => number; limit?: number }): TrendRow[] {
    const score = opts.score ?? ((r: Rumor) => r.heat);
    const sorted = this.rumors.filter((r) => !opts.filter || opts.filter(r)).sort((a, b) => score(b) - score(a));
    let snap = this.snaps.get(opts.key);
    if (!snap) this.snaps.set(opts.key, (snap = { prev: new Map(), cur: new Map(), at: -1e9 }));
    if (now - snap.at >= 30) {
      snap.prev = snap.cur;
      snap.cur = new Map(sorted.map((r, i) => [r.id, i + 1]));
      snap.at = now;
    }
    const prev = snap.prev;
    return sorted.slice(0, opts.limit ?? 10).map((rumor, i) => {
      const p = prev.get(rumor.id);
      return { rumor, rank: i + 1, delta: p === undefined ? ('new' as const) : p - (i + 1) };
    });
  }
}
