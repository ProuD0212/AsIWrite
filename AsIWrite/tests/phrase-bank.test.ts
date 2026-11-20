import { World, givenName } from '../src/engine/World';
import { phraseBank } from '../src/ai/phraseBank';
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? pass++ : fail++, console.log(c ? 'PASS' : 'FAIL', m));
// unit: names come back in the right form
phraseBank.learn('하늘 씨, 안녕하세요!', '하늘 씨, 오늘도 반가워요!', ['김민수', '민수'], ['정하늘', '하늘']);
ok(phraseBank.recall('서연 씨, 안녕하세요!', ['박철수', '철수'], ['최서연', '서연']) === '서연 씨, 오늘도 반가워요!', `learned line reused for other people: ${phraseBank.recall('서연 씨, 안녕하세요!', ['박철수', '철수'], ['최서연', '서연'])}`);
ok(phraseBank.recall('처음 보는 문장이에요', ['a'], ['b']) === null, 'unknown template → nothing');
// in the game: a "storyteller" that rewrote templates earlier → later the same templates get learned lines
const w = World.createWith({ context: '현대 서울', weather: 'clear', wills: 8, places: 6, animals: 0 });
w.meta.minutes = 10 * 60;
for (let i = 0; i < 20 * 60 * 3; i++) w.update(0.05);
const spoken = w.feed.filter((f) => f.kind === 'line' && f.speakerId && f.toId && !f.thought);
for (const f of spoken) {
  const s = w.agent(f.speakerId)!, l = w.agent(f.toId)!;
  if (s && l) phraseBank.learn(f.text, f.text.replace(/[.!?…]*$/, '') + ', 진짜로요.', [s.name, givenName(s.name)], [l.name, givenName(l.name)]);
}
World.learnedLine = (d, s, l) => phraseBank.recall(d, [s.name, givenName(s.name)], [l.name, givenName(l.name)]);
const n0 = w.feed.length;
for (let i = 0; i < 20 * 60 * 3; i++) w.update(0.05);
const later = w.feed.slice(n0).filter((f) => f.kind === 'line' && f.toId && !f.thought);
const learned = later.filter((f) => f.learned);
ok(learned.length > 0, `bank ${phraseBank.size} lines · later ${later.length} lines, ${learned.length} spoken from the bank (e.g. "${learned[0]?.speaker}: ${learned[0]?.text}")`);
ok(learned.every((f) => !/\{[LS]\}/.test(f.text)), 'no placeholder leaks');
console.log(`=== ${pass} passed, ${fail} failed ===`);
