// World · 의뢰 · 목표 · 작은 사건 · 입양 · 이사 · 말 걸기
// These are methods of the World class kept in their own file. They are installed on
// World.prototype at the end of World.ts, so callers keep writing world.someMethod() as before.

import { questId, type Quest } from '../quests';
import { TILE } from '../TileMap';
import { extractDream, extractObject, josa, suffix, traitPolarity } from '../traits';
import { type Agent, type PlaceStyle } from '../types';
import { hashString, pick } from '../util';
import { givenName, JOB_WORDS, STYLE_LABEL, World } from '../World';

export const questsMethods = {
  person(this: World, id?: string) {
    const a = this.agent(id);
    return a && a.kind === 'person' ? a : undefined;
  },
  avgMood(this: World) {
    const ps = this.agents.filter((a) => a.kind === 'person');
    return ps.length ? ps.reduce((s, a) => s + a.mood, 0) / ps.length : 0;
  },
  loverCount(this: World) {
    let n = 0;
    for (const r of this.relations.values()) if (r.status === 'lovers') n++;
    return n;
  },
  checkQuest(this: World, q: Quest): boolean | null {
    const c = q.check;
    const now = this.meta.minutes;
    switch (c.type) {
      case 'placeStyle':
        return this.places.some((p) => p.style === c.style);
      case 'feelBoth':
        if (!this.agent(c.a) || !this.agent(c.b)) return null;
        return this.feel(c.a, c.b) >= c.value && this.feel(c.b, c.a) >= c.value;
      case 'confessOrLovers': {
        if (!this.agent(c.a) || !this.agent(c.b)) return null;
        const r = this.peekRelation(c.a, c.b);
        return r?.status === 'lovers' || (r?.confessedAt ?? -1e9) >= c.since;
      }
      case 'friend':
        if (!this.agent(c.a)) return null;
        return this.agents.some((o) => o.kind === 'person' && o.id !== c.a && this.feel(c.a, o.id) >= c.value && this.feel(o.id, c.a) >= c.value * 0.6);
      case 'ownsPet':
        if (!this.agent(c.a)) return null;
        return this.agents.some((x) => x.ownerId === c.a);
      case 'mood': {
        const a = this.agent(c.a);
        return a ? a.mood >= c.value : null;
      }
      case 'avgMoodHold':
        if (this.avgMood() >= c.value) {
          c.heldSince ??= now;
          return now - c.heldSince >= c.minutes;
        }
        c.heldSince = undefined;
        return false;
      case 'groups':
        return this.factions.length >= c.n;
      case 'lovers':
        return this.loverCount() >= c.n;
      case 'population':
        return this.agents.filter((a) => a.kind === 'person').length >= c.n;
      case 'event':
        return this.eventLog.some((e) => e.kind === c.event && e.t >= c.since && (!c.target || e.target === c.target));
      case 'weather':
        return this.meta.weather === c.weather;
    }
  },
  /** a 0..1 progress hint for the goal list */
  questProgress(this: World, q: Quest): number | null {
    const c = q.check;
    if (c.type === 'avgMoodHold') return c.heldSince === undefined ? Math.min(0.99, this.avgMood() / c.value) * 0.5 : 0.5 + Math.min(0.5, ((this.meta.minutes - c.heldSince) / c.minutes) * 0.5);
    if (c.type === 'population') return Math.min(1, this.agents.filter((a) => a.kind === 'person').length / c.n);
    if (c.type === 'feelBoth') return Math.max(0, Math.min(1, (Math.min(this.feel(c.a, c.b), this.feel(c.b, c.a)) + 50) / (c.value + 50)));
    if (c.type === 'mood') return Math.min(1, (this.agent(c.a)?.mood ?? 0) / c.value);
    return null;
  },
  acceptQuest(this: World, id: string) {
    const q = this.quests.find((x) => x.id === id);
    if (!q || q.status !== 'offered') return;
    q.status = 'active';
    q.expiresAt = this.meta.minutes + 2 * 1440;
    if (q.check.type === 'confessOrLovers') q.check.since = this.meta.minutes;
    const a = this.person(q.from);
    if (a) {
      this.addThought(a, `asked:${q.id}`, '부탁을 들어준대!', 4, 600);
      this.say(a, pick(['(정말요? 고마워요!)', '(들어주는구나… 다행이다.)']), { thought: true });
    }
    this.pushFeed({ kind: 'event', speakerId: q.from, text: `📮 「${q.title}」 의뢰를 맡았어요.` });
  },
  declineQuest(this: World, id: string) {
    const q = this.quests.find((x) => x.id === id);
    if (!q || q.status !== 'offered') return;
    q.status = 'declined';
    const a = this.person(q.from);
    if (a) this.addThought(a, `declined:${q.id}`, '부탁이 거절됐다', -2, 360);
  },
  completeQuest(this: World, q: Quest) {
    q.status = 'done';
    this.questsDone++;
    const a = this.person(q.from);
    if (q.kind === 'request' && a) {
      this.addThought(a, `wish-granted:${q.id}`, '바라던 일이 이루어졌다', 12, 720);
      this.say(a, pick(['정말 고마워요! 꿈만 같아요.', '이렇게 될 줄은 몰랐어요… 고마워요!', '최고예요, 진짜로!']));
      this.emote(a, '💖');
      this.log(a, 'diary', `「${q.title}」 — 바라던 일이 정말 이루어졌다. 누군가 내 마음을 알아준 것 같다.`);
      this.pushFeed({ kind: 'care', speakerId: a.id, text: `🎉 의뢰 완료! ${a.name}: 「정말 고마워요!」 — ${q.title}` });
    } else if (q.kind === 'goal') {
      this.pushFeed({ kind: 'care', text: `🏆 동네 목표 달성: ${q.title}` });
      for (const p of this.awakePeople()) this.addThought(p, 'town-goal', '요즘 동네 분위기가 참 좋다', 4, 480);
    } else {
      if (a) this.addThought(a, `moment:${q.id}`, '오늘 운이 좋았다', 5, 360);
      this.pushFeed({ kind: 'care', speakerId: q.from, text: `✨ ${q.title} — 잘 해결됐어요.` });
    }
  },
  failQuest(this: World, q: Quest) {
    q.status = 'failed';
    const a = this.person(q.from);
    if (q.kind === 'request' && a) {
      this.addThought(a, `quest-fail:${q.id}`, '기다렸는데… 결국 안 됐다', -3, 480);
      this.pushFeed({ kind: 'event', speakerId: a.id, text: `⌛ ${a.name}의 의뢰 「${q.title}」 기한이 지났어요.` });
    }
  },
  addQuest(this: World, q: Omit<Quest, 'id' | 'createdAt' | 'status'> & { status?: Quest['status'] }) {
    const full: Quest = { ...q, id: questId(), createdAt: this.meta.minutes, status: q.status ?? 'offered' };
    this.quests.push(full);
    this.recentQuestKeys.push({ key: q.key, t: this.meta.minutes });
    return full;
  },
  recentlyAsked(this: World, key: string) {
    return this.recentQuestKeys.some((k) => k.key === key && this.meta.minutes - k.t < 2 * 1440);
  },
  /** A Will asks for something that grows out of their own situation. */
  offerRequest(this: World) {
    const busy = new Set(this.quests.filter((q) => q.status === 'offered' || q.status === 'active').map((q) => q.from));
    const now = this.meta.minutes;
    const options: Omit<Quest, 'id' | 'createdAt' | 'status'>[] = [];
    for (const a of this.awakePeople()) {
      if (busy.has(a.id)) continue;
      const wish = this.missingWish(a);
      if (wish && wish.key !== 'dream') {
        const style = wish.key as PlaceStyle;
        const name = STYLE_LABEL[style];
        options.push({ kind: 'request', from: a.id, icon: '🏗️', key: `wish:${a.id}:${style}`, title: `${josa(name, '을/를')} 지어 주세요`, text: `${name}${suffix(name, '이/가')} 있으면 정말 좋겠어요. 하나만 지어 주실 수 있을까요?`, check: { type: 'placeStyle', style }, action: { label: `🏗️ ${name} 짓기`, cmd: { type: 'SPAWN_ENTITY', entity: { kind: 'place', style } } }, expiresAt: now + 360 });
      } else if (wish?.key === 'dream') {
        const style = (Object.keys(JOB_WORDS) as PlaceStyle[]).map((s) => ({ s, v: this.matcher.similarity(a.job, JOB_WORDS[s]!) })).sort((x, y) => y.v - x.v)[0];
        if (style && style.v >= 0.35) options.push({ kind: 'request', from: a.id, icon: '💭', key: `dream:${a.id}`, title: `${STYLE_LABEL[style.s]}에서 일하고 싶어요`, text: `언젠가 ${a.job} 일을 해 보고 싶어요. 그럴 만한 곳이 생기면 좋겠어요.`, check: { type: 'placeStyle', style: style.s }, action: { label: `🏗️ ${STYLE_LABEL[style.s]} 짓기`, cmd: { type: 'SPAWN_ENTITY', entity: { kind: 'place', style: style.s } } }, expiresAt: now + 360 });
      }
      const rival = this.agents.find((b) => b.kind === 'person' && b !== a && this.feel(a.id, b.id) <= -15 && (a.persona.kind >= 0 || (this.peekRelation(a.id, b.id)?.chats ?? 0) >= 2));
      if (rival) options.push({ kind: 'request', from: a.id, icon: '🤝', key: `repair:${a.id}:${rival.id}`, title: `${josa(rival.name, '와/과')} 화해하고 싶어요`, text: `${josa(rival.name, '이랑/랑')} 사이가 틀어졌어요… 다시 잘 지내고 싶어요. 둘이 만날 기회를 만들어 주실래요?`, check: { type: 'feelBoth', a: a.id, b: rival.id, value: 5 }, action: { label: '👣 둘이 만나게 하기', cmd: { type: 'TRIGGER_EVENT', event: 'MEET', targets: [{ id: a.id }, { id: rival.id }] } }, expiresAt: now + 360 });
      const crush = this.agents.find((b) => b.kind === 'person' && b !== a && this.feel(a.id, b.id) >= 62 && this.peekRelation(a.id, b.id)?.status !== 'lovers' && !this.loverOf(a));
      if (crush) options.push({ kind: 'request', from: a.id, icon: '💌', key: `crush:${a.id}:${crush.id}`, title: `${crush.name}에게 마음을 전하고 싶어요`, text: `사실 ${josa(crush.name, '을/를')} 좋아해요… 용기를 낼 수 있게 둘만 있을 기회를 만들어 주세요.`, check: { type: 'confessOrLovers', a: a.id, b: crush.id, since: now }, action: { label: '👣 둘이 만나게 하기', cmd: { type: 'TRIGGER_EVENT', event: 'MEET', targets: [{ id: a.id }, { id: crush.id }] } }, expiresAt: now + 360 });
      const needs = this.needsOf(a);
      const hasFriend = this.agents.some((o) => o.kind === 'person' && o !== a && this.feel(a.id, o.id) >= 40);
      if (needs.social < 35 && !hasFriend) options.push({ kind: 'request', from: a.id, icon: '🫂', key: `lonely:${a.id}`, title: '친구가 생기면 좋겠어요', text: '요즘 너무 외로워요. 마음 맞는 친구가 한 명이라도 있으면 좋겠어요.', check: { type: 'friend', a: a.id, value: 40 }, expiresAt: now + 360 });
      const petLove = a.traits.find((t) => traitPolarity(t) > 0 && /(고양이|강아지|개를|토끼|햄스터|고슴도치|새를|오리|동물)/.test(t));
      if (petLove && !this.agents.some((x) => x.ownerId === a.id) && this.place(a.homeId)) {
        const stray = this.agents.filter((x) => x.kind === 'animal' && !x.ownerId).sort((x, y) => this.favor(a, y) - this.favor(a, x))[0];
        const sp = petLove.match(/(고양이|강아지|토끼|햄스터|고슴도치|오리)/)?.[1] ?? '반려동물';
        options.push({ kind: 'request', from: a.id, icon: '🐾', key: `pet:${a.id}`, title: `${josa(sp, '을/를')} 키우고 싶어요`, text: `${josa(sp, '을/를')} 키우고 싶어요… 집에 돌아오면 반겨 주는 친구가 있으면 좋겠어요.`, check: { type: 'ownsPet', a: a.id },
          action: stray && this.favor(a, stray) >= 0.4 ? { label: `🐾 ${josa(stray.name, '을/를')} 입양 보내기`, cmd: { type: 'SYSTEM', action: 'ADOPT', value: stray.id, target: { id: a.id } } } : { label: `🐾 ${sp} 소환하기`, cmd: { type: 'SPAWN_ENTITY', entity: { kind: 'animal', category: sp }, at: { near: { id: a.id } } } }, expiresAt: now + 360 });
      }
    }
    const fresh = options.filter((o) => !this.recentlyAsked(o.key));
    if (!fresh.length) return;
    const q = this.addQuest(pick(fresh));
    const a = this.person(q.from);
    if (a) {
      this.say(a, pick(['(누가 내 부탁 좀 들어줬으면…)', '(부탁하면 들어줄까…?)']), { thought: true });
      this.pushFeed({ kind: 'event', speakerId: a.id, text: `📮 ${a.name}의 의뢰: ${q.title}` });
    }
    this.lastRequestAt = this.meta.minutes;
  },
  /** A town-wide goal: always achievable from where the town is now. */
  offerGoal(this: World) {
    const now = this.meta.minutes;
    const people = this.agents.filter((a) => a.kind === 'person').length;
    const wants = new Map<PlaceStyle, number>();
    for (const a of this.agents) if (a.kind === 'person') { const w = this.missingWish(a); if (w && w.key !== 'dream') wants.set(w.key as PlaceStyle, (wants.get(w.key as PlaceStyle) ?? 0) + 1); }
    const topWant = [...wants].sort((x, y) => y[1] - x[1])[0];
    const all: (Omit<Quest, 'id' | 'createdAt' | 'status'> | null)[] = [
      this.avgMood() < 65 && people >= 2 ? { kind: 'goal', icon: '😊', key: 'goal:mood', title: '모두의 기분을 65 이상으로 2시간 지키기', text: '마을 모두가 웃는 날을 만들어 보세요. 좋아하는 것을 가까이 두거나, 축제를 열거나…', check: { type: 'avgMoodHold', value: 65, minutes: 120 }, expiresAt: now + 5 * 1440 } : null,
      people >= 4 ? { kind: 'goal', icon: '🎌', key: `goal:group${this.factions.length + 1}`, title: '새 그룹이 생기게 하기', text: '마음이 맞는 윌 넷 이상이 자주 어울리면 모임이 생겨요. 취향이 비슷한 윌을 만나게 해 보세요.', check: { type: 'groups', n: this.factions.length + 1 }, expiresAt: now + 5 * 1440 } : null,
      people >= 2 ? { kind: 'goal', icon: '💘', key: `goal:lovers${this.loverCount() + 1}`, title: '연인 한 쌍 탄생시키기', text: '서로 좋아하는 두 윌에게 함께할 시간을 만들어 주세요. 고백은 쉽게 받아들여지지 않아요!', check: { type: 'lovers', n: this.loverCount() + 1 }, expiresAt: now + 5 * 1440 } : null,
      this.migration ? { kind: 'goal', icon: '🧳', key: `goal:pop${people + 2}`, title: `주민 ${people + 2}명 되기`, text: '동네 분위기가 좋으면 새 윌이 이사 와요. 물론 직접 불러도 돼요.', check: { type: 'population', n: people + 2 }, expiresAt: now + 5 * 1440 } : null,
      topWant ? { kind: 'goal', icon: '🏗️', key: `goal:build:${topWant[0]}`, title: `주민들이 바라는 ${josa(STYLE_LABEL[topWant[0]], '을/를')} 짓기`, text: `${topWant[1]}명이 ${STYLE_LABEL[topWant[0]]}${suffix(STYLE_LABEL[topWant[0]], '이/가')} 있었으면 해요.`, check: { type: 'placeStyle', style: topWant[0] }, expiresAt: now + 5 * 1440 } : null,
      { kind: 'goal', icon: '🎉', key: `goal:festival:${Math.floor(now / 1440)}`, title: '동네 축제 열기', text: '광장이나 공원에서 축제를 열어 모두 모이게 해 보세요. (🎪 사건 창 또는 「광장에서 축제 열어 줘」)', check: { type: 'event', event: 'FESTIVAL', since: now }, action: { label: '🎉 축제 열기', cmd: { type: 'WORLD_EVENT', event: 'FESTIVAL' } }, expiresAt: now + 2 * 1440 },
    ];
    const options = all.filter((o): o is NonNullable<typeof o> => !!o && !this.recentlyAsked(o.key) && !this.checkQuest({ ...o, id: '', createdAt: now, status: 'active' } as Quest));
    if (!options.length) return;
    const q = options[this.goalCursor++ % options.length];
    this.addQuest({ ...q, status: 'active' });
    this.pushFeed({ kind: 'event', text: `🎯 새 동네 목표: ${q.title}` });
  },
  /** A small, short-lived moment the player can answer with one click. */
  offerMoment(this: World) {
    const now = this.meta.minutes;
    const people = this.awakePeople();
    if (!people.length) return;
    const options: Omit<Quest, 'id' | 'createdAt' | 'status'>[] = [];
    const sad = people.filter((a) => a.mood < 32).sort((x, y) => x.mood - y.mood)[0];
    if ((this.meta.weather === 'rain' || this.meta.weather === 'storm') && people.length) {
      const who = people.find((a) => a.traits.some((t) => /비/.test(t) && traitPolarity(t) < 0)) ?? sad ?? pick(people);
      options.push({ kind: 'moment', from: who.id, icon: '🌧️', key: `moment:rain:${who.id}`, title: `비 때문에 ${josa(who.name, '이/가')} 시무룩해요`, text: '하늘을 맑게 개게 해 줄까요?', check: { type: 'weather', weather: 'clear' }, action: { label: '☀️ 맑게 하기', cmd: { type: 'SET_WEATHER', weather: 'clear' } }, expiresAt: now + 120 });
    }
    if (sad) options.push({ kind: 'moment', from: sad.id, icon: '💤', key: `moment:sad:${sad.id}`, title: `${josa(sad.name, '이/가')} 많이 지쳤어요`, text: '좋아하는 걸 근처에 두거나, 살짝 축복을 내려 줄 수도 있어요.', check: { type: 'mood', a: sad.id, value: 45 }, action: { label: '✨ 축복하기', cmd: { type: 'TRIGGER_EVENT', event: 'BLESS', targets: [{ id: sad.id }] } }, expiresAt: now + 240 });
    const singer = people.find((a) => a.traits.some((t) => /(노래|음악|기타|밴드|버스킹)/.test(t)));
    const day = this.hour() >= 9 && this.hour() < 20;
    if (singer && day) options.push({ kind: 'moment', from: singer.id, icon: '🎸', key: `moment:busk:${singer.id}`, title: `${josa(singer.name, '이/가')} 광장에서 노래하고 싶대요`, text: '작은 무대를 열어 줄까요? 사람들이 모이면 둘 사이도 가까워져요.', check: { type: 'event', event: 'BUSKING', since: now }, action: { label: '🎸 버스킹 열기', cmd: { type: 'WORLD_EVENT', event: 'BUSKING', target: { id: singer.id } } }, expiresAt: now + 180 });
    const bday = pick(people);
    if (day) options.push({ kind: 'moment', from: bday.id, icon: '🎂', key: `moment:bday:${bday.id}`, title: `오늘이 ${givenName(bday.name)}의 생일이래요!`, text: '친구들이 축하해 주면 정말 기뻐할 거예요.', check: { type: 'event', event: 'BIRTHDAY', since: now, target: bday.id }, action: { label: '🎂 생일 축하하기', cmd: { type: 'WORLD_EVENT', event: 'BIRTHDAY', target: { id: bday.id } } }, expiresAt: now + 240 });
    if (this.meta.weather === 'clear' && (this.hour() >= 21 || this.hour() < 4)) options.push({ kind: 'moment', icon: '🌠', key: `moment:meteor:${Math.floor(now / 1440)}`, title: '별이 유난히 잘 보이는 밤이에요', text: '유성우를 내려 줄까요? 깨어 있는 윌들이 소원을 빌 거예요.', check: { type: 'event', event: 'METEOR', since: now }, action: { label: '🌠 유성우', cmd: { type: 'WORLD_EVENT', event: 'METEOR' } }, expiresAt: now + 120 });
    if (this.meta.weather === 'clear' && day && Math.random() < 0.5) options.push({ kind: 'moment', icon: '🌈', key: `moment:rainbow:${Math.floor(now / 1440)}`, title: '하늘이 참 맑아요', text: '무지개를 띄우면 다들 하늘을 올려다볼 거예요.', check: { type: 'event', event: 'RAINBOW', since: now }, action: { label: '🌈 무지개', cmd: { type: 'WORLD_EVENT', event: 'RAINBOW' } }, expiresAt: now + 120 });
    const fresh = options.filter((o) => !this.recentlyAsked(o.key));
    if (!fresh.length) return;
    const q = this.addQuest({ ...pick(fresh), status: 'active' });
    this.pushFeed({ kind: 'event', speakerId: q.from, text: `${q.icon} ${q.title}` });
    this.lastMomentAt = now;
  },
  tickQuests(this: World) {
    const now = this.meta.minutes;
    for (const q of this.quests) {
      if (q.status === 'offered' && now > q.expiresAt) q.status = 'failed';
      if (q.status !== 'active') continue;
      const r = this.checkQuest(q);
      if (r === null) q.status = 'failed';
      else if (r) this.completeQuest(q);
      else if (now > q.expiresAt) this.failQuest(q);
    }
    if (this.questsPaused) return;
    const open = this.quests.filter((q) => q.status === 'offered' || q.status === 'active');
    if (!open.some((q) => q.kind === 'request') && now - this.lastRequestAt > 240 && Math.random() < 0.5) this.offerRequest();
    if (!open.some((q) => q.kind === 'goal')) this.offerGoal();
    if (!open.some((q) => q.kind === 'moment') && now - this.lastMomentAt > 300 && Math.random() < 0.35) this.offerMoment();
    // keep a short history
    const old = this.quests.filter((q) => q.status !== 'offered' && q.status !== 'active');
    if (old.length > 30) this.quests = this.quests.filter((q) => !old.slice(0, old.length - 30).includes(q));
    this.recentQuestKeys = this.recentQuestKeys.filter((k) => now - k.t < 2 * 1440);
    // pets: a Will who loves an animal they've bonded with may take it home
    for (const a of this.agents) {
      if (a.kind !== 'person' || a.ai.sleeping || !this.place(a.homeId) || this.agents.some((x) => x.ownerId === a.id)) continue;
      const near = this.grid.queryRadius(a.x, a.y, 120, this.tmp).find((x) => x.kind === 'animal' && !x.ownerId && this.feel(a.id, x.id) >= 30 && this.favor(a, x) >= 0.55);
      if (near && Math.random() < 0.12) this.adopt(a, near);
    }
    // once a day (in the morning): people move in and out
    const day = Math.floor(now / 1440);
    if (this.lastDay < 0) this.lastDay = day; // the first morning only starts the count
    else if (day !== this.lastDay && this.hour() >= 7) {
      this.lastDay = day;
      this.dailyTick();
    }
  },
  // ───────────────────────── pets (입양) ─────────────────────────
  adopt(this: World, owner: Agent, pet: Agent): { ok: boolean; message: string } {
    if (owner.kind !== 'person' || pet.kind !== 'animal') return { ok: false, message: '윌이 동물을 입양할 수 있어요.' };
    if (pet.ownerId) return { ok: false, message: `${josa(pet.name, '은/는')} 이미 가족이 있어요.` };
    pet.ownerId = owner.id;
    this.addFeel(owner.id, pet.id, 20);
    this.addFeel(pet.id, owner.id, 20);
    this.addThought(owner, 'adopted', `${josa(pet.name, '와/과')} 가족이 되었다`, 12, 1440);
    this.emote(owner, '💖');
    this.emote(pet, '❤️');
    this.say(owner, pick([`${josa(pet.name, '아/야')}, 오늘부터 우리 집에서 같이 살자!`, `${josa(givenName(pet.name), '아/야')}, 이제 넌 우리 가족이야.`]));
    this.log(owner, 'diary', `오늘 ${josa(pet.name, '을/를')} 집에 데려왔다. 집이 갑자기 따뜻해졌다.`, pet.id);
    this.log(pet, 'diary', `${owner.name}네 집에 살게 됐다. 밥이 맛있고 이불이 푹신하다.`, owner.id);
    this.relation(owner.id, pet.id).memories.push({ t: this.meta.minutes, text: `${josa(owner.name, '이/가')} ${josa(pet.name, '을/를')} 입양했다.` });
    this.pushFeed({ kind: 'care', speakerId: owner.id, text: `🐾 ${josa(owner.name, '이/가')} ${josa(pet.name, '을/를')} 입양했어요!` });
    this.naturalRumor(`${josa(owner.name, '이/가')} ${josa(pet.name, '을/를')} 키우기 시작했대`, [owner, pet], owner, 0.6, 'care', 10);
    return { ok: true, message: `🐾 ${josa(pet.name, '이/가')} ${owner.name}의 가족이 되었어요.` };
  },
  // ───────────────────────── moving in & out (이사) ─────────────────────────
  dailyTick(this: World) {
    const people = this.agents.filter((a) => a.kind === 'person');
    if (!people.length) return;
    // birthdays come round by themselves (every Will has one in each 14-day cycle)
    const today = Math.floor(this.meta.minutes / 1440);
    for (const a of people)
      if (this.birthdayIn(a) === 0 && this.lastBirthday.get(a.id) !== today) {
        this.lastBirthday.set(a.id, today);
        this.later(20 + Math.random() * 360, () => {
          if (this.agents.includes(a) && !a.ai.sleeping) this.happen('BIRTHDAY', a);
        });
      }
    for (const a of people) {
      a.lowDays = a.mood < 28 ? (a.lowDays ?? 0) + 1 : 0;
      if (!this.migration) continue;
      if (a.lowDays === 1) {
        this.addThought(a, 'thinking-leaving', '이 동네를 떠날까 고민 중', -2, 1440);
        this.log(a, 'diary', '요즘 이 동네에서 버티는 게 힘들다. 떠나야 할까.');
        this.say(a, '(여길 떠나야 할까…)', { thought: true });
        this.addQuest({ kind: 'moment', from: a.id, icon: '😟', key: `stay:${a.id}`, status: 'active', title: `${josa(a.name, '이/가')} 동네를 떠날까 고민해요`, text: `내일 아침까지 기분을 50 이상으로 올려 주면 남을 거예요. 좋아하는 것, 친구, 바람을 살펴보세요.`, check: { type: 'mood', a: a.id, value: 50 }, action: { label: `🎥 ${a.name}에게 가기`, cmd: { type: 'SYSTEM', action: 'FOLLOW', target: { id: a.id } } }, expiresAt: this.meta.minutes + 1440 });
        this.pushFeed({ kind: 'break', speakerId: a.id, text: `😟 ${josa(a.name, '이/가')} 동네를 떠날까 고민하고 있어요.` });
      } else if (a.lowDays >= 2 && people.length > 2) this.moveOut(a);
    }
    const avg = this.avgMood();
    const homesFree = this.places.some((p) => p.style === 'home' && this.residentsOf(p).length < 3) || this.map.roads;
    if (this.migration && avg >= 62 && people.length < 30 && homesFree && Math.random() < 0.6) this.moveIn();
  },
  /** days until this Will's next birthday (0 = today); a 14-day cycle fixed by who they are */
  birthdayIn(this: World, a: Agent): number {
    const day = Math.floor(this.meta.minutes / 1440);
    const b = hashString(a.id + a.name) % 14;
    return (b - (day % 14) + 14) % 14;
  },
  /** today is their birthday (it came round, or the player made it happen) */
  isBirthday(this: World, a: Agent) {
    return this.hasThought(a, 'birthday');
  },
  /** everyone close by notices and reacts (cheer, clap, a word or two) */
  nearbyReact(this: World, who: Agent, radiusTiles: number, react: (b: Agent) => void) {
    for (const b of this.agents) {
      if (b === who || b.kind !== 'person' || b.ai.sleeping) continue;
      if (Math.hypot(b.x - who.x, b.y - who.y) > radiusTiles * TILE) continue;
      react(b);
    }
  },
  moveOut(this: World, a: Agent) {
    const friends = this.agents.filter((o) => o.kind === 'person' && o !== a && this.feel(o.id, a.id) >= 30);
    this.say(a, pick(['…다들 잘 지내요.', '그동안 고마웠어요.', '언젠가 다시 올게요.']));
    for (const f of friends) {
      this.addThought(f, `missed:${a.id}`, `${josa(a.name, '이/가')} 떠나서 쓸쓸하다`, -6, 1440);
      this.log(f, 'diary', `${josa(a.name, '이/가')} 동네를 떠났다. 잘 지냈으면 좋겠다.`, a.id);
    }
    for (const x of this.agents) if (x.ownerId === a.id) x.ownerId = undefined;
    this.pushFeed({ kind: 'break', text: `👋 ${josa(a.name, '이/가')} 동네를 떠났어요… (오래 힘들어했어요)` });
    this.removeEntity(a.id);
  },
  moveIn(this: World) {
    const r = Math.floor((this.map.roadRows[0] + this.map.roadRows[1]) / 2);
    const fromLeft = Math.random() < 0.5;
    const x = (fromLeft ? 1.5 : this.map.w - 1.5) * TILE, y = (r + 0.5) * TILE;
    const t = this.map.nearestWalkable(Math.floor(x / TILE), Math.floor(y / TILE));
    const a = this.spawnRandomized({ kind: 'person' }, (t.tx + 0.5) * TILE, (t.ty + 0.5) * TILE);
    this.ensureHome(a);
    this.log(a, 'diary', '살기 좋은 동네라는 얘기를 듣고 이사 왔다. 잘 지낼 수 있겠지?');
    this.pushFeed({ kind: 'care', speakerId: a.id, text: `🧳 ${josa(a.name, '이/가')} 이사 왔어요 — "살기 좋은 동네라던데요!"` });
  },
  /**
   * The player speaks to a Will; the Will answers in character (storyteller, or a template built
   * from their state if no model is available). Being listened to warms them a little.
   */
  talkTo(this: World, a: Agent, text: string, done?: () => void) {
    const log = this.talks.get(a.id) ?? [];
    log.push({ who: 'me', text });
    this.talks.set(a.id, log.slice(-20));
    this.pushFeed({ kind: 'system', text: `🗣️ 나 → ${a.name}: "${text}"` });
    if (this.addThought(a, 'heard', '누군가 내 이야기를 들어 줬다', 4, 360) && /(힘내|괜찮|응원|고마|사랑|잘하고|멋져|최고)/.test(text)) this.addThought(a, 'cheered', '따뜻한 말을 들었다', 4, 360);
    this.emote(a, '💬');
    const draft = this.templateReply(a, text);
    const finish = (reply: string, ai: boolean) => {
      const l = this.talks.get(a.id) ?? [];
      l.push({ who: 'will', text: reply, ai });
      this.talks.set(a.id, l.slice(-20));
      const fi = this.say(a, reply, { kind: reply.length > 60 ? 'monologue' : 'line' });
      if (fi) {
        fi.to = '나';
        if (ai) fi.ai = true;
      }
      done?.();
    };
    const hook = World.storyHook;
    if (!hook || World.storyCapacity() === 0) return finish(draft, false);
    a.bubble = { text: '…', born: this.simTime, life: 60 };
    let settled = false;
    const once = (t: string, ai: boolean) => {
      if (settled) return;
      settled = true;
      if (a.bubble?.text === '…') a.bubble = undefined;
      finish(t, ai);
    };
    this.pendingPolish.push({ deadline: performance.now() + 25000 * World.polishPatience, fire: () => once(draft, false), done: () => settled });
    hook({ world: this, kind: 'reply', speaker: a, draft, topic: text, important: true, history: log.slice(-6).map((m) => ({ name: m.who === 'me' ? '나' : a.name, text: m.text })), apply: (t) => once(t, true), fail: () => once(draft, false) });
  },
  /** an in-character answer from the Will's own state (used when no model is around, and as the draft) */
  templateReply(this: World, a: Agent, text: string): string {
    const log = this.talks.get(a.id) ?? [];
    const mine = log.filter((m) => m.who === 'me');
    const prevAsk = mine.length >= 2 ? mine[mine.length - 2].text : undefined;
    const last = this.talkTopic.get(a.id);
    const set = (key: string, extra: { obj?: string; who?: string } = {}) => void this.talkTopic.set(a.id, { key, ...extra });
    // the same question twice in a row
    const again = prevAsk && prevAsk.replace(/[\s?!.]/g, '') === text.replace(/[\s?!.]/g, '') ? '아까도 물어봤잖아요, 하하. ' : '';
    // a follow-up to the last answer: "왜요?", "진짜요?", "더 얘기해 줘요"
    if (last && !again && /^(왜|어째서|무슨 일|진짜|정말|그래요|그래\?|어떻게|더 (얘기|말))|^(왜|어째서)[요?]*$/.test(text.trim())) {
      const th = this.thoughtsSorted(a);
      switch (last.key) {
        case 'mood': {
          const two = th.slice(0, 2).map((t) => t.label.replace(/[!.]$/, ''));
          if (two.length) return `${two.join('… 그리고 ')}. 그래서 그런 것 같아요.`;
          return '딱히 이유는 없어요. 그냥 그런 날이 있잖아요.';
        }
        case 'like':
          return last.obj ? `그냥 ${josa(last.obj, '을/를')} 생각만 해도 마음이 편해지거든요. 이상하죠?` : '말로 설명하긴 어려워요, 하하.';
        case 'friend': {
          const f = this.agent(last.who);
          const mem = f && this.peekRelation(a.id, f.id)?.memories.slice(-1)[0];
          return mem ? `${mem.text.replace(/다\.?$/, '어요.')} 그때부터 더 가까워졌어요.` : '같이 있으면 말이 잘 통해요. 억지로 웃을 필요가 없달까요.';
        }
        case 'dream':
          return '어릴 때부터 막연히 그랬어요. 지금도 가끔 상상해요.';
        case 'wish':
          return last.obj ? `${last.obj}… 그게 있으면 하루가 훨씬 나을 것 같아서요.` : '그냥 그런 게 있으면 좋겠다 싶었어요.';
        case 'person': {
          const p = this.agent(last.who);
          const mem = p && this.peekRelation(a.id, p.id)?.memories.slice(-1)[0];
          return mem ? `음… ${mem.text.replace(/다\.?$/, '어요.')}` : '아직 같이 보낸 시간이 많지 않아서요.';
        }
      }
    }
    // asking about another Will by name: what they think of them
    const named = this.agents.find((o) => o !== a && (text.includes(o.name) || (o.kind === 'person' && givenName(o.name).length >= 2 && text.includes(givenName(o.name)))));
    if (named && !/(에게|한테) /.test(text)) {
      set('person', { who: named.id });
      const f = this.feel(a.id, named.id);
      const nm = this.referName(a, named);
      const status = this.peekRelation(a.id, named.id)?.status;
      if (named.ownerId === a.id) return again + `${josa(named.name, '은/는')} 우리 집 가족이에요! 제일 소중해요.`;
      if (status === 'lovers') return again + `${nm}요? 헤헤… 제 연인이에요. 생각만 해도 웃음이 나요.`;
      if (status === 'ex') return again + `${nm}… 예전에 만났었죠. 지금은 그냥 잘 지냈으면 해요.`;
      if (f >= 60) return again + `${nm}요? 정말 좋아해요. 같이 있으면 편해요.`;
      if (f >= 25) return again + `${nm}… 좋은 사람이에요. 더 친해지고 싶어요.`;
      if (f > -10) return again + `${nm}요? 아직 잘 몰라요. 몇 번 얘기해 본 정도예요.`;
      if (f > -40) return again + `솔직히 ${nm}랑은 좀 어색해요…`;
      return again + `${nm} 얘기는… 별로 하고 싶지 않아요.`;
    }
    const reply = this.templateReplyBase(a, text, set);
    return again + reply;
  },
  templateReplyBase(this: World, a: Agent, text: string, set: (key: string, extra?: { obj?: string; who?: string }) => void): string {
    const top = this.thoughtsSorted(a)[0];
    const likes = a.traits.filter((t) => traitPolarity(t) > 0).map(extractObject).filter(Boolean) as string[];
    const friend = this.agents.filter((o) => o.kind === 'person' && o !== a).sort((x, y) => this.feel(a.id, y.id) - this.feel(a.id, x.id))[0];
    const wish = this.missingWish(a);
    const dream = a.traits.map(extractDream).find(Boolean);
    if (/(기분|어때|괜찮|요즘|지내)/.test(text)) set('mood');
    if (/(좋아|취미|뭐 해|즐겨)/.test(text) && !/(기분|어때|괜찮|요즘|지내)/.test(text)) set('like', { obj: likes[0] });
    if (/(친구|누구|사람)/.test(text)) set('friend', { who: friend?.id });
    if (/(꿈|하고 싶|되고 싶)/.test(text)) set('dream');
    if (/(필요|원해|바라|소원|부탁)/.test(text)) set('wish', { obj: wish?.label.replace(/[이가]? ?(있|생기)(으면|었으면).*$/, '') });
    if (/(기분|어때|괜찮|요즘|지내)/.test(text)) return a.mood >= 65 ? `요즘 꽤 좋아요!${top && top.value > 0 ? ` ${top.label.replace(/[!.]$/, '')}… 그래서 그런가 봐요.` : ''}` : a.mood >= 40 ? `그럭저럭 지내요.${top ? ` 요즘은 ${top.label.replace(/[!.]$/, '')}…` : ''}` : `솔직히 좀 힘들어요.${top && top.value < 0 ? ` ${top.label.replace(/[!.]$/, '')}…` : ''}`;
    if (/(좋아|취미|뭐 해|즐겨)/.test(text)) return likes.length ? `${josa(likes[0], '을/를')} 정말 좋아해요. 얘기만 해도 신나요!` : '음… 아직 잘 모르겠어요. 이것저것 해 보는 중이에요.';
    if (/(친구|누구|사람)/.test(text)) return friend && this.feel(a.id, friend.id) >= 30 ? `${this.referName(a, friend)}랑 제일 친해요. 같이 있으면 편해요.` : '아직 친한 사람이 별로 없어요… 조금 외로워요.';
    if (/(꿈|하고 싶|되고 싶)/.test(text)) return dream ? `언젠가 ${dream}… 그게 제 꿈이에요.` : a.job ? `언젠가 ${a.job} 일을 제대로 해 보고 싶어요.` : '꿈이요? 생각해 본 적이 별로 없네요.';
    if (/(필요|원해|바라|소원|부탁)/.test(text)) return wish ? `${wish.label.replace(/다$/, '어요')}.` : '지금은 이대로도 괜찮아요. 물어봐 줘서 고마워요.';
    if (/(힘내|응원|고마|사랑|멋져|최고)/.test(text)) return pick(['헤헤, 그런 말 들으니 힘이 나요!', '고마워요… 덕분에 오늘 하루 버틸 수 있겠어요.', '정말요? 갑자기 기분이 좋아졌어요.']);
    return pick([`음… ${a.mood >= 50 ? '그렇게 생각해 줘서 고마워요.' : '잘 모르겠어요. 요즘 생각이 많아서요.'}`, '그런 얘기는 처음 들어 봐요. 조금 더 얘기해 줄래요?', '하하, 재밌는 분이네요.']);
  },
};
