// Headless test suite for the 25 requested changes. Run through the real engine.
import { World, givenName } from '../src/engine/World';
import { Game } from '../src/engine/Game';
import { Camera, ZOOMS } from '../src/engine/render/Renderer';
import { G, D, TILE } from '../src/engine/TileMap';
import { serializeWorld, deserializeWorld } from '../src/engine/save';
import { randomName } from '../src/presets/traitPools';
import { cleanOutput } from '../src/ai/validate';
import { parseCommand } from '../src/commands/ruleParser';
import type { Agent } from '../src/engine/types';

let pass = 0, fail = 0;
const fails: string[] = [];
const ok = (cond: boolean, msg: string) => {
  if (cond) pass++;
  else (fail++, fails.push(msg));
  console.log(cond ? 'PASS' : 'FAIL', msg);
};
const run = (w: World, steps: number) => {
  for (let i = 0; i < steps; i++) w.update(0.05);
};
const persons = (w: World) => w.agents.filter((a) => a.kind === 'person');
const town = () => World.createWith({ context: '현대 서울', weather: 'clear', wills: 8, places: 7, animals: 2 });

// ── 1) zoom ──
{
  const c = new Camera();
  c.w = 1280; c.h = 800;
  ok(ZOOMS[0] <= 0.125 && ZOOMS.includes(1.5 as never) && ZOOMS.includes(0.75 as never), '1 zoom: finer steps + deep zoom-out levels exist');
  c.zoom = 2;
  c.zoomAt(640, 400, 0.5);
  ok(c.zoom === 1.5, `1 zoom: one step out from 2× is 1.5× (got ${c.zoom})`);
  c.fit(200 * TILE, 150 * TILE);
  ok(c.zoom <= (1280 / (200 * TILE)), `1 zoom: fit() shows a 200×150 map (zoom ${c.zoom})`);
}

