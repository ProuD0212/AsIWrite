// World · 생각과 행동 결정
// These are methods of the World class kept in their own file. They are installed on
// World.prototype at the end of World.ts, so callers keep writing world.someMethod() as before.

import { ANIMAL_SOUNDS, HUM, petLine, SAD_SONG } from '../../presets/banter';
import { SPECIES_WORDS } from '../appearance';
import { DISLIKE_RE, LIKE_RE } from '../semantic';
import { TILE } from '../TileMap';
import { josa } from '../traits';
import { type Agent, type Place, type PlaceStyle } from '../types';
import { clamp, pick, weekdayOf } from '../util';
import { WORK_LINES, MEAL_MORNING, MEAL_LUNCH, STUDENT_LINES, PRICE, NOCTURNAL, STYLE_EMOTE, type Conversation, World } from '../World';

export const thinkingMethods = {
  // ───────────────────────── thinking ─────────────────────────
  think(this: World, a: Agent) {
    const ai = a.ai;
    ai.nextThinkAt = this.simTime + 0.5 + Math.random() * 0.7;
    const now = this.meta.minutes;
    if (a.thoughts.length) a.thoughts = a.thoughts.filter((t) => t.expiresAt > now);

    this.perceive(a);
    if (ai.mode === 'chat') return;

    // meeting a requested partner (MEET event / seeking a friend)
    if (ai.meetWith && this.showBusy(a)) ai.meetWith = undefined;
    if (ai.meetWith) {
      const b = this.agent(ai.meetWith);
      if (!b || ai.timer <= 0) {
        // partner gone or gave up looking
        ai.meetWith = undefined;
        ai.meetForced = false;
      } else {
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d < 44) {
          const forced = ai.meetForced;
          const grumble = ai.mode === 'break' && ai.breakKind === 'grumble';
          ai.meetWith = undefined;
          ai.meetForced = false;
          if (b.ai.meetWith === a.id) b.ai.meetWith = undefined;
          const existing = this.convoOf(b);
          if (existing && existing.members.length < 5 && !grumble) this.joinConvo(existing, a);
          else if (existing && grumble) this.endConvo(existing);
          if (!existing || grumble) {
            if (forced || this.canChat(a, b)) this.startConvo([a, b], grumble);
            else this.setIdle(a, 2);
          }
          return;
        } else if (ai.pathIndex >= ai.path.length || Math.random() < 0.25) {
          const bt = this.tileOf(b);
          if (ai.mode !== 'break') ai.mode = 'goto';
          ai.targetPlaceId = undefined;
          this.pathTo(a, bt.tx, bt.ty);
          return;
        }
      }
    }

    // spontaneous encounters
    if (a.kind === 'person' && ai.mode !== 'break' && !this.showBusy(a)) {
      const near = this.grid.queryRadius(a.x, a.y, 52, this.tmp);
      for (const b of near) {
        if (b === a || b.kind !== 'person') continue;
        const c = this.convoOf(b);
        if (c) {
          if (c.members.length < 5 && !c.argue && this.wantsToJoin(a, c) && Math.random() < 0.35) {
            this.joinConvo(c, a);
            return;
          }
          continue;
        }
        if (Math.hypot(b.x - a.x, b.y - a.y) < 38 && this.canChat(a, b) && b.ai.mode !== 'break' && Math.random() < this.chatChance(a, b)) {
          // bad blood, clashing tempers or a foul mood can turn a meeting into an argument
          const feel = this.feel(a.id, b.id);
          const hot = Math.max(0, a.persona.temper);
          const argue = (feel <= -20 && Math.random() < 0.35) || (this.clash(a, b) >= 0.5 && Math.random() < 0.12 + hot * 0.2) || (a.mood < 30 && Math.random() < hot * 0.25);
          this.startConvo([a, b], argue);
          return;
        }
      }
    }

    switch (ai.mode) {
      case 'idle':
        if (ai.timer <= 0) this.decide(a);
        else if (a.mood >= 80 && Math.random() < 0.04 && a.kind === 'person') this.say(a, pick(HUM), { silentFeed: true });
        else if (Math.random() < 0.03) this.innerMonologue(a);
        break;
      case 'visit':
        this.visitTick(a);
        if (ai.timer <= 0) this.decide(a);
        break;
      case 'break':
        this.breakTick(a);
        if (ai.timer <= 0) this.endBreak(a);
        break;
      case 'goto':
      case 'wander':
        if (ai.pathIndex >= ai.path.length) this.decide(a);
        else if (ai.timer < -40) this.decide(a); // safety
        break;
    }
  },
  canChat(this: World, a: Agent, b: Agent) {
    if (a.ai.sleeping || b.ai.sleeping || this.showBusy(a) || this.showBusy(b)) return false;
    const last = Math.max(a.ai.lastChatAt[b.id] ?? -999, b.ai.lastChatAt[a.id] ?? -999);
    return this.simTime - last > 75 && b.ai.mode !== 'chat' && a.ai.mode !== 'chat';
  },
  chatChance(this: World, a: Agent, b: Agent) {
    const rel = this.peekRelation(a.id, b.id);
    let p = 0.16 + a.persona.social * 0.15 + b.persona.social * 0.08 + (this.sharesGroup(a.id, b.id) ? 0.12 : 0);
    if (rel) p += this.feel(a.id, b.id) / 200;
    if (a.mood >= 80) p += 0.25;
    if (a.mood <= 25) p -= 0.15;
    return clamp(p, 0.05, 0.85);
  },
  wantsToJoin(this: World, a: Agent, c: Conversation) {
    for (const m of c.members) {
      if (this.feel(a.id, m) >= 30 || this.sharesGroup(a.id, m)) return true;
    }
    for (const t of a.traits) if (this.matcher.similarity(t, c.topic) >= 0.65) return true;
    return false;
  },
  perceive(this: World, a: Agent) {
    if (a.ai.sleeping) return; // asleep: the world can wait till morning
    const near = this.grid.queryRadius(a.x, a.y, 80, this.tmp);
    for (const b of near) {
      if (b === a) continue;
      if (a.kind === 'person' && b.kind === 'animal') this.meetAnimal(a, b);
      if (a.kind === 'person' && b.kind === 'animal' && !this.hasThought(a, `fear:${b.id}`)) {
        // only a dislike that really is about this kind of animal (the old embedding scored
        // "비 오는 날" ≈ "길고양이", so cat lovers screamed at cats — see 4-38)
        const d = this.dislikeDetail(a, b);
        if (d && d.score >= 0.7) {
          const sp = SPECIES_WORDS[b.layers.species].split(' ')[0];
          this.addThought(a, `fear:${b.id}`, `${josa(b.name, '을/를')} 보고 깜짝 놀람`, -8, 90);
          this.emote(a, '❗');
          this.say(a, pick(['으악, 저리 가!', '히익… 가까이 오지 마.', `(${sp}… 난 정말 ${d.obj.includes(sp) ? '무서워' : '별로야'}.)`, '저, 저기로 가 줄래?']), { thought: false });
          this.log(a, 'diary', `${josa(b.name, '을/를')} 마주쳤다. ${d.obj}만 보면 아직도 몸이 굳는다.`, b.id);
          if (a.ai.mode !== 'chat') this.wander(a, 8);
        }
      }
      if (a.kind === 'person' && b.kind === 'person' && !this.hasThought(a, `uneasy:${b.id}`)) {
        const u = this.unease(a, b);
        if (u) {
          const n = this.referName(a, b);
          const line =
            u.kind === 'history'
              ? pick([`(${n}… 저 사람이랑은 좀 어색해.)`, `(${josa(n, '이랑/랑')}은 잘 안 맞는 것 같아.)`, `(또 ${n}… 마주치기 싫다.)`, `(${n}… 지난번 일이 아직 마음에 걸려.)`])
              : u.kind === 'clash'
                ? pick([`(${n}, 나랑은 결이 좀 다른 것 같아.)`, `(${n}, ${u.detail}… 같이 있으면 기가 빨려.)`, `(${n}… 아직은 좀 어렵다.)`])
                : pick([`(저 ${u.detail}… 괜히 신경 쓰이네.)`, `(${n}의 ${u.detail}, 왠지 눈에 거슬려.)`]);
          this.addThought(a, `uneasy:${b.id}`, u.kind === 'history' ? `${josa(b.name, '와/과')} 마주쳐 어색함` : `${b.name} 곁이 왠지 불편함`, u.kind === 'history' ? -5 : -3, 120);
          this.emote(a, '💦');
          this.say(a, line, { thought: true });
          if (u.kind === 'history' && Math.random() < 0.5) this.log(a, 'diary', `${josa(b.name, '을/를')} 또 마주쳤다. 아직은 어색하다.`, b.id);
          if (u.kind === 'history' && a.ai.mode !== 'chat' && Math.random() < 0.6) this.wander(a, 6);
        }
      }
    }
    if (a.kind === 'person') {
      this.perceiveWeather(a);
      if (a.money < 10000) this.addThought(a, 'money', '돈이 궁해서 걱정', -4, 30);
      else if (a.money > 400000) this.addThought(a, 'money', '통장이 두둑해 든든함', 3, 30);
      else if (this.hasThought(a, 'money')) a.thoughts = a.thoughts.filter((t) => t.key !== 'money');
    }
  },
  meetAnimal(this: World, a: Agent, b: Agent) {
    const key = `pet:${b.id}`;
    if (this.hasThought(a, key) || a.ai.mode === 'chat') return;
    const f = this.favor(a, b);
    if (f < 0.45) return;
    const lowBefore = a.mood <= 40;
    const val = lowBefore ? 20 : 14;
    const label = lowBefore ? `운명처럼 나타난 ${josa(b.name, '을/를')} 쓰다듬음` : `${josa(b.name, '을/를')} 쓰다듬음`;
    this.addThought(a, key, label, val, 240);
    a.facing = b.x < a.x ? 'left' : 'right';
    this.emote(a, '❤️');
    this.emote(b, '❤️');
    const line = petLine(this.callName(a, b), b.layers.species);
    this.say(a, line);
    this.say(b, pick(ANIMAL_SOUNDS[b.layers.species] ?? ANIMAL_SOUNDS.cat), { silentFeed: true });
    this.addFeel(a.id, b.id, 8);
    this.addFeel(b.id, a.id, 6);
    const rel = this.relation(a.id, b.id);
    if (rel.memories.length < 1 || Math.random() < 0.3) rel.memories.push({ t: this.meta.minutes, text: `${josa(a.name, '이/가')} ${josa(b.name, '을/를')} 쓰다듬었다.` });
    this.log(b, 'diary', pick([
      `${josa(a.name, '이/가')}라는 인간이 나를 쓰다듬었다. 나쁘지 않았다.`,
      `오늘도 ${josa(a.name, '이/가')} 내 이름을 불렀다. 못 이기는 척 다가가 줬다.`,
      `${a.name}의 손은 따뜻했다. 다음에도 와 주면 좋겠다.`,
    ]), a.id);
    if (lowBefore && !this.hasThought(a, 'cared')) {
      this.addThought(a, 'cared', '누군가 나를 위로해 준 하루', 3, 720);
      this.log(a, 'diary', `힘든 하루였는데, ${b.name} 덕분에 오랜만에 웃었다. 고마워.`, b.id);
      this.pushFeed({ kind: 'care', speakerId: a.id, speaker: a.name, text: `${a.name}의 표정이 밝아졌다 — ${b.name} 덕분에.` });
      this.naturalRumor(`${josa(a.name, '이/가')} ${b.name} 덕분에 다시 웃게 됐대`, [a, b], a, 0.6, 'care');
    } else this.log(a, 'diary', `${josa(b.name, '을/를')} 만나 쓰다듬어 줬다.`, b.id);
    if (a.ai.mode !== 'break' && a.ai.mode !== 'visit') this.setIdle(a, 3);
    if (b.ai.mode !== 'chat') this.setIdle(b, 4);
  },
  perceiveWeather(this: World, a: Agent) {
    const w = this.meta.weather;
    const t = this.tileOf(a);
    const outdoor = this.map.isOutdoor(t.tx, t.ty);
    const likesRain = a.traits.some((s) => /비 ?오는|빗소리|비가/.test(s) && LIKE_RE.test(s));
    const hatesRain = a.traits.some((s) => /비 ?오는|비가|비를/.test(s) && DISLIKE_RE.test(s));
    if (w === 'rain' || w === 'storm') {
      if (likesRain) this.addThought(a, 'weather', '빗소리가 좋다', 8, 30);
      else if (hatesRain) this.addThought(a, 'weather', '비 오는 날은 질색이다', -10, 30);
      else if (outdoor && a.layers.prop !== 'umbrella' && a.layers.outfitStyle !== 'raincoat') this.addThought(a, 'weather', '비에 쫄딱 젖음', -6, 20);
      if (w === 'storm' && !this.hasThought(a, 'thunder') && Math.random() < 0.05) {
        this.addThought(a, 'thunder', '천둥소리에 깜짝 놀람', -5, 40);
        this.emote(a, '❗');
      }
    } else if (w === 'snow') {
      this.addThought(a, 'weather', '눈이 내려 설렘', 6, 30);
    }
  },
  decide(this: World, a: Agent) {
    // keep sleeping through the night without giving up the bed (unless sleep won't come)
    if (a.kind === 'person' && a.ai.sleeping && a.ai.mode === 'visit' && this.isBedtime(a)) {
      if (this.maybeInsomnia(a)) return;
      a.ai.timer = 40;
      return;
    }
    if (this.showTick(a)) return;
    this.releaseSeat(a);
    a.ai.targetPlaceId = undefined;
    if (a.kind === 'animal') return this.decideAnimal(a);
    if (a.ai.working) this.endShiftIfOver(a);
    // ── each Will's own bedtime (아침형 · 보통 · 올빼미형 · 야간 근무); waking up ──
    if (this.isBedtime(a)) return this.goSleep(a);
    if (a.ai.sleeping) this.wakeUp(a);
    if (a.mood <= 20 && Math.random() < 0.4 && this.simTime - (a.ai.lastBreakAt ?? -999) > 90) return this.startBreak(a);
    // 성실함 keeps the shift; a 즉흥적 Will sometimes skips off to play (0.78 … 0.98)
    if (this.worksAtAll(a) && this.onShift(a) && Math.random() < 0.88 + a.persona.diligence * 0.1) {
      const work = this.chooseWorkplace(a);
      if (work) {
        this.noteWorkplace(a, work);
        return this.goWork(a, work);
      }
    }

    // ── the rhythm of a day ──
    const phase = this.dayPhase();
    const home = this.place(a.homeId);
    if (this.lateHours()) {
      // owls (and the sleepless) stay out; everyone else mostly drifts home before bed
      const up = this.chronotype(a) === 'owl' || (a.ai.awakeUntil ?? 0) > this.simTime;
      if (!up && home && Math.random() < 0.55) return this.goVisit(a, home);
      return this.nightActivity(a);
    }
    if ((phase === 'morning' || phase === 'lunch') && !this.hasThought(a, `meal-${phase}`)) {
      const food = this.places
        .filter((p) => (phase === 'lunch' ? MEAL_LUNCH : MEAL_MORNING).includes(p.style))
        .sort((x, y) => this.favor(a, y) - this.favor(a, x) + (Math.random() - 0.5) * 0.4 + (phase === 'lunch' && y.style === 'restaurant' ? 0.3 : 0))[0];
      const want = !food ? 0 : phase === 'lunch' ? 0.7 : 0.3 + this.favor(a, food) * 0.5;
      if (food && Math.random() < want) {
        a.ai.meal = phase === 'lunch' ? 'lunch' : 'breakfast';
        return this.goVisit(a, food);
      }
    }

    const weekend = weekdayOf(this.meta.minutes).weekend;
    // ── love and needs come before whims ──
    const lover = this.loverOf(a);
    if (lover && (phase === 'evening' || (weekend && this.hour() >= 13)) && !lover.ai.sleeping && !lover.ai.working && !this.hasThought(a, 'date-today') && Math.random() < 0.3 && this.planDate(a, lover)) return;
    const need = this.needsOf(a);
    if (need.food < 30) {
      const food = this.places.filter((p) => MEAL_LUNCH.includes(p.style) && this.openAt(p)).sort((x, y) => this.favor(a, y) - this.favor(a, x))[0];
      if (food && Math.random() < 0.7) {
        a.ai.meal = 'lunch';
        return this.goVisit(a, food);
      }
    }
    // group hangout: members drift to their group's usual spot now and then
    const hang = this.factionsOf(a.id).map((f) => this.place(f.homePlaceId)).find(Boolean);
    if (hang && Math.random() < (weekend ? 0.35 : 0.18)) return this.goVisit(a, hang);

    const raining = this.meta.weather === 'rain' || this.meta.weather === 'storm';
    // favourite place scoring
    let bestPlace: Place | undefined;
    let bestScore = -1;
    for (const p of this.places) {
      if (p.style === 'home' && p.id !== a.homeId && !this.residentsOf(p).some((r) => this.feel(a.id, r.id) >= 50)) continue;
      let s = this.favor(a, p) + Math.random() * 0.35;
      if (raining && p.style !== 'park' && p.style !== 'plaza') s += 0.25;
      if ((p.style === 'bar' || p.style === 'cinema') && this.dayPhase() === 'evening') s += 0.3;
      if (p.style === 'bar' && this.dayPhase() === 'morning') s -= 0.5;
      if (p.style === 'hospital') s += a.mood < 35 ? 0.35 : -0.35;
      if (p.style === 'school' && !/학생|선생|교사/.test(a.job)) s -= 0.25;
      if (this.aversion(a, p) > 0.5) s -= 0.6;
      if (s > bestScore) {
        bestScore = s;
        bestPlace = p;
      }
    }
    // evenings are for favourite places and friends; mornings are quieter
    const eve = (phase === 'evening' ? 1.4 : phase === 'morning' ? 0.7 : 1) * (weekend ? 1.3 : 1);
    const wVisit = bestPlace ? (0.9 + bestScore * 2.5) * eve * (need.fun < 30 ? 1.6 : 1) : 0;
    const wWander = (raining ? 0.4 : 1) * (phase === 'evening' ? 0.7 : 1);
    const wIdle = phase === 'morning' ? 0.9 : 0.5;
    // lonely Wills go looking for company; bored ones for their favourite places
    const wSocial = (a.mood >= 80 ? 1.6 : a.mood <= 30 ? 0.2 : 0.5) * (1 + a.persona.social * 0.6) * eve * (need.social < 30 ? 2.5 : 1);
    const total = wVisit + wWander + wIdle + wSocial;
    let r = Math.random() * total;
    if ((r -= wVisit) < 0 && bestPlace) return this.goVisit(a, bestPlace);
    if ((r -= wWander) < 0) return this.wander(a, Math.round(10 + a.persona.curious * 5));
    if ((r -= wIdle) < 0) {
      this.setIdle(a, 2 + Math.random() * 5);
      return;
    }
    const friend = this.bestFriend(a);
    if (friend && this.canChat(a, friend)) return this.goMeet(a, friend);
    this.wander(a, 10);
  },
  /** walk over to a friend to talk */
  goMeet(this: World, a: Agent, friend: Agent) {
    a.ai.meetWith = friend.id;
    a.ai.meetForced = false;
    a.ai.mode = 'goto';
    a.ai.timer = 30;
    const ft = this.tileOf(friend);
    this.pathTo(a, ft.tx, ft.ty);
  },
  bestFriend(this: World, a: Agent): Agent | undefined {
    let best: Agent | undefined;
    let bestAff = -Infinity;
    for (const b of this.agents) {
      if (b === a || b.kind !== 'person') continue;
      const aff = this.feel(a.id, b.id) + Math.random() * 25;
      if (aff > bestAff) {
        bestAff = aff;
        best = b;
      }
    }
    return best;
  },
  decideAnimal(this: World, a: Agent) {
    const owner = this.agent(a.ownerId);
    if (owner) {
      const home = this.place(owner.homeId);
      if (owner.ai.sleeping && home) {
        // curl up at home
        const spot = home.seats[home.seats.length - 1] ?? home.door;
        const t = this.tileOf(a);
        if (Math.abs(t.tx - spot.tx) + Math.abs(t.ty - spot.ty) > 1 && this.pathTo(a, spot.tx, spot.ty)) return void (a.ai.mode = 'wander');
        this.setIdle(a, 40);
        this.emote(a, '💤');
        return;
      }
      // far away → trot back to them; close by → mostly stay near, sometimes sniff around
      const far = Math.hypot(a.x - owner.x, a.y - owner.y) > 5 * TILE;
      if (far || Math.random() < 0.6) {
        const t = this.tileOf(owner);
        const spot = this.map.nearestWalkable(t.tx + (Math.random() < 0.5 ? -1 : 1), t.ty + 1);
        a.ai.mode = 'wander';
        if (this.pathTo(a, spot.tx, spot.ty) || this.pathTo(a, t.tx, t.ty)) return;
      }
    } else if (a.ownerId) a.ownerId = undefined;
    // night: most animals curl up; owls, cats, foxes and hedgehogs come out
    if (this.isNight() && !NOCTURNAL.has(a.layers.species)) {
      this.setIdle(a, 30 + Math.random() * 30);
      this.emote(a, '💤');
      return;
    }
    if (this.isNight() && a.layers.species === 'owl' && Math.random() < 0.25) this.say(a, '부엉~ 부엉~', { silentFeed: true });
    const r = Math.random();
    if (r < 0.3) {
      this.setIdle(a, 8 + Math.random() * 14);
      this.emote(a, '💤');
      return;
    }
    if (r < 0.5) {
      // wander toward someone who likes animals
      let target: Agent | undefined;
      let best = 0.45;
      for (const b of this.agents) {
        if (b.kind !== 'person') continue;
        const f = this.favor(b, a);
        if (f > best) {
          best = f;
          target = b;
        }
      }
      if (target) {
        const t = this.tileOf(target);
        a.ai.mode = 'wander';
        if (this.pathTo(a, t.tx + 1, t.ty)) return;
      }
    }
    this.wander(a, 6);
  },
  wander(this: World, a: Agent, radius: number) {
    this.releaseSeat(a);
    const t = this.tileOf(a);
    const dest = this.map.randomWalkable(Math.random, { tx: t.tx, ty: t.ty, r: radius });
    a.ai.mode = 'wander';
    a.ai.targetPlaceId = undefined;
    a.ai.timer = 0;
    if (!this.pathTo(a, dest.tx, dest.ty)) this.setIdle(a, 2);
  },
  goVisit(this: World, a: Agent, p: Place, sleeping = false) {
    a.ai.working = false;
    a.ai.sleeping = sleeping;
    if (sleeping) a.ai.meal = undefined;
    let seat = p.seats.find((s) => !this.seatTaken.has(`${s.tx},${s.ty}`));
    if (!seat) {
      const inn = this.inwardOf(p);
      seat = this.map.randomWalkable(Math.random, { tx: p.door.tx + inn.dx * 2, ty: p.door.ty + inn.dy * 2, r: 1 });
    }
    this.seatTaken.set(`${seat.tx},${seat.ty}`, a.id);
    a.ai.mode = 'goto';
    a.ai.targetPlaceId = p.id;
    a.ai.timer = 0;
    if (!this.pathTo(a, seat.tx, seat.ty)) this.wander(a, 6);
  },
  enterVisit(this: World, a: Agent, p: Place) {
    a.ai.mode = 'visit';
    a.ai.timer = 14 + Math.random() * 22;
    a.facing = this.inwardOf(p).facing;
    if (a.ai.working) return this.startWork(a, p);
    if (a.ai.sleeping) {
      a.ai.timer = 40 + Math.random() * 40; // re-checked by decide(); stays asleep while it's night
      this.emote(a, '💤');
      return;
    }
    if (a.kind === 'person') {
      const n = this.needsOf(a);
      if (a.ai.meal || ['restaurant', 'bakery', 'cafe', 'store'].includes(p.style)) n.food = Math.min(100, n.food + (a.ai.meal ? 60 : 30));
      if (this.favor(a, p) >= 0.4 || ['karaoke', 'cinema', 'park', 'bar', 'gym'].includes(p.style)) n.fun = Math.min(100, n.fun + 25);
      if (a.ai.dateWith) this.dateMoment(a, p);
    }
    if (a.ai.meal) {
      const lunch = a.ai.meal === 'lunch';
      a.ai.meal = undefined;
      this.addThought(a, lunch ? 'meal-lunch' : 'meal-morning', lunch ? '점심을 맛있게 먹음' : '모닝커피로 하루를 시작함', 3, lunch ? 300 : 240);
      this.emote(a, lunch ? '🍙' : '☕');
      if (Math.random() < 0.25) this.say(a, lunch ? pick(['(배부르다~)', '(오늘 점심 성공.)', '(역시 여기 밥이 최고야.)']) : pick(['(커피 한 잔이면 충분해.)', '(이제 좀 정신이 드네.)']), { thought: true, silentFeed: true });
    }
    // regulars: the place remembers who keeps coming back
    const n = (p.regulars[a.id] = (p.regulars[a.id] ?? 0) + 1);
    if (n === 3) this.log(p, 'event', `${josa(a.name, '이/가')} 요즘 자주 온다. 단골이 될 것 같다.`, a.id);
    else if (n === 10) this.log(p, 'event', `${josa(a.name, '은/는')} 이제 누가 봐도 이곳의 단골이다.`, a.id);
    // leisure costs a little (always far below income)
    // simplified economy: you only pay when comfortably able to → income always wins
    const price = PRICE[p.style];
    if (price > 0 && a.money > price * 3) a.money -= price;
    const f = this.favor(a, p);
    if (f >= 0.4) {
      const sing = p.style === 'karaoke';
      const label = sing ? `좋아하는 ${p.name}에서 열창함` : `좋아하는 ${p.name}에서 시간을 보냄`;
      if (this.addThought(a, `place:${p.id}`, label, sing ? 15 : 10, 180)) {
        this.log(a, 'diary', sing ? `${p.name}에서 목이 쉬도록 노래했다. 속이 뻥 뚫렸다!` : `${p.name}에 갔다. 역시 여기가 좋다.`);
        this.log(p, 'event', `${josa(a.name, '이/가')} 즐거운 시간을 보냈다.`, a.id);
      }
      this.emote(a, STYLE_EMOTE[p.style]);
    }
    if (p.style === 'office' && a.traits.some((t) => /야근/.test(t))) this.addThought(a, 'overtime', '또 야근이다…', -4, 120);
    this.visitEffect(a, p);
    this.nightVisitEffect(a, p);
  },
  /** What each kind of facility does for a visitor (small, always-on flavour on top of favourites). */
  visitEffect(this: World, a: Agent, p: Place) {
    const fx: Partial<Record<PlaceStyle, [string, number, number, string, string]>> = {
      // [label, mood, minutes, diary, emote]
      gym: ['땀 흘리며 운동해서 개운함', 6, 200, `${p.name}에서 땀을 쫙 뺐다. 몸이 가볍다.`, '💪'],
      cinema: ['영화의 여운이 남음', 8, 240, `${p.name}에서 영화를 봤다. 장면 하나가 계속 떠오른다.`, '🎬'],
      bar: ['한잔하며 털어놓음', 6, 180, `${p.name}에서 한잔했다. 하루가 조금 가벼워졌다.`, '🍺'],
      flower: ['꽃 한 송이를 샀음', 5, 240, `${p.name}에서 꽃을 한 송이 샀다. 방이 환해질 것 같다.`, '💐'],
      bakery: ['갓 구운 빵 냄새에 기분 좋음', 4, 180, `${p.name} 빵 냄새는 반칙이다.`, '🥐'],
      restaurant: ['든든하게 한 끼 먹음', 4, 200, `${p.name}에서 든든하게 먹었다.`, '🍲'],
      hospital: [a.mood < 40 ? '진료를 받고 마음이 놓임' : '건강 검진을 받음', a.mood < 40 ? 8 : 2, 300, `${p.name}에 다녀왔다. 괜찮다는 말을 들으니 안심이 된다.`, '🩺'],
      school: ['오랜만에 배우는 즐거움', 3, 240, `${p.name}에 들렀다. 칠판 냄새가 그립다.`, '✏️'],
    };
    const e = fx[p.style];
    if (!e || a.ai.working) return;
    const [label, mood, mins, diary, emo] = e;
    if (this.addThought(a, `visit:${p.style}`, label, mood, mins)) {
      if (Math.random() < 0.5) this.log(a, 'diary', diary);
      this.emote(a, emo);
    }
  },
  visitTick(this: World, a: Agent) {
    const p = this.place(a.ai.targetPlaceId);
    if (a.ai.sleeping) {
      if (Math.random() < 0.06) this.emote(a, '💤');
      return;
    }
    if (!p || Math.random() > 0.08) return;
    if (a.ai.working) {
      const lines = p.style === 'school' && /학생/.test(a.job) ? STUDENT_LINES : WORK_LINES[p.style];
      if (lines && Math.random() < 0.5) this.say(a, pick(lines), { silentFeed: Math.random() < 0.7 });
      else this.emote(a, STYLE_EMOTE[p.style]);
      return;
    }
    if (Math.random() < 0.25) return this.innerMonologue(a);
    if (Math.random() < 0.04 && this.favor(a, p) >= 0.4 && a.kind === 'person' && this.simTime - (a.ai.lastMonologueAt ?? -1e9) > 240) {
      a.ai.lastMonologueAt = this.simTime;
      const text = this.composeMonologue(a);
      this.speakPolished(a, `(${text})`, a.id === this.watchedId, { thought: true, kind: 'monologue' });
      return;
    }
    if (p.style === 'karaoke') {
      this.emote(a, '🎵');
      this.say(a, a.mood > 40 ? pick(HUM) : pick(SAD_SONG), { silentFeed: Math.random() < 0.6 });
    } else this.emote(a, STYLE_EMOTE[p.style]);
  },
};
