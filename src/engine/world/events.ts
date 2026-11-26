// World · 신의 개입 · 공연과 축제 · 세계 사건
// These are methods of the World class kept in their own file. They are installed on
// World.prototype at the end of World.ts, so callers keep writing world.someMethod() as before.

import { impactOf, mutateTraits, type MutationReason } from '../mutation';
import { DISLIKE_RE, LIKE_RE } from '../semantic';
import { TILE } from '../TileMap';
import { extractDream, extractObject, josa, traitPolarity } from '../traits';
import { type Agent, type Place, type Weather } from '../types';
import { pick, uid, weekdayOf } from '../util';
import { givenName, MIN_PER_SEC, Renderer_dark, World, type WorldEventKind } from '../World';

export const eventsMethods = {
  // ───────────────────────── god interventions ─────────────────────────
  setWeather(this: World, w: Weather) {
    this.meta.weather = w;
    for (const a of this.agents) if (a.kind === 'person') a.thoughts = a.thoughts.filter((t) => t.key !== 'weather');
  },
  setContext(this: World, ctx: string) {
    const prev = this.meta.context;
    this.meta.context = ctx;
    for (const a of this.agents) {
      if (a.kind !== 'person') continue;
      this.addThought(a, 'worldshift', '세상이 하루아침에 달라져 어리둥절함', -4, 120);
      this.log(a, 'mutation', `세계가 ${prev}에서 ${josa(ctx, '으로/로')} 바뀌었다.`);
      // queue a reactive mutation; a newer world shift replaces an older pending one
      // nobody "gets it" instantly: sensitive/curious Wills sooner, easy-going ones much later
      const speedUp = 1 - Math.max(0, a.persona.sensitive) * 0.35 - Math.max(0, a.persona.curious) * 0.25 + Math.max(0, -a.persona.energy) * 0.3;
      const delay = (30 + Math.random() * 330) * Math.max(0.4, speedUp);
      const q: (MutationReason & { readyAt: number })[] = (this.mutationQueue.get(a.id) ?? []).filter((r) => r.kind !== 'context');
      q.push({ kind: 'context', from: prev, to: ctx, readyAt: this.meta.minutes + delay });
      this.mutationQueue.set(a.id, q);
    }
  },
  /** queue impact mutations for Wills near a high-impact newcomer (dragon, celebrity, …) */
  queueImpact(this: World, e: Agent) {
    const what = impactOf(e.category, e.appearance, e.name);
    if (!what) return;
    for (const a of this.agents) {
      if (a === e || a.kind !== 'person' || Math.hypot(a.x - e.x, a.y - e.y) > TILE * 12) continue;
      const q = this.mutationQueue.get(a.id) ?? [];
      q.push({ kind: 'impact', byId: e.id, byName: e.name, what, readyAt: this.meta.minutes + 5 + Math.random() * 40 });
      this.mutationQueue.set(a.id, q);
      this.emote(a, '❗');
    }
  },
  /** Lazy processing: only DUE mutations, watched Will first, then Wills inside the camera view; others wait. */
  processOneMutation(this: World) {
    const v = this.viewRect;
    const now = this.meta.minutes;
    const inView = (a: Agent) => !v || (a.x >= v.x0 && a.x <= v.x1 && a.y >= v.y0 && a.y <= v.y1);
    const due = (id: string) => (this.mutationQueue.get(id) ?? []).some((r) => r.readyAt <= now);
    let pickId: string | undefined;
    if (this.watchedId && due(this.watchedId)) pickId = this.watchedId;
    else
      for (const id of this.mutationQueue.keys()) {
        const a = this.agent(id);
        if (!a) {
          this.mutationQueue.delete(id);
          continue;
        }
        if (due(id) && inView(a)) {
          pickId = id;
          break;
        }
      }
    if (!pickId) return;
    const a = this.agent(pickId);
    const q = this.mutationQueue.get(pickId) ?? [];
    const i = q.findIndex((r) => r.readyAt <= now);
    const [reason] = q.splice(i, 1);
    if (q.length) this.mutationQueue.set(pickId, q);
    else this.mutationQueue.delete(pickId);
    if (a && reason) this.applyMutation(a, reason);
  },
  /**
   * Slow drift from lived experience — happens even when nothing in the world changes.
   * Picks one fitting story for this Will (friend influence, a comfortable place, habits from
   * repeated events, a healing wound, group belonging) and queues it with a delay.
   */
  planDrift(this: World, a: Agent) {
    if ((this.mutationQueue.get(a.id) ?? []).some((r) => r.kind === 'drift')) return;
    const options: Extract<MutationReason, { kind: 'drift' }>[] = [];
    // 1) friend's taste rubs off
    const friend = this.agents.filter((o) => o !== a && o.kind === 'person' && this.feel(a.id, o.id) >= 50).sort(() => Math.random() - 0.5)[0];
    if (friend) {
      const theirLike = friend.traits.map((t) => (traitPolarity(t) > 0 ? extractObject(t) : null)).find((o) => o && o.length <= 12 && !a.traits.some((t) => t.includes(o)));
      if (theirLike) options.push({ kind: 'drift', source: 'friend', text: `요즘 ${this.referName(a, friend)} 영향으로 ${theirLike}에 관심이 생겼다`, note: `${friend.name}의 영향으로` });
    }
    // 2) a place becomes a comfort
    const fav = this.places.filter((p) => (p.regulars[a.id] ?? 0) >= 5).sort((x, y) => (y.regulars[a.id] ?? 0) - (x.regulars[a.id] ?? 0))[0];
    if (fav && !a.traits.some((t) => t.includes(fav.name))) options.push({ kind: 'drift', source: 'place', text: `${fav.name}에 가면 마음이 편해진다`, note: `${fav.name}의 단골이 되며` });
    // 3) habits from repeated experience
    const diary = a.logs.slice(-60);
    const fights = diary.filter((l) => /싸웠다|말다툼/.test(l.text)).length;
    const pets = a.thoughts.some((t) => t.key.startsWith('pet:')) || diary.filter((l) => /쓰다듬/.test(l.text)).length >= 2;
    if (fights >= 2) options.push({ kind: 'drift', source: 'experience', text: '말다툼 뒤엔 혼자 걷는 버릇이 생겼다', note: '잦은 다툼 끝에' });
    if (pets) options.push({ kind: 'drift', source: 'experience', text: '길고양이를 보면 저도 모르게 걸음을 멈춘다', note: '동물들과 자주 마주치며' });
    if (a.jobId && diary.filter((l) => /퇴근|일을 마쳤다/.test(l.text)).length >= 2) options.push({ kind: 'drift', source: 'experience', text: '일이 손에 익어 조금 자신감이 붙었다', note: '꾸준히 일하며' });
    if (a.mood <= 30) options.push({ kind: 'drift', source: 'experience', text: '요즘은 사소한 일에도 쉽게 지친다', note: '힘든 날이 이어지며' });
    if (a.mood >= 80) options.push({ kind: 'drift', source: 'experience', text: '요즘은 아침에 눈뜨는 게 즐겁다', note: '좋은 날이 이어지며' });
    // 4) wounds heal: "얼마 전 실연을 당했다" → "…아픔이 조금씩 옅어지고 있다"
    const wound = a.traits.find((t) => /(실연|떨어지고 있다|떨어져|우울하다|잃은 적|그리워한다|힘들다)/.test(t) && !/옅어지고/.test(t));
    if (wound && a.mood >= 50) {
      const missed = wound.match(/^(.+?)(?:을|를)\s*그리워한다/)?.[1];
      const healed = /실연/.test(wound)
        ? '실연의 아픔이 조금씩 옅어지고 있다'
        : /(오디션|떨어)/.test(wound)
          ? '계속 떨어져도 다시 해 볼 용기가 조금씩 생긴다'
          : /우울/.test(wound)
            ? '우울했던 마음이 조금씩 가벼워지고 있다'
            : /잃은 적/.test(wound)
              ? '떠나간 이를 떠올려도 이제는 조금 덜 아프다'
              : missed
                ? `${josa(missed, '을/를')} 그리워하지만, 지금의 삶도 나쁘지 않다고 느낀다`
                : '힘든 시간이 조금씩 지나가고 있다';
      options.push({ kind: 'drift', source: 'heal', replaces: wound, text: healed, note: '시간이 흐르며' });
    }
    // 5) group colours you
    const grp = this.factionsOf(a.id)[0];
    if (grp && !a.traits.some((t) => t.includes(grp.name))) options.push({ kind: 'drift', source: 'group', text: `${grp.name} 사람들과 있으면 웃음이 많아진다`, note: `${grp.name}에 물들며` });
    if (!options.length) return;
    const pickOne = options[Math.floor(Math.random() * options.length)];
    const q = this.mutationQueue.get(a.id) ?? [];
    q.push({ ...pickOne, readyAt: this.meta.minutes + 30 + Math.random() * 240 });
    this.mutationQueue.set(a.id, q);
  },
  applyMutation(this: World, a: Agent, reason: MutationReason) {
    const probe = reason.kind === 'context' ? reason.to : reason.kind === 'impact' ? reason.byName : reason.text;
    if (reason.kind === 'drift' && reason.replaces && !a.traits.includes(reason.replaces)) return;
    const res = mutateTraits(a, reason, (t) => this.matcher.similarity(t, probe));
    if (reason.kind === 'context') {
      this.addThought(a, 'realize', `이제야 실감이 난다… 여긴 정말 「${reason.to}」구나`, -2, 180);
      this.say(a, `(이제야 실감이 난다… 여긴 정말 「${reason.to}」구나.)`, { thought: true, silentFeed: true });
    }
    let traits = [...a.traits];
    if (res.replaced) traits = traits.map((t) => (t === res.replaced!.from ? res.replaced!.to : t));
    if (res.added && !traits.includes(res.added)) traits.push(res.added);
    while (traits.length > 12) {
      const drop = traits.findIndex((t) => traitPolarity(t) === 0);
      traits.splice(drop >= 0 ? drop : 0, 1);
    }
    this.updateAgent(a, { traits });
    this.mutationsDone++;
    if (res.replaced) this.log(a, 'mutation', `마음이 변했다: 「${res.replaced.from}」 → 「${res.replaced.to}」`);
    if (res.added) this.log(a, 'mutation', `새로 생긴 마음: 「${res.added}」`);
    this.emote(a, '💭');
    const why = reason.kind === 'context' ? `「${reason.to}」 세상` : reason.kind === 'impact' ? reason.byName : reason.note;
    this.pushFeed({
      kind: 'event', speakerId: a.id,
      text: reason.kind === 'drift' ? `🌱 ${a.name}, ${why} 마음이 조금 변했다 — 「${res.replaced?.to ?? res.added}」` : `🔄 ${a.name}의 마음이 ${why} 앞에서 조금 달라졌다 — 「${res.replaced?.to ?? res.added}」`,
    });
    // the storyteller may phrase the new trait more naturally (kept only if it still reads like a trait)
    for (const t of [res.replaced?.to, res.added].filter(Boolean) as string[]) {
      if (this.simSpeed < 3) World.storyHook?.({
        world: this, kind: 'mutation', speaker: a, draft: t, topic: `${res.replaced && t === res.replaced.to ? res.replaced.from : ''} | ${why}`, important: a.id === this.watchedId,
        apply: (text) => {
          const clean = text.replace(/[.。]$/, '').trim();
          if (!/다$/.test(clean) || clean.length > 45 || !a.traits.includes(t)) return;
          this.updateAgent(a, { traits: a.traits.map((x) => (x === t ? clean : x)) });
          this.log(a, 'mutation', `(이야기꾼) 「${t}」 → 「${clean}」`);
        },
      });
    }
  },
  showOf(this: World, a: Agent) {
    const id = a.ai.showId;
    if (!id) return undefined;
    const s = this.shows.find((x) => x.id === id && x.until > this.meta.minutes);
    if (!s) {
      a.ai.showId = undefined;
      a.ai.showSpot = undefined;
      a.ai.showArrived = false;
    }
    return s;
  },
  /** on the way to a show (or watching a performance): no new conversations */
  showBusy(this: World, a: Agent) {
    const s = this.showOf(a);
    return !!s && (!a.ai.showArrived || !s.social);
  },
  crowdSpot(this: World, s: World['shows'][number], i: number): { tx: number; ty: number } {
    if (s.social) {
      // festival: anywhere around the square
      const ang = i * 2.39996, r = 2 + (i % 4);
      return this.map.nearestWalkable(s.stage.tx + Math.round(Math.cos(ang) * r * 1.4), s.stage.ty + Math.round(Math.sin(ang) * r));
    }
    // performance: a half circle in front of (below) the performer, rows of seven
    const row = Math.floor(i / 7), col = i % 7;
    const ang = Math.PI * (0.12 + 0.76 * (col / 6));
    const r = 2 + row;
    return this.map.nearestWalkable(s.stage.tx + Math.round(Math.cos(ang) * r * 1.5), s.stage.ty + Math.max(1, Math.round(Math.sin(ang) * r)));
  },
  joinShow(this: World, a: Agent, s: World['shows'][number], spot?: { tx: number; ty: number }) {
    if (a.ai.sleeping || this.showOf(a)) return;
    const c = this.convoOf(a);
    if (c) {
      c.members = c.members.filter((m) => m !== a.id);
      if (c.members.length < 2) this.endConvo(c);
    }
    this.releaseSeat(a);
    a.ai.meetWith = undefined;
    a.ai.working = false;
    a.ai.showId = s.id;
    a.ai.showArrived = false;
    a.ai.showSpot = spot ?? this.crowdSpot(s, s.crowd.length);
    if (a.id !== s.starId) s.crowd.push(a.id);
    a.ai.mode = 'goto';
    a.ai.targetPlaceId = undefined;
    a.ai.timer = 0;
    if (!this.pathTo(a, a.ai.showSpot.tx, a.ai.showSpot.ty)) a.ai.showArrived = true;
  },
  /** called first in decide(): keeps show-goers at their spot, facing the stage. true = handled */
  showTick(this: World, a: Agent): boolean {
    const s = this.showOf(a);
    if (!s || !a.ai.showSpot) return false;
    const t = this.tileOf(a), spot = a.ai.showSpot;
    if (Math.abs(t.tx - spot.tx) + Math.abs(t.ty - spot.ty) > 1) {
      a.ai.mode = 'goto';
      if (this.pathTo(a, spot.tx, spot.ty)) return true;
    }
    a.ai.showArrived = true;
    this.setIdle(a, 3 + Math.random() * 4);
    const dx = s.stage.tx - t.tx, dy = s.stage.ty - t.ty;
    if (a.id !== s.starId) a.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    else a.facing = 'down';
    return true;
  },
  endShow(this: World, id: string) {
    const s = this.shows.find((x) => x.id === id);
    if (!s) return;
    s.until = this.meta.minutes;
    for (const a of this.agents)
      if (a.ai.showId === id) {
        a.ai.showId = undefined;
        a.ai.showSpot = undefined;
        a.ai.showArrived = false;
        if (a.ai.mode === 'idle') a.ai.timer = Math.min(a.ai.timer, 1 + Math.random() * 3);
      }
    this.shows = this.shows.filter((x) => x.until > this.meta.minutes - 60);
  },
  stageOf(this: World, p: Place) {
    return this.map.nearestWalkable(Math.floor(p.tx + p.tw / 2), Math.floor(p.ty + p.th / 2));
  },
  stagePx(this: World, s: { stage: { tx: number; ty: number } }) {
    return { x: (s.stage.tx + 0.5) * TILE, y: (s.stage.ty + 0.5) * TILE };
  },
  /** passers-by within earshot may stop and watch */
  drawCrowd(this: World, s: World['shows'][number], radiusTiles: number, chance: number) {
    const c = this.stagePx(s);
    for (const a of this.agents) {
      if (a.kind !== 'person' || a.ai.sleeping || a.ai.working || a.ai.showId || a.id === s.starId) continue;
      if (Math.hypot(a.x - c.x, a.y - c.y) > radiusTiles * TILE || Math.random() > chance) continue;
      this.joinShow(a, s);
      this.emote(a, '👀');
    }
  },
  startBusking(this: World, star: Agent, p: Place) {
    const len = 40;
    const s = { id: uid('show'), kind: 'busking' as const, placeId: p.id, starId: star.id, stage: this.stageOf(p), until: this.meta.minutes + len, social: false, crowd: [] as string[] };
    this.shows.push(s);
    this.joinShow(star, s, s.stage);
    this.addThought(star, 'busking', '버스킹을 해서 뿌듯함', 12, 300);
    this.announce(`🎸 ${josa(star.name, '이/가')} ${p.name}에서 버스킹을 시작한다! 사람들이 하나둘 모여든다.`);
    this.say(star, pick(['안녕하세요, 노래 한 곡 들려 드릴게요!', '떨리지만… 시작해 볼게요!', '지나가는 길에 잠깐만 들어 주세요~']));
    const fans = this.awakePeople().filter((a) => a !== star && !a.ai.working && (this.feel(a.id, star.id) >= 25 || a.traits.some((t) => /(노래|음악|공연|기타|밴드)/.test(t) && traitPolarity(t) > 0) || Math.random() < 0.3));
    for (const a of fans) this.joinShow(a, s);
    const px = this.stagePx(s);
    this.effects.push({ kind: 'stage', x: px.x, y: px.y, born: this.simTime, life: len / MIN_PER_SEC });
    const SONG = ['♪ 오늘 하루도 수고했어요~', '♪ 이 거리에 노을이 지면~', '♫ 라라라~ 너에게로~', '♪ 별이 빛나는 밤에~', '♫ 우리 함께 걸어요~', '♪ 괜찮아, 다 잘 될 거야~'];
    const CHEER = ['와, 목소리 좋다!', '최고예요!', '앵콜! 앵콜!', '한 곡 더!', '소름 돋았어요…', '이 노래 뭐예요?'];
    for (let m = 3; m < len; m += 4)
      this.later(m, () => {
        if (!this.shows.includes(s) || s.until <= this.meta.minutes || !this.agents.includes(star) || star.ai.sleeping) return;
        const atStage = Math.hypot(star.x - px.x, star.y - px.y) < TILE * 2;
        if (!atStage) return;
        this.say(star, pick(SONG), { silentFeed: true });
        this.emote(star, '🎵');
        this.effects.push({ kind: 'notes', x: star.x, y: star.y - 20, born: this.simTime, life: 4 });
        for (const id of s.crowd) {
          const a = this.agent(id);
          if (!a || !a.ai.showArrived || a.ai.showId !== s.id) continue;
          const r = Math.random();
          if (r < 0.35) this.emote(a, pick(['👏', '🎶', '😍', '✨']));
          else if (r < 0.45) this.say(a, pick(CHEER), { silentFeed: true });
          else if (r < 0.52 && a.money > 5000) {
            const tip = pick([1000, 2000, 5000]);
            a.money -= tip;
            star.money += tip;
            this.emote(a, '💸');
          }
        }
        this.drawCrowd(s, 9, 0.25);
      });
    this.later(len, () => {
      if (!this.shows.includes(s)) return;
      const crowd = s.crowd.map((id) => this.agent(id)).filter((a): a is Agent => !!a && a.ai.showId === s.id && !!a.ai.showArrived);
      if (this.agents.includes(star)) {
        this.say(star, crowd.length ? pick(['들어 주셔서 정말 감사합니다!', '끝까지 들어 줘서 고마워요!', '다음에 또 올게요!']) : '(아무도 없었지만… 그래도 좋았어.)');
        this.emote(star, '🙇');
      }
      this.effects.push({ kind: 'confetti', x: px.x, y: px.y, born: this.simTime, life: 4 });
      for (const a of crowd) {
        this.addThought(a, 'busking-watch', `${givenName(star.name)}의 길거리 공연을 봄`, 7, 240);
        this.addFeel(a.id, star.id, 4);
        this.emote(a, '👏');
      }
      if (crowd.length >= 2) {
        this.log(star, 'diary', `${p.name}에서 노래했다. ${crowd.length}명이 끝까지 들어 줬다. 손이 아직도 떨린다.`);
        this.naturalRumor(`${givenName(star.name)}의 버스킹이 대박이었대!`, [star, p], crowd[0], 0.9, 'event', 22);
        this.announce(`🎸 ${givenName(star.name)}의 버스킹이 끝났다 — ${crowd.length}명이 끝까지 박수를 쳤다.`);
      } else this.log(star, 'diary', `${p.name}에서 노래했다. 듣는 사람은 거의 없었지만 그래도 노래했다.`);
      this.endShow(s.id);
    });
  },
  startFestival(this: World, p: Place) {
    const len = 90;
    const s = { id: uid('show'), kind: 'festival' as const, placeId: p.id, stage: this.stageOf(p), until: this.meta.minutes + len, social: true, crowd: [] as string[] };
    this.shows.push(s);
    const px = this.stagePx(s);
    this.effects.push({ kind: 'confetti', x: px.x, y: px.y, born: this.simTime, life: 6 });
    this.effects.push({ kind: 'stage', x: px.x, y: px.y, born: this.simTime, life: len / MIN_PER_SEC });
    for (const a of this.awakePeople()) {
      this.addThought(a, 'festival', '동네 축제에 들뜸', 10, 360);
      if (!a.ai.working && Math.random() < 0.75) this.joinShow(a, s);
    }
    const LINES = ['축제다~!', '오늘은 다 같이 노는 날!', '저기 솜사탕 판다!', '이런 날이 제일 좋아요.', '사진 찍어요, 사진!', '불꽃놀이도 한대요!'];
    for (let m = 4; m < len; m += 6)
      this.later(m, () => {
        if (!this.shows.includes(s) || s.until <= this.meta.minutes) return;
        const here = s.crowd.map((id) => this.agent(id)).filter((a): a is Agent => !!a && a.ai.showId === s.id && !!a.ai.showArrived);
        const spot = here.length ? pick(here) : undefined;
        this.effects.push({ kind: Math.random() < 0.5 ? 'confetti' : 'notes', x: spot ? spot.x : px.x, y: (spot ? spot.y : px.y) - 10, born: this.simTime, life: 4 });
        for (const a of here) {
          const r = Math.random();
          if (r < 0.25) this.emote(a, pick(['🎉', '🎶', '😆', '🍡', '🎈']));
          else if (r < 0.35) this.say(a, pick(LINES), { silentFeed: true });
        }
        this.drawCrowd(s, 12, 0.3);
      });
    this.later(len, () => {
      const here = s.crowd.map((id) => this.agent(id)).filter((a): a is Agent => !!a && a.ai.showId === s.id);
      for (let i = 0; i + 1 < here.length; i += 2) this.addFeel(here[i].id, here[i + 1].id, 3);
      if (here[0]) this.log(here[0], 'diary', `${p.name} 축제에 갔다. 다들 웃고 있었다. 이 동네가 조금 더 좋아졌다.`);
      this.effects.push({ kind: 'confetti', x: px.x, y: px.y, born: this.simTime, life: 6 });
      this.announce(`🎉 ${p.name} 축제가 끝났다. ${here.length}명이 함께했다.`);
      this.endShow(s.id);
    });
  },
  // ───────────────────────── world events (사건) ─────────────────────────
  awakePeople(this: World) {
    return this.agents.filter((a) => a.kind === 'person' && !a.ai.sleeping);
  },
  skyCenter(this: World) {
    const v = this.viewRect;
    return v ? { x: (v.x0 + v.x1) / 2, y: v.y0 + (v.y1 - v.y0) * 0.35 } : { x: (this.map.w * TILE) / 2, y: (this.map.h * TILE) / 3 };
  },
  later(this: World, minutes: number, run: () => void) {
    this.pending.push({ at: this.meta.minutes + minutes, run });
  },
  announce(this: World, text: string) {
    this.pushFeed({ kind: 'event', text });
  },
  outdoorPlace(this: World): Place | undefined {
    return this.places.find((p) => p.style === 'plaza') ?? this.places.find((p) => p.style === 'park');
  },
  musicFan(this: World): Agent | undefined {
    const fans = this.awakePeople().filter((a) => a.traits.some((t) => /(노래|기타|음악|가수|밴드|피아노|버스킹|춤|댄스|랩)/.test(t)) || /(가수|음악|밴드|아이돌|음유시인)/.test(a.job));
    return fans.length ? pick(fans) : pick(this.awakePeople());
  },
  /** Natural events roll about once a game day (more on weekends); follow-ups run on schedule. */
  tickEvents(this: World, dm: number) {
    if (this.pending.length) {
      const now = this.meta.minutes;
      const due = this.pending.filter((p) => p.at <= now);
      if (due.length) {
        this.pending = this.pending.filter((p) => p.at > now);
        for (const d of due) d.run();
      }
    }
    if (this.blackoutUntil && this.meta.minutes >= this.blackoutUntil) {
      this.blackoutUntil = 0;
      this.announce('💡 전기가 다시 들어왔다. 여기저기서 환호성이 들린다.');
      for (const a of this.awakePeople()) if (this.hasThought(a, 'blackout')) this.addThought(a, 'blackout', '정전이 끝나서 안심함', 3, 90);
    }
    this.eventAcc += dm;
    if (this.eventAcc < 60) return;
    this.eventAcc = 0;
    if (this.meta.minutes - this.lastEventAt < 360 || this.awakePeople().length < 2) return;
    const weekend = weekdayOf(this.meta.minutes).weekend;
    if (Math.random() > (weekend ? 1 / 14 : 1 / 22)) return;
    const night = this.isNight() || (this.meta.minutes % 1440) / 60 >= 20;
    const options: WorldEventKind[] = night
      ? ['METEOR', 'BLACKOUT', 'LOST_TREASURE']
      : ['BIRTHDAY', 'LOST_TREASURE', 'LOTTERY', 'BUSKING', ...(this.meta.weather === 'clear' ? (['RAINBOW'] as const) : []), ...(weekend ? (['FESTIVAL', 'BUSKING'] as const) : [])];
    const kind = pick(options);
    if (kind === 'LOTTERY' && Math.random() < 0.6) return; // lotteries are rare
    this.happen(kind);
  },
  /** Trigger a world event (player command or natural). */
  happen(this: World, kind: WorldEventKind, target?: Agent | Place): { ok: boolean; message: string } {
    const r = this.happenInner(kind, target);
    if (r.ok) this.eventLog.push({ kind, t: this.meta.minutes, target: target?.id });
    if (this.eventLog.length > 60) this.eventLog.shift();
    return r;
  },
  happenInner(this: World, kind: WorldEventKind, target?: Agent | Place): { ok: boolean; message: string } {
    const people = this.awakePeople();
    const person = target && target.kind === 'person' ? target : undefined;
    this.lastEventAt = this.meta.minutes;
    switch (kind) {
      case 'FESTIVAL': {
        const p = target && target.kind === 'place' ? target : this.outdoorPlace() ?? this.places.find((x) => x.style !== 'home');
        if (!p) return { ok: false, message: '축제를 열 장소가 없어요. 광장이나 공원을 먼저 지어 주세요.' };
        this.announce(`🎉 ${p.name}에서 동네 축제가 열렸다! 음악 소리와 맛있는 냄새가 퍼진다.`);
        this.log(p, 'event', '동네 축제가 열렸다. 오늘만큼은 모두의 무대다.');
        this.startFestival(p);
        if (people[0]) this.naturalRumor(`${p.name}에서 축제가 열렸대!`, [p], people[0], 0.8, 'event', 20);
        return { ok: true, message: `🎉 ${p.name}에서 축제가 시작됐어요!` };
      }
      case 'RAINBOW': {
        if (Renderer_dark(this.meta.minutes)) return { ok: false, message: '무지개는 해가 떠 있을 때만 보여요.' };
        const c = this.skyCenter();
        this.effects.push({ kind: 'rainbow', x: c.x, y: c.y, born: this.simTime, life: 70 });
        if (this.meta.weather !== 'clear') this.meta.weather = 'clear';
        this.announce('🌈 하늘에 커다란 무지개가 떴다. 다들 고개를 든다.');
        for (const a of people) {
          if (!this.map.isOutdoor(this.tileOf(a).tx, this.tileOf(a).ty) && Math.random() < 0.5) continue;
          this.addThought(a, 'rainbow', '무지개를 봄', 6, 240);
          this.emote(a, '🌈');
          if (Math.random() < 0.25) this.say(a, pick(['우와, 무지개다!', '(오늘은 좋은 일이 생기려나.)', '사진 찍어야지!', '무지개 끝에 보물이 있대요.']), { silentFeed: true, thought: false });
        }
        return { ok: true, message: '🌈 무지개가 떴어요.' };
      }
      case 'BLACKOUT': {
        this.blackoutUntil = this.meta.minutes + 90;
        this.announce('🔌 동네에 정전이 났다! 가로등도 간판도 꺼졌다.');
        for (const a of this.agents) {
          if (a.ai.sleeping) continue;
          this.emote(a, a.kind === 'animal' ? '❗' : '😮');
          if (a.kind !== 'person') continue;
          const brave = a.persona.sensitive < -0.2 || a.persona.cheer > 0.4 || a.traits.some((t) => /(어둠|밤|별)/.test(t) && !DISLIKE_RE.test(t));
          this.addThought(a, 'blackout', brave ? '정전 덕분에 별이 잘 보임' : '갑자기 정전돼서 당황함', brave ? 4 : -5, 120);
          if (Math.random() < 0.3) this.say(a, brave ? pick(['와, 별이 이렇게 많았나?', '가끔은 이런 것도 좋네요.']) : pick(['어? 불이 나갔어!', '아무것도 안 보여요!', '휴대폰 손전등 어디 있지?']), { silentFeed: true });
        }
        if (people[0]) this.naturalRumor('동네에 정전이 났었대!', [], people[0], -0.2, 'event', 14);
        return { ok: true, message: '🔌 정전이 났어요. 약 1시간 반 뒤에 복구돼요.' };
      }
      case 'BUSKING': {
        const star = person ?? this.musicFan();
        const p = this.outdoorPlace() ?? this.places.find((x) => x.style !== 'home');
        if (!star || !p) return { ok: false, message: '버스킹할 윌이나 장소(광장·공원)가 없어요.' };
        if (this.shows.some((s) => s.starId === star.id && s.until > this.meta.minutes)) return { ok: true, message: `🎸 ${josa(star.name, '은/는')} 지금 공연 중이에요 — 보러 가요!` };
        this.startBusking(star, p);
        return { ok: true, message: `🎸 ${star.name}의 버스킹이 시작됐어요.` };
      }
      case 'METEOR': {
        if (!Renderer_dark(this.meta.minutes)) return { ok: false, message: '유성우는 밤에만 볼 수 있어요 (저녁 8시 이후).' };
        const c = this.skyCenter();
        this.effects.push({ kind: 'meteor', x: c.x, y: c.y, born: this.simTime, life: 45 });
        this.announce('🌠 밤하늘에 유성우가 쏟아진다. 누군가는 소원을 빈다.');
        for (const a of people) {
          const dream = a.traits.map(extractDream).find(Boolean);
          this.addThought(a, 'meteor', '유성우를 보며 소원을 빎', 8, 300);
          this.emote(a, '🌠');
          if (Math.random() < 0.4) this.say(a, dream ? `(${dream}… 꼭 이루어지게 해 주세요.)` : pick(['(소원 빌어야지…!)', '(다들 행복하게 해 주세요.)', '(내일은 좋은 일이 있기를.)']), { thought: true, silentFeed: !dream });
        }
        return { ok: true, message: '🌠 유성우가 쏟아져요.' };
      }
      case 'BIRTHDAY': {
        const who = person ?? pick(people);
        if (!who) return { ok: false, message: '생일을 맞을 윌이 없어요.' };
        this.addThought(who, 'birthday', '생일 축하를 받음', 15, 720);
        this.effects.push({ kind: 'confetti', x: who.x, y: who.y - 10, born: this.simTime, life: 4 });
        this.emote(who, '🎂');
        this.announce(`🎂 오늘은 ${givenName(who.name)}의 생일이다!`);
        const wishedBy = this.wished.get(who.id) ?? new Set<string>();
        this.wished.set(who.id, wishedBy);
        let k = 0;
        this.nearbyReact(who, 7, (b) => {
          this.emote(b, pick(['🎉', '👏', '🥳']));
          // the first one or two say it out loud (the first always does); the rest clap
          if (k < 3 && (k === 0 || Math.random() < 0.6)) {
            k++;
            wishedBy.add(b.id);
            this.say(b, this.speaksCasually(b, who) ? `${this.callName(b, who)}, 생일 축하해!` : `${this.callName(b, who)}, 생일 축하해요!`, { to: who, silentFeed: k > 1 || this.simSpeed >= 5 }); // fast-forward: bubbles only, no line-by-line log
            this.addFeel(who.id, b.id, 3);
            this.addThought(b, `wished:${who.id}`, `${givenName(who.name)}의 생일을 축하해 줬다`, 3, 300);
          }
        });
        // friends and acquaintances come over to say it in person; with nobody close yet, the nearest neighbours do
        const others = this.agents.filter((b) => b.kind === 'person' && b !== who && !b.ai.sleeping && !wishedBy.has(b.id));
        let friends = others.filter((b) => this.feel(b.id, who.id) >= 10).sort((x, y) => this.feel(y.id, who.id) - this.feel(x.id, who.id)).slice(0, 4);
        if (!friends.length) friends = others.sort((x, y) => Math.hypot(x.x - who.x, x.y - who.y) - Math.hypot(y.x - who.x, y.y - who.y)).slice(0, 2);
        for (const b of friends) wishedBy.add(b.id);
        friends.forEach((b, i) =>
          this.later(4 + i * 12, () => {
            if (b.ai.sleeping || !this.agents.includes(who) || who.ai.sleeping) return;
            // walk over to say it in person
            if (Math.hypot(b.x - who.x, b.y - who.y) > 3 * TILE) this.meet(b, who);
          }),
        );
        friends.forEach((b, i) =>
          this.later(14 + i * 12, () => {
            if (b.ai.sleeping || !this.agents.includes(who)) return;
            this.effects.push({ kind: 'confetti', x: who.x, y: who.y - 10, born: this.simTime, life: 3 });
            this.say(b, this.speaksCasually(b, who) ? `${this.callName(b, who)}, 생일 축하해! 🎉` : `${this.callName(b, who)}, 생일 축하드려요!`, { to: who, silentFeed: this.simSpeed >= 5 });
            this.addFeel(who.id, b.id, 5);
            this.addFeel(b.id, who.id, 2);
            this.emote(who, '💖');
          }),
        );
        this.log(who, 'diary', friends.length ? `생일이었다. ${friends.map((f) => givenName(f.name)).join(', ')}에게 축하를 받았다. 혼자가 아니었다.` : '생일이었다. 조용히 케이크 한 조각을 먹었다.');
        if (!friends.length) this.addThought(who, 'birthday', '조용히 혼자 보낸 생일', 2, 720);
        this.naturalRumor(`오늘이 ${givenName(who.name)} 생일이래!`, [who], who, 0.7, 'bond', 16, true);
        return { ok: true, message: `🎂 ${who.name}의 생일이에요${friends.length ? ` — 친구 ${friends.length}명이 축하하러 와요.` : '.'}` };
      }
      case 'LOTTERY': {
        const who = person ?? pick(people);
        if (!who) return { ok: false, message: '복권을 산 윌이 없어요.' };
        const prize = pick([50000, 300000, 1000000, 5000000]);
        who.money += prize;
        this.addThought(who, 'lottery', '복권에 당첨됨!', prize >= 1000000 ? 20 : 10, 720);
        this.emote(who, '💰');
        this.say(who, prize >= 1000000 ? pick(['에엥?! 당첨이라고?!', '이거 꿈 아니죠?!', '엄마!! 나 당첨됐어!!']) : pick(['오, 소소하게 당첨!', '치킨 값은 벌었다!']));
        this.announce(`🍀 ${josa(givenName(who.name), '이/가')} 복권에 당첨됐다! (${prize.toLocaleString()}원)`);
        this.nearbyReact(who, 6, (b) => {
          const envy = this.feel(b.id, who.id) < 0 || (b.persona.kind < -0.2 && Math.random() < 0.5);
          this.emote(b, envy ? '😒' : pick(['😮', '🎉', '👏']));
          if (Math.random() < 0.5) this.say(b, envy ? pick(['(…부럽다. 나는 왜 안 되지.)', '(좋겠다, 진짜.)']) : this.speaksCasually(b, who) ? pick(['우와, 대박! 한턱 쏴!', '진짜? 축하해!']) : pick(['우와, 축하해요!', '대박이에요! 한턱 쏘세요~']), envy ? { thought: true, silentFeed: true } : { to: who, silentFeed: true });
          if (envy) this.addThought(b, `envy:${who.id}`, `${givenName(who.name)}의 복권 당첨이 부럽다`, -2, 240);
        });
        this.log(who, 'diary', `복권에 당첨됐다. ${prize.toLocaleString()}원. 손이 떨려서 몇 번이나 다시 봤다.`);
        if (prize >= 300000)
          this.later(45, () => {
            const pals = this.agents.filter((b) => b.kind === 'person' && b !== who && this.feel(who.id, b.id) >= 45).slice(0, 3);
            for (const b of pals) {
              this.addThought(b, 'treat', `${givenName(who.name)}에게 한턱 얻어먹음`, 6, 240);
              this.addFeel(b.id, who.id, 5);
            }
            if (pals.length) this.log(who, 'event', `${pals.map((b) => givenName(b.name)).join(', ')}에게 한턱냈다.`);
          });
        this.naturalRumor(`${givenName(who.name)}${josa(givenName(who.name), '이/가').slice(givenName(who.name).length)} 복권에 당첨됐대!`, [who], who, 0.6, 'event', 26, true);
        return { ok: true, message: `🍀 ${who.name}이(가) ${prize.toLocaleString()}원에 당첨됐어요!` };
      }
      case 'LOST_TREASURE': {
        const who = person ?? pick(people.filter((a) => a.treasure && !this.hasThought(a, 'lost-treasure')));
        if (!who || !who.treasure) return { ok: false, message: '애착 물건을 가진 윌이 없어요.' };
        const item = who.treasure;
        this.addThought(who, 'lost-treasure', `${item}을(를) 잃어버림`, -14, 1440);
        this.emote(who, '😢');
        this.say(who, `(${item}… 어디 갔지? 분명 여기 있었는데…)`, { thought: true });
        this.log(who, 'diary', `${item}을(를) 잃어버렸다. 하루 종일 그 생각뿐이다.`);
        this.naturalRumor(`${givenName(who.name)}${josa(givenName(who.name), '이/가').slice(givenName(who.name).length)} 소중한 물건을 잃어버렸대`, [who], who, -0.4, 'struggle', 14, true);
        this.later(60 + Math.random() * 180, () => {
          if (!this.agents.includes(who) || !this.hasThought(who, 'lost-treasure')) return;
          const cands = this.agents.filter((b) => b.kind === 'person' && b !== who && !b.ai.sleeping);
          if (!cands.length) return;
          const finder = cands.sort((x, y) => Math.hypot(x.x - who.x, x.y - who.y) - Math.hypot(y.x - who.x, y.y - who.y))[Math.floor(Math.random() * Math.min(3, cands.length))];
          who.thoughts = who.thoughts.filter((t) => t.key !== 'lost-treasure');
          this.addThought(who, 'found-treasure', `${givenName(finder.name)}이(가) ${item}을(를) 찾아 줌`, 14, 600);
          this.addThought(finder, 'helped', '누군가의 소중한 물건을 찾아 줌', 8, 300);
          this.addFeel(who.id, finder.id, 15);
          this.addFeel(finder.id, who.id, 6);
          this.meet(finder, who);
          this.say(finder, `${this.callName(finder, who)}, 혹시 이거 ${this.speaksCasually(finder, who) ? '네 거야?' : '찾으시던 거예요?'}`, { to: who });
          this.later(8, () => this.say(who, this.speaksCasually(who, finder) ? `${this.callName(who, finder)}, 진짜 고마워! 이거 정말 소중한 거야.` : `${this.callName(who, finder)}, 정말 고마워요! 이거 정말 소중한 거예요.`, { to: finder }));
          this.announce(`🔎 ${josa(givenName(finder.name), '이/가')} ${givenName(who.name)}의 ${josa(item, '을/를')} 찾아 주었다.`);
          this.log(who, 'diary', `${givenName(finder.name)}이(가) ${item}을(를) 찾아 줬다. 이 은혜는 잊지 않을 거다.`);
          this.naturalRumor(`${givenName(finder.name)}이(가) ${givenName(who.name)}의 잃어버린 물건을 찾아 줬대`, [finder, who], finder, 0.8, 'care', 18);
        });
        return { ok: true, message: `😢 ${who.name}이(가) ${josa(item, '을/를')} 잃어버렸어요. 누군가 찾아 줄까요?` };
      }
    }
  },
  lightning(this: World, x: number, y: number) {
    this.effects.push({ kind: 'lightning', x, y, born: this.simTime, life: 0.7 });
    const near = this.grid.queryRadius(x, y, 140, this.tmp);
    for (const a of [...near]) {
      const d = Math.hypot(a.x - x, a.y - y);
      this.emote(a, '❗');
      if (d < 40) this.addThought(a, 'lightning', '번개에 맞을 뻔함', -18, 240);
      else this.addThought(a, 'lightning', '눈앞에 번개가 떨어져 혼비백산함', -10, 180);
      this.log(a, 'event', '바로 옆에 번개가 떨어졌다!');
      if (a.ai.mode === 'chat') {
        const c = this.convoOf(a);
        if (c) this.endConvo(c);
      }
      if (a.kind === 'person' && Math.random() < 0.6) this.say(a, pick(['으아악!', '깜짝이야!!', '하늘이 노했나?!']), { silentFeed: true });
      this.wander(a, 7);
    }
    const pid = this.map.placeIdAt(Math.floor(x / TILE), Math.floor(y / TILE));
    const p = this.place(pid ?? undefined);
    if (p) this.log(p, 'event', '번개를 맞았다!');
    const victim = near.find((a) => Math.hypot(a.x - x, a.y - y) < 40);
    const where = p?.name ?? (victim ? `${victim.name} 바로 옆` : '골목');
    if (near[0]) this.naturalRumor(`${where}에 마른하늘에 번개가 떨어졌대!`, p ? [p, ...near.slice(0, 2)] : near.slice(0, 2), near[0], 0, 'event', 18);
  },
  bless(this: World, a: Agent) {
    this.addThought(a, 'bless', '알 수 없는 따스한 기운을 느낌', 12, 180);
    this.emote(a, '✨');
    this.effects.push({ kind: 'sparkle', x: a.x, y: a.y - 20, born: this.simTime, life: 1.2 });
    this.log(a, 'diary', '갑자기 마음이 따뜻해졌다. 누군가 지켜봐 주는 것 같다.');
  },
  gift(this: World, a: Agent) {
    const like = a.traits.find((t) => LIKE_RE.test(t));
    const what = like ? like.replace(/(을|를)?\s*(정말|매우)?\s*(좋아한다|좋아하는|사랑한다|즐긴다).*$/, '').slice(0, 14) : '작은 선물';
    this.addThought(a, 'gift', `누군가 ${what} 선물을 두고 감`, 10, 240);
    this.emote(a, '🎁');
    this.say(a, '(어? 이게 뭐지… 나한테?)', { thought: true });
    this.log(a, 'diary', `누군가 ${what} 선물을 두고 갔다. 누굴까?`);
  },
  meet(this: World, a: Agent, b: Agent) {
    a.ai.meetWith = b.id;
    a.ai.meetForced = true;
    b.ai.meetWith = a.id;
    b.ai.meetForced = true;
    for (const m of [a, b]) {
      if (m.ai.mode === 'chat') {
        const c = this.convoOf(m);
        if (c) this.endConvo(c);
      }
      this.releaseSeat(m);
      m.ai.mode = 'goto';
      m.ai.targetPlaceId = undefined;
      m.ai.timer = 40;
      m.ai.nextThinkAt = this.simTime;
    }
  },
};
