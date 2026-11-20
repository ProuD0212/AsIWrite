// Headless tests: requests / goals / moments, adoption, moving in & out, talking to a Will.
import { World } from '../src/engine/World';
import { Game } from '../src/engine/Game';
import { serializeWorld, deserializeWorld } from '../src/engine/save';
import { parseCommand } from '../src/commands/ruleParser';
import type { Agent } from '../src/engine/types';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? pass++ : fail++, console.log(c ? 'PASS' : 'FAIL', m));
const run = (w: World, steps: number) => {
  for (let i = 0; i < steps; i++) w.update(0.05);
};
const persons = (w: World) => w.agents.filter((a) => a.kind === 'person');
const town = (wills = 8, places = 7, animals = 2) => World.createWith({ context: '현대 서울', weather: 'clear', wills, places, animals });
const W = (w: World) => w as unknown as Record<string, (...a: unknown[]) => unknown>;

// ── parser ──
{
  const t1 = parseCommand('윤한별에게 "요즘 어때?"');
  ok(t1?.type === 'TALK' && (t1 as { text: string }).text === '요즘 어때?', `parse quoted talk → ${JSON.stringify(t1)}`);
  const t2 = parseCommand('윤한별한테 요즘 기분 어떠냐고 물어봐');
  ok(t2?.type === 'TALK', `parse indirect question → ${JSON.stringify(t2)}`);
  const t3 = parseCommand('윤한별에게 "고양이를 좋아함" 특성 추가');
  ok(t3?.type !== 'TALK', `trait sentence is still a trait edit → ${t3?.type}`);
  const t4 = parseCommand('윤한별에게 "힘내요"라고 말해 줘');
  ok(t4?.type === 'TALK' && (t4 as { text: string }).text === '힘내요', `parse "…라고 말해 줘" → ${JSON.stringify(t4)}`);
}

// ── talking (no storyteller → template answer at once) ──
{
  const w = town();
  const g = new Game(w);
  const a = persons(w)[0];
  const mood0 = a.mood;
  const r = g.dispatch({ type: 'TALK', target: { id: a.id }, text: '요즘 기분 어때요?' });
  const log = w.talks.get(a.id) ?? [];
  ok(r.ok && log.length === 2 && log[1].who === 'will' && log[1].text.length > 3, `talk: ${a.name} answers "${log[1]?.text}"`);
  ok(w.hasThought(a, 'heard'), 'talk: being listened to leaves a warm thought');
  run(w, 200);
  ok(a.mood >= mood0 - 3, `talk: mood not hurt (${mood0.toFixed(0)} → ${a.mood.toFixed(0)})`);
  g.dispatch({ type: 'TALK', target: { id: a.id }, text: '꿈이 뭐예요?' });
  ok((w.talks.get(a.id) ?? []).length === 4, `talk: second question answered "${w.talks.get(a.id)?.[3]?.text}"`);
  ok(w.feed.some((f) => f.to === '나' && f.speakerId === a.id), 'talk: the answer is in the story log, addressed to 나');
}

// ── requests: wish → accept → build → done ──
{
  const w = town(6, 2, 0);
  const g = new Game(w);
  let q = undefined as ReturnType<() => (typeof w.quests)[number]> | undefined;
  for (let i = 0; i < 30 && !q; i++) {
    W(w).offerRequest();
    q = w.quests.find((x) => x.status === 'offered' && x.check.type === 'placeStyle');
    if (!q) for (const x of w.quests) if (x.status === 'offered') x.status = 'declined';
    (w as unknown as { recentQuestKeys: unknown[] }).recentQuestKeys = [];
  }
  ok(!!q, `request offered: ${q ? `${w.agent(q.from)?.name}: ${q.title} — "${q.text}"` : 'none'}`);
  if (q) {
    w.acceptQuest(q.id);
    ok(q.status === 'active', 'request accepted');
    ok(!!q.action, `request has a shortcut: ${q.action?.label}`);
    const r = g.dispatch(q.action!.cmd);
    ok(r.ok, `shortcut runs: ${r.message}`);
    run(w, 20 * 11);
    ok(q.status === 'done' && w.questsDone >= 1, `request completed (${q.status}) · thanks: ${w.feed.filter((f) => f.text.includes('의뢰 완료')).map((f) => f.text).slice(-1)}`);
  }
}

// ── repair request ──
{
  const w = town(5, 4, 0);
  const [a, b] = persons(w);
  for (const p of persons(w)) for (const o of persons(w)) if (p !== o) w.relation(p.id, o.id);
  w.addFeel(a.id, b.id, -60);
  w.addFeel(b.id, a.id, -30);
  const busy = new Set(persons(w).filter((p) => p !== a).map((p) => p.id));
  // only a can ask (others are "busy" with a placeholder)
  for (const id of busy) w.quests.push({ id: 'x' + id, kind: 'request', status: 'active', from: id, icon: '', title: '', text: '', check: { type: 'groups', n: 99 }, createdAt: 0, expiresAt: 1e9, key: 'x' + id });
  let q;
  for (let i = 0; i < 40 && !q; i++) {
    W(w).offerRequest();
    q = w.quests.find((x) => x.status === 'offered' && x.check.type === 'feelBoth');
    if (!q) for (const x of w.quests) if (x.status === 'offered') x.status = 'declined';
    (w as unknown as { recentQuestKeys: unknown[] }).recentQuestKeys = [];
  }
  ok(!!q, `repair request: ${q?.title}`);
  if (q) {
    w.acceptQuest(q.id);
    w.addFeel(a.id, b.id, 80);
    w.addFeel(b.id, a.id, 80);
    run(w, 20 * 11);
    ok(q.status === 'done', `repair completes once both warm up (${q.status})`);
  }
}

