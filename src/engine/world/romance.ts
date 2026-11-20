// World · 연애 — 고백 · 연인 · 데이트 · 이별
// These are methods of the World class kept in their own file. They are installed on
// World.prototype at the end of World.ts, so callers keep writing world.someMethod() as before.

import { type Rumor } from '../rumors';
import { josa } from '../traits';
import { type Agent, type Place } from '../types';
import { pick } from '../util';
import { type Relation, World } from '../World';

export const romanceMethods = {
  // ───────────────────────── romance ─────────────────────────
  loverOf(this: World, a: Agent): Agent | undefined {
    for (const r of this.relations.values()) if (r.status === 'lovers' && (r.a === a.id || r.b === a.id)) return this.agent(r.a === a.id ? r.b : r.a);
    return undefined;
  },
  /** after a warm 1:1 talk, whoever is smitten may confess — and it usually doesn't work out */
  maybeConfess(this: World, p: Agent, q: Agent) {
    const [x, y] = this.feel(p.id, q.id) >= this.feel(q.id, p.id) ? [p, q] : [q, p];
    if (x.kind !== 'person' || y.kind !== 'person') return;
    const r = this.relation(x.id, y.id);
    if (r.status === 'lovers' || this.feel(x.id, y.id) < 75 || this.loverOf(x)) return;
    if (r.confessedAt !== undefined && this.meta.minutes - r.confessedAt < 3 * 1440) return;
    if (Math.random() > 0.3) return;
    r.confessedAt = this.meta.minutes;
    const theirs = this.feel(y.id, x.id);
    const taken = !!this.loverOf(y);
    const p_ = taken ? 0.02 : theirs >= 85 ? 0.75 : theirs >= 70 ? 0.35 : theirs >= 55 ? 0.12 : 0.03;
    this.say(x, `${this.callName(x, y)}, 사실… 좋아해요. 저랑 사귈래요?`, { to: y });
    this.emote(x, '💗');
    if (Math.random() < p_) {
      r.status = 'lovers';
      r.since = this.meta.minutes;
      this.say(y, pick(['…저도요. 좋아요.', '사실 저도 같은 마음이었어요.', '…네. 잘 부탁해요.']), { to: x });
      this.emote(y, '💕');
      this.pushFeed({ kind: 'romance', speakerId: x.id, text: `💘 ${x.name}의 고백을 ${josa(y.name, '이/가')} 받아들였다. 두 사람은 이제 연인이다!` });
      this.addThought(x, 'love', '고백이 받아들여졌다!', 14, 1440);
      this.addThought(y, 'love', '연인이 생겼다', 10, 1440);
      this.addFeel(x.id, y.id, 6);
      this.addFeel(y.id, x.id, 8);
      r.memories.push({ t: this.meta.minutes, text: `${josa(x.name, '이/가')} 고백했고, ${josa(y.name, '이/가')} 받아들였다. 연인이 되었다.` });
      this.log(x, 'diary', `${y.name}에게 고백했다. …받아 줬다. 오늘을 평생 못 잊을 것 같다.`, y.id);
      this.log(y, 'diary', `${josa(x.name, '이/가')} 고백했다. 심장이 아직도 두근거린다.`, x.id);
      this.naturalRumor(`${josa(x.name, '이랑/랑')} ${y.name}, 사귄대`, [x, y], x, 0.6, 'romance', 16);
    } else {
      this.say(y, pick(['미안해요… 좋은 친구로 지내고 싶어요.', '고마워요. 그런데… 아직은 잘 모르겠어요.', '…미안해요.']), { to: x });
      this.emote(x, '💔');
      this.pushFeed({ kind: 'romance', speakerId: x.id, text: `💔 ${josa(x.name, '이/가')} ${y.name}에게 고백했지만, 마음이 닿지 않았다.` });
      this.addThought(x, 'heartbreak', '고백했다가 차였다', -12, 720);
      this.addThought(y, 'turned-down', '고백을 거절해서 마음이 무겁다', -3, 240);
      this.addFeel(x.id, y.id, -6); // a little awkward now
      this.addFeel(y.id, x.id, -2);
      r.memories.push({ t: this.meta.minutes, text: `${josa(x.name, '이/가')} 고백했지만 ${josa(y.name, '이/가')} 거절했다.` });
      this.log(x, 'diary', `${y.name}에게 고백했다. 안 된대. …괜찮은 척하는 중.`, y.id);
      this.naturalRumor(`${josa(x.name, '이/가')} ${y.name}한테 고백했다가 차였대`, [x, y], x, -0.2, 'gossip', 12);
    }
  },
  /** both head to a place they'd both enjoy */
  planDate(this: World, a: Agent, b: Agent): boolean {
    const spots = this.places.filter((p) => ['cafe', 'cinema', 'restaurant', 'park', 'bar', 'plaza', 'karaoke', 'bakery'].includes(p.style) && this.openAt(p));
    const p = spots.sort((x, y) => this.favor(a, y) + this.favor(b, y) - this.favor(a, x) - this.favor(b, x) + (Math.random() - 0.5) * 0.4)[0];
    if (!p) return false;
    for (const [m, o] of [[a, b], [b, a]] as const) {
      this.addThought(m, 'date-today', `${josa(o.name, '와/과')} 데이트 약속`, 5, 360);
      m.ai.dateWith = o.id;
      this.goVisit(m, p);
    }
    return true;
  },
  dateMoment(this: World, a: Agent, p: Place) {
    const b = this.agent(a.ai.dateWith);
    a.ai.dateWith = undefined;
    if (!b) return;
    const r = this.relation(a.id, b.id);
    const day = Math.floor(this.meta.minutes / 1440);
    if (r.status !== 'lovers' || r.lastDate === day) return;
    r.lastDate = day;
    this.pushFeed({ kind: 'romance', speakerId: a.id, text: `💕 ${josa(a.name, '와/과')} ${josa(b.name, '이/가')} ${p.name}에서 데이트 중` });
    for (const [m, o] of [[a, b], [b, a]] as const) {
      this.addThought(m, 'date', `${josa(o.name, '와/과')} 데이트를 했다`, 8, 480);
      this.addFeel(m.id, o.id, 4);
      this.emote(m, '💕');
    }
    r.memories.push({ t: this.meta.minutes, text: `${p.name}에서 데이트를 했다.` });
    this.log(a, 'diary', `${josa(b.name, '와/과')} ${p.name}에 갔다. 시간이 너무 빨리 갔다.`, b.id);
    this.log(p, 'event', `${josa(a.name, '와/과')} ${josa(b.name, '이/가')} 데이트하러 왔다.`);
    this.naturalRumor(`${josa(a.name, '이랑/랑')} ${josa(b.name, '이/가')} ${p.name}에서 데이트하더래`, [a, b], a, 0.5, 'romance', 10);
  },
  /** someone hears about a couple: a crush turns into jealousy, friends cheer */
  romanceNews(this: World, l: Agent, r: Rumor) {
    const [x, y] = r.about.map((id) => this.agent(id));
    if (!x || !y || l === x || l === y || r.sentiment <= 0) return;
    for (const [m, o] of [[x, y], [y, x]] as const) {
      if (this.feel(l.id, m.id) >= 65 && this.addThought(l, `jealous:${m.id}`, `${josa(m.name, '이/가')} ${o.name}랑… 마음이 복잡하다`, -7, 720)) {
        this.addFeel(l.id, o.id, -8);
        this.log(l, 'diary', `${josa(m.name, '이/가')} ${o.name}랑 사귄다고 한다. …아무렇지 않은 척해야지.`, m.id);
        this.say(l, `(${m.name}… 그렇구나.)`, { thought: true });
        return;
      }
    }
    if ((this.feel(l.id, x.id) >= 35 || this.feel(l.id, y.id) >= 35) && this.addThought(l, `cheer:${x.id}`, '친구의 연애를 응원한다', 3, 360)) {
      this.addFeel(l.id, x.id, 2);
      this.addFeel(l.id, y.id, 2);
    }
  },
  breakUp(this: World, r: Relation) {
    const a = this.agent(r.a), b = this.agent(r.b);
    r.status = 'ex';
    if (!a || !b) return;
    this.pushFeed({ kind: 'romance', speakerId: a.id, text: `💔 ${josa(a.name, '와/과')} ${josa(b.name, '이/가')} 헤어졌다.` });
    for (const [m, o] of [[a, b], [b, a]] as const) {
      this.addThought(m, 'breakup', `${josa(o.name, '와/과')} 헤어졌다`, -10, 1440);
      this.log(m, 'diary', `${josa(o.name, '와/과')} 헤어졌다. 이렇게 끝날 줄은 몰랐다.`, o.id);
    }
    r.memories.push({ t: this.meta.minutes, text: '헤어졌다.' });
    this.naturalRumor(`${josa(a.name, '이랑/랑')} ${b.name}, 헤어졌대`, [a, b], a, -0.3, 'romance', 14);
  },
};
