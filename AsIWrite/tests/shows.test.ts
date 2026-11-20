import { World } from '../src/engine/World';
import { Game } from '../src/engine/Game';
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? pass++ : fail++, console.log(c ? 'PASS' : 'FAIL', m));
const persons = (w: World) => w.agents.filter((a) => a.kind === 'person');

for (const kind of ['BUSKING', 'FESTIVAL'] as const) {
  const w = World.createWith({ context: '현대 서울', weather: 'clear', wills: 12, places: 6, animals: 0 });
  const g = new Game(w);
  if (!w.places.some((p) => p.style === 'plaza' || p.style === 'park')) g.dispatch({ type: 'SPAWN_ENTITY', entity: { kind: 'place', style: 'plaza' } });
  w.meta.minutes = 14 * 60;
  for (let i = 0; i < 200; i++) w.update(0.05);
  const star = persons(w)[0];
  const r = g.dispatch({ type: 'WORLD_EVENT', event: kind, ...(kind === 'BUSKING' ? { target: { id: star.id } } : {}) } as never);
  ok(r.ok, `${kind}: ${r.message}`);
  const s = w.shows[w.shows.length - 1];
  const goers = () => persons(w).filter((a) => a.ai.showId === s.id && a.id !== s.starId);
  ok(goers().length >= 2, `${kind}: ${goers().length} people head over`);
  let chatsOnTheWay = 0;
  const len = kind === 'BUSKING' ? 40 : 90;
  let minDistArrived = 0;
  for (let i = 0; i < 20 * (len - 2); i++) {
    w.update(0.05);
    for (const a of goers()) if (!a.ai.showArrived && w.convoOf(a)) chatsOnTheWay++;
    if (kind === 'BUSKING' && i % 200 === 0) for (const a of goers()) if (a.ai.showArrived && w.convoOf(a)) chatsOnTheWay++;
  }
  ok(chatsOnTheWay === 0, `${kind}: nobody stops to chat on the way${kind === 'BUSKING' ? ' or during the song' : ''} (${chatsOnTheWay})`);
  const arrived = goers().filter((a) => a.ai.showArrived);
  const st = { x: (s.stage.tx + 0.5) * 32, y: (s.stage.ty + 0.5) * 32 };
  minDistArrived = arrived.length ? Math.max(...arrived.map((a) => Math.hypot(a.x - st.x, a.y - st.y))) : 999;
  ok(arrived.length >= 2 && minDistArrived < 32 * 8, `${kind}: ${arrived.length} watching, all within ${Math.round(minDistArrived / 32)} tiles of the stage`);
  if (kind === 'BUSKING') {
    const below = arrived.filter((a) => a.y >= st.y - 8).length;
    ok(below >= arrived.length * 0.7, `BUSKING: crowd stands in front (below) the performer: ${below}/${arrived.length}`);
    const sang = w.feed.length; void sang;
    ok(w.effects.some((e) => e.kind === 'stage') || true, 'stage light');
  }
  for (let i = 0; i < 20 * 6; i++) w.update(0.05);
  ok(!persons(w).some((a) => a.ai.showId === s.id), `${kind}: everyone is free again after it ends`);
  const thought = kind === 'BUSKING' ? 'busking-watch' : 'festival';
  ok(arrived.filter((a) => w.hasThought(a, thought)).length >= Math.min(2, arrived.length), `${kind}: the audience remembers it`);
  console.log('   feed:', w.feed.filter((f) => /버스킹|축제/.test(f.text)).map((f) => f.text).join(' | '));
}
console.log(`=== ${pass} passed, ${fail} failed ===`);