// ── 2/3/6/7/8) map editing, undo, ghost placement, moving, homes ──
{
  const w = town();
  const g = new Game(w);
  run(w, 200);
  // brush stroke recorded → undo
  let gx = -1, gy = -1;
  for (let y = 3; y < w.map.h - 3 && gx < 0; y++) for (let x = 3; x < w.map.w - 3; x++) { const i = w.map.idx(x, y); if (w.map.ground[i] === G.Grass && w.map.owner[i] === 0 && w.map.deco[i] === D.None) { gx = x; gy = y; break; } }
  const before = w.map.encodeTiles();
  w.map.journal = new Map();
  for (let k = 0; k < 4; k++) w.paintMap(gx + k, gy, 'road', 1);
  const saved = w.map.journal; w.map.journal = null;
  g.pushUndo({ label: '맵 칠하기', undo: () => w.map.restoreTiles(saved!) });
  ok(w.map.ground[w.map.idx(gx, gy)] === G.Road, '3 paint: road painted');
  g.undo();
  ok(JSON.stringify(w.map.encodeTiles()) === JSON.stringify(before), '2 undo: brush stroke fully undone (incl. curb)');
  // spawn → undo
  const n0 = w.agents.length;
  g.dispatch({ type: 'SPAWN_ENTITY', entity: { kind: 'person', name: '테스트윌' } });
  ok(w.agents.length === n0 + 1, '2 undo: spawned');
  g.undo();
  ok(w.agents.length === n0, '2 undo: spawn undone');
  // delete with relations → undo
  const a = persons(w)[0], b = persons(w)[1];
  w.addFeel(a.id, b.id, 40);
  const feel = w.feel(a.id, b.id);
  g.dispatch({ type: 'DELETE_ENTITY', target: { id: a.id } });
  ok(!w.agent(a.id), '2 undo: deleted');
  g.undo();
  ok(!!w.agent(a.id) && Math.abs(w.feel(a.id, b.id) - feel) < 1e-6, '2 undo: deleted Will restored with id + relations');
  // place delete → undo (residents come back)
  const home = w.places.find((p) => p.style === 'home');
  if (home) {
    const res = w.residentsOf(home).map((x) => x.id);
    g.dispatch({ type: 'DELETE_ENTITY', target: { id: home.id } });
    g.undo();
    const back = w.place(home.id);
    ok(!!back && res.every((id) => w.agent(id)?.homeId === home.id), `2/8 undo: home restored with its ${res.length} residents`);
  }
  // modify → undo
  const t0 = [...b.traits];
  g.dispatch({ type: 'MODIFY_ENTITY', target: { id: b.id }, changes: { traits: [...b.traits.slice(1), '새로 고친 특성이다'] } });
  ok(b.traits.includes('새로 고친 특성이다'), '10 inline edit: MODIFY with a full trait list works');
  g.undo();
  ok(JSON.stringify(b.traits) === JSON.stringify(t0), '2 undo: trait edit undone');
  // ghost placement: exact top-left
  const free = (() => { for (let y = 2; y < w.map.h - 10; y++) for (let x = 2; x < w.map.w - 12; x++) if (w.canBuildAt('cafe', x, y)) return { x, y }; return null; })();
  if (free) {
    const at = { x: (free.x + 4) * TILE + 5, y: (free.y + 3) * TILE + 5 };
    const tl = Game.topLeftFor('cafe', at.x, at.y);
    g.dispatch({ type: 'SPAWN_ENTITY', entity: { kind: 'place', style: 'cafe', name: '고스트 카페' }, at });
    const cafe = w.places.find((p) => p.name === '고스트 카페');
    ok(!!cafe && cafe.tx === tl.tx && cafe.ty === tl.ty, '6 ghost: building lands exactly where the ghost was');
    // move it and undo the move
    if (cafe) {
      const spot = (() => { for (let y = 2; y < w.map.h - 10; y++) for (let x = 2; x < w.map.w - 12; x++) if ((Math.abs(x - cafe.tx) > cafe.tw + 1 || Math.abs(y - cafe.ty) > cafe.th + 1) && w.canBuildAt('cafe', x, y, cafe)) return { x, y }; return null; })();
      if (spot) {
        const from = { tx: cafe.tx, ty: cafe.ty };
        g.startMove(cafe);
        const r = g.tool!.run!((spot.x + 4) * TILE + 5, (spot.y + 3) * TILE + 5);
        const tl2 = Game.topLeftFor('cafe', (spot.x + 4) * TILE + 5, (spot.y + 3) * TILE + 5);
        ok(r.ok && cafe.tx === tl2.tx && cafe.ty === tl2.ty && cafe.seats.every((s) => s.tx >= cafe.tx && s.tx < cafe.tx + cafe.tw), '7 move: building moved with its seats');
        ok(w.map.owner[w.map.idx(from.tx + 1, from.ty + 1)] === 0 || (from.tx === cafe.tx), '7 move: old footprint freed');
        g.undo();
        ok(cafe.tx === from.tx && cafe.ty === from.ty, '2/7 undo: move undone');
      }
    }
  }
  // homes: set and list residents
  const h2 = w.places.find((p) => p.style === 'home')!;
  w.setHome(b, h2);
  ok(w.residentsOf(h2).includes(b), '8 homes: resident listed');
  // resize undo
  const W0 = w.map.w, H0 = w.map.h;
  const tilesBefore = w.map.encodeTiles();
  const r = w.resizeMap(3, 2, 4, 1);
  g.pushUndo({ label: 'resize', undo: () => { w.resizeMap(-3, -2, -4, -1); w.map.applyTiles(tilesBefore); } });
  g.undo();
  ok(r.ok && w.map.w === W0 && w.map.h === H0, '2 undo: resize undone');
  run(w, 2000);
  ok(true, 'sim keeps running after edits/undos');
}

// ── 12/17) aversion & unease ──
{
  const w = town();
  run(w, 3000);
  const screams = w.feed.filter((f) => /으악, 저리 가|히익|가까이 오지 마/.test(f.text)).map((f) => f.speaker);
  ok(!screams.includes('김민수'), `12 김민수 no longer screams at animals (screams: ${screams.join(',') || 'none'})`);
  const uneasy = w.feed.filter((f) => f.thought && /어색|안 맞|결이|거슬|불편/.test(f.text));
  console.log('   unease lines:', uneasy.slice(0, 4).map((f) => `${f.speaker}: ${f.text}`).join(' | ') || '(none)');
  ok(!w.feed.some((f) => /왠지 좀 불편해/.test(f.text)), '17 the old one-size "왠지 좀 불편해" line is gone');
  // a real dislike still works
  const x = persons(w)[0];
  x.traits = ['고양이를 무서워한다'];
  const cat = w.agents.find((a) => a.kind === 'animal' && a.layers.species === 'cat');
  if (cat) {
    w.teleport(cat, x.x + 10, x.y);
    x.thoughts = x.thoughts.filter((t) => !t.key.startsWith('fear'));
    run(w, 300);
    ok(w.hasThought(x, `fear:${cat.id}`) || x.logs.some((l) => /몸이 굳는다/.test(l.text)), '12 a Will who fears cats still reacts to a cat');
  }
  // history-based unease
  const [p, q] = persons(w);
  w.addFeel(p.id, q.id, -60);
  w.teleport(q, p.x + 20, p.y);
  run(w, 300);
  ok(w.hasThought(p, `uneasy:${q.id}`), '17 unease appears when they really don\'t get on');
}

