// Emergent groups (그룹/파벌) and the split between global and group trends.
// A Will may belong to SEVERAL groups at once.
//
// Formation rule (spec §3.4): a set of ≥4 Wills who were together in ≥3
// multi-person conversations and whose average pairwise affinity is > 50.
// Name/colour are rule-based now; Phase 2 lets the LLM coin the name.

import type { Rumor } from './rumors';
import { hashString, makeRng, pick } from './util';

export interface Faction {
  id: string;
  name: string; // "#심야_노래방_결사대"
  color: string;
  members: string[];
  founded: number; // game minutes
  homePlaceId?: string;
  origin: 'emergent' | 'player';
  logs: { t: number; text: string }[];
}

const SUFFIX = ['결사대', '모임', '동호회', '연합', '수호단', '클럽', '패밀리', '동지회', '원정대'];
const PALETTE = ['#ff8a5b', '#5bc0ff', '#b98aff', '#7ee08a', '#ffd24a', '#ff6fa8', '#4ad6c8', '#f0a35e'];

export function factionColor(seed: string, taken: string[]): string {
  const free = PALETTE.filter((c) => !taken.includes(c));
  return (free.length ? free : PALETTE)[hashString(seed) % (free.length || PALETTE.length)];
}

/** "#야근_동지회" from a keyword + suffix */
export function coinName(keyword: string, seed: string, taken: string[]): string {
  const rng = makeRng(hashString(seed));
  const kw = keyword.replace(/[^가-힣a-zA-Z0-9]/g, '').slice(0, 8) || '골목';
  for (let k = 0; k < 10; k++) {
    const n = `#${kw}_${pick(SUFFIX, rng())}`;
    if (!taken.includes(n)) return n;
  }
  return `#${kw}_${Math.floor(rng() * 90 + 10)}`;
}

/** co-chat counts: how many ≥3-person conversations each pair shared */
export function coChatCounts(history: { members: string[] }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of history)
    for (let i = 0; i < h.members.length; i++)
      for (let j = i + 1; j < h.members.length; j++) {
        const a = h.members[i], b = h.members[j];
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        m.set(k, (m.get(k) ?? 0) + 1);
      }
  return m;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Greedy clique growth over the co-chat graph. Returns member sets that
 * satisfy the formation rule and are not already (mostly) an existing faction.
 */
export function findNewGroups(
  history: { members: string[] }[],
  affinity: (a: string, b: string) => number,
  existing: Faction[],
  alive: Set<string>,
): string[][] {
  const co = coChatCounts(history);
  const edges = [...co.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  // multi-membership: only skip sets that are (almost) an existing group already
  const isKnown = (g: string[]) => existing.some((f) => g.filter((m) => f.members.includes(m)).length >= Math.min(g.length, f.members.length) - 1);
  const used = new Set<string>(); // within this pass only, to avoid duplicate finds
  const found: string[][] = [];
  for (const [k] of edges) {
    const [a, b] = k.split('|');
    if (!alive.has(a) || !alive.has(b) || used.has(a) || used.has(b)) continue;
    const group = [a, b];
    const cands = new Set<string>();
    for (const [k2, n] of co) {
      if (n < 3) continue;
      const [x, y] = k2.split('|');
      if (group.includes(x) && !used.has(y) && alive.has(y)) cands.add(y);
      if (group.includes(y) && !used.has(x) && alive.has(x)) cands.add(x);
    }
    for (const c of cands) {
      if (group.includes(c)) continue;
      if (group.every((g) => (co.get(pairKey(g, c)) ?? 0) >= 3)) group.push(c);
      if (group.length >= 6) break;
    }
    if (group.length < 4) continue;
    let sum = 0, n = 0;
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) (sum += affinity(group[i], group[j])), n++;
    if (sum / n <= 50 || isKnown(group)) continue;
    found.push(group);
    for (const g of group) used.add(g);
  }
  return found;
}

// ───────────────────────── trend scopes ─────────────────────────

/**
 * Global trends exclude rumors that live inside a single group: a rumor is
 * "global" when its knowers span ≥2 groups (unaffiliated Wills each count as
 * their own circle) or it reached a quarter of the town.
 */
export function isGlobal(r: Rumor, factionsOf: (id: string) => string[], population: number): boolean {
  const circles = new Set<string>();
  for (const k of r.knownBy) {
    const fs = factionsOf(k);
    if (fs.length) fs.forEach((f) => circles.add(f));
    else circles.add(`solo:${k}`);
  }
  if (circles.size === 1) return false;
  const groups = [...circles].filter((c) => !c.startsWith('solo:')).length;
  const solos = circles.size - groups;
  return groups >= 2 || solos >= 2 || (groups >= 1 && solos >= 1 && r.knownBy.length >= 3) || r.knownBy.length >= population * 0.25;
}

/** Filter + score for one trend scope. */
export function scopeSpec(scope: 'global' | Faction, factionsOf: (id: string) => string[], population: number) {
  if (scope === 'global')
    return {
      key: 'global',
      filter: (r: Rumor) => isGlobal(r, factionsOf, population),
      reach: (r: Rumor) => r.knownBy.length / Math.max(1, population),
    };
  const inGroup = (r: Rumor) => r.knownBy.filter((k) => scope.members.includes(k)).length;
  return {
    key: scope.id,
    filter: (r: Rumor) => inGroup(r) >= 2,
    reach: (r: Rumor) => inGroup(r) / Math.max(1, scope.members.length),
  };
}
