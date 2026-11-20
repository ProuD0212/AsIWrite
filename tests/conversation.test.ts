// Conversation context: replies answer the previous line; topics carry over; the player's follow-ups.
import { World } from '../src/engine/World';
import type { Conversation } from '../src/engine/World';
import type { Agent } from '../src/engine/types';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? pass++ : fail++, console.log(c ? 'PASS' : 'FAIL', m));
const run = (w: World, steps: number) => {
  for (let i = 0; i < steps; i++) w.update(0.05);
};
const persons = (w: World) => w.agents.filter((a) => a.kind === 'person');
const P = (w: World) => w as unknown as { reactTo: (c: Conversation, s: Agent, l: Agent) => { text: string } | null };
const convo = (a: Agent, b: Agent, act: Conversation['lastAct']): Conversation => ({ id: 'c', members: [a.id, b.id], topic: '고양이를 좋아한다', topicSim: 0, nextAt: 0, lines: 2, maxLines: 6, argue: false, lastSpeaker: a.id, lastAct: act });

{
  const w = World.createWith({ context: '현대 서울', weather: 'clear', wills: 4, places: 4, animals: 0 });
  const [a, b, c, d] = persons(w);
  a.traits = ['고양이를 좋아한다'];
  b.traits = ['고양이를 좋아한다', '커피를 좋아한다'];
  const r1 = P(w).reactTo(convo(a, b, { kind: 'like', obj: '고양이', by: a.id }), b, a);
  ok(!!r1 && /저도/.test(r1.text), `shared like → agreement: "${r1?.text}"`);
  b.traits = ['고양이를 싫어한다'];
  const r2 = P(w).reactTo(convo(a, b, { kind: 'like', obj: '고양이', by: a.id }), b, a);
  ok(!!r2 && /별로|안 맞/.test(r2.text), `opposite taste → polite disagreement: "${r2?.text}"`);
  b.traits = ['등산을 좋아한다'];
  const cv = convo(a, b, { kind: 'like', obj: '고양이', by: a.id });
  const r3 = P(w).reactTo(cv, b, a);
  ok(!!r3 && /\?$/.test(r3.text) && cv.pendingAct?.kind === 'askWhy', `no opinion → asks back: "${r3?.text}"`);
  // ...and the asker gets an answer
  cv.lastAct = { kind: 'askWhy', obj: '고양이', by: b.id };
  const r4 = P(w).reactTo(cv, a, b);
  ok(!!r4 && cv.pendingAct?.kind === 'explained', `the question gets answered: "${r4?.text}"`);
  // rumor about a friend → defend
  w.addFeel(b.id, c.id, 70);
  const r5 = P(w).reactTo(convo(a, b, { kind: 'rumor', about: [c.id], sentiment: -0.6, by: a.id }), b, a);
  ok(!!r5 && /아니에요/.test(r5.text), `bad rumor about a friend → defends them: "${r5?.text}"`);
  const r6 = P(w).reactTo(convo(a, b, { kind: 'rumor', about: [d.id], sentiment: 0.6, by: a.id }), b, a);
  ok(!!r6 && /잘됐|좋은 소식/.test(r6.text), `good news → glad: "${r6?.text}"`);
  const r7 = P(w).reactTo(convo(a, b, { kind: 'greet', ask: true, by: a.id }), b, a);
  ok(!!r7 && !/^안녕/.test(r7.text), `"오늘 어땠어요?" → an actual answer: "${r7?.text}"`);
  const r8 = P(w).reactTo(convo(a, b, { kind: 'like', obj: '고양이', by: b.id }), b, a);
  ok(r8 === null, 'never reacts to its own line');
}

