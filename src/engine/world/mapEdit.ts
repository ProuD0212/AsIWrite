// World · 맵 편집 · 맵 칠하기
// These are methods of the World class kept in their own file. They are installed on
// World.prototype at the end of World.ts, so callers keep writing world.someMethod() as before.

import { D, G, TILE, type MapBrush } from '../TileMap';
import { josa, suffix } from '../traits';
import { type Agent, type Place } from '../types';
import { hashString } from '../util';
import { type PaintArea, World } from '../World';

export const mapEditMethods = {
  /**
   * Map painting from a sentence ("중앙에 인도를 쭉 깔아 줘", "공원 주변에 꽃 심어 줘",
   * "카페에서 도서관까지 흙길", "길가에 가로등"). Ground brushes cover the area; trees, flowers,
   * lamps and benches are spaced out or scattered. Buildings are never painted over.
   */
  paintArea(this: World, brush: MapBrush, area: PaintArea, opt: { width?: number; count?: number; density?: 'few' | 'many'; only?: MapBrush } = {}): { ok: boolean; message: string; changed: number } {
    const m = this.map;
    const ground = brush === 'road' || brush === 'sidewalk' || brush === 'dirt' || brush === 'plaza' || brush === 'grass';
    const deco = !ground && brush !== 'erase';
    const GROUND_OF: Partial<Record<MapBrush, number>> = { road: G.Road, sidewalk: G.Sidewalk, dirt: G.Dirt, plaza: G.Plaza, grass: G.Grass };
    const DECO_OF: Partial<Record<MapBrush, number>> = { tree: D.Tree, bush: D.Bush, flower: D.Flower, lamp: D.Lamp, bench: D.Bench };
    const free = (x: number, y: number) => m.inBounds(x, y) && m.owner[m.idx(x, y)] === 0;
    const isRoad = (x: number, y: number) => m.inBounds(x, y) && m.ground[m.idx(x, y)] === G.Road;
    const nearDoor = (x: number, y: number) => this.places.some((p) => Math.abs(p.door.tx - x) <= 1 && Math.abs(p.door.ty - y) <= 2);
    // a decoration may go here: open land, not on asphalt, not in front of a door
    const decoOk = (x: number, y: number) => {
      if (!free(x, y) || isRoad(x, y) || nearDoor(x, y)) return false;
      const i = m.idx(x, y);
      if (m.deco[i] !== D.None) return false;
      const g = m.ground[i];
      return brush === 'lamp' || brush === 'bench' ? true : g === G.Grass || g === G.Dirt || (brush === 'flower' && g === G.Plaza);
    };
    let changed = 0, roadHits = 0;
    const put = (x: number, y: number, size = 1) => {
      if (!m.inBounds(x, y)) return;
      // a path of earth or pavement doesn't dig up an existing road
      if (ground && brush !== 'road' && size === 1 && isRoad(x, y) && !opt.only) return void roadHits++;
      changed += this.paintMap(x, y, brush, size);
    };
    const spaced = (tiles: { tx: number; ty: number }[]) => {
      const gap = { tree: 3, bush: 2, flower: 1, lamp: 6, bench: 7 }[brush as 'tree'] ?? 2;
      let last = -1e9, k = 0;
      for (const t of tiles) {
        k++;
        if (k - last < gap || !decoOk(t.tx, t.ty)) continue;
        if (m.paint(t.tx, t.ty, brush)) (changed++, (last = k));
      }
    };
    const scatter = (cands: { tx: number; ty: number }[], n0: number) => {
      const n = opt.count ?? Math.max(1, Math.round(n0 * (opt.density === 'many' ? 2 : opt.density === 'few' ? 0.4 : 1)));
      const pool = cands.filter((t) => decoOk(t.tx, t.ty));
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      for (const t of pool.slice(0, n)) changed += this.paintMap(t.tx, t.ty, brush, 1);
    };
    const rect = (x0: number, y0: number, x1: number, y1: number) => {
      const out: { tx: number; ty: number }[] = [];
      for (let y = Math.max(0, y0); y <= Math.min(m.h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(m.w - 1, x1); x++) out.push({ tx: x, ty: y });
      return out;
    };
    const W = m.w, H = m.h;
    const width = Math.max(1, Math.min(6, opt.width ?? ({ road: 2, sidewalk: 2, dirt: 1, plaza: 3, grass: 2 }[brush as 'road'] ?? 1)));
    // clear / replace: "나무 다 베어 줘", "도로를 다 없애 줘"
    const replace = (tiles: { tx: number; ty: number }[]) => {
      const only = opt.only;
      for (const t of tiles) {
        if (!free(t.tx, t.ty)) continue;
        const i = m.idx(t.tx, t.ty);
        if (brush === 'erase') {
          if (m.deco[i] === D.None || (only && DECO_OF[only] !== undefined && m.deco[i] !== DECO_OF[only]) || m.deco[i] === D.Wall || m.deco[i] === D.Door) continue;
          if (m.paint(t.tx, t.ty, 'erase')) changed++;
        } else if (only && GROUND_OF[only] !== undefined) {
          const g = m.ground[i];
          const match = only === 'road' ? g === G.Road || g === G.Sidewalk : g === GROUND_OF[only];
          if (match && m.ground[i] !== GROUND_OF[brush]) {
            m.paint(t.tx, t.ty, brush);
            changed++;
          }
        }
      }
    };
    let where = '';
    switch (area.kind) {
      case 'line': {
        const at = area.at ?? 'center';
        const rowAt = { center: Math.floor(H / 2), top: Math.floor(H * 0.25), bottom: Math.floor(H * 0.75), left: Math.floor(H / 2), right: Math.floor(H / 2) }[at];
        const colAt = { center: Math.floor(W / 2), left: Math.floor(W * 0.25), right: Math.floor(W * 0.75), top: Math.floor(W / 2), bottom: Math.floor(W / 2) }[at];
        const dir = area.dir ?? (at === 'left' || at === 'right' ? 'v' : at === 'top' || at === 'bottom' ? 'h' : W >= H ? 'h' : 'v');
        const off = -Math.floor((width - 1) / 2);
        const h = () => {
          const row = Array.from({ length: W }, (_, x) => ({ tx: x, ty: rowAt }));
          if (deco) spaced(row);
          else for (let k = 0; k < width; k++) for (let x = 0; x < W; x++) put(x, rowAt + off + k);
        };
        const v = () => {
          const col = Array.from({ length: H }, (_, y) => ({ tx: colAt, ty: y }));
          if (deco) spaced(col);
          else for (let k = 0; k < width; k++) for (let y = 0; y < H; y++) put(colAt + off + k, y);
        };
        if (dir !== 'v') h();
        if (dir !== 'h') v();
        where = `${{ center: '가운데', top: '위쪽', bottom: '아래쪽', left: '왼쪽', right: '오른쪽' }[at]}에 ${{ h: '가로로', v: '세로로', cross: '십자로' }[dir]}`;
        break;
      }
      case 'border': {
        const ring: { tx: number; ty: number }[] = [];
        for (let x = 1; x < W - 1; x++) ring.push({ tx: x, ty: 1 });
        for (let y = 2; y < H - 1; y++) ring.push({ tx: W - 2, ty: y });
        for (let x = W - 3; x >= 1; x--) ring.push({ tx: x, ty: H - 2 });
        for (let y = H - 3; y >= 2; y--) ring.push({ tx: 1, ty: y });
        if (deco) spaced(ring);
        else for (const t of ring) put(t.tx, t.ty, 1);
        where = '맵 테두리를 따라';
        break;
      }
      case 'roadside': {
        const side: { tx: number; ty: number }[] = [];
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            if (isRoad(x, y)) continue;
            // the first tile off the asphalt (past the auto-sidewalk)
            const n4 = [isRoad(x - 2, y), isRoad(x + 2, y), isRoad(x, y - 2), isRoad(x, y + 2), isRoad(x - 1, y), isRoad(x + 1, y), isRoad(x, y - 1), isRoad(x, y + 1)];
            if (n4.some(Boolean)) side.push({ tx: x, ty: y });
          }
        if (!side.length) return { ok: false, message: '아직 도로가 없어요. 먼저 「가운데에 도로 깔아 줘」처럼 길을 내 보세요.', changed: 0 };
        // walk them in reading order per row/column so spacing looks even
        side.sort((a, b) => a.ty - b.ty || a.tx - b.tx);
        if (deco) spaced(side);
        else for (const t of side) put(t.tx, t.ty, 1);
        where = '길가에';
        break;
      }
      case 'around': {
        const e = area.target;
        const r = area.radius ?? (ground ? 1 : 3);
        let tiles: { tx: number; ty: number }[];
        if ('tw' in e) tiles = rect(e.tx - r, e.ty - r, e.tx + e.tw - 1 + r, e.ty + e.th - 1 + r).filter((t) => free(t.tx, t.ty));
        else {
          const c = this.tileOf(e);
          tiles = rect(c.tx - r, c.ty - r, c.tx + r, c.ty + r).filter((t) => (t.tx - c.tx) ** 2 + (t.ty - c.ty) ** 2 <= r * r + 1);
        }
        if (deco) scatter(tiles, Math.max(2, Math.round(tiles.length * ({ flower: 0.4, tree: 0.15, bush: 0.15, lamp: 0.04, bench: 0.04 }[brush as 'tree'] ?? 0.1))));
        else if (brush === 'erase' || opt.only) replace(tiles);
        else for (const t of tiles) if (!nearDoor(t.tx, t.ty) || brush !== 'grass') put(t.tx, t.ty, 1);
        where = `${e.name} 주변에`;
        break;
      }
      case 'path': {
        const from = area.from, to = area.to;
        const outside = (p: Agent | Place): { tx: number; ty: number } => {
          if (!('tw' in p)) return this.tileOf(p);
          const d = p.door;
          for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (free(d.tx + dx, d.ty + dy)) return { tx: d.tx + dx, ty: d.ty + dy };
          return d;
        };
        const goal = outside(to);
        let start: { tx: number; ty: number } | null = from ? outside(from) : null;
        if (!start) {
          // from the nearest road or pavement (or the middle of the map if there's none)
          let best = Infinity;
          for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
              const g = m.ground[m.idx(x, y)];
              if ((g !== G.Road && g !== G.Sidewalk && g !== G.Plaza && g !== G.Dirt) || !free(x, y)) continue;
              const d = Math.abs(x - goal.tx) + Math.abs(y - goal.ty);
              if (d < best && d > 1) (best = d), (start = { tx: x, ty: y });
            }
          start ??= { tx: Math.floor(W / 2), ty: Math.floor(H / 2) };
        }
        const route = this.groundRoute(start, goal);
        if (!route) return { ok: false, message: '건물에 막혀 길을 이을 수 없어요.', changed: 0 };
        if (deco) spaced(route);
        else for (const t of route) put(t.tx, t.ty, width >= 2 ? 2 : 1);
        where = from ? `${from.name}에서 ${to.name}까지` : `${to.name}까지`;
        break;
      }
      case 'region': {
        const q = area.where;
        const x3 = Math.floor(W / 3), y3 = Math.floor(H / 3), xm = Math.floor(W / 2), ym = Math.floor(H / 2);
        const R: Record<typeof q, [number, number, number, number]> = {
          all: [0, 0, W - 1, H - 1], top: [0, 0, W - 1, y3], bottom: [0, H - y3, W - 1, H - 1], left: [0, 0, x3, H - 1], right: [W - x3, 0, W - 1, H - 1],
          topleft: [0, 0, xm, ym], topright: [xm, 0, W - 1, ym], bottomleft: [0, ym, xm, H - 1], bottomright: [xm, ym, W - 1, H - 1], center: [x3, y3, W - x3, H - y3],
        };
        const tiles = rect(...R[q]);
        if (brush === 'erase' || opt.only) replace(tiles);
        else if (deco) scatter(tiles, Math.max(4, Math.round(tiles.length * ({ flower: 0.03, tree: 0.016, bush: 0.012, lamp: 0.004, bench: 0.004 }[brush as 'tree'] ?? 0.01))));
        else for (const t of tiles) if (free(t.tx, t.ty) && !nearDoor(t.tx, t.ty)) put(t.tx, t.ty, 1);
        where = { all: '마을 전체에', top: '위쪽에', bottom: '아래쪽에', left: '왼쪽에', right: '오른쪽에', topleft: '왼쪽 위에', topright: '오른쪽 위에', bottomleft: '왼쪽 아래에', bottomright: '오른쪽 아래에', center: '가운데에' }[q];
        break;
      }
    }
    const NAME: Record<MapBrush, string> = { road: '도로', sidewalk: '인도', dirt: '흙길', plaza: '돌바닥', grass: '잔디', tree: '나무', bush: '덤불', flower: '꽃', lamp: '가로등', bench: '벤치', erase: '장식' };
    if (!changed) {
      if (area.kind === 'line' && ground && brush !== 'road' && roadHits > 0) return { ok: false, message: `${where}에는 이미 큰길과 양옆 ${NAME.sidewalk}${suffix(NAME.sidewalk, '이/가')} 있어요 — 「위쪽에 가로로 ${NAME[brush]}」처럼 다른 곳을 말해 보세요.`, changed: 0 };
      const what = brush === 'erase' ? (opt.only ? NAME[opt.only] : '장식') : NAME[opt.only ?? brush];
      return { ok: false, message: brush === 'erase' || opt.only ? `바뀐 곳이 없어요 — ${where.replace(/에$/, '')}에는 ${josa(what, '이/가')} 없어요.` : `바뀐 곳이 없어요 — ${where.replace(/에$/, '')}에는 이미 ${josa(what, '이/가')} 있거나 건물에 막혔어요.`, changed: 0 };
    }
    const verb = brush === 'erase' ? `${josa(opt.only ? NAME[opt.only] : '나무·꽃 같은 장식', '을/를')} 치웠어요` : opt.only ? `${josa(NAME[opt.only], '을/를')} ${NAME[brush]}${josa(NAME[brush], '으로/로').slice(NAME[brush].length)} 바꿨어요` : ground ? `${josa(NAME[brush], '을/를')} 깔았어요` : `${josa(NAME[brush], '을/를')} ${{ tree: '심었어요', flower: '심었어요', bush: '심었어요', lamp: '세웠어요', bench: '놓았어요' }[brush as 'tree']}`;
    return { ok: true, message: `🛠️ ${where} ${verb} (${changed}칸). 마음에 안 들면 Ctrl+Z`, changed };
  },
  /** a walkable-on-foot route for a new path: around buildings, preferring existing roads (4-way A*) */
  groundRoute(this: World, s: { tx: number; ty: number }, g: { tx: number; ty: number }): { tx: number; ty: number }[] | null {
    const m = this.map;
    const N = m.w * m.h;
    const cost = new Float32Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const open: [number, number][] = [];
    const push = (i: number, f: number) => {
      open.push([f, i]);
      let k = open.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (open[p][0] <= open[k][0]) break;
        [open[p], open[k]] = [open[k], open[p]];
        k = p;
      }
    };
    const pop = () => {
      const top = open[0];
      const last = open.pop()!;
      if (open.length) {
        open[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1;
          let s2 = k;
          if (l < open.length && open[l][0] < open[s2][0]) s2 = l;
          if (r < open.length && open[r][0] < open[s2][0]) s2 = r;
          if (s2 === k) break;
          [open[s2], open[k]] = [open[k], open[s2]];
          k = s2;
        }
      }
      return top;
    };
    const si = m.idx(s.tx, s.ty), gi = m.idx(g.tx, g.ty);
    const h = (i: number) => Math.abs((i % m.w) - g.tx) + Math.abs(Math.floor(i / m.w) - g.ty);
    cost[si] = 0;
    push(si, h(si));
    let seen = 0;
    while (open.length && seen++ < 200000) {
      const [, i] = pop();
      if (i === gi) break;
      const x = i % m.w, y = Math.floor(i / m.w);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (!m.inBounds(nx, ny)) continue;
        const j = m.idx(nx, ny);
        if (m.owner[j] !== 0 && j !== gi) continue;
        const gnd = m.ground[j];
        const step = gnd === G.Road || gnd === G.Sidewalk || gnd === G.Dirt || gnd === G.Plaza ? 1 : 1.6;
        const c = cost[i] + step;
        if (c < cost[j]) {
          cost[j] = c;
          prev[j] = i;
          push(j, c + h(j));
        }
      }
    }
    if (prev[gi] < 0 && gi !== si) return null;
    const out: { tx: number; ty: number }[] = [];
    for (let i = gi; i >= 0; i = prev[i]) out.push({ tx: i % m.w, ty: Math.floor(i / m.w) });
    return out.reverse();
  },
  /** Paint a square brush (size 1–3) centred on a tile. Returns how many tiles changed. */
  paintMap(this: World, tx: number, ty: number, brush: MapBrush, size = 1): number {
    let n = 0;
    const r0 = -Math.floor((size - 1) / 2), r1 = r0 + size - 1;
    for (let dy = r0; dy <= r1; dy++) for (let dx = r0; dx <= r1; dx++) if (this.map.paint(tx + dx, ty + dy, brush)) n++;
    if (n) {
      // nobody gets stuck inside a freshly planted tree or lamp post
      for (const a of this.agents) {
        const t = this.tileOf(a);
        if (!this.map.isBlocked(t.tx, t.ty)) continue;
        const free = this.map.nearestWalkable(t.tx, t.ty);
        this.grid.remove(a);
        a.x = (free.tx + 0.5) * TILE;
        a.y = (free.ty + 0.5) * TILE;
        this.grid.insert(a);
        a.ai.path = [];
        a.ai.pathIndex = 0;
      }
    }
    return n;
  },
  /**
   * Resize the map like a window: tiles added (+) or cut (−) on the left, top, right and bottom.
   * Buildings may not be cut; everything shifts by (dl, dt) tiles when the left/top edge moves.
   */
  resizeMap(this: World, dl: number, dt: number, dr: number, db: number): { ok: boolean; message: string } {
    const W = this.map.w + dl + dr, H = this.map.h + dt + db;
    if (!dl && !dt && !dr && !db) return { ok: true, message: '' };
    const { MAP_MIN: mn, MAP_MAX: mx } = World;
    if (W < mn.w || H < mn.h) return { ok: false, message: `세계가 너무 작아져요 (최소 ${mn.w}×${mn.h}칸)` };
    if (W > mx.w || H > mx.h) return { ok: false, message: `세계가 너무 커져요 (최대 ${mx.w}×${mx.h}칸)` };
    for (const p of this.places) {
      const x0 = p.tx + dl, y0 = p.ty + dt;
      if (x0 < 1 || y0 < 1 || x0 + p.tw > W - 1 || y0 + p.th > H - 1) return { ok: false, message: `${josa(p.name, '이/가')} 잘려요 — 그쪽 건물을 먼저 지우거나 덜 줄여 주세요.` };
    }
    this.map.resize(dl, dt, dr, db, hashString(`resize${W}x${H}`));
    if (dl || dt) {
      const ox = dl * TILE, oy = dt * TILE;
      const mv = (s: { tx: number; ty: number }) => {
        s.tx += dl;
        s.ty += dt;
      };
      for (const p of this.places) {
        mv(p);
        mv(p.door);
        p.seats.forEach(mv);
        p.workSpots.forEach(mv);
      }
      for (const a of this.agents) {
        a.x += ox;
        a.y += oy;
        for (const n of a.ai.path) (n.x += ox), (n.y += oy);
      }
      for (const e of this.effects) (e.x += ox), (e.y += oy);
      const seats = [...this.seatTaken];
      this.seatTaken.clear();
      for (const [k, id] of seats) {
        const [x, y] = k.split(',').map(Number);
        this.seatTaken.set(`${x + dl},${y + dt}`, id);
      }
    }
    // anyone left outside a shrunk edge walks back in
    for (const a of this.agents) {
      const tx = Math.floor(a.x / TILE), ty = Math.floor(a.y / TILE);
      if (this.map.inBounds(tx, ty) && !this.map.isBlocked(tx, ty)) continue;
      const free = this.map.nearestWalkable(Math.max(0, Math.min(W - 1, tx)), Math.max(0, Math.min(H - 1, ty)));
      a.x = (free.tx + 0.5) * TILE;
      a.y = (free.ty + 0.5) * TILE;
      a.ai.path = [];
      a.ai.pathIndex = 0;
    }
    this.rebuildGrid();
    return { ok: true, message: `🗺️ 세계 크기를 ${W}×${H}칸으로 바꿨어요.` };
  },
};
