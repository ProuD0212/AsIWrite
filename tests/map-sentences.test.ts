// Map sentences in many phrasings → parse → run on a real world. Expected slots, not exact strings.
import { World } from '../src/engine/World';
import { Game } from '../src/engine/Game';
import { parseCommand } from '../src/commands/ruleParser';

type Exp = { type?: string; brush?: string; area?: string; dir?: string; at?: string; only?: string; where?: string; run?: boolean };
const CASES: [string, Exp][] = [
  // the original sentence and its cousins
  ['중앙에 인도를 쭉 깔아줘', { brush: 'sidewalk', area: 'line', at: 'center' }],
  ['가운데에 인도 깔아 줘', { brush: 'sidewalk', area: 'line', at: 'center' }],
  ['맵 한가운데로 보도를 쭉 내줘', { brush: 'sidewalk', area: 'line', at: 'center' }],
  ['가로로 도로 하나 깔아줘', { brush: 'road', area: 'line', dir: 'h' }],
  ['세로로 큰길 하나 내 줘', { brush: 'road', area: 'line', dir: 'v' }],
  ['십자 모양으로 도로를 깔아', { brush: 'road', area: 'line', dir: 'cross' }],
  ['위쪽에 가로로 흙길 만들어줘', { brush: 'dirt', area: 'line', at: 'top', dir: 'h' }],
  ['왼쪽에 세로로 산책로를 놓아 줘', { brush: 'dirt', area: 'line', at: 'left', dir: 'v' }],
  ['아래쪽에 길 쭉 깔아줘', { brush: 'road', area: 'line', at: 'bottom' }],
  ['오른쪽에 인도 깔아줘', { brush: 'sidewalk', area: 'line', at: 'right' }],
  ['길 하나 깔아줘', { brush: 'road', area: 'line' }],
  ['동서로 가로지르는 도로를 만들어', { brush: 'road', area: 'line', dir: 'h' }],
  ['남북으로 길을 하나 뚫어줘 깔아줘', { brush: 'road', area: 'line', dir: 'v' }],
  ['3칸짜리 넓은 도로를 가운데에 깔아', { brush: 'road', area: 'line', at: 'center' }],
  ['폭 2칸으로 인도를 세로로 깔아줘', { brush: 'sidewalk', area: 'line', dir: 'v' }],
  ['좁은 흙길을 가로로 하나 내줘', { brush: 'dirt', area: 'line', dir: 'h' }],
  // routes
  ['카페에서 도서관까지 길 깔아줘', { brush: 'road', area: 'path' }],
  ['카페에서 공원까지 인도를 이어 줘', { brush: 'sidewalk', area: 'path' }],
  ['카페와 도서관을 흙길로 연결해줘', { brush: 'dirt', area: 'path' }],
  ['공원까지 산책로를 만들어 줘', { brush: 'dirt', area: 'path' }],
  ['도서관까지 가는 길 깔아 줘', { brush: 'road', area: 'path' }],
  // around something
  ['카페 주변에 꽃 심어줘', { brush: 'flower', area: 'around' }],
  ['공원 근처에 나무를 많이 심어 줘', { brush: 'tree', area: 'around' }],
  ['도서관 앞에 벤치 놓아줘', { brush: 'bench', area: 'around' }],
  ['카페 옆에 가로등 하나 세워줘', { brush: 'lamp', area: 'around' }],
  ['카페 앞을 돌바닥으로 꾸며줘', { brush: 'plaza', area: 'around' }],
  ['공원 둘레에 덤불 심어줘', { brush: 'bush', area: 'around' }],
  // roadside / border
  ['길가에 가로수 심어줘', { brush: 'tree', area: 'roadside' }],
  ['도로 양옆에 가로등 세워 줘', { brush: 'lamp', area: 'roadside' }],
  ['길 따라 꽃을 심어줘', { brush: 'flower', area: 'roadside' }],
  ['인도마다 벤치 좀 놓아줘', { brush: 'bench', area: 'roadside' }],
  ['맵 테두리에 나무를 심어', { brush: 'tree', area: 'border' }],
  ['마을 외곽을 덤불로 빙 둘러 줘 심어', { brush: 'bush', area: 'border' }],
  ['가장자리에 흙길 깔아줘', { brush: 'dirt', area: 'border' }],
  // regions / scatter
  ['나무 심어줘', { brush: 'tree', area: 'region', where: 'all' }],
  ['여기저기 꽃 좀 심어 줘', { brush: 'flower', area: 'region', where: 'all' }],
  ['왼쪽 위에 나무를 빽빽하게 심어줘', { brush: 'tree', area: 'region', where: 'topleft' }],
  ['오른쪽 아래에 꽃밭 만들어줘', { brush: 'flower', area: 'region', where: 'bottomright' }],
  ['북동쪽에 나무 20그루 심어', { brush: 'tree', area: 'region', where: 'topright' }],
  ['위쪽에 가로등 몇 개 세워줘', { brush: 'lamp', area: 'region', where: 'top' }],
  ['가운데를 광장 바닥으로 바꿔줘', { brush: 'plaza', area: 'region', where: 'center' }],
  ['동네 곳곳에 벤치를 놓아 줘', { brush: 'bench', area: 'region', where: 'all' }],
  ['남서쪽을 잔디로 덮어줘', { brush: 'grass', area: 'region', where: 'bottomleft' }],
  // erase / replace
  ['나무 다 베어줘', { brush: 'erase', only: 'tree', area: 'region' }],
  ['꽃 전부 뽑아 줘', { brush: 'erase', only: 'flower', area: 'region' }],
  ['가로등 다 없애줘', { brush: 'erase', only: 'lamp', area: 'region' }],
  ['왼쪽에 있는 나무 치워줘', { brush: 'erase', only: 'tree', area: 'region', where: 'left' }],
  ['도로를 전부 잔디로 바꿔줘', { brush: 'grass', only: 'road', area: 'region' }],
  ['흙길을 인도로 바꿔 줘', { brush: 'sidewalk', only: 'dirt', area: 'region' }],
  ['길 다 없애줘', { brush: 'grass', only: 'road', area: 'region' }],
  ['카페 주변 나무 치워줘', { brush: 'erase', only: 'tree', area: 'around' }],
  // resize
  ['맵을 오른쪽으로 20칸 넓혀줘', { type: 'RESIZE_MAP' }],
  ['맵 세로로 늘려 줘', { type: 'RESIZE_MAP' }],
  ['마을을 좀 줄여줘', { type: 'RESIZE_MAP' }],
  ['땅을 위쪽으로 10칸 확장해', { type: 'RESIZE_MAP' }],
  ['맵 넓혀줘', { type: 'SYSTEM' }],
  // edit mode
  ['맵 편집 모드 켜줘', { type: 'SYSTEM' }],
  ['직접 길 그릴래', { type: 'SYSTEM' }],
  // must NOT be map paint
  ['카페 하나 지어줘', { type: 'SPAWN_ENTITY', run: false }],
  ['꽃집 만들어줘', { type: 'SPAWN_ENTITY', run: false }],
  ['나무가 많은 공원 만들어줘', { type: 'SPAWN_ENTITY', run: false }],
  ['꽃을 좋아하는 할머니 소환', { type: 'SPAWN_ENTITY', run: false }],
  ['광장 만들어 줘', { type: 'SPAWN_ENTITY', run: false }],
  ['광장에서 축제 열어줘', { type: 'WORLD_EVENT', run: false }],
  ['김민수에게 "꽃 심는 거 좋아해요?"', { type: 'TALK', run: false }],
];