// in a running town: lines answer each other, topics carry over
{
  const w = World.createWith({ context: '현대 서울', weather: 'clear', wills: 10, places: 7, animals: 0 });
  w.meta.minutes = 9 * 60;
  let reacts = 0, nulls = 0;
  const orig = P(w).reactTo.bind(w);
  (w as unknown as { reactTo: typeof orig }).reactTo = (c, s, l) => {
    const r = orig(c, s, l);
    r ? reacts++ : nulls++;
    return r;
  };
  run(w, 20 * 60 * 8);
  const lines = w.feed.filter((f) => f.kind === 'line' && f.to && !f.thought);
  ok(reacts > lines.length * 0.2, `share of lines that answer the previous one: ${reacts}/${lines.length} (${((reacts / Math.max(1, lines.length)) * 100).toFixed(0)}%)`);
  const withTopic = [...w.relations.values()].filter((r) => r.lastTopic);
  ok(withTopic.length > 0, `pairs remember what they talked about: ${withTopic.length} (e.g. "${withTopic[0]?.lastTopic}")`);
  // sample conversations
  const byPair = new Map<string, string[]>();
  for (const f of lines) {
    const k = [f.speakerId, f.toId].sort().join('|');
    const arr = byPair.get(k) ?? [];
    arr.push(`${f.speaker}: ${f.text}`);
    byPair.set(k, arr);
  }
  const samples = [...byPair.values()].filter((x) => x.length >= 5).slice(0, 4);
  for (const s of samples) console.log('  ┌ ' + s.slice(0, 7).join('\n  │ '));
  // recall: a pair that talked properly before brings it up again when they meet
  const L = w as unknown as { lineFor: (c: Conversation, s: Agent, l: Agent) => { text: string } };
  const rnd = Math.random;
  let recalled = '';
  Math.random = () => 0.1;
  try {
    for (const r of withTopic) {
      const s = w.agent(r.a), l = w.agent(r.b);
      if (!s || !l || w.feel(s.id, l.id) <= -10) continue;
      const cv: Conversation = { id: 'r', members: [s.id, l.id], topic: 'x', topicSim: 0, nextAt: 0, lines: 0, maxLines: 6, argue: false };
      const t = L.lineFor(cv, s, l).text;
      if (/지난번에 했던|저번에 말한|그때 얘기한/.test(t) && cv.pendingAct?.kind === 'recall') { recalled = t; break; }
    }
  } finally {
    Math.random = rnd;
  }
  ok(!!recalled, `meeting again, last time's topic comes back: "${recalled}"`);
}

// the player's follow-ups
{
  const w = World.createWith({ context: '현대 서울', weather: 'clear', wills: 4, places: 4, animals: 0 });
  const [a, b] = persons(w);
  w.addThought(a, 't1', '오늘 커피가 맛있었다', 5, 300);
  w.addThought(a, 't2', '날씨가 좋다', 3, 300);
  w.talkTo(a, '요즘 기분 어때요?');
  w.talkTo(a, '왜요?');
  const log = w.talks.get(a.id)!;
  ok(/커피|날씨/.test(log[3].text), `"왜요?" explains the last answer: "${log[1].text}" → "${log[3].text}"`);
  w.addFeel(a.id, b.id, 70);
  w.talkTo(a, `${b.name} 어때요?`);
  ok(/좋아|편해/.test(log[5]?.text ?? w.talks.get(a.id)!.slice(-1)[0].text), `asking about another Will: "${w.talks.get(a.id)!.slice(-1)[0].text}"`);
  w.talkTo(a, `${b.name} 어때요?`);
  ok(/아까도/.test(w.talks.get(a.id)!.slice(-1)[0].text), `the same question twice: "${w.talks.get(a.id)!.slice(-1)[0].text}"`);
  w.talkTo(a, '뭘 좋아해요?');
  w.talkTo(a, '왜 좋아요?');
  ok(/생각만 해도|설명/.test(w.talks.get(a.id)!.slice(-1)[0].text), `"왜 좋아요?" follows the likes answer: "${w.talks.get(a.id)!.slice(-1)[0].text}"`);
}

console.log(`=== ${pass} passed, ${fail} failed ===`);
