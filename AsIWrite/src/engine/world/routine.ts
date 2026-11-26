// World · 일과 — 일 · 집 · 잠 · 정신적 한계
// These are methods of the World class kept in their own file. They are installed on
// World.prototype at the end of World.ts, so callers keep writing world.someMethod() as before.

import { SAD_SONG, SIGH, NIGHT_SNACK, NIGHT_STARS, NIGHT_UP } from '../../presets/banter';
import { randomPlace } from '../../presets/traitPools';
import { DISLIKE_RE } from '../semantic';
import { parseSheet, type CharacterSheet } from '../sheet';
import { extractDream, extractObject, josa, traitPolarity } from '../traits';
import { type Agent, type BreakKind, type Place } from '../types';
import { hashString, pick, weekdayOf } from '../util';
import { innerFromThought, givenName, MIN_PER_SEC, JOB_WORDS, DEFAULT_ROLE, SHIFT_LEN_H, NIGHT_SHIFT_START, World } from '../World';

export const routineMethods = {
  // ───────────────────────── work ─────────────────────────
  /** Map free-text job → best workplace (or a random open one if allowed). */
  // ── work: the job in a Will's sheet is what they DREAM of doing (장래희망); actual work is freelance ──
  /** retired / travelling / "not working" Wills take no shifts */
  worksAtAll(this: World, a: Agent) {
    if (a.kind !== 'person' || a.workPin === 'none') return false;
    return !/(은퇴|백수|무직|여행자|방랑|퇴직|주부)/.test(a.job);
  },
  /** how well a workplace fits the Will's dream job (0..1) */
  dreamFit(this: World, a: Agent, p: Place) {
    return a.job ? Math.max(this.matcher.similarity(a.job, JOB_WORDS[p.style] ?? ''), this.matcher.similarity(a.job, DEFAULT_ROLE[p.style] ?? '')) : 0;
  },
  /**
   * Today's workplace. Pinned by the player → that one. Otherwise freelance: wherever there's a free
   * spot, preferring places close to their dream job, places they like, and (a little) where they
   * worked last time. Students go to school; only teachers work there otherwise.
   */
  chooseWorkplace(this: World, a: Agent): Place | undefined {
    if (a.workPin && a.workPin !== 'none') {
      const p = this.place(a.workPin);
      if (p) return p;
    }
    const student = /학생/.test(a.job);
    const teacher = /(선생|교사|강사)/.test(a.job);
    let best: Place | undefined;
    let bs = -Infinity;
    for (const p of this.places) {
      if (!p.workSpots.length || !JOB_WORDS[p.style] || !this.openAt(p)) continue;
      if (student !== (p.style === 'school') && !(teacher && p.style === 'school')) continue;
      const busy = this.agents.filter((x) => x !== a && x.ai.working && x.ai.targetPlaceId === p.id).length;
      if (busy >= p.workSpots.length) continue;
      // the dream job pulls, but freelancers wander — curious ones more often
      const s = this.dreamFit(a, p) * 0.9 + this.favor(a, p) * 0.8 + (p.id === a.jobId ? 0.1 : 0) - (this.aversion(a, p) > 0.5 ? 1 : 0) + Math.random() * (1 + Math.max(0, a.persona.curious) * 0.6);
      if (s > bs) (bs = s), (best = p);
    }
    return best;
  },
  /** a first idea of where they'd work (no logs) — used when a Will appears */
  assignJob(this: World, a: Agent, _allowRandom: boolean) {
    void _allowRandom;
    if (this.worksAtAll(a)) a.jobId = this.chooseWorkplace(a)?.id;
  },
  /** player's choice: pin a workplace (p), stop working ('none'), or freelance again (undefined) */
  setJob(this: World, a: Agent, p: Place | undefined | 'none') {
    a.workPin = p === 'none' ? 'none' : p?.id;
    if (p && p !== 'none') {
      a.jobId = p.id;
      this.log(a, 'event', `앞으로는 ${p.name}에서 일하기로 했다.`, p.id);
      this.log(p, 'event', `${josa(a.name, '이/가')} 이곳에 자리를 잡았다.`, a.id);
    } else if (p === 'none') this.log(a, 'event', '당분간 일을 쉬기로 했다.');
    else this.log(a, 'event', '정해진 일터 없이, 그날그날 일할 곳을 찾기로 했다.');
  },
  noteWorkplace(this: World, a: Agent, p: Place) {
    const prev = this.place(a.jobId);
    a.jobId = p.id;
    if (prev !== p) {
      this.log(p, 'event', `${josa(a.name, '이/가')} 일하러 왔다.`, a.id);
      if (Math.random() < 0.4) this.log(a, 'diary', prev ? `오늘은 ${prev.name} 대신 ${p.name}에서 일했다.` : `${p.name}에서 일을 시작했다.`, p.id);
    }
  },
  /** Each worker has a 6h shift; start hour spread by id so the town never empties. */
  shiftStart(this: World, a: Agent) {
    if (this.nightShift(a)) return NIGHT_SHIFT_START[this.place(a.jobId)!.style]!;
    if (this.chronotype(a) === 'owl') return [10, 13, 15][hashString(a.id) % 3]; // owls never take the 8 a.m. shift
    return [8, 10, 13, 15][hashString(a.id) % 4];
  },
  onShift(this: World, a: Agent) {
    if (weekdayOf(this.meta.minutes).weekend) return false; // weekends off
    const h = this.hour();
    const s = this.shiftStart(a);
    const e = s + SHIFT_LEN_H;
    return e <= 24 ? h >= s && h < e : h >= s || h < e - 24; // night shifts run past midnight
  },
  goWork(this: World, a: Agent, p: Place) {
    const taken = (s: { tx: number; ty: number }) => {
      const k = `${s.tx},${s.ty}`;
      return this.seatTaken.has(k) && this.seatTaken.get(k) !== a.id;
    };
    const spot = p.workSpots.find((s) => !taken(s)) ?? p.seats.find((s) => !taken(s));
    if (!spot) return this.wander(a, 6);
    this.seatTaken.set(`${spot.tx},${spot.ty}`, a.id);
    a.ai.mode = 'goto';
    a.ai.targetPlaceId = p.id;
    a.ai.working = true;
    a.ai.timer = 0;
    if (!this.pathTo(a, spot.tx, spot.ty)) {
      a.ai.working = false;
      this.wander(a, 6);
    }
  },
  startWork(this: World, a: Agent, p: Place) {
    const h = (this.meta.minutes % 1440) / 60;
    const leftMin = (this.shiftStart(a) + SHIFT_LEN_H - h) * 60;
    a.ai.timer = Math.max(8, Math.min(70, leftMin / MIN_PER_SEC));
    if (!a.ai.shiftEarned) {
      a.ai.shiftEarned = 0;
      const dream = this.dreamFit(a, p);
      if (dream >= 0.5 && this.addThought(a, 'dreamwork', `꿈꾸던 ${a.job} 일을 하고 있다`, 6, 300)) {
        if (Math.random() < 0.4) this.log(a, 'diary', `${p.name}에서 일했다. ${a.job}… 언젠가 진짜 내 일이 될 것 같다.`, p.id);
      } else if (Math.max(this.favor(a, p), dream) >= 0.4 || a.persona.energy > 0.3) this.addThought(a, 'work', '일하는 게 꽤 즐겁다', 4, 240);
      else if (a.persona.energy < -0.3) this.addThought(a, 'work', '출근하기 싫다…', -3, 240);
      this.emote(a, '💼');
    }
  },
  endShiftIfOver(this: World, a: Agent) {
    if (this.onShift(a) && this.place(a.jobId)) return;
    const earned = Math.round(a.ai.shiftEarned ?? 0);
    a.ai.working = false;
    a.ai.shiftEarned = 0;
    if (earned > 0) {
      this.log(a, 'diary', pick(['오늘도 무사히 일을 마쳤다. 수고했어, 나.', '퇴근! 이 순간을 위해 일한다.', '조금 힘들었지만 보람찬 하루였다.']) + ` (+${earned.toLocaleString('ko-KR')}원)`);
      if (Math.random() < 0.5) this.say(a, pick(['퇴근이다~!', '오늘 하루도 끝!', '하아, 집에 가자.']), { silentFeed: true });
    }
  },
  /** RimWorld-ish inner voice: a quiet thought bubble drawn from traits & mood. */
  innerMonologue(this: World, a: Agent) {
    if (a.kind !== 'person') return;
    const top = this.thoughtsSorted(a)[0];
    const r = Math.random();
    let text: string | null = null;
    if (top && r < 0.4) text = innerFromThought(top.label, top.value);
    else {
      const t = pick(a.traits.length ? a.traits : ['오늘은 무슨 일이 있을까']);
      const obj = extractObject(t);
      const dream = extractDream(t);
      // only short, clean objects read naturally inside a thought ("고양이", not "동네 맛집 탐방이 취미다")
      const cleanObj = obj && obj.length <= 9 && !/(다|요)$/.test(obj) && obj.split(' ').length <= 2 ? obj : null;
      if (a.treasure && Math.random() < 0.25) text = pick([`(${a.treasure}… 오늘도 함께야.)`, `(${josa(a.treasure, '을/를')} 보면 마음이 놓여.)`, `(${a.treasure}, 잃어버리면 안 돼.)`]);
      else if (dream) text = pick([`(${dream}… 언젠가는 꼭.)`, `(${dream}. 그날까지 버텨 보자.)`]);
      else if (cleanObj && traitPolarity(t) > 0) text = pick([`(${cleanObj} 생각나네…)`, `(요즘은 ${josa(cleanObj, '이/가')} 제일 좋아.)`, `(오늘은 ${josa(cleanObj, '이랑/랑')} 함께하고 싶다.)`]);
      else if (a.money < 15000) text = '(이번 달 좀 빠듯한데…)';
      else if (a.mood < 35) text = pick(['(다들 행복해 보이네…)', '(나만 이런 걸까.)', '(누가 말 좀 걸어줬으면.)']);
      else if (a.mood > 75) text = pick(['(오늘 기분 최고야!)', '(세상이 반짝반짝해 보여.)']);
    }
    if (text) this.say(a, text, { thought: true, silentFeed: true });
  },
  /**
   * Generative world-fitting: ask the storyteller to rewrite the RANDOMLY filled parts of a
   * Will's sheet for the current world. Player-written fields are never touched.
   */
  /**
   * ✨ AI character creation: the storyteller rewrites the randomly filled fields of a new Will as one
   * person (name, looks, job, treasured item, traits — consistent with the gender and the world).
   */
  reimagine(this: World, a: Agent, which: { name?: boolean; appearance: boolean; job: boolean; treasure: boolean; keepTraits: number }) {
    const hook = World.storyHook;
    const fields = [which.name && '이름', which.appearance && '외형', which.job && '직업', which.treasure && '애착 물건', a.traits.length > which.keepTraits && '특성'].filter(Boolean) as string[];
    if (!hook || !fields.length) return;
    const taken = this.agents.filter((x) => x !== a && x.kind === 'person').map((x) => x.name).slice(0, 40);
    const before = a.name;
    hook({
      world: this, kind: 'profile', speaker: a, draft: this.sheetOf(a), topic: `${this.meta.context}|${fields.join(',')}|${taken.join(', ')}`, important: true,
      apply: (text) => {
        if (!this.agents.includes(a)) return;
        const newName = text.match(/^\s*\[이름\]\s*(.+)$/m)?.[1].trim();
        const parsed = parseSheet(`[이름] ${a.name}\n` + text.replace(/^\s*\[이름\][^\n]*\n?/m, ''));
        const sh = parsed.sheet;
        const okSentence = (t: string) => /[가-힣]/.test(t) && t.length <= 40 && !/[A-Za-z]{3,}/.test(t);
        const patch: Partial<CharacterSheet> = {};
        // a name: Korean letters (a space for "이름 성"), short, not anyone else's
        if (which.name && newName && /^[가-힣]{2,5}( [가-힣]{1,6})?$/.test(newName) && newName !== a.name && !this.agents.some((x) => x !== a && x.name === newName)) this.renameAgent(a, newName);
        if (which.appearance && sh.appearance && sh.appearance.length <= 60) patch.appearance = sh.appearance;
        if (which.job && sh.job && sh.job.length <= 15) patch.job = sh.job;
        if (which.treasure && sh.treasure && sh.treasure.length <= 30) patch.treasure = sh.treasure;
        const fresh = sh.traits.filter(okSentence).slice(0, 7);
        if (fields.includes('특성') && fresh.length >= 3) patch.traits = [...a.traits.slice(0, which.keepTraits), ...fresh].slice(0, 10);
        if (!Object.keys(patch).length && a.name === before) return;
        this.updateAgent(a, patch);
        this.log(a, 'mutation', a.name !== before ? `이야기꾼이 이름과 이야기를 지어 주었다: ${a.name} ✨` : `「${this.meta.context}」 세계에 어울리는 모습으로 다시 그려졌다. ✨`);
      },
    });
  },
  /** change a Will's name everywhere it was already written (feed, logs, rumors, groups) */
  renameAgent(this: World, a: Agent, name: string) {
    const old = a.name;
    if (!name || name === old) return;
    const swap = (t: string) => t.split(old).join(name);
    a.name = name;
    for (const f of this.feed) {
      if (f.speakerId === a.id) f.speaker = name;
      if (f.toId === a.id) f.to = name;
      f.text = swap(f.text);
    }
    for (const e of [...this.agents, ...this.places]) for (const l of e.logs) l.text = swap(l.text);
    for (const r of this.rumors.rumors) {
      r.text = swap(r.text);
      r.tag = swap(r.tag);
    }
    for (const f of this.factions) for (const l of f.logs) l.text = swap(l.text);
    this.invalidateFavor(a.id);
  },
  // ───────────────────────── homes & night ─────────────────────────
  /** morning 6:30–9 · lunch 12–13:30 · evening 18–22 · late 22–23 · otherwise day */
  dayPhase(this: World): 'morning' | 'lunch' | 'day' | 'evening' | 'late' {
    const h = (this.meta.minutes % 1440) / 60;
    if (h >= 6.5 && h < 9) return 'morning';
    if (h >= 12 && h < 13.5) return 'lunch';
    if (h >= 18 && h < 22) return 'evening';
    if (h >= 22 && h < 23) return 'late';
    return 'day';
  },
  isNight(this: World) {
    const h = (this.meta.minutes % 1440) / 60;
    return h >= 23 || h < 6.5;
  },
  hour(this: World) {
    return (this.meta.minutes % 1440) / 60;
  },
  /** late evening through the small hours: most places are closed */
  lateHours(this: World, h = this.hour()) {
    return h >= 22 || h < 6.5;
  },
  // ───────────────────────── sleep rhythm (chronotype) ─────────────────────────
  /**
   * 아침형 · 보통 · 올빼미형. The Will's own words decide first ("밤하늘 보는 걸 좋아한다"
   * → owl); otherwise a stable coin flip from the id, so a reload doesn't change anyone.
   */
  chronotype(this: World, a: Agent): 'lark' | 'normal' | 'owl' {
    const likes = a.traits.filter((t) => !DISLIKE_RE.test(t)).join(' ');
    if (/(아침형|일찍 일어|새벽 운동|조깅|아침 산책|일출)/.test(likes)) return 'lark';
    if (/(밤|야행|올빼미|새벽|심야|불면|야식|별을|별 보)/.test(likes)) return 'owl';
    const r = hashString(a.id + ':chrono') % 100;
    return r < 22 ? 'owl' : r < 35 ? 'lark' : 'normal';
  },
  /** an owl who works where the lights stay on takes the night shift */
  nightShift(this: World, a: Agent) {
    const p = this.place(a.jobId);
    return !!p && NIGHT_SHIFT_START[p.style] !== undefined && this.chronotype(a) === 'owl';
  },
  /** [fall asleep, wake up] in hours (may wrap past midnight) */
  sleepWindow(this: World, a: Agent): [number, number] {
    if (this.nightShift(a)) return [5, 12];
    const c = this.chronotype(a);
    return c === 'lark' ? [21.5, 5.5] : c === 'owl' ? [1.5, 8] : [23, 6.5];
  },
  isBedtime(this: World, a: Agent) {
    if (a.ai.awakeUntil !== undefined && this.simTime < a.ai.awakeUntil) return false;
    const [s, e] = this.sleepWindow(a);
    const h = this.hour();
    return s < e ? h >= s && h < e : h >= s || h < e;
  },
  /** opening hours: at night only the bar, karaoke, late cinema, 24h store and open air stay open */
  openAt(this: World, p: Place, h = this.hour()) {
    if (!this.lateHours(h)) return true;
    switch (p.style) {
      case 'store':
      case 'park':
      case 'plaza':
      case 'home':
        return true;
      case 'bar':
        return h >= 17 || h < 2;
      case 'karaoke':
        return h >= 12 || h < 3;
      case 'cinema':
        return h >= 12 || h < 1;
      default:
        return false;
    }
  },
  /** Sleepless in the small hours: a low-mood Will may get up and go out for a while. */
  maybeInsomnia(this: World, a: Agent): boolean {
    const h = this.hour();
    if (a.mood > 32 || h >= 4.5 || h < 0.5 || Math.random() > 0.05 || this.hasThought(a, 'insomnia')) return false;
    a.ai.sleeping = false;
    a.ai.awakeUntil = this.simTime + 50 + Math.random() * 50;
    this.addThought(a, 'insomnia', '잠이 안 와서 뒤척이다 밖으로 나옴', -2, 300);
    this.emote(a, '🌙');
    this.say(a, pick(NIGHT_UP), { thought: true });
    this.log(a, 'diary', '잠이 오지 않아 밖으로 나왔다. 밤공기가 차다.');
    this.releaseSeat(a);
    this.nightActivity(a);
    return true;
  },
  /** What an awake Will does after dark: friends who are also up, late-night spots, stars, snacks, a walk. */
  nightActivity(this: World, a: Agent) {
    const h = this.hour();
    const open = this.places.filter((p) => p.style !== 'home' && this.openAt(p, h));
    const clear = this.meta.weather === 'clear';
    const opts: [number, () => void][] = [];
    const friend = this.agents
      .filter((b) => b !== a && b.kind === 'person' && !b.ai.sleeping && this.feel(a.id, b.id) >= 25)
      .sort((x, y) => this.feel(a.id, y.id) - this.feel(a.id, x.id))[0];
    if (friend && this.canChat(a, friend)) opts.push([1.2 * (1 + a.persona.social * 0.6), () => this.goMeet(a, friend)]);
    let best: Place | undefined;
    let bs = -1;
    for (const p of open) {
      if (p.style === 'park' || p.style === 'plaza') continue; // the sky gets its own option
      const s = this.favor(a, p) + Math.random() * 0.35 + (p.style === 'bar' ? 0.15 : 0) - (this.aversion(a, p) > 0.5 ? 0.6 : 0);
      if (s > bs) (bs = s), (best = p);
    }
    if (best) {
      const b = best;
      opts.push([0.8 + bs * 2, () => this.goVisit(a, b)]);
    }
    const sky = open.filter((p) => p.style === 'park' || p.style === 'plaza');
    if (sky.length) opts.push([(clear ? 0.7 : 0.25) + Math.max(0, a.persona.curious) * 0.4, () => this.goVisit(a, pick(sky))]);
    const store = open.find((p) => p.style === 'store');
    if (store) opts.push([0.5, () => this.goVisit(a, store)]);
    opts.push([0.6, () => this.wander(a, 12)]); // a walk through the quiet streets
    const home = this.place(a.homeId);
    if (home) opts.push([0.5, () => this.goVisit(a, home)]); // a quiet night in
    let r = Math.random() * opts.reduce((s, o) => s + o[0], 0);
    for (const [w, go] of opts) if ((r -= w) < 0) return go();
    this.wander(a, 8);
  },
  /** Night-only flavour when arriving somewhere after 22:00. */
  nightVisitEffect(this: World, a: Agent, p: Place) {
    const h = this.hour();
    if (!this.lateHours(h) || a.ai.working || a.ai.sleeping || a.kind !== 'person') return;
    if (p.style === 'store') {
      if (this.addThought(a, 'night:snack', '한밤의 야식은 진리', 4, 240)) {
        this.emote(a, '🍜');
        if (Math.random() < 0.5) this.say(a, pick(NIGHT_SNACK), { thought: true, silentFeed: Math.random() < 0.5 });
        if (Math.random() < 0.4) this.log(a, 'diary', `${p.name}에서 야식을 먹었다. 이 시간의 라면은 왜 이렇게 맛있을까.`);
      }
      return;
    }
    if (p.style === 'park' || p.style === 'plaza') {
      const clear = this.meta.weather === 'clear';
      if (!this.addThought(a, 'night:sky', clear ? '밤하늘의 별을 올려다봄' : '밤 산책으로 머리를 식힘', clear ? 6 : 3, 300)) return;
      this.emote(a, clear ? '✨' : '🌙');
      if (!clear) return;
      this.log(a, 'diary', `${p.name}에서 별을 봤다. 별이 이렇게 많았나 싶었다.`);
      // a starry night loosens the heart: the long inner monologue comes easily here
      if (this.simTime - (a.ai.lastMonologueAt ?? -1e9) > 240 && Math.random() < 0.35) {
        a.ai.lastMonologueAt = this.simTime;
        const text = this.composeMonologue(a);
        this.speakPolished(a, `(${text})`, a.id === this.watchedId, { thought: true, kind: 'monologue' });
      } else this.say(a, pick(NIGHT_STARS), { thought: true });
    }
  },
  homeCapacity(this: World, p: Place) {
    return Math.max(2, Math.min(4, p.seats.length + 1));
  },
  /** Give a homeless Will a home: an existing one with room, else build "○○네 집" (not in empty worlds). */
  ensureHome(this: World, a: Agent, allowBuild = this.map.roads) {
    if (a.kind !== 'person' || this.place(a.homeId)) return;
    const homes = this.places.filter((p) => p.style === 'home');
    let home = homes.find((p) => this.agents.filter((x) => x.homeId === p.id).length < this.homeCapacity(p));
    if (!home && allowBuild) {
      const near = this.place(a.jobId);
      home =
        this.addPlace(
          { name: `${givenName(a.name)}네 집`, style: 'home', ...(() => { const r = randomPlace('home', hashString(a.name), this.meta.context); return { appearance: r.appearance, traits: r.traits }; })() },
          near ? { tx: near.tx, ty: near.ty } : undefined,
        ) ?? undefined;
    }
    if (!home) return;
    a.homeId = home.id;
    this.log(a, 'event', `${josa(home.name, '을/를')} 집으로 삼았다.`, home.id);
    this.log(home, 'event', `${josa(a.name, '이/가')} 이사 왔다.`, a.id);
  },
  goSleep(this: World, a: Agent) {
    a.ai.sleeping = true;
    a.ai.working = false;
    const home = this.place(a.homeId);
    if (home) return this.goVisit(a, home, true);
    // homeless: a bench (or wherever they are) for the night
    const bench = this.places.filter((p) => p.style === 'park' || p.style === 'plaza')[0];
    this.addThought(a, 'sleep', '잘 곳이 없어 벤치에서 밤을 지새움', -6, 600);
    if (bench) return this.goVisit(a, bench, true);
    this.setIdle(a, 40);
    a.ai.sleeping = true;
  },
  wakeUp(this: World, a: Agent) {
    a.ai.sleeping = false;
    if (a.kind === 'person') this.needsOf(a).rest = 100;
    const home = this.place(a.homeId);
    if (home && !this.hasThought(a, 'sleep')) {
      const good = a.mood >= 35;
      this.addThought(a, 'sleep', good ? '푹 자고 일어남' : '밤새 뒤척였다', good ? 4 : -3, 600);
      if (weekdayOf(this.meta.minutes).weekend && a.jobId) this.addThought(a, 'weekend', '오늘은 쉬는 날!', 5, 900);
      if (Math.random() < 0.3) this.log(a, 'diary', good ? '아침이다. 오늘은 좋은 일이 있을 것 같다.' : '잠을 설쳤다. 오늘도 버텨 보자.');
    }
    if (Math.random() < 0.5) this.say(a, a.mood >= 40 ? pick(['(으음… 잘 잤다.)', '(아침이다!)', '(오늘도 힘내 보자.)']) : '(하아… 벌써 아침이야.)', { thought: true, silentFeed: true });
  },
  // ───────────────────────── mental breaks ─────────────────────────
  startBreak(this: World, a: Agent) {
    const music = a.traits.some((t) => /노래|음악|기타|밴드/.test(t));
    const kind: BreakKind = music && Math.random() < 0.6 ? 'sadSong' : Math.random() < 0.25 + Math.max(0, a.persona.temper) * 0.45 ? 'grumble' : 'sigh';
    a.ai.mode = 'break';
    a.ai.breakKind = kind;
    a.ai.timer = 30 + Math.random() * 20;
    a.ai.lastBreakAt = this.simTime;
    const label = { sigh: '벤치에 주저앉아 한숨만 쉰다', sadSong: '혼자 슬픈 노래를 부른다', grumble: '괜히 누군가에게 시비를 걸고 싶다' }[kind];
    this.pushFeed({ kind: 'break', speakerId: a.id, speaker: a.name, text: `⚠ ${josa(a.name, '이/가')} 한계에 다다랐다: ${label}` });
    this.naturalRumor(kind === 'grumble' ? `${josa(a.name, '이/가')} 요즘 날이 서 있대. 건드리지 말래` : `${josa(a.name, '이/가')} 요즘 많이 힘들어 보인대`, [a], a, kind === 'grumble' ? -0.3 : 0, 'struggle');
    this.log(a, 'diary', `오늘은 정말… 더는 못 버티겠다. (${label})`);
    if (kind === 'sigh') {
      let best: { tx: number; ty: number } | undefined;
      let bd = Infinity;
      const t = this.tileOf(a);
      for (const p of this.places) {
        if (p.style !== 'park' && p.style !== 'plaza') continue;
        for (const s of p.seats) {
          const d = Math.hypot(s.tx - t.tx, s.ty - t.ty);
          if (d < bd && !this.seatTaken.has(`${s.tx},${s.ty}`)) {
            bd = d;
            best = s;
          }
        }
      }
      if (best) {
        this.seatTaken.set(`${best.tx},${best.ty}`, a.id);
        this.pathTo(a, best.tx, best.ty);
      }
    } else if (kind === 'grumble') {
      const near = this.grid.queryRadius(a.x, a.y, 320, this.tmp).filter((b) => b !== a && b.kind === 'person');
      const victim = near[0];
      if (victim) {
        a.ai.meetWith = victim.id;
        a.ai.meetForced = true;
        const vt = this.tileOf(victim);
        this.pathTo(a, vt.tx, vt.ty);
      }
    }
  },
  breakTick(this: World, a: Agent) {
    if (a.ai.pathIndex < a.ai.path.length) return;
    if (Math.random() > 0.12) return;
    switch (a.ai.breakKind) {
      case 'sigh':
        this.emote(a, '💨');
        this.say(a, pick(SIGH), { silentFeed: true });
        break;
      case 'sadSong':
        this.emote(a, '🎵');
        this.say(a, pick(SAD_SONG), { silentFeed: Math.random() < 0.5 });
        break;
      case 'grumble':
        this.emote(a, '💢');
        break;
    }
  },
  endBreak(this: World, a: Agent) {
    a.ai.breakKind = undefined;
    a.ai.meetWith = undefined;
    this.addThought(a, 'catharsis', '실컷 감정을 쏟아내고 나니 조금 후련함', 10, 150);
    if (a.treasure) {
      this.addThought(a, 'treasure', `${josa(a.treasure, '이/가')} 곁에 있어 위로가 됨`, 4, 240);
      this.log(a, 'diary', `${josa(a.treasure, '을/를')} 꼭 쥐고 마음을 추슬렀다. 그래, 아직 괜찮아.`);
      this.say(a, `(${a.treasure}… 오늘도 곁에 있어 줘서 고마워.)`, { thought: true, silentFeed: true });
    } else this.log(a, 'diary', '실컷 울고 나니 조금은 괜찮아졌다.');
    this.setIdle(a, 2);
  },
};