// ── 11) inner voice in the log ──
{
  const w = town();
  run(w, 4000);
  ok(w.feed.filter((f) => f.thought).length >= 5, `11 inner monologues reach the story log (${w.feed.filter((f) => f.thought).length})`);
}

// ── 13/15/18) buffered storyteller, speed modes, conversation context ──
async function bufferedTest() {
  const w = town();
  const seen = new Map<object, string>();
  let calls = 0, histories = 0;
  World.storyCapacity = () => 1;
  World.storyHook = (r) => {
    calls++;
    if (r.history && r.history.length) histories++;
    setTimeout(() => (Math.random() < 0.8 ? r.apply(`[다듬음] ${r.draft}`) : r.fail?.()), 5);
  };
  w.onFeed((f) => seen.set(f, f.text));
  for (let i = 0; i < 120; i++) {
    run(w, 25);
    await new Promise((res) => setTimeout(res, 2));
  }
  const changed = [...seen].filter(([f, t]) => (f as { text: string }).text !== t).length;
  ok(calls > 5, `13 storyteller asked (${calls} lines)`);
  ok(changed === 0, `13 no logged line changed after it appeared (changed: ${changed})`);
  ok(w.feed.some((f) => f.ai && f.text.startsWith('[다듬음]')), '13 polished lines are logged once, already polished');
  ok(histories > 0, `18 rewrite requests carry the conversation so far (${histories})`);
  // 3×: no storyteller; 5×: summaries
  calls = 0;
  w.simSpeed = 3;
  run(w, 1500);
  ok(calls === 0, '15 at 3× the storyteller is not used');
  const n0 = w.feed.length;
  w.simSpeed = 6;
  run(w, 3000);
  const fresh = w.feed.slice(n0);
  ok(fresh.some((f) => /이야기를 나눴다 \(\d+마디\)/.test(f.text)), '15 at 5×+ conversations are summarised in the log');
  { const bad = fresh.filter((f) => f.kind === 'line' && !f.thought && f.to); ok(!bad.length, `15 at 5×+ no line-by-line chatter in the log ${bad.slice(0, 3).map((f) => f.speaker + '→' + f.to + ': ' + f.text).join(' / ')}`); }
  World.storyHook = null;
  World.storyCapacity = () => 0.2;
}

// ── 9) needs ──
{
  const w = World.createWith({ context: '현대 서울', weather: 'clear', wills: 1, places: 0, animals: 0, empty: true });
  const solo = persons(w)[0];
  solo.traits = ['노래방에서 노래하는 걸 좋아한다', '커피를 사랑한다'];
  run(w, 20 * 60 * 10); // ~10 game hours
  const thoughts = solo.thoughts.map((t) => t.label).join(' / ');
  ok(/말 걸 사람이 아무도 없다/.test(thoughts) || solo.logs.some((l) => /말 걸 사람/.test(l.text)), `9 a lone Will says they have no one to talk to (${thoughts})`);
  ok(/밥 먹을 데가 없다|배가 고프다/.test(thoughts) || solo.logs.some((l) => /밥 먹을 곳/.test(l.text)), '9 hunger without any place to eat is expressed');
  ok(!!w.missingWish(solo), `9 wishes for missing places (${w.missingWish(solo)?.label})`);
}

