// World · 그룹 — 결성 · 이름 · 해산
// These are methods of the World class kept in their own file. They are installed on
// World.prototype at the end of World.ts, so callers keep writing world.someMethod() as before.

import { coChatCounts, coinName, factionColor, findNewGroups, type Faction } from '../factions';
import { extractObject, josa, suffix, traitPolarity } from '../traits';
import { type Agent, type Place } from '../types';
import { uid } from '../util';
import { STYLE_LABEL, World } from '../World';

export const groupsMethods = {
  // ───────────────────────── groups (그룹) ─────────────────────────
  factionsOf(this: World, id: string): Faction[] {
    return this.factions.filter((f) => f.members.includes(id));
  },
  faction(this: World, id?: string) {
    return id ? this.factions.find((f) => f.id === id) : undefined;
  },
  sharesGroup(this: World, a: string, b: string) {
    return this.factions.some((f) => f.members.includes(a) && f.members.includes(b));
  },
  mutual(this: World, a: string, b: string) {
    return (this.feel(a, b) + this.feel(b, a)) / 2;
  },
  /** Where the members hang out most (sum of visits), used for naming and hangouts. */
  groupHome(this: World, members: string[]): Place | undefined {
    let best: Place | undefined, bv = 0;
    for (const p of this.places) {
      const v = members.reduce((s, m) => s + (p.regulars[m] ?? 0), 0);
      if (v > bv) (bv = v), (best = p);
    }
    return bv >= 2 ? best : undefined;
  },
  /** A keyword for the group name: their hangout, else the most shared liked thing. */
  groupKeyword(this: World, members: Agent[], home?: Place): string {
    if (home) return STYLE_LABEL[home.style];
    const count = new Map<string, number>();
    for (const m of members)
      for (const t of m.traits) {
        const o = traitPolarity(t) > 0 ? extractObject(t) : null;
        if (o && o.length <= 6) count.set(o, (count.get(o) ?? 0) + 1);
      }
    const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    return top && top[1] >= 2 ? top[0] : '골목';
  },
  /** Create a group (emergent or by the player). */
  formFaction(this: World, memberIds: string[], opts: { name?: string; origin?: Faction['origin'] } = {}): Faction | null {
    const members = memberIds.map((id) => this.agent(id)).filter((a): a is Agent => !!a && a.kind === 'person');
    if (members.length < 2) return null;
    const home = this.groupHome(members.map((m) => m.id));
    const h = (this.meta.minutes % 1440) / 60;
    const night = h >= 21 || h < 5 ? '심야_' : '';
    const taken = this.factions.map((f) => f.name);
    let name = opts.name?.trim() || coinName(night + this.groupKeyword(members, home), members.map((m) => m.id).join(), taken);
    if (!name.startsWith('#')) name = '#' + name.replace(/\s+/g, '_');
    const f: Faction = {
      id: uid('g'), name, color: factionColor(name, this.factions.map((x) => x.color)), members: members.map((m) => m.id),
      founded: this.meta.minutes, homePlaceId: home?.id, origin: opts.origin ?? 'emergent', logs: [],
    };
    this.factions.push(f);
    const names = members.map((m) => m.name).join(', ');
    f.logs.push({ t: this.meta.minutes, text: `${names}${suffix(members[members.length - 1].name, '이/가')} 모여 ${f.name}${suffix(f.name.replace(/[^가-힣a-zA-Z0-9]+$/, ''), '을/를')} 결성했다.` });
    this.pushFeed({ kind: 'care', text: `🎉 ${members.length}명의 윌이 모여 ${f.name}${suffix(f.name, '을/를')} 결성했어요!` });
    for (const m of members) {
      this.log(m, 'event', `${f.name}의 멤버가 되었다.`);
      this.addThought(m, `group:${f.id}`, `${f.name}에 소속감을 느낌`, 6, 600);
    }
    if (members[0]) this.naturalRumor(`${names}${suffix(members[members.length - 1].name, '이/가')} ${f.name}${suffix(f.name, '을/를')} 만들었대`, members, members[0], 0.4, 'bond', 20);
    // let the storyteller coin a livelier name (kept only if it looks like a #hashtag)
    if (this.simSpeed < 3) World.storyHook?.({
      world: this, kind: 'groupName', speaker: members[0], draft: f.name, topic: `${home ? home.name + ' 단골' : ''} ${this.groupKeyword(members, home)}`.trim(), important: true,
      listener: undefined,
      apply: (t) => {
        const clean = '#' + t.replace(/^#+/, '').replace(/[\s"“”'.,!?]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        if (!/^#[가-힣A-Za-z0-9_]{2,18}$/.test(clean) || this.factions.some((x) => x !== f && x.name === clean)) return;
        f.logs.push({ t: this.meta.minutes, text: `모임 이름을 ${clean}${suffix(clean, '으로/로')} 정했다.` });
        f.name = clean;
      },
    });
    return f;
  },
  disbandFaction(this: World, id: string, why = '해산했다.') {
    const f = this.faction(id);
    if (!f) return;
    this.factions = this.factions.filter((x) => x !== f);
    this.pushFeed({ kind: 'event', text: `💨 ${f.name} — ${why}` });
    for (const m of f.members) {
      const a = this.agent(m);
      if (a) this.log(a, 'event', `${f.name}이(가) 사라졌다. 조금 허전하다.`.replace('이(가)', suffix(f.name, '이/가')));
    }
  },
  renameFaction(this: World, id: string, name: string) {
    const f = this.faction(id);
    if (!f) return false;
    const clean = '#' + name.trim().replace(/^#+/, '').replace(/\s+/g, '_');
    f.logs.push({ t: this.meta.minutes, text: `이름이 ${f.name}에서 ${clean}${suffix(clean, '으로/로')} 바뀌었다.` });
    f.name = clean;
    return true;
  },
  /** every 30 game minutes: new groups form, people join/leave, tiny groups dissolve */
  updateFactions(this: World) {
    const alive = new Set(this.agents.filter((a) => a.kind === 'person').map((a) => a.id));
    for (const g of findNewGroups(this.groupHistory, (a, b) => this.mutual(a, b), this.factions, alive)) this.formFaction(g);
    const co = coChatCounts(this.groupHistory);
    const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    for (const f of [...this.factions]) {
      // join: chatted together repeatedly with at least half the members, and warm both ways
      for (const id of alive) {
        if (f.members.includes(id)) continue;
        const withMany = f.members.filter((m) => (co.get(key(id, m)) ?? 0) >= 2).length >= Math.ceil(f.members.length / 2);
        if (!withMany) continue;
        const out = f.members.reduce((s, m) => s + this.feel(id, m), 0) / f.members.length;
        const back = f.members.reduce((s, m) => s + this.feel(m, id), 0) / f.members.length;
        if (out >= 45 && back >= 35) {
          f.members.push(id);
          const a = this.agent(id)!;
          f.logs.push({ t: this.meta.minutes, text: `${josa(a.name, '이/가')} 새로 합류했다.` });
          this.log(a, 'event', `${f.name}에 들어갔다. 이제 나도 이 사람들 중 하나다.`);
          this.pushFeed({ kind: 'care', speakerId: a.id, text: `🤝 ${josa(a.name, '이/가')} ${f.name}에 합류했어요.` });
        }
      }
      // leave: drifted apart
      for (const id of [...f.members]) {
        const others = f.members.filter((m) => m !== id);
        if (!others.length) continue;
        const avg = others.reduce((s, m) => s + this.mutual(id, m), 0) / others.length;
        if (avg < 15) {
          f.members = others;
          const a = this.agent(id);
          if (a) {
            f.logs.push({ t: this.meta.minutes, text: `${josa(a.name, '이/가')} 모임을 떠났다.` });
            this.log(a, 'event', `${f.name}에서 나왔다. 예전 같지 않다.`);
          }
        }
      }
      if (f.members.length < 3) this.disbandFaction(f.id, '모이는 사람이 줄어 자연스럽게 흩어졌다.');
    }
  },
};
