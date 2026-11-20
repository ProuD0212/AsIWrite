// World · 대화 — 시작 · 대사 고르기 · 앞 말에 대답하기
// These are methods of the World class kept in their own file. They are installed on
// World.prototype at the end of World.ts, so callers keep writing world.someMethod() as before.

import { AGREE, ARGUE, COMFORT, GENERIC_DISLIKE, GENERIC_DREAM, GENERIC_LIKE, GREET, GREET_CLOSE, GREET_COLD, HAPPY, MUSE, SAD, topicLine, NIGHT_GREET } from '../../presets/banter';
import { hearsay, makeTag, type Rumor } from '../rumors';
import { copula, extractDream, extractObject, josa, suffix, toBanmal, traitPolarity } from '../traits';
import { type Agent } from '../types';
import { pick, uid } from '../util';
import { givenName, World, type Conversation, type ConvoAct } from '../World';

export const conversationMethods = {
  // ───────────────────────── conversations ─────────────────────────
  convoOf(this: World, a: Agent) {
    return this.convos.find((c) => c.members.includes(a.id));
  },
  startConvo(this: World, members: Agent[], argue: boolean) {
    const [a, b] = members;
    // shared topic = most similar pair of traits
    let topic = a.traits.length ? pick(a.traits) : '날씨';
    let topicSim = 0;
    for (const ta of a.traits)
      for (const tb of b.traits) {
        const s = this.matcher.similarity(ta, tb);
        if (s > topicSim) {
          topicSim = s;
          topic = Math.random() < 0.5 ? ta : tb;
        }
      }
    const c: Conversation = {
      id: uid('c'), members: members.map((m) => m.id), topic, topicSim, nextAt: this.simTime + 0.3,
      lines: 0, maxLines: argue ? 3 : 4 + Math.floor(Math.random() * 4), argue, initiator: a.id,
    };
    this.convos.push(c);
    for (const m of members) {
      this.releaseSeat(m);
      m.ai.mode = 'chat';
      m.ai.path = [];
      m.ai.pathIndex = 0;
      m.ai.partnerId = members.find((x) => x !== m)?.id;
    }
    this.faceEachOther(c);
  },
  joinConvo(this: World, c: Conversation, a: Agent) {
    // not everyone likes being interrupted: reserved or sensitive Wills, or a close 1:1 talk
    const intimate = c.members.length === 2 && this.feel(c.members[0], c.members[1]) >= 50;
    for (const id of c.members) {
      const m = this.agent(id);
      if (!m || this.feel(m.id, a.id) >= 15) continue;
      if ((intimate || m.persona.social < -0.2 || m.persona.sensitive > 0.4) && Math.random() < 0.7) {
        this.addFeel(m.id, a.id, -4);
        this.addThought(m, `intrude:${a.id}`, `${josa(a.name, '이/가')} 대화에 불쑥 끼어들어 언짢음`, -3, 90);
        if (intimate && Math.random() < 0.6) this.say(m, pick(['(둘이 얘기하던 중이었는데…)', '(아, 타이밍이…)', '(조금 아쉽네.)']), { thought: true });
      }
    }
    c.members.push(a.id);
    c.maxLines += 2;
    this.releaseSeat(a);
    a.ai.mode = 'chat';
    a.ai.path = [];
    a.ai.pathIndex = 0;
    this.emote(a, '❓');
    const first = this.agent(c.members[0]);
    this.say(a, first ? `뭐 해요? 저도 껴도 돼요?` : '안녕하세요!');
    this.faceEachOther(c);
  },
  faceEachOther(this: World, c: Conversation) {
    const ms = c.members.map((id) => this.agent(id)).filter(Boolean) as Agent[];
    const cx = ms.reduce((s, m) => s + m.x, 0) / ms.length;
    const cy = ms.reduce((s, m) => s + m.y, 0) / ms.length;
    for (const m of ms) {
      const dx = cx - m.x, dy = cy - m.y;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
      m.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    }
  },
  tickConvos(this: World) {
    for (const c of [...this.convos]) {
      const ms = c.members.map((id) => this.agent(id)).filter(Boolean) as Agent[];
      if (ms.length < 2 && !c.waiting) {
        this.endConvo(c);
        continue;
      }
      if (c.waiting) continue; // the storyteller is still writing this line — everyone waits for it
      if (this.simTime < c.nextAt) continue;
      // a reply that has to come next (defending a friend, answering a confession…)
      if (c.forced) {
        const f = c.forced;
        c.forced = undefined;
        const sp = this.agent(f.speakerId), li = this.agent(f.toId);
        if (sp && li) {
          this.speakInConvo(c, sp, li, f.text, f.icon, false, false);
          continue;
        }
      }
      const choices = ms.filter((m) => m.id !== c.lastSpeaker);
      const speaker = pick(choices.length ? choices : ms);
      const others = ms.filter((m) => m !== speaker);
      const listener = others.find((o) => o.id === c.lastSpeaker) ?? pick(others); // answer whoever just spoke
      c.pendingAct = undefined;
      let line = this.lineFor(c, speaker, listener) as { text: string; icon?: string; long?: boolean; named?: boolean };
      const said = (t: string) => (c.history ?? []).some((h) => h.text.replace(/^[^,]{1,12}, /, '').replace(/[.!?…\s]/g, '').includes(t.replace(/[.!?…\s]/g, '')));
      for (let i = 0; i < 3 && said(line.text) && (!c.pendingAct || /^(like|dislike|dream|happy)$/.test((c.pendingAct as Conversation['pendingAct'])!.kind)); i++) {
        c.pendingAct = undefined;
        line = this.lineFor(c, speaker, listener) as typeof line;
      }
      const { text, icon } = line;
      // address the listener by name now and then so it's clear who is talking to whom
      const vocChance = c.lines === 0 ? 0.75 : c.members.length > 2 ? 0.6 : 0.3;
      const casual = this.speaksCasually(speaker, listener);
      const body = casual ? toBanmal(text) : text;
      const spoken = !line.long && !text.startsWith('(') && !line.named && Math.random() < vocChance ? `${this.callName(speaker, listener)}, ${body}` : body;
      // Layer 2: how much to rewrite follows this computer's spare capacity; never at 3× and up
      const watched = !!this.watchedId && (speaker.id === this.watchedId || listener.id === this.watchedId);
      const cap = this.simSpeed >= 3 ? 0 : World.storyCapacity();
      const chance = cap === 0 ? 0 : line.long ? 1 : c.argue ? 0 : c.lines === 0 ? cap * 0.5 : watched ? Math.max(0.8, cap) : cap;
      if (Math.random() < chance) {
        // buffered: hold the line until the rewrite arrives, then say it once ("…" meanwhile)
        const kind = line.long ? 'monologue' : 'line';
        c.waiting = true;
        speaker.bubble = { text: '…', born: this.simTime, life: 60, thought: false };
        const ok = this.requestPolish(kind, speaker, spoken, listener, c.topic, line.long || watched, c.history ?? [], (final, ai) => {
          c.waiting = false;
          if (speaker.bubble?.text === '…') speaker.bubble = undefined;
          this.speakInConvo(c, speaker, listener, final, icon, !!line.long, ai);
        });
        if (ok) continue;
        c.waiting = false;
        speaker.bubble = undefined;
      }
      // not rewritten this time: a line learned from earlier rewrites of the same template, if any
      const learned = !line.long && !c.argue && Math.random() < 0.75 ? World.learnedLine?.(spoken, speaker, listener) : null;
      this.speakInConvo(c, speaker, listener, learned ?? spoken, icon, !!line.long, false, !!learned);
    }
  },
  /** Say one conversation line (after any rewrite) and move the conversation on. */
  speakInConvo(this: World, c: Conversation, speaker: Agent, listener: Agent, text: string, icon: string | undefined, long: boolean, ai: boolean, learned = false) {
    // fast-forward (5× and up): lines still happen (bubbles, effects) but the log gets one summary at the end
    const quiet = this.simSpeed >= 5;
    const fi = this.say(speaker, text, { kind: long ? 'monologue' : 'line', to: listener, silentFeed: quiet });
    if (fi && ai) fi.ai = true;
    if (fi && learned) fi.learned = true;
    if (quiet) c.quiet = (c.quiet ?? 0) + 1;
    if (icon) this.emote(speaker, icon);
    (c.history ??= []).push({ name: speaker.name, text });
    if (c.history.length > 4) c.history.shift();
    c.lastSpeaker = speaker.id;
    c.lastText = text;
    c.lastAct = c.pendingAct ? { ...c.pendingAct, by: speaker.id } : undefined;
    c.pendingAct = undefined;
    c.lines++;
    // a calmer pace so lines can actually be read (and slower game speeds stretch it further)
    c.nextAt = this.simTime + (long ? 6 : 3.4 + Math.random() * 1.8);
    const hanging = c.lastAct && /^(greet|ask|like|dislike|secret|monologue|sad|comfortNeeded|differ|birthday)/.test(c.lastAct.kind) && c.lines < c.maxLines + 2;
    if (c.lines >= c.maxLines && !c.forced && !hanging && this.convos.includes(c)) this.endConvo(c);
  },
  lineFor(this: World, c: Conversation, s: Agent, l: Agent): { text: string; icon?: string } {
    const rel = this.relation(s.id, l.id);
    if (c.argue) return { text: pick(ARGUE), icon: '💢' };
    const greet = (text: string, icon?: string) => {
      c.pendingAct = { kind: 'greet', ask: /(어땠|어때|잘 지냈|뭐 해|뭐 하|괜찮|어디 가)/.test(text), obj: /날씨/.test(text) ? '날씨' : /어디 가/.test(text) ? '어디' : undefined };
      return { text, icon };
    };
    if (c.lines === 0 && this.isBirthday(l) && !this.wished.get(l.id)?.has(s.id) && (this.feel(s.id, l.id) >= 0 || this.rumors.rumors.some((r) => /생일/.test(r.text) && r.about.includes(l.id) && r.knownBy.includes(s.id)))) {
      (this.wished.get(l.id) ?? this.wished.set(l.id, new Set()).get(l.id)!).add(s.id);
      c.pendingAct = { kind: 'birthdayWish' };
      return { text: pick(['생일 축하해요! 오늘 좋은 일만 가득하길!', '오늘 생일이라면서요? 진짜 축하해요!', '생일 축하해요! 선물은 못 챙겼지만 마음만은 가득이에요.']), icon: '🎂' };
    }
    if (c.lines === 0 && this.isBirthday(s) && !this.wished.get(s.id)?.has(l.id) && this.feel(s.id, l.id) >= 20 && Math.random() < 0.6) {
      c.pendingAct = { kind: 'birthdayNews' };
      return { text: pick(['있잖아요… 사실 오늘 제 생일이에요!', '헤헤, 오늘 제 생일인 거 알아요?']), icon: '🎂' };
    }
    if (c.lines === 0 && this.peekRelation(s.id, l.id)?.status === 'lovers') return greet(pick(['보고 싶었어!', '오늘 하루 어땠어?', '왔어? 기다렸잖아.', '같이 있으니까 좋다.']), '💕');
    if (c.lines === 0) {
      const mine = this.feel(s.id, l.id);
      const h = this.hour();
      // picking up where they left off last time
      const last = this.peekRelation(s.id, l.id)?.lastTopic;
      if (last && mine > -10 && Math.random() < 0.3) {
        c.topic = last;
        const o = extractObject(last) ?? extractDream(last) ?? (last.length <= 12 && !/다$/.test(last) ? last : null);
        if (o) {
          c.pendingAct = { kind: 'recall', obj: o };
          return { text: pick([`지난번에 했던 ${o} 얘기요, 그 뒤로 계속 생각났어요.`, `아, 저번에 말한 ${o} 말인데요…`, `그때 얘기한 ${o}, 기억나요?`]), icon: '💭' };
        }
      }
      if ((h >= 23 || h < 5) && mine > -30 && Math.random() < 0.6) return greet(pick(NIGHT_GREET), '🌙');
      if (mine >= 40) return greet(pick(GREET_CLOSE), '❤️');
      if (mine <= -30) return greet(pick(GREET_COLD), '💭');
      return greet(pick(GREET), Math.random() < 0.4 ? '👋' : undefined);
    }
    // first, answer what the other person just said (agree, ask back, defend a friend, say thanks…)
    const mustAnswer = !!c.lastAct && (c.lastAct.ask || /^(ask|secret|monologue|comfort|recall|shared|explained|birthday)/.test(c.lastAct.kind));
    if (c.lastAct?.by === l.id && (mustAnswer || Math.random() < 0.85)) {
      const r = this.reactTo(c, s, l);
      if (r) return r;
    }
    const caring = s.persona.kind > 0.3 || s.traits.some((t) => /(우울해 보이|위로|웃게|정이 많)/.test(t));
    if (l.mood <= 30 && (caring || s.mood >= 70) && Math.random() < 0.55) {
      if (this.addThought(l, `comfort:${s.id}`, `${josa(s.name, '이/가')} 위로해 줌`, 8, 180)) {
        this.addFeel(l.id, s.id, 6); // the comforted one remembers it
        this.log(l, 'diary', `${josa(s.name, '이/가')} 내 얘기를 들어줬다. 조금 힘이 났다.`, s.id);
        rel.memories.push({ t: this.meta.minutes, text: `${josa(s.name, '이/가')} 우울해하던 ${josa(l.name, '을/를')} 위로했다.` });
      }
      c.pendingAct = { kind: 'comfort' };
      return { text: pick(COMFORT), icon: '❤️' };
    }
    if (s.mood <= 25 && Math.random() < 0.5) {
      c.pendingAct = { kind: 'sad' };
      return { text: pick(SAD), icon: '💧' };
    }
    // answer what was just said: a question gets an answer, not a brand-new topic
    if (!c.lastAct && c.lastText && c.lastSpeaker === l.id && /\?["”]?\s*$/.test(c.lastText) && Math.random() < 0.75) {
      const mine = s.traits.reduce((m, t) => Math.max(m, this.matcher.similarity(t, c.topic)), 0);
      return mine >= 0.5
        ? { text: pick(['네! 저도 그거 진짜 좋아해요.', '맞아요, 저도 딱 그래요.', '오, 저도 관심 많아요!', '그럼요, 저도 자주 그래요.']), icon: '😊' }
        : { text: pick(['음, 저는 잘 모르겠어요. 그래도 재밌겠네요.', '저는 그쪽은 잘 몰라서요… 더 얘기해 줘요.', '글쎄요, 저는 아직 안 해 봤어요.']), icon: '💭' };
    }
    // talking about someone who isn't here: badmouthing (험담) or praise
    if (c.lines >= 1 && Math.random() < 0.14) {
      const g = this.gossipLine(c, s, l);
      if (g) return g;
    }
    // agreeing with the previous speaker when the topic is shared
    if (c.topicSim >= 0.45 && c.lines === 2 && Math.random() < 0.6) return { text: pick(AGREE), icon: '❤️' };
    // confiding a crush to a close friend ("비밀이에요!") — secrets have a way of travelling
    if (c.lines >= 1 && c.members.length === 2 && Math.random() < 0.18) {
      const crush = this.agents.find((x) => x.kind === 'person' && x !== s && x !== l && this.feel(s.id, x.id) >= 65 && this.peekRelation(s.id, x.id)?.status !== 'lovers');
      if (crush && this.feel(s.id, l.id) >= 45 && !this.rumors.rumors.some((r) => r.secretOf === s.id && r.about.includes(crush.id))) {
        this.rumors.add({
          text: hearsay(`${josa(s.name, '이/가')} ${josa(crush.name, '을/를')} 좋아한다`), tag: makeTag('짝사랑', [s.name, crush.name]), about: [s.id, crush.id],
          sentiment: 0.3, knownBy: [l.id], origin: 'natural', born: this.meta.minutes, kind: 'romance', heat: 10, secretOf: s.id, confidant: l.id,
        });
        this.log(s, 'diary', `${l.name}에게만 ${crush.name} 얘기를 털어놓았다. 비밀 지켜 주겠지?`, l.id);
        c.pendingAct = { kind: 'secret', about: [crush.id] };
        return { text: `사실… 저 ${this.referName(s, crush)} 좋아하는 것 같아요. 비밀이에요!`, icon: '🤫' };
      }
    }
    // gossip: pass on a rumor the listener hasn't heard
    if (c.lines >= 1 && Math.random() < 0.22) {
      const r = this.rumors.pickToTell(s.id, l.id);
      // a good friend keeps a secret (mostly)
      const keeps = r?.secretOf && this.feel(s.id, r.secretOf) >= 60 && Math.random() < 0.7;
      if (r && !keeps) {
        const aboutListener = r.about.includes(l.id);
        const text = aboutListener ? `${this.callName(s, l)}, 혹시 알아요? 요즘 이런 얘기가 돌던데… "${r.text}"` : pick([`그거 들었어요? ${r.text}.`, `있잖아요, ${r.text}.`, `소문 들었어요? ${r.text}!`]);
        this.hearRumor(l, r, s);
        c.pendingAct = { kind: 'rumor', about: r.about, sentiment: r.sentiment };
        return { text, icon: '💬', named: aboutListener } as { text: string; icon?: string };
      }
    }
    // a rare long-form heart-to-heart — the small hours make people more candid
    const lateNight = this.hour() >= 23 || this.hour() < 5;
    if (!c.monologued && this.simTime - (s.ai.lastMonologueAt ?? -1e9) > 240 && c.members.length === 2 && c.lines >= 2 && (this.feel(s.id, l.id) >= (lateNight ? 30 : 45) || (s.mood <= 28 && l.persona.kind > 0.2)) && Math.random() < (lateNight ? 0.4 : 0.2)) {
      c.monologued = true;
      s.ai.lastMonologueAt = this.simTime;
      const text = this.composeMonologue(s, l);
      this.addFeel(l.id, s.id, 8); // being trusted with a secret moves the listener most
      this.addFeel(s.id, l.id, 4);
      rel.memories.push({ t: this.meta.minutes, text: `${josa(s.name, '이/가')} ${l.name}에게 속마음을 털어놓았다: "${text.split(/(?<=[.?!…])\s/)[1] ?? text.slice(0, 30)}"` });
      this.log(l, 'diary', `${josa(s.name, '이/가')} 오늘 속마음을 털어놓았다. 왠지 더 가까워진 느낌이다.`, s.id);
      this.log(s, 'diary', `${l.name}에게 처음으로 솔직한 이야기를 했다. 조금 후련하다.`, l.id);
      this.addThought(s, `heart:${l.id}`, `${l.name}에게 속마음을 털어놓음`, 6, 300);
      c.maxLines = Math.max(c.maxLines, c.lines + 2);
      c.nextAt = this.simTime + 6; // give the long line room to be read
      c.pendingAct = { kind: 'monologue' };
      return { text, icon: '💭', long: true } as { text: string; icon?: string };
    }
    if (s.treasure && c.lines >= 2 && this.feel(s.id, l.id) >= 20 && Math.random() < 0.12) {
      c.pendingAct = { kind: 'treasure' };
      return { text: pick([`이거요? ${copula(s.treasure).replace(/이다$/, '이에요').replace(/다$/, '예요')}. 저한테는 보물이에요.`, `제 ${josa(s.treasure, '은/는')} 절대 못 버려요.`, `${s.treasure} 얘기 해 드릴까요? 사연이 좀 있어요.`]), icon: '💭' };
    }
    this.lastTopical = undefined;
    let topical = Math.random() < 0.75 ? this.topicalLine(s, c.topic) : null;
    const done = (m?: { obj?: string; dream?: string }) => !!m && !!c.covered?.includes((m.obj ?? m.dream)!);
    // already talked through: say something else (another of their own interests)
    if (topical && done(this.lastTopical) && s.traits.length) {
      this.lastTopical = undefined;
      topical = this.topicalLine(s, pick(s.traits));
      if (done(this.lastTopical)) topical = null;
    }
    if (topical) {
      const m = this.lastTopical as { obj?: string; pol?: number; dream?: string; muse?: string } | undefined;
      if (m?.muse) c.pendingAct = { kind: 'muse', obj: m.muse };
      else if (m?.dream) c.pendingAct = { kind: 'dream', obj: m.dream };
      else if (m?.obj && m.pol !== undefined) c.pendingAct = { kind: m.pol < 0 ? 'dislike' : 'like', obj: m.obj };
      const icon = /노래|♪|음악|기타/.test(topical + c.topic) ? '🎵' : this.feel(s.id, l.id) >= 50 ? '❤️' : Math.random() < 0.3 ? '💬' : undefined;
      return { text: topical, icon };
    }
    if (s.mood >= 60) {
      if (Math.random() < 0.5) c.pendingAct = { kind: 'happy' };
      return { text: pick(HAPPY), icon: Math.random() < 0.4 ? '😊' : undefined };
    }
    return { text: pick(['그렇구나…', '음, 그럴 수도 있겠네요.', '진짜요?', '아하!', '그건 몰랐어요.']), icon: Math.random() < 0.3 ? '❓' : undefined };
  },
  /**
   * Speak about a topic. Curated lines first; otherwise build a line from the
   * extracted object of ANY trait (so user-written traits are voiced too).
   */
  topicalLine(this: World, s: Agent, convoTopic: string): string | null {
    const own = s.traits.length ? pick(s.traits) : convoTopic;
    const src = Math.random() < 0.6 ? convoTopic : own;
    const curated = topicLine(src);
    const obj = extractObject(src);
    const dream = extractDream(src);
    this.lastTopical = obj ? { obj, pol: traitPolarity(src) < 0 ? -1 : 1 } : dream ? { dream } : undefined;
    if (curated && Math.random() < 0.6) return curated;
    if (obj) return traitPolarity(src) < 0 ? pick(GENERIC_DISLIKE)(obj) : pick(GENERIC_LIKE)(obj);
    if (dream) return pick(GENERIC_DREAM)(dream);
    if (/다$/.test(src) && src.length <= 28 && Math.random() < 0.5) {
      this.lastTopical = { muse: src };
      return pick(MUSE)(src);
    }
    return curated;
  },
  endConvo(this: World, c: Conversation) {
    this.convos = this.convos.filter((x) => x !== c);
    const ms = c.members.map((id) => this.agent(id)).filter(Boolean) as Agent[];
    if (ms.length === 2 && !c.argue && c.lines >= 3) this.relation(ms[0].id, ms[1].id).lastTopic = c.topic;
    if (ms.length >= 3) this.groupHistory.push({ t: this.meta.minutes, members: ms.map((m) => m.id).sort() });
    const herePlace = ms[0] ? this.placeAt(ms[0].x, ms[0].y) : undefined;
    if (c.argue && ms.length >= 2 && c.lines >= 2) this.naturalRumor(`${josa(ms[0].name, '이랑/랑')} ${josa(ms[1].name, '이/가')} ${herePlace ? herePlace.name + '에서' : '길에서'} 대판 싸웠대`, ms.slice(0, 2), ms[0], -0.5, 'fight');
    const sameSet = (h: { members: string[] }) => h.members.length === ms.length && ms.every((m) => h.members.includes(m.id));
    if (ms.length >= 4 && this.groupHistory.filter(sameSet).length >= 2) this.naturalRumor(`${ms.map((m) => m.name).join(', ')}${suffix(ms[ms.length - 1].name, '이/가')} ${herePlace ? herePlace.name + '에서' : '동네에서'} 자주 모인대`, [...ms, ...(herePlace ? [herePlace] : [])], ms[0], 0.3, 'bond');
    // the place where it happened remembers it too
    if (ms[0] && c.lines >= 3) {
      const here = this.placeAt(ms[0].x, ms[0].y);
      if (here && Math.random() < (c.argue ? 1 : 0.5)) {
        const names = ms.map((m) => m.name).join(', ');
        this.log(here, 'event', c.argue ? `${names} 사이에 언성이 높아졌다.` : `${names}${suffix(ms[ms.length - 1].name, '이/가')} 이곳에서 한참 이야기를 나눴다.`);
      }
    }
    for (let i = 0; i < ms.length; i++)
      for (let j = i + 1; j < ms.length; j++) {
        const a = ms[i], b = ms[j];
        const rel = this.relation(a.id, b.id);
        const before = rel.affinity;
        // each side feels it differently: own mood, sociability and who picked the fight
        // temperaments and values can clash: then a chat leaves them cooler, not warmer
        const awkward = c.topicSim < 0.15 && Math.random() < 0.35; // nothing in common to talk about
        const warm = (x: Agent, y: Agent) => 2 + Math.random() * 3 + c.topicSim * 7 + (x.mood - 50) / 22 + x.persona.social * 1.2 - this.clash(x, y) * 9 - (awkward ? 4 + Math.random() * 3 : 0);
        const hurt = (x: Agent) => -(c.initiator === x.id ? 3 + Math.random() * 3 : 7 + Math.random() * 6 + Math.max(0, x.persona.sensitive) * 4);
        this.addFeel(a.id, b.id, c.argue ? hurt(a) : warm(a, b));
        this.addFeel(b.id, a.id, c.argue ? hurt(b) : warm(b, a));
        if (!c.argue)
          for (const [x, y] of [[a, b], [b, a]] as const)
            if (this.clash(x, y) >= 0.6 && this.addThought(x, `clash:${y.id}`, `${josa(y.name, '와/과')}는 말이 잘 안 통한다`, -3, 180)) {
              rel.memories.push({ t: this.meta.minutes, text: `${josa(x.name, '이/가')} 보기엔 대화가 자꾸 겉돌았다.` });
              if (Math.random() < 0.5) this.log(x, 'diary', `${y.name}… 나쁜 사람은 아닌데, 이상하게 잘 안 맞는다.`, y.id);
            }
        rel.chats++;
        // one-sided feelings make stories: a crush that isn't (yet) returned
        for (const [x, y] of [[a, b], [b, a]] as const) {
          const mine = this.feel(x.id, y.id), theirs = this.feel(y.id, x.id);
          if (mine >= 65 && theirs < 30 && !rel.memories.some((m) => m.text.includes(`${josa(x.name, '이/가')} ${josa(y.name, '을/를')} 짝사랑`))) {
            rel.memories.push({ t: this.meta.minutes, text: `${josa(x.name, '이/가')} ${josa(y.name, '을/를')} 짝사랑하기 시작했다. ${y.name}은(는) 아직 모르는 눈치다.`.replace('은(는)', suffix(y.name, '은/는')) });
            this.log(x, 'diary', `요즘 자꾸 ${y.name} 생각이 난다. …이게 뭐지.`, y.id);
            this.naturalRumor(`${josa(x.name, '이/가')} ${josa(y.name, '을/를')} 좋아한다는 말이 있더라`, [x, y], x, 0.3, 'bond', 14);
          }
        }

        const topicShort = c.topic.length > 18 ? c.topic.slice(0, 18) + '…' : c.topic;
        if (rel.chats === 1) rel.memories.push({ t: this.meta.minutes, text: c.argue ? `${josa(a.name, '와/과')} ${josa(b.name, '이/가')} 처음부터 말다툼을 벌였다.` : `처음으로 대화를 나눴다. 화제: "${topicShort}"` });
        else if (c.argue) rel.memories.push({ t: this.meta.minutes, text: `말다툼을 벌였다.` });
        else if (before < 30 && rel.affinity >= 30) rel.memories.push({ t: this.meta.minutes, text: `"${topicShort}" 이야기로 꽤 친해졌다.` });
        else if (before < 60 && rel.affinity >= 60) {
          rel.memories.push({ t: this.meta.minutes, text: `서로를 깊이 신뢰하는 사이가 되었다.` });
          this.naturalRumor(`${josa(a.name, '이랑/랑')} ${b.name}, 요즘 엄청 친하대`, [a, b], a, 0.5, 'bond');
        } else if (before < 85 && rel.affinity >= 85) this.naturalRumor(`${josa(a.name, '이랑/랑')} ${b.name}, 혹시 사귀는 거 아니냐는 말이 있더라`, [a, b], b, 0.4, 'bond', 16);
        if (rel.memories.length > 40) rel.memories.shift();
      }
    // a 1:1 talk between two who like each other a lot may end in a confession
    if (ms.length === 2 && !c.argue) this.maybeConfess(ms[0], ms[1]);
    // at 5×+ the lines weren't logged one by one: one line sums the talk up
    if (c.quiet && ms.length >= 2) {
      const names = ms.map((m) => m.name).join(', ');
      const topicShort = c.topic.length > 16 ? c.topic.slice(0, 16) + '…' : c.topic;
      this.pushFeed({ kind: 'event', speakerId: ms[0].id, text: c.argue ? `💢 ${names}${suffix(ms[ms.length - 1].name, '이/가')} 말다툼을 벌였다.` : `💬 ${names}${suffix(ms[ms.length - 1].name, '이/가')} 「${topicShort}」 이야기를 나눴다 (${c.lines}마디).` });
    }
    for (const m of ms) {
      if (m.kind === 'person') {
        const n = this.needsOf(m);
        n.social = Math.min(100, n.social + (c.argue ? 8 : ms.length >= 3 ? 30 : 25));
        n.fun = Math.min(100, n.fun + (c.argue ? 0 : 6));
      }
      const others = ms.filter((x) => x !== m);
      for (const o of others) m.ai.lastChatAt[o.id] = this.simTime;
      const names = others.map((o) => o.name).join(', ');
      if (c.argue) {
        this.addThought(m, `argue:${others[0]?.id}`, `${josa(names, '와/과')} 말다툼을 함`, -8, 180);
        this.emote(m, '💢');
        this.log(m, 'diary', `${josa(names, '와/과')} 싸웠다. 기분이 나쁘다.`, others[0]?.id);
      } else {
        const key = ms.length >= 3 ? 'groupchat' : `chat:${others[0]?.id}`;
        this.addThought(m, key, ms.length >= 3 ? '여럿이서 왁자지껄 떠듦' : `${josa(names, '와/과')} 즐거운 대화를 나눔`, ms.length >= 3 ? 8 : 5, 120);
        if (Math.random() < 0.5) this.log(m, 'chat', `${josa(names, '와/과')} 이야기를 나눴다.`, others[0]?.id);
      }
      m.ai.partnerId = undefined;
      this.setIdle(m, 0.8 + Math.random() * 1.5);
    }
  },
  /** how `s` feels about a thing: +1 likes, -1 dislikes, 0 no idea (from their own traits) */
  stance(this: World, s: Agent, obj: string): number {
    let best = 0, pol = 0;
    for (const t of s.traits) {
      const o = extractObject(t);
      const v = o && (o === obj || o.includes(obj) || obj.includes(o)) ? 1 : this.matcher.similarity(t, obj);
      if (v > best) {
        best = v;
        pol = traitPolarity(t);
      }
    }
    return best >= 0.55 ? Math.sign(pol) || 1 : 0;
  },
  /**
   * The answer to the line the listener just said — agreeing, disagreeing, asking back, defending a
   * friend, thanking… Returns null when there's nothing natural to say back (then a new line starts).
   * Every reply also says what it is (`c.pendingAct`) so the other person can answer it in turn.
   */
  reactTo(this: World, c: Conversation, s: Agent, l: Agent): { text: string; icon?: string } | null {
    const act = c.lastAct;
    if (!act || act.by !== l.id) return null;
    const next = (a?: Omit<ConvoAct, 'by'>) => void (c.pendingAct = a);
    const X = act.obj ?? '';
    // "사진 찍는 것" + 요 → "사진 찍는 거요"
    const Xyo = `${X.replace(/것$/, '거')}요`;
    if (X && /^(like|dislike|dream)$/.test(act.kind)) (c.covered ??= []).push(X);
    switch (act.kind) {
      case 'greet': {
        if (act.ask && act.obj === '어디') {
          const p = this.place(s.ai.targetPlaceId);
          return next(), { text: p ? (p.id === s.homeId ? '집에 가는 길이에요.' : `${p.name}에 가는 길이에요. 같이 갈래요?`) : pick(['그냥 산책 중이에요.', '딱히 정한 데는 없어요, 하하.']) };
        }
        if (act.ask && act.obj === '날씨') {
          const wx = { clear: pick(['맑아서 좋네요! 산책하기 딱이에요.', '햇살이 좋아요. 기분까지 좋아지네요.']), rain: pick(['비가 와서 좀 꿉꿉하네요.', '빗소리 듣기엔 좋은 날이에요.']), snow: pick(['눈 와요! 왠지 설레네요.', '춥지만 눈은 예쁘네요.']), storm: pick(['바람이 장난 아니에요. 조심해요!', '오늘은 집에 있고 싶네요.']) }[this.meta.weather];
          return next(), { text: wx };
        }
        if (act.ask) {
          const top = this.thoughtsSorted(s)[0];
          const why = top ? top.label.replace(/[!.]$/, '') : '';
          if (s.mood >= 65) return next(), { text: top && top.value > 0 ? `좋았어요! ${why}… 그래서 그런가 봐요.` : '좋았어요! 그쪽은요?', icon: '😊' };
          if (s.mood >= 40) return next({ kind: 'askBack' }), { text: '그럭저럭요. 그쪽은 어땠어요?' };
          return next({ kind: 'sad' }), { text: top && top.value < 0 ? `솔직히 좀 지쳤어요… ${why}.` : '솔직히 좀 지쳤어요…', icon: '💧' };
        }
        const mine = this.feel(s.id, l.id);
        if (mine <= -30) return next(), { text: pick(['…아, 네.', '네, 뭐.']), icon: '💭' };
        const wx = { clear: '오늘 날씨 좋네요.', rain: '비가 꽤 오네요.', snow: '눈 오니까 기분 좋네요.', storm: '바람이 엄청 부네요.' }[this.meta.weather];
        if (mine >= 40) return next(), { text: pick(['반가워요!', '오, 마침 보고 싶었는데!', `왔어요? ${wx}`]), icon: '😊' };
        return next(), { text: pick([`안녕하세요! ${wx}`, '아, 안녕하세요!', `네, 반가워요. ${wx}`]) };
      }
      case 'askBack':
        return next(), { text: s.mood >= 60 ? pick(['저는 꽤 좋았어요!', '저도 나쁘지 않았어요.']) : pick(['저도 그냥 그랬어요.', '저는 좀 피곤했어요, 하하.']) };
      case 'like': {
        const st = this.stance(s, X);
        if (st > 0) {
          this.addFeel(s.id, l.id, 2);
          this.addFeel(l.id, s.id, 2);
          return next({ kind: 'shared', obj: X }), { text: pick([`저도 ${josa(X, '을/를')} 정말 좋아해요!`, `오, ${X}! 저도 완전 좋아해요.`, `${X} 얘기 나오니까 반갑네요. 저도 좋아하거든요.`]), icon: '❤️' };
        }
        if (st < 0) return next({ kind: 'differ', obj: X }), { text: pick([`아… 저는 ${josa(X, '은/는')} 좀 별로라서요.`, `${Xyo}? 저랑은 잘 안 맞더라고요, 하하.`]), icon: '💭' };
        return next({ kind: 'askWhy', obj: X }), { text: pick([`${Xyo}? 어떤 점이 좋아요?`, `오, ${X}! 어떻게 좋아하게 됐어요?`]), icon: '❓' };
      }
      case 'shared':
        return next(), { text: pick(['역시 통하네요! 다음에 그 얘기 더 해요.', '이렇게 잘 통하는 사람 오랜만이에요.', '우리 취향 진짜 비슷하네요!']), icon: '😊' };
      case 'differ': {
        return next({ kind: 'askLike' }), { text: pick(['그래요? 그럼 뭘 좋아해요?', '아하, 사람마다 다르죠. 그쪽은 뭘 좋아해요?']) };
      }
      case 'askLike': {
        const likes = s.traits.filter((t) => traitPolarity(t) > 0).map(extractObject).filter(Boolean) as string[];
        if (!likes.length) return next(), { text: '음… 저는 아직 딱히 없어요. 찾는 중이에요.' };
        const o = pick(likes);
        return next({ kind: 'like', obj: o }), { text: pick([`저는 ${josa(o, '을/를')} 좋아해요.`, `저요? ${o} 얘기라면 하루 종일도 해요.`]) };
      }
      case 'askWhy':
        return next({ kind: 'explained' }), { text: pick([`그냥 ${josa(X, '을/를')} 생각만 해도 기분이 좋아져요.`, '처음엔 우연이었는데, 어느새 푹 빠졌어요.', '말로 하긴 어려운데… 그냥 마음이 편해져요.']), icon: '😊' };
      case 'explained':
        return next(), { text: pick(['그렇구나, 저도 한번 관심 가져 볼게요.', '듣고 보니 저도 궁금해지네요.', '그런 게 있다는 게 부럽네요.']) };
      case 'dislike': {
        const st = this.stance(s, X);
        if (st < 0) {
          this.addFeel(s.id, l.id, 2);
          return next(), { text: pick([`맞아요, 저도 ${josa(X, '은/는')} 좀…`, '그쵸? 저만 그런 게 아니었네요.']), icon: '😅' };
        }
        if (st > 0) return next(), { text: pick([`에이, ${josa(X, '은/는')} 좋은데요!`, `전 ${X} 좋아하는데… 아쉽네요.`]), icon: '💭' };
        return next({ kind: 'askWhyNot' }), { text: pick([`${X}에 무슨 안 좋은 기억 있어요?`, '왜요, 무슨 일 있었어요?']), icon: '❓' };
      }
      case 'askWhyNot':
        return next(), { text: pick(['예전에 좀 안 좋은 일이 있었거든요.', '그냥… 이유는 잘 모르겠는데 싫어요.', '얘기하자면 길어요, 하하.']) };
      case 'dream': {
        const mine = s.traits.map(extractDream).find(Boolean);
        const same = mine && this.matcher.similarity(mine, X) >= 0.5;
        return next({ kind: 'cheered' }), { text: same ? '저도 비슷한 꿈이 있어요! 우리 같이 힘내요.' : pick(['멋진 꿈이네요. 꼭 이루실 거예요!', '와, 응원할게요!', '그 꿈 이루면 제일 먼저 알려 줘요.']), icon: '✨' };
      }
      case 'cheered':
      case 'comforted':
        return next(), { text: pick(['고마워요, 힘이 나요!', '그렇게 말해 주니까 좋네요.', '헤헤, 고마워요.']), icon: '😊' };
      case 'comfort':
        return next(), { text: pick(['고마워요… 조금 나아졌어요.', '그렇게 말해 주니까 힘이 나요.', '들어 줘서 고마워요.']), icon: '🥲' };
      case 'sad': {
        if (s.persona.kind > 0 || this.feel(s.id, l.id) >= 30) return next({ kind: 'askSad' }), { text: pick(['무슨 일 있어요?', '괜찮아요? 얼굴이 안 좋아 보여요.']), icon: '💭' };
        return null;
      }
      case 'askSad': {
        const low = this.thoughtsSorted(s).find((t) => t.value < 0);
        return next({ kind: 'comfortNeeded' }), { text: low ? `${low.label.replace(/[!.]$/, '')}… 그래서 그래요.` : '그냥 이것저것요. 들어 줘서 고마워요.', icon: '💧' };
      }
      case 'comfortNeeded':
        this.addThought(l, `comfort:${s.id}`, `${josa(s.name, '이/가')} 위로해 줌`, 6, 180);
        return next({ kind: 'comfort' }), { text: pick(['그랬구나… 힘들었겠어요.', '말해 줘서 고마워요. 제가 옆에 있을게요.', '괜찮아질 거예요. 같이 있어 줄게요.']), icon: '❤️' };
      case 'rumor': {
        const about = (act.about ?? []).map((id) => this.agent(id)).filter(Boolean) as Agent[];
        const sent = act.sentiment ?? 0;
        if (about.some((x) => x.id === s.id)) return next(), { text: sent >= 0 ? pick(['에이, 누가 그런 말을 해요… 부끄럽게.', '헉, 벌써 소문났어요?']) : '…그런 얘기가 돈다고요?', icon: '😳' };
        const friend = about.find((x) => this.feel(s.id, x.id) >= 40);
        if (friend && sent < -0.2) {
          this.addFeel(s.id, l.id, -1);
          return next(), { text: `설마요. ${this.referName(s, friend)} 그럴 사람 아니에요.`, icon: '💢' };
        }
        if (sent > 0.2) return next(), { text: pick(['와, 잘됐네요!', '진짜요? 좋은 소식이네요.']), icon: '😊' };
        if (sent < -0.2) return next(), { text: pick(['헐, 진짜요?', '설마… 사실이 아니었으면 좋겠네요.']), icon: '😮' };
        return next(), { text: pick(['그래요? 처음 들어요.', '오, 그런 일이 있었구나.']) };
      }
      case 'secret': {
        const crush = this.agent(act.about?.[0]);
        if (crush && this.feel(s.id, crush.id) >= 62) {
          this.addThought(s, `rival:${crush.id}`, `${l.name}도 ${josa(crush.name, '을/를')} 좋아한다니… 마음이 복잡하다`, -4, 360);
          return next(), { text: pick(['아… 그렇구나. 응원… 할게요.', '그, 그렇군요. 잘되면 좋겠네요.']), icon: '💭' };
        }
        return next(), { text: pick(['헉! 비밀 꼭 지킬게요.', '와, 진짜요? 잘됐으면 좋겠어요!', '어머, 둘이 잘 어울려요!']), icon: '🤫' };
      }
      case 'monologue':
        return next({ kind: 'comforted' }), { text: pick(['얘기해 줘서 고마워요. 언제든 들어 줄게요.', '그런 마음이었구나… 몰랐어요.', '말해 줘서 고마워요. 우리 더 친해진 것 같아요.']), icon: '❤️' };
      case 'treasure':
        return next(), { text: pick(['소중한 거네요. 잘 간직해요.', '와, 사연이 궁금하네요.', '그런 물건 하나쯤 있으면 좋죠.']) };
      case 'gossipGood': {
        const x = this.agent(act.about?.[0]);
        if (!x) return null;
        const f = this.feel(s.id, x.id);
        return next(), { text: f >= 30 ? `맞아요, ${this.referName(s, x)} 진짜 좋은 사람이죠.` : f <= -10 ? '음… 저는 잘 모르겠어요.' : '그래요? 한번 친해져 보고 싶네요.' };
      }
      case 'gossipBad': {
        const x = this.agent(act.about?.[0]);
        if (!x) return null;
        return next(), { text: this.feel(s.id, x.id) <= -10 ? '그쵸? 저도 좀 그렇게 느꼈어요.' : pick(['음… 그래도 사정이 있겠죠.', '그래요? 저는 잘 모르겠어요.']), icon: '💭' };
      }
      case 'recall':
        return next(), { text: pick(['아, 맞다! 그 얘기 저도 계속 생각났어요.', '기억하고 있었어요? 반갑네요.', '그때 얘기 진짜 재밌었죠.']), icon: '😊' };
      case 'muse': {
        // "사실 저… 누군가 우울해 보이면 말을 걸고 싶어 하거든요" → "저도 그래요!" or interest
        const same = s.traits.some((t) => this.matcher.similarity(t, X) >= 0.6);
        if (same) {
          this.addFeel(s.id, l.id, 2);
          this.addFeel(l.id, s.id, 2);
          return next(), { text: pick(['어, 저도 그래요! 신기하네요.', '저도요! 우리 은근히 비슷하네요.']), icon: '😲' };
        }
        return next(), { text: pick(['오, 그렇구나. 처음 알았어요.', '의외네요! 그런 면이 있었구나.', '그거 좋네요. 더 알고 싶어져요.']) };
      }
      case 'birthdayWish':
        this.addFeel(s.id, l.id, 3);
        this.addFeel(l.id, s.id, 1);
        this.addThought(s, `wished-by:${l.id}`, `${givenName(l.name)}에게 생일 축하를 받음`, 3, 600);
        return next(), { text: pick(['고마워요! 기억해 줘서 정말 기뻐요.', '헤헤, 고마워요! 오늘 하루가 더 좋아졌어요.', '와, 알고 있었어요? 고마워요!']), icon: '💖' };
      case 'birthdayNews': {
        (this.wished.get(l.id) ?? this.wished.set(l.id, new Set()).get(l.id)!).add(s.id);
        this.addFeel(l.id, s.id, 3);
        this.addThought(l, `wished-by:${s.id}`, `${givenName(s.name)}에게 생일 축하를 받음`, 3, 600);
        return next({ kind: 'cheered' }), { text: pick(['어머, 진짜요? 생일 축하해요!', '헉, 몰랐어요! 축하해요! 🎉', '생일 축하해요! 오늘은 주인공이네요.']), icon: '🎉' };
      }
      case 'happy':
        if (Math.random() < 0.5) return null;
        return next(), { text: pick(['오늘 기분 좋아 보이네요!', '덩달아 저도 기분 좋아지네요.']), icon: '😊' };
    }
    return null;
  },
  /** Talk about someone who isn't here: badmouthing someone you dislike, or praising someone you love. */
  gossipLine(this: World, c: Conversation, s: Agent, l: Agent): { text: string; icon?: string } | null {
    const absent = this.agents.filter((x) => x.kind === 'person' && x !== s && x !== l && !c.members.includes(x.id));
    const disliked = absent.filter((x) => this.feel(s.id, x.id) <= -10).sort((p, q) => this.feel(s.id, p.id) - this.feel(s.id, q.id))[0];
    const loved = absent.filter((x) => this.feel(s.id, x.id) >= 45).sort((p, q) => this.feel(s.id, q.id) - this.feel(s.id, p.id))[0];
    const bad = disliked && (!loved || Math.random() < 0.5);
    const x = bad ? disliked : loved;
    if (!x) return null;
    const nm = this.referName(s, x);
    if (bad) {
      const why = pick(['좀 이기적인 것 같아요', '말을 너무 함부로 해요', '은근히 사람을 무시해요', '약속을 잘 안 지켜요']);
      this.rumors.add({ text: hearsay(`${josa(x.name, '이/가')} ${why.replace(/요$/, '').replace(/해$/, '한다').replace(/아$/, '다')}`), tag: makeTag('험담', [x.name]), about: [x.id], sentiment: -0.5, knownBy: [s.id, l.id], origin: 'natural', born: this.meta.minutes, kind: 'gossip', heat: 8 });
      if (this.feel(l.id, x.id) >= 40) {
        // defending a friend: the gossip backfires on the one who started it
        this.addFeel(l.id, s.id, -5);
        this.addThought(l, `defend:${x.id}`, `${josa(x.name, '을/를')} 험담하는 걸 들어 불쾌함`, -4, 120);
        c.forced = { speakerId: l.id, toId: s.id, text: `에이, ${this.referName(l, x)} 그런 사람 아니에요.`, icon: '💢' };
        this.log(l, 'diary', `${josa(s.name, '이/가')} ${x.name} 험담을 했다. 친구 욕은 듣기 싫다.`, s.id);
      } else if (l.persona.kind > 0.3) {
        this.addFeel(l.id, s.id, -3);
        this.addThought(l, 'gossip-uneasy', '남 험담을 듣는 게 불편했다', -2, 90);
      } else {
        this.addFeel(l.id, x.id, -4);
        this.addFeel(l.id, s.id, 2); // a shared secret
      }
      if (!c.forced) c.pendingAct = { kind: 'gossipBad', about: [x.id] };
      return { text: `솔직히 ${nm}… ${why}.`, icon: '🤫' };
    }
    const why = pick(['늘 먼저 챙겨 줘요', '같이 있으면 마음이 편해요', '약속은 꼭 지켜요', '진짜 좋은 사람이에요']);
    this.rumors.add({ text: hearsay(`${josa(x.name, '이/가')} 진짜 좋은 사람이다`), tag: makeTag('칭찬', [x.name]), about: [x.id], sentiment: 0.5, knownBy: [s.id, l.id], origin: 'natural', born: this.meta.minutes, kind: 'care', heat: 6 });
    this.addFeel(l.id, x.id, 3);
    c.pendingAct = { kind: 'gossipGood', about: [x.id] };
    return { text: `${nm}… ${why}.`, icon: '😊' };
  },
  /**
   * "A가 B를 좋아한대" reaches A or B. B: flattered (and warmer) or uneasy, depending on how B feels.
   * A: the secret is out — and A knows exactly who they told.
   */
  secretArrives(this: World, l: Agent, r: Rumor, from: Agent) {
    this.rumors.tell(r, l.id, this.meta.minutes);
    const owner = this.agent(r.secretOf);
    const target = this.agent(r.about.find((id) => id !== r.secretOf));
    if (!owner || !target) return;
    if (l === target) {
      if (this.feel(target.id, owner.id) >= 45) {
        this.addThought(target, `liked-by:${owner.id}`, `${josa(owner.name, '이/가')} 나를 좋아한대… 두근거린다`, 6, 720);
        this.addFeel(target.id, owner.id, 8);
        this.log(target, 'diary', `${josa(owner.name, '이/가')} 나를 좋아한다는 얘기를 들었다. 자꾸 생각난다.`, owner.id);
        this.say(target, `(${owner.name}… 정말일까?)`, { thought: true });
      } else {
        this.addThought(target, `liked-by:${owner.id}`, `${josa(owner.name, '이/가')} 나를 좋아한대… 조금 부담스럽다`, -2, 360);
        this.addFeel(target.id, owner.id, -3);
        this.log(target, 'diary', `${josa(owner.name, '이/가')} 나를 좋아한다고 한다. 어떻게 대해야 할지 모르겠다.`, owner.id);
      }
      return;
    }
    // the owner hears their own secret going around
    const confidant = this.agent(r.confidant);
    this.addThought(owner, 'secret-out', '비밀이 새어 나갔다', -7, 600);
    this.say(owner, pick(['(어떻게 그걸…?!)', '(분명히 비밀이라고 했는데…)']), { thought: true });
    if (confidant) {
      this.addFeel(owner.id, confidant.id, -12);
      this.log(owner, 'diary', `${confidant.name}한테만 말했는데… ${from.name}까지 알고 있었다. 다시는 말하나 봐라.`, confidant.id);
      this.relation(owner.id, confidant.id).memories.push({ t: this.meta.minutes, text: `${josa(owner.name, '이/가')} 털어놓은 비밀이 ${confidant.name} 쪽에서 새어 나갔다.` });
    }
  },
};
