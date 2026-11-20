// 5-1 regression: older features still work after the 25 changes.
import { World } from '../src/engine/World';
import { Game } from '../src/engine/Game';
import { parseCommand } from '../src/commands/ruleParser';
import { suggest } from '../src/commands/suggest';
import { TILE } from '../src/engine/TileMap';
import type { PlaceStyle } from '../src/engine/types';

let pass = 0, fail = 0;
const fails: string[] = [];
const ok = (c: boolean, m: string) => {
  if (c) pass++;
  else (fail++, fails.push(m));
  console.log(c ? 'PASS' : 'FAIL', m);
};
const run = (w: World, n: number) => { for (let i = 0; i < n; i++) w.update(0.05); };
const persons = (w: World) => w.agents.filter((a) => a.kind === 'person');

// ① day cycle: at 03:00 most are asleep; at 15:00 some work; weekend no work
{
  const w = World.createWith({ context: '현대 서울', weather: 'clear', wills: 10, places: 9, animals: 2 });
  const hour = () => (w.meta.minutes % 1440) / 60;
  let asleep3 = 0, working15 = 0, n3 = 0, n15 = 0;
  for (let day = 0; day < 3; day++)
    for (let m = 0; m < 1440; m++) {
      run(w, 20);
      const h = Math.floor(hour());
      if (h === 3 && m % 60 === 0) (n3++, (asleep3 += persons(w).filter((a) => a.ai.sleeping).length / persons(w).length));
      if (h === 15 && m % 60 === 0 && day < 2) (n15++, (working15 += persons(w).filter((a) => a.ai.working).length));
    }
  ok(asleep3 / Math.max(1, n3) >= 0.5, `① at 3 a.m. most Wills sleep (${Math.round((asleep3 / Math.max(1, n3)) * 100)}%)`);
  ok(working15 > 0, `① someone works in the afternoon (${working15})`);
}

// ② casual speech between close friends
{
  const w = World.createWith({ context: '현대 서울', weather: 'clear', wills: 4, places: 4, animals: 0 });
  const [a, b] = persons(w);
  w.addFeel(a.id, b.id, 90);
  ok(w.speaksCasually(a, b) && /[아야]$/.test(w.callName(a, b)), `② close friends use 반말 + "${w.callName(a, b)}"`);
}

// ③ eight themes create worlds; ⑤ every facility type builds with reachable seats + an open door
{
  const themes = ['현대 서울', '중세 판타지 왕국', '좀비 아포칼립스', '사이버펑크 도시', '학원물 학교', '해적 항구', '우주 정거장', '조선 시대'];
  for (const th of themes) {
    const w = World.createWith({ context: th, weather: 'clear', wills: 5, places: 5, animals: 2 });
    run(w, 400);
    ok(persons(w).length === 5 && w.places.length >= 5, `③ world builds: ${th}`);
  }
  const styles: PlaceStyle[] = ['cafe', 'park', 'karaoke', 'store', 'library', 'home', 'plaza', 'office', 'factory', 'restaurant', 'bakery', 'gym', 'hospital', 'school', 'bar', 'flower', 'cinema'];
  const w = World.createWith({ context: '현대 서울', weather: 'clear', wills: 1, places: 0, animals: 0, empty: true });
  w.resizeMap(0, 0, 60, 40);
  for (const s of styles) {
    const p = w.addPlace({ name: `시험 ${s}`, style: s, appearance: '', traits: [] });
    if (!p) { ok(false, `⑤ ${s} could not be built`); continue; }
    const door = p.door;
    // reachable from open ground far away (the door may open sideways onto the free strip)
    const outside = w.map.nearestWalkable(w.map.w - 2, w.map.h - 2);
    const blockedDoor = w.map.isBlocked(door.tx, door.ty) || !w.map.findPath(outside.tx, outside.ty, door.tx, door.ty, 40000);
    const unreachable = [...p.seats, ...p.workSpots].filter((t) => !w.map.findPath(outside.tx, outside.ty, t.tx, t.ty, 40000)).length;
    ok(!blockedDoor && unreachable === 0 && p.seats.length > 0, `⑤ ${s}: door open, ${p.seats.length} seats + ${p.workSpots.length} work spots all reachable${unreachable ? ` (${unreachable} unreachable!)` : ''}`);
  }
}