// ── goals and moments appear on their own ──
{
  const w = town();
  w.meta.minutes = 10 * 60;
  run(w, 20 * 30);
  const goal = w.quests.find((q) => q.kind === 'goal' && q.status === 'active');
  ok(!!goal, `a town goal is active: ${goal?.title}`);
  w.setWeather('rain');
  (w as unknown as { lastMomentAt: number }).lastMomentAt = -1e9;
  let m;
  for (let i = 0; i < 20 && !m; i++) {
    W(w).offerMoment();
    m = w.quests.find((q) => q.kind === 'moment' && q.status === 'active' && q.check.type === 'weather');
    if (!m) for (const q of w.quests) if (q.kind === 'moment') q.status = 'failed';
    (w as unknown as { recentQuestKeys: unknown[] }).recentQuestKeys = [];
  }
  ok(!!m, `rain moment: ${m?.title} → ${m?.action?.label}`);
  if (m) {
    const g = new Game(w);
    g.dispatch(m.action!.cmd);
    run(w, 20 * 11);
    ok(m.status === 'done', `moment solved by its button (${m.status})`);
  }
  // festival goal via event log
  const fest = { id: 'f', kind: 'goal' as const, status: 'active' as const, icon: '🎉', title: '축제', text: '', check: { type: 'event' as const, event: 'FESTIVAL', since: w.meta.minutes }, createdAt: w.meta.minutes, expiresAt: w.meta.minutes + 999, key: 'f' };
  w.quests.push(fest);
  w.happen('FESTIVAL' as never);
  run(w, 20 * 11);
  ok(w.quests.find((q) => q.id === 'f')?.status === 'done', 'event goal counts world events that happened');
  // over a long run quests don't pile up
  run(w, 20 * 60 * 24);
  const open = w.quests.filter((q) => q.status === 'offered' || q.status === 'active');
  ok(open.length <= 4 && w.quests.length <= 40, `after a day: ${open.length} open, ${w.quests.length} kept · done ${w.questsDone} · ${open.map((q) => q.title).join(' / ')}`);
}

// ── adoption ──
{
  const w = town(4, 5, 2);
  const g = new Game(w);
  const owner = persons(w).find((p) => w.place(p.homeId))!;
  const pet = w.agents.find((a) => a.kind === 'animal')!;
  const r = g.dispatch({ type: 'SYSTEM', action: 'ADOPT', value: pet.id, target: { id: owner.id } });
  ok(r.ok && pet.ownerId === owner.id, `adopt: ${r.message}`);
  const r2 = g.dispatch({ type: 'SYSTEM', action: 'ADOPT', value: pet.id, target: { id: persons(w)[1].id } });
  ok(!r2.ok, `can't adopt an owned pet twice: ${r2.message}`);
  // follows
  pet.x = owner.x + 600; pet.y = owner.y;
  const d0 = Math.hypot(pet.x - owner.x, pet.y - owner.y);
  let d1 = d0;
  for (let i = 0; i < 20 * 60; i++) (w.update(0.05), (d1 = Math.min(d1, Math.hypot(pet.x - owner.x, pet.y - owner.y))));
  ok(d1 < d0 * 0.5, `pet follows its owner (${d0.toFixed(0)}px → ${d1.toFixed(0)}px)`);
  const s = deserializeWorld(serializeWorld(w));
  ok(s.agent(pet.id)?.ownerId === owner.id, 'adoption survives save/load');
  // owner removed → pet free again
  g.dispatch({ type: 'DELETE_ENTITY', target: { id: owner.id } });
  run(w, 40);
  ok(!pet.ownerId, 'pet is free again when its owner is gone');
}

// ── moving out / in ──
{
  const w = town(6, 6, 0);
  const sad = persons(w)[0];
  const id = sad.id;
  sad.mood = 10;
  W(w).dailyTick();
  ok(sad.lowDays === 1 && w.quests.some((q) => q.key === `stay:${id}` && q.status === 'active'), 'day 1 unhappy: a "떠날까 고민" moment appears');
  sad.mood = 10;
  W(w).dailyTick();
  ok(!w.agent(id) && w.feed.some((f) => f.text.includes('떠났어요')), 'day 2 still unhappy: the Will moves away');
  const n0 = persons(w).length;
  for (const p of persons(w)) p.mood = 90;
  const rnd = Math.random;
  Math.random = () => 0.1;
  try {
    W(w).dailyTick();
  } finally {
    Math.random = rnd;
  }
  ok(persons(w).length === n0 + 1 && w.feed.some((f) => f.text.includes('이사 왔어요')), `happy town: someone moves in (${n0} → ${persons(w).length})`);
  const newbie = persons(w)[persons(w).length - 1];
  ok(!!w.place(newbie.homeId), `newcomer has a home: ${w.place(newbie.homeId)?.name}`);
  // toggle off
  w.migration = false;
  const s2 = persons(w)[0];
  s2.mood = 5;
  W(w).dailyTick();
  s2.mood = 5;
  W(w).dailyTick();
  ok(!!w.agent(s2.id), 'migration off: nobody leaves');
  const back = deserializeWorld(serializeWorld(w));
  ok(back.migration === false && back.quests.length === w.quests.length && back.questsDone === w.questsDone, `quests + migration survive save/load (${back.quests.length} quests)`);
}

// ── quests stay quiet in the tutorial ──
{
  const w = town(4, 4, 0);
  w.questsPaused = true;
  run(w, 20 * 60 * 6);
  ok(w.quests.length === 0, 'paused world: no requests or goals');
}

console.log(`=== ${pass} passed, ${fail} failed ===`);
void (0 as unknown as Agent);