// ── 14) freelance work ──
{
  const w = town();
  run(w, 20 * 60 * 24); // a day
  const workers = persons(w).filter((a) => a.logs.some((l) => /일했다|일을 시작/.test(l.text)) || a.jobId);
  ok(workers.length >= 3, `14 Wills find work (${workers.length})`);
  const moved = persons(w).filter((a) => a.logs.filter((l) => /대신 .*에서 일했다/.test(l.text)).length > 0).length;
  console.log('   moved between workplaces:', moved);
  const pinned = persons(w).find((a) => w.worksAtAll(a))!;
  const place = w.places.find((p) => p.workSpots.length > 0)!;
  w.setJob(pinned, place);
  ok(w.chooseWorkplace(pinned) === place, '14 a pinned workplace is respected');
}

// ── 16/22/21/24) relationships, gossip, romance, rumors ──
{
  const w = town();
  const ps = persons(w);
  // romance: two who adore each other, talking a lot
  const [x, y] = ps;
  w.addFeel(x.id, y.id, 95);
  w.addFeel(y.id, x.id, 95);
  for (let k = 0; k < 40 && w.relation(x.id, y.id).status !== 'lovers'; k++) {
    w.relation(x.id, y.id).confessedAt = undefined;
    // a refusal makes things a little awkward (feel −6/−2); restore it so a run of bad luck can't end the test
    w.addFeel(x.id, y.id, 95 - w.feel(x.id, y.id));
    w.addFeel(y.id, x.id, 95 - w.feel(y.id, x.id));
    (w as unknown as { maybeConfess: (a: Agent, b: Agent) => void }).maybeConfess(x, y);
  }
  ok(w.relation(x.id, y.id).status === 'lovers', '22 a mutual crush can become lovers');
  ok(w.feed.some((f) => f.kind === 'romance' && /연인/.test(f.text)), '22 the confession is in the log');
  // one-sided: usually rejected
  const [, , u, v] = ps;
  let accepted = 0;
  for (let k = 0; k < 30; k++) {
    const r = w.relation(u.id, v.id);
    r.status = undefined; r.confessedAt = undefined; r.ab = u.id === r.a ? 90 : 20; r.ba = u.id === r.a ? 20 : 90;
    (w as unknown as { maybeConfess: (a: Agent, b: Agent) => void }).maybeConfess(u, v);
    if (w.relation(u.id, v.id).status === 'lovers') accepted++;
  }
  ok(accepted <= 3, `22 one-sided confessions are usually turned down (${accepted}/~9 accepted)`);
  // run a couple of days: dates, decay, gossip, clashes
  run(w, 20 * 60 * 72);
  ok(w.feed.some((f) => /데이트 중/.test(f.text)) || w.relation(x.id, y.id).memories.some((m) => /데이트/.test(m.text)), '22 lovers go on dates');
  const negatives = [...w.relations.values()].filter((r) => r.ab < 0 || r.ba < 0).length;
  ok(negatives > 0, `16 some feelings turn negative (${negatives} relations)`);
  ok(w.feed.some((f) => /솔직히 .*…|좋은 사람이에요|챙겨 줘요|마음이 편해요/.test(f.text)) || w.rumors.rumors.some((r) => r.kind === 'gossip'), '16 talking about people who are not there (험담/칭찬) happens');
  // forgetting
  const r = w.relation(ps[4].id, ps[5].id);
  r.ab = 80; r.ba = 80; r.status = undefined;
  (w as unknown as { decayRelations: (m: number) => void }).decayRelations(24 * 60);
  ok(r.ab < 80 && r.ab > 60, `16 feelings fade toward 0 over a day (80 → ${r.ab.toFixed(1)})`);
  // witnesses
  const lone = World.createWith({ context: '현대 서울', weather: 'clear', wills: 2, places: 0, animals: 0, empty: true });
  const [m1, m2] = persons(lone);
  lone.teleport(m2, m1.x + 2000, m1.y);
  const rr = (lone as unknown as { naturalRumor: (...a: unknown[]) => unknown }).naturalRumor('둘이 싸웠대', [m1], m1, -0.5, 'fight');
  ok(rr === null, '21 no witness → no rumor');
  lone.teleport(m2, m1.x + 30, m1.y);
  const r2 = (lone as unknown as { naturalRumor: (...a: unknown[]) => { knownBy: string[] } | null }).naturalRumor('혼자 울고 있었대', [m1], m1, -0.5, 'struggle');
  ok(!!r2 && !r2.knownBy.includes(m1.id) && r2.knownBy.includes(m2.id), '21 the witness knows, the subject is not counted');
  // trend decay
  const mill = w.rumors;
  const t = mill.add({ text: '테스트 소문이래', tag: '#테스트', about: [], sentiment: 0, knownBy: [ps[0].id], origin: 'natural', born: w.meta.minutes, heat: 40 })!;
  const h0 = t.heat;
  mill.tick(180, w.meta.minutes + 180);
  ok(Math.abs(t.heat - h0 / 2) < 0.5, `24 trend heat halves in 3 game hours (${h0} → ${t.heat.toFixed(1)})`);
}

