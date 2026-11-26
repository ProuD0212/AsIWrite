// World · 소문 전하기 · 속마음 · 긴 이야기
// These are methods of the World class kept in their own file. They are installed on
// World.prototype at the end of World.ts, so callers keep writing world.someMethod() as before.

import { scopeSpec } from '../factions';
import { guessSentiment, hearsay, makeTag, type Rumor, type TrendRow } from '../rumors';
import { copula, extractDream, extractObject, josa, toGeodeunyo, traitPolarity } from '../traits';
import { type Agent, type Place } from '../types';
import { pick } from '../util';
import { World } from '../World';

export const voicesMethods = {
  // ───────────────────────── rumors & monologues ─────────────────────────
  /**
   * A rumor is born only if someone SAW it: awake Wills near `origin` who aren't its subjects.
   * More witnesses → hotter from the start (a crowd can put it straight on the board).
   * `selfTold` news (birthdays, lottery wins…) may also be spread by the subject themselves.
   */
  naturalRumor(this: World, text: string, about: (Agent | Place)[], origin: Agent, sentiment: number, kind: Rumor['kind'], heat?: number, selfTold = false) {
    const subjects = new Set(about.map((e) => e.id));
    const witnesses = this.grid
      .queryRadius(origin.x, origin.y, 170, this.tmp)
      .filter((a) => a.kind === 'person' && !a.ai.sleeping && !subjects.has(a.id))
      .map((a) => a.id);
    const knownBy = witnesses.length ? witnesses : selfTold && origin.kind === 'person' ? [origin.id] : [];
    if (!knownBy.length) return null; // nobody saw it → no rumor
    const r = this.rumors.add({
      text: hearsay(text), tag: makeTag(text, about.filter((e) => e.kind !== 'place' || about.length === 1).map((e) => e.name).slice(0, 2)), about: about.map((e) => e.id),
      sentiment, knownBy, origin: 'natural', born: this.meta.minutes, kind, heat: (heat ?? 6) + witnesses.length * 4, selfTold,
    });
    if (r) this.checkTopRumor();
    return r;
  },
  /** 🌐 global trend board (group-scoped boards arrive with Phase-3 groups). */
  globalTrends(this: World, limit = 10): (TrendRow & { reach: number })[] {
    const pop = this.agents.filter((a) => a.kind === 'person').length;
    const spec = scopeSpec('global', (id) => this.factionsOf(id).map((f) => f.id), pop);
    return this.rumors
      .trends(this.meta.minutes, { key: spec.key, filter: spec.filter, score: (r) => r.heat * (0.5 + spec.reach(r)), limit })
      .map((row) => ({ ...row, reach: spec.reach(row.rumor) }));
  },
  /** Trend board inside one group: rumors circulating among its members. */
  groupTrends(this: World, fid: string, limit = 10): (TrendRow & { reach: number })[] {
    const f = this.faction(fid);
    if (!f) return [];
    const spec = scopeSpec(f, (id) => this.factionsOf(id).map((x) => x.id), f.members.length);
    return this.rumors
      .trends(this.meta.minutes, { key: spec.key, filter: spec.filter, score: (r) => r.heat * (0.5 + spec.reach(r)), limit })
      .map((row) => ({ ...row, reach: spec.reach(row.rumor) }));
  },
  /** Player-planted rumor ("소문 퍼뜨리기"). */
  plantRumor(this: World, text: string, whisperTo: Agent[] = []): Rumor | null {
    const all: (Agent | Place)[] = [...this.agents, ...this.places];
    const about = all.filter((e) => e.name.length >= 2 && text.includes(e.name.replace(/\s*«.*»/, '')));
    let targets = whisperTo.filter((a) => a.kind === 'person');
    if (!targets.length) {
      const people = this.agents.filter((a) => a.kind === 'person' && !about.includes(a));
      targets = people.sort(() => Math.random() - 0.5).slice(0, 2);
    }
    const r = this.rumors.add({
      text: hearsay(text), tag: makeTag(text, about.map((e) => e.name)), about: about.map((e) => e.id), sentiment: guessSentiment(text),
      knownBy: targets.map((a) => a.id), origin: 'player', born: this.meta.minutes, heat: 28, kind: 'event',
    });
    if (r) {
      for (const t of targets) this.log(t, 'event', `어디선가 이런 소문을 들었다: "${r.text}"`);
      this.checkTopRumor();
    }
    return r;
  },
  hearRumor(this: World, l: Agent, r: Rumor, from: Agent) {
    this.rumors.tell(r, l.id, this.meta.minutes);
    // a confided crush reaches one of the two people it's about
    if (r.secretOf && r.about.includes(l.id)) return this.secretArrives(l, r, from);
    for (const id of r.about) {
      if (id === l.id) {
        this.addThought(l, `rumor:${r.id}`, r.sentiment >= 0 ? '내 좋은 소문이 돌고 있다' : '나에 대한 안 좋은 소문을 들음', r.sentiment >= 0 ? 4 : -7, 240);
        this.log(l, 'diary', r.sentiment >= 0 ? `내 소문이 돌고 있단다. "${r.text}" …조금 쑥스럽다.` : `나에 대한 이상한 소문을 들었다. "${r.text}" 누가 퍼뜨린 거지?`);
        continue;
      }
      const subj = this.agent(id);
      if (!subj) continue;
      this.addFeel(l.id, subj.id, r.sentiment * 5); // only the listener's view changes
      // hearing someone is struggling: caring Wills go and check on them
      if (r.kind === 'struggle' && l.persona.kind > 0.2 && subj.kind === 'person' && Math.random() < 0.5) {
        l.ai.meetWith = subj.id;
        l.ai.meetForced = false;
        l.ai.timer = 40;
        this.log(l, 'diary', `${josa(subj.name, '이/가')} 힘들어 보인다는 얘기를 들었다. 한번 가 봐야겠다.`, subj.id);
      }
    }
    // not everyone enjoys bad news about others — and nobody likes the one who brings bad news about them
    if (r.sentiment < 0 && !r.about.includes(l.id) && (l.persona.kind > 0.3 || l.traits.some((t) => /(험담|뒷담|남 얘기)/.test(t)))) {
      this.addFeel(l.id, from.id, -2);
      this.addThought(l, 'gossip-uneasy', '남 얘기를 듣는 게 불편했다', -2, 90);
    }
    if (r.sentiment < 0 && r.about.includes(l.id)) this.addFeel(l.id, from.id, -4);
    if (r.kind === 'romance') this.romanceNews(l, r);
    if (Math.random() < 0.3) this.log(l, 'event', `${from.name}에게서 소문을 들었다: "${r.text}"`, from.id);
    this.checkTopRumor();
  },
  checkTopRumor(this: World) {
    let top: Rumor | undefined;
    for (const r of this.rumors.rumors) if (!top || r.heat > top.heat) top = r;
    if (top && top.id !== this.topRumorId && top.heat >= 25) {
      this.topRumorId = top.id;
      this.pushFeed({ kind: 'rumor', text: `🔥 실시간 트렌드 1위 ${top.tag} — "${top.text}"` });
    }
  },
  /** Several sentences from traits, treasure, dream and current mood. */
  composeMonologue(this: World, a: Agent, listener?: Agent): string {
    const out: string[] = [];
    out.push(listener ? pick(['있잖아요, 이건 아무한테나 안 하는 얘긴데요.', '갑자기 이런 얘기 해서 미안한데요…', '요즘 이런저런 생각이 많아요.']) : pick(['가끔은 이런 생각을 한다.', '아무도 없을 때면 꼭 이런 생각이 든다.']));
    const neutral = a.traits.filter((t) => traitPolarity(t) === 0 && !extractDream(t));
    const heavy = neutral.filter((t) => /(요즘|최근|얼마 전|계속|매일|혼자|고향|그리워)/.test(t));
    const backstory = Math.random() < 0.7 && heavy.length ? pick(heavy) : neutral.length ? pick(neutral) : undefined;
    if (backstory) out.push(listener ? `사실 저 ${toGeodeunyo(backstory)}.` : `사실 나는 ${backstory.replace(/다$/, '다.').replace(/\.\.$/, '.')}`);
    if (a.mood <= 30) out.push(listener ? '괜찮은 척하는 것도 요즘은 좀 지쳐요.' : '괜찮은 척하는 것도 이제 좀 지친다.');
    else if (a.mood >= 75) out.push(listener ? '그래도 요즘은 하루하루가 꽤 괜찮아요.' : '그래도 요즘은 하루하루가 꽤 괜찮다.');
    if (a.treasure && Math.random() < 0.7) out.push(listener ? `이 ${josa(a.treasure, '을/를')} 보면 ${pick(['처음 이 동네에 왔을 때가 생각나요', '힘들 때마다 조금은 버틸 수 있었어요', '누군가가 떠올라요'])}.` : `${josa(a.treasure, '을/를')} 만지작거리면 ${pick(['처음 이 동네에 왔을 때가 떠오른다', '조금은 버틸 수 있을 것 같다'])}.`);
    const likes = a.traits.map((t) => (traitPolarity(t) > 0 ? extractObject(t) : null)).filter(Boolean) as string[];
    const like = likes.length ? pick(likes) : null;
    const friend = this.agents
      .filter((o) => o !== a && o.kind === 'person' && this.feel(a.id, o.id) >= 50)
      .sort((x, y) => this.feel(a.id, y.id) - this.feel(a.id, x.id))[0];
    if (friend && friend !== listener && Math.random() < 0.4) out.push(listener ? `${josa(friend.name, '이/가')} 없었으면 어떻게 버텼을까 싶어요.` : `${josa(friend.name, '이/가')} 있어서 다행이다.`);
    else if (friend && friend === listener && Math.random() < 0.6) out.push(`요즘 ${josa(this.referName(a, listener), '이랑/랑')} 얘기하는 시간이 제일 좋아요.`);
    const but = a.mood >= 75 ? '' : '그래도 ';
    if (like && Math.random() < 0.8) out.push(listener ? pick([`${but}${like} 생각을 하면 조금 괜찮아져요.`, `${like}만 있으면 뭐든 버틸 수 있을 것 같아요.`]) : `${but}${like} 생각을 하면 조금 괜찮아진다.`);
    const dream = a.traits.map(extractDream).find(Boolean);
    if (dream) out.push(listener ? `언젠가 ${dream}… 그게 제 꿈이에요.` : `언젠가 ${dream}. 그날까지는 버텨 보자.`);
    const grp = this.factionsOf(a.id)[0];
    if (grp && Math.random() < 0.35) out.push(listener ? `요즘은 ${grp.name} 사람들 덕분에 덜 외로워요.` : `${grp.name} 사람들이 있어서 다행이다.`);
    if (listener) {
      const nm = this.referName(a, listener);
      out.push(pick(['…들어줘서 고마워요.', `이런 얘기, ${nm}${/씨$/.test(nm) ? '라서' : copula(nm).endsWith('이다') ? '이라서' : '라서'} 하는 거예요.`, '우리 앞으로도 잘 지내요.']));
    }
    return out.join(' ');
  },
};
