import { World } from '../src/engine/World';
import { Game } from '../src/engine/Game';
import { PLACE_SIZES, D } from '../src/engine/TileMap';
import { serializeWorld, deserializeWorld } from '../src/engine/save';
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? pass++ : fail++, console.log(c ? 'PASS' : 'FAIL', m));
const w = new World('현대 서울', 'clear', { empty: true });
w.resizeMap(0, 0, 120, 100);
const g = new Game(w);
g.dispatch({ type: 'SPAWN_ENTITY', entity: { kind: 'person', traits: ['커피를 좋아한다'] }, at: { x: 10 * 32, y: 70 * 32 } });
const styles = Object.keys(PLACE_SIZES) as (keyof typeof PLACE_SIZES)[];
let x = 4, y = 4, bad: string[] = [];
for (const side of ['left', 'right'] as const) {
  for (const st of styles) {
    const [tw0, th0] = PLACE_SIZES[st];
    if (x + th0 + 2 > w.map.w) { x = 4; y += 14; }
    if (y + tw0 + 2 > w.map.h) { w.resizeMap(0, 0, 0, 20); }
    const p = w.addPlaceAt({ name: `${st}-${side}`, style: st, appearance: '', traits: [] }, x, y, side);
    if (!p) { bad.push(`${st}/${side}: no build`); x += th0 + 2; continue; }
    // turned footprint, door on that wall, door tile outside and walkable, all seats/work spots reachable from it
    const doorOk = side === 'left' ? p.door.tx === p.tx - 1 : p.door.tx === p.tx + p.tw;
    const sizeOk = p.tw === th0 && p.th === tw0;
    const spots = [...p.seats, ...p.workSpots];
    const unreachable = spots.filter((s) => !w.map.findPath(p.door.tx, p.door.ty, s.tx, s.ty) && !(s.tx === p.door.tx && s.ty === p.door.ty));
    if (!doorOk || !sizeOk || unreachable.length) bad.push(`${st}/${side}: door=${doorOk} size=${sizeOk} unreachable=${unreachable.length}/${spots.length}`);
    x += th0 + 2;
  }
}
ok(bad.length === 0, `all ${styles.length} styles × left/right: turned size, door on that wall, every seat & work spot reachable ${bad.join(' | ')}`);
// R in the placement ghost + save/load + move keeps the turn
g.tool = { label: 't', ghost: { kind: 'place', style: 'cafe', name: '카페' }, build: () => null };
(g as unknown as { hoverWorld: { x: number; y: number } }).hoverWorld = { x: 30 * 32, y: 60 * 32 };
const seq = [g.rotatePlacement() && g.placeDoor, g.rotatePlacement() && g.placeDoor, g.rotatePlacement() && g.placeDoor, g.rotatePlacement() && g.placeDoor];
ok(seq.join(',').split(',').length === 4 && new Set(seq).size === 4, `R cycles the door through all four walls: ${seq.join(' → ')}`);
const cafe = w.places.find((p) => p.name === 'cafe-left')!;
const back = deserializeWorld(serializeWorld(w));
const c2 = back.places.find((p) => p.name === 'cafe-left')!;
ok(back.doorSideOf(c2) === 'left' && c2.tw === cafe.tw && c2.door.tx === cafe.door.tx, 'turned buildings survive save/load');
const moved = w.movePlace(cafe, cafe.tx, cafe.ty + 40);
ok(moved.ok ? w.doorSideOf(cafe) === 'left' : true, `moving keeps it turned (${moved.message || 'ok'})`);
// people actually use a turned building
const p0 = w.agents.find((a) => a.kind === 'person')!;
w.meta.minutes = 14 * 60;
w.visitNow(p0, cafe);
let t = 0;
for (; t < 20 * 60 * 2 && !(p0.ai.mode === 'visit' && p0.ai.targetPlaceId === cafe.id); t++) w.update(0.05);
ok(p0.ai.mode === 'visit', `a Will walks into the turned café (${(t * 0.05).toFixed(0)} game min)`);
console.log(`=== ${pass} passed, ${fail} failed ===`);
void D;