// ── 19) names ──
{
  const themes = ['현대 서울', '중세 판타지 왕국', '좀비 아포칼립스', '사이버펑크 도시', '조선 시대', '해적 항구', '우주 정거장'];
  const bad: string[] = [];
  for (const th of themes) for (let s = 0; s < 30; s++) {
    const n = randomName(th, s * 7919 + 1, new Set());
    if (!(/\s/.test(n) || /^[가-힣]{2,4}$/.test(n))) bad.push(`${th}:${n}`);
  }
  ok(bad.length === 0, `19 every Will has a family name (${bad.slice(0, 5).join(', ') || 'all ok'})`);
  ok(givenName('아렌 블랙우드') === '아렌' && givenName('남궁현우') === '현우' && givenName('김민수') === '민수', '19 given names parsed (서양식·두 글자 성 포함)');
  const w = town();
  const [a, b] = persons(w);
  a.traits = [...a.traits, '예의가 바르고 정중하다'];
  w.addFeel(a.id, b.id, 50);
  ok(w.referName(a, b) === `${b.name} 씨`, `19 a formal Will keeps the family name at 50 (${w.referName(a, b)})`);
}

// ── 23) separation ──
{
  const w = town();
  const [a, b] = persons(w);
  w.teleport(b, a.x, a.y);
  b.x = a.x; b.y = a.y;
  a.ai.mode = 'idle'; b.ai.mode = 'idle'; a.ai.timer = 99; b.ai.timer = 99;
  for (let i = 0; i < 40; i++) w.update(0.05);
  ok(Math.hypot(a.x - b.x, a.y - b.y) >= 6, `23 two Wills on the same spot drift apart (${Math.hypot(a.x - b.x, a.y - b.y).toFixed(1)}px)`);
  ok(w.agentsAtAll(a.x, a.y - 12, 30).length >= 2, '23 clicks can cycle through everyone under the cursor');
}

// ── 25) romance words survive the rewrite ──
ok(cleanOutput('둘이 무슨 일 있는 거 아니에요?', 'line', '민수랑 영희, 사귄대요!', 'polite') === null, '25 a rewrite that drops "사귄다" is rejected');
ok(cleanOutput('민수 씨랑 영희 씨, 사귄대요! 정말 잘 어울려요.', 'line', '민수랑 영희, 사귄대요!', 'polite') !== null, '25 a rewrite that keeps it passes');

// ── chat commands still parse ──
for (const s of ['맵 편집', '길 만들래', '밤 건너뛰기', '10배속', '비 내리게 해줘', '고양이를 좋아하는 샐러리맨 소환', '광장에서 축제 열어 줘']) ok(!!parseCommand(s), `cmd parses: ${s}`);

// ── save/load with all the new state ──
{
  const w = town();
  run(w, 20 * 60 * 8);
  const [x, y] = persons(w);
  w.relation(x.id, y.id).status = 'lovers';
  x.workPin = 'none';
  const w2 = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(w))));
  ok(w2.relation(x.id, y.id).status === 'lovers' && w2.agent(x.id)!.workPin === 'none' && !!w2.agent(x.id)!.needs, 'save/load keeps lovers, work choice, needs');
  // stability + speed: 2 game days with 20 Wills
  const big = World.createWith({ context: '현대 서울', weather: 'clear', wills: 20, places: 10, animals: 4 });
  const t0 = performance.now();
  let threw = '';
  try { run(big, 20 * 60 * 48); } catch (e) { threw = String(e); }
  const ms = (performance.now() - t0) / (20 * 60 * 48);
  ok(!threw, `2 game days with 20 Wills, no errors ${threw}`);
  ok(ms < 0.5, `average tick ${ms.toFixed(3)} ms`);
}

await bufferedTest();
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fails.length) console.log('FAILED:\n- ' + fails.join('\n- '));