let pass = 0, fail = 0;
const w = World.createWith({ context: '현대 서울', weather: 'clear', wills: 4, places: 0, animals: 0 });
const g = new Game(w);
// a few named buildings to aim at
g.dispatch({ type: 'SPAWN_ENTITY', entity: { kind: 'place', style: 'cafe', name: '카페' }, at: { x: 20 * 32, y: 12 * 32 } });
g.dispatch({ type: 'SPAWN_ENTITY', entity: { kind: 'place', style: 'library', name: '도서관' }, at: { x: 50 * 32, y: 34 * 32 } });
g.dispatch({ type: 'SPAWN_ENTITY', entity: { kind: 'place', style: 'park', name: '공원' }, at: { x: 52 * 32, y: 10 * 32 } });
console.log('places:', w.places.map((p) => p.name).join(', '));
for (const [s, e] of CASES) {
  const c = parseCommand(s) as Record<string, unknown> | null;
  const area = (c?.area ?? {}) as Record<string, unknown>;
  const errs: string[] = [];
  const want = e.type ?? 'PAINT_MAP';
  if (c?.type !== want) errs.push(`type ${c?.type}≠${want}`);
  if (want === 'PAINT_MAP' && c?.type === 'PAINT_MAP') {
    if (e.brush && c.brush !== e.brush) errs.push(`brush ${c.brush}≠${e.brush}`);
    if (e.only && c.only !== e.only) errs.push(`only ${c.only}≠${e.only}`);
    if (e.area && area.kind !== e.area) errs.push(`area ${area.kind}≠${e.area}`);
    if (e.dir && area.dir !== e.dir) errs.push(`dir ${area.dir}≠${e.dir}`);
    if (e.at && area.at !== e.at) errs.push(`at ${area.at}≠${e.at}`);
    if (e.where && area.where !== e.where) errs.push(`where ${area.where}≠${e.where}`);
  }
  let ran = '';
  if (!errs.length && c && e.run !== false && (c.type === 'PAINT_MAP' || c.type === 'RESIZE_MAP')) {
    const r = g.dispatch(c as never);
    ran = ` → ${r.ok ? '✓' : '✗'} ${r.message}`;
    // erase/replace on an empty spot may legitimately change nothing
    if (!r.ok && !/바뀐 곳이 없어요|이미 큰길/.test(r.message)) errs.push('run failed');
  }
  errs.length ? fail++ : pass++;
  console.log(errs.length ? 'FAIL' : 'PASS', s, errs.length ? `[${errs.join(', ')}] ${JSON.stringify(c)}` : ran);
}
console.log(`=== ${pass} passed, ${fail} failed ===`);
