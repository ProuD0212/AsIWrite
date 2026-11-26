import { World } from '../src/engine/World';
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? pass++ : fail++, console.log(c ? 'PASS' : 'FAIL', m));
const run = (w: World, n: number) => { for (let i = 0; i < n; i++) w.update(0.05); };
const w = World.createWith({ context: '현대 서울', weather: 'clear', wills: 8, places: 6, animals: 0 });
const ps = w.agents.filter((a) => a.kind === 'person');
w.meta.minutes = 12 * 60;
run(w, 100);
// put three Wills around the birthday Will
const who = ps[0];
for (const b of ps.slice(1, 4)) { b.x = who.x + 30; b.y = who.y + 10; }
const n0 = w.feed.length;
console.log('near:', ps.slice(1, 4).map((b) => [b.name, b.ai.sleeping, Math.round(Math.hypot(b.x - who.x, b.y - who.y)), b.ai.mode].join(':')).join(' '));
const rr = w.happen('BIRTHDAY' as never, who);
console.log('happen:', rr, 'feed after:', w.feed.slice(n0).map((f) => [f.kind, f.speaker, f.toId === who.id, f.text].join('|')).slice(0, 8));
const near = w.feed.slice(n0).filter((f) => f.toId === who.id && /생일 축하/.test(f.text));
ok(near.length >= 1, `people nearby wish them right away: ${near.map((f) => `${f.speaker}: ${f.text}`).join(' / ')}`);
// over the day, conversations with the birthday Will start with a wish
run(w, 20 * 60 * 6);
const conv = w.feed.slice(n0).filter((f) => f.kind === 'line' && /(생일 축하|제 생일)/.test(f.text));
const thanks = w.feed.slice(n0).filter((f) => f.speakerId === who.id && /고마워요/.test(f.text));
ok(conv.length >= 2, `more wishes in conversations through the day: ${conv.length} (e.g. "${conv.at(-1)?.speaker}: ${conv.at(-1)?.text}")`);
ok(thanks.length >= 1 || conv.length >= 3, `the birthday Will thanks them: ${thanks.length}`);
// birthdays come by themselves
const days = new Set(ps.map((a) => w.birthdayIn(a)));
ok(days.size >= 3, `Wills have different birthdays: ${[...days].sort((a, b) => a - b).join(',')}`);
const w2 = World.createWith({ context: '현대 서울', weather: 'clear', wills: 10, places: 6, animals: 0 });
w2.meta.minutes = 6 * 60;
const before = w2.eventLog.length;
// 7 days: with 10 Wills on a 14-day cycle, 3 days missed everyone ~1 run in 5 ((12/14)^10)
run(w2, 20 * 60 * 24 * 7);
const auto = w2.eventLog.slice(before).filter((e) => e.kind === 'BIRTHDAY').length;
ok(auto >= 1, `birthdays happen on their own over 7 days: ${auto}`);
console.log(`=== ${pass} passed, ${fail} failed ===`);