// ⑧ parser regressions incl. short words
{
  const cases: [string, string][] = [
    ['고양이를 좋아하는 샐러리맨 소환', 'SPAWN_ENTITY'], ['김민수 옆에 작고 노란 길고양이 소환', 'SPAWN_ENTITY'], ['골목 어귀에 아늑한 노래방 배치', 'SPAWN_ENTITY'],
    ['갑자기 소나기가 내리게 해줘', 'SET_WEATHER'], ['세계관을 중세 판타지로 변경', 'SET_WORLD_CONTEXT'], ['저장', 'SYSTEM'], ['2배속', 'SYSTEM'],
    ['말 한 마리 소환', 'SPAWN_ENTITY'], ['용 소환', 'SPAWN_ENTITY'], ['개 한 마리 소환', 'SPAWN_ENTITY'],
    ['광장에서 축제 열어 줘', 'WORLD_EVENT'], ['유성우 내려 줘', 'WORLD_EVENT'], ['맵 편집', 'SYSTEM'], ['밤 건너뛰기', 'SYSTEM'],
  ];
  for (const [s, t] of cases) ok(parseCommand(s)?.type === t, `⑧ "${s}" → ${t} (got ${parseCommand(s)?.type})`);
  // words that must NOT become an animal spawn
  for (const s of ['말이 너무 많아', '용돈 좀 줘', '개인적으로 좋아']) ok(parseCommand(s)?.type !== 'SPAWN_ENTITY', `⑧ "${s}" is not a spawn`);
}

// ⑨ every suggestion actually runs
{
  const w = World.createWith({ context: '현대 서울', weather: 'clear', wills: 8, places: 7, animals: 2 });
  const g = new Game(w);
  run(w, 2000);
  let total = 0, okRuns = 0;
  const targets: (string | null)[] = [null, ...persons(w).slice(0, 3).map((a) => a.id), w.agents.find((a) => a.kind === 'animal')?.id ?? null, w.places[0].id];
  for (const sel of targets)
    for (let k = 0; k < 3; k++) {
      g.selectedId = sel;
      for (const it of suggest(w, sel).items) {
        total++;
        const cmd = parseCommand(it.text, sel ?? undefined);
        if (cmd && g.dispatch(cmd).ok) okRuns++;
        else console.log('   ✗', it.text);
      }
      run(w, 50);
    }
  ok(okRuns === total, `⑨ suggestions that run: ${okRuns}/${total}`);
}

// Phase 3: groups form, mutations happen
{
  const w = World.createWith({ context: '현대 서울', weather: 'clear', wills: 12, places: 8, animals: 2 });
  // make a tight circle that chats a lot
  const ps = persons(w).slice(0, 5);
  for (const a of ps) for (const b of ps) if (a !== b) w.addFeel(a.id, b.id, 70);
  // groups form by chance: watch up to three 60-hour stretches before calling it
  for (let k = 0; k < 3 && !w.factions.length && !w.feed.some((f) => /결성|만들었대/.test(f.text)); k++) run(w, 20 * 60 * 60);
  ok(w.factions.length > 0 || w.feed.some((f) => /결성|만들었대/.test(f.text)), `Phase 3 groups form (${w.factions.map((f) => f.name).join(', ') || 'none'})`);
  ok(w.mutationsDone > 0 || w.agents.some((a) => a.logs.some((l) => l.kind === 'mutation')), `Phase 3 traits drift (${w.mutationsDone})`);
  w.setContext('중세 판타지 왕국');
  run(w, 20 * 60 * 8);
  ok(w.agents.some((a) => a.logs.some((l) => /실감|판타지/.test(l.text))), 'Phase 3 a world change sinks in over time');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fails.length) console.log('FAILED:\n- ' + fails.join('\n- '));

// themed building names + blackout saved
{
  const { serializeWorld, deserializeWorld } = await import('../src/engine/save');
  const f = World.createWith({ context: '중세 판타지 왕국', weather: 'clear', wills: 3, places: 6, animals: 0 });
  const modern = /(할머니|편의점|코인노래방|사무실|카페 «|스타트업)/;
  ok(!f.places.some((p) => p.style !== 'home' && modern.test(p.name)), `fantasy names: ${f.places.map((p) => p.name).join(', ')}`);
  const j = World.createWith({ context: '조선 시대', weather: 'clear', wills: 3, places: 6, animals: 0 });
  ok(!j.places.some((p) => modern.test(p.name)), `joseon names: ${j.places.map((p) => p.name).join(', ')}`);
  const g = new Game(f);
  g.dispatch({ type: 'SPAWN_ENTITY', entity: { kind: 'place', style: 'restaurant' } });
  ok(!f.places.some((p) => /^새 /.test(p.name)), `chat-built place gets a themed name (${f.places[f.places.length - 1].name})`);
  f.blackoutUntil = f.meta.minutes + 60;
  ok(deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(f)))).blackoutUntil === f.blackoutUntil, 'blackout survives save/load');
  console.log(`\n=== ${pass} passed, ${fail} failed (with names) ===`);
}
