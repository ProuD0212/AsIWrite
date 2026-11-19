// Procedural tile map: roads, park, building interiors (RimWorld-style roofless
// cutaway rooms) + A* pathfinding. No image assets: everything is drawn in
// render/drawMap.ts from these tile codes.

import type { Place, PlaceStyle } from './types';
import { makeRng } from './util';

export const TILE = 32;

export const G = { Grass: 0, Road: 1, Sidewalk: 2, Wood: 3, Tile: 4, Carpet: 5, Plaza: 6, Dirt: 7 } as const;
export type G = (typeof G)[keyof typeof G];

export const D = {   None: 0,   Wall: 1,   Tree: 2,   Bench: 3,   Table: 4,   Chair: 5,   Counter: 6,   Shelf: 7,   Bookshelf: 8,   Sofa: 9,   Screen: 10,   Bed: 11,   Desk: 12,   Flower: 13,   Lamp: 14,   Door: 15,   Bush: 16,   Fountain: 17,   Machine: 18, } as const;
export type D = (typeof D)[keyof typeof D];

const BLOCKING = new Set<number>([D.Wall, D.Tree, D.Table, D.Counter, D.Shelf, D.Bookshelf, D.Screen, D.Bed, D.Desk, D.Flower, D.Lamp, D.Bush, D.Fountain, D.Machine]);

export const PLACE_SIZES: Record<PlaceStyle, [number, number]> = {
  cafe: [9, 7],
  karaoke: [9, 7],
  store: [8, 6],
  library: [10, 7],
  home: [7, 6],
  office: [9, 7],
  park: [13, 9],
  plaza: [9, 7],
  factory: [11, 8],
};

export class TileMap {
  w: number;
  h: number;
  /** false for a bare "empty world" (just open land) */
  readonly roads: boolean;
  ground: Uint8Array;
  deco: Uint8Array;
  blocked: Uint8Array;
  /** which place owns each tile (index into placeIds, 0 = none) */
  owner: Uint16Array;
  ownerIds: string[] = [''];
  roadRows: [number, number];
  roadCols: [number, number];

  constructor(w = 72, h = 48, seed = 7, roads = true) {
    this.w = w;
    this.h = h;
    this.roads = roads;
    this.ground = new Uint8Array(w * h);
    this.deco = new Uint8Array(w * h);
    this.blocked = new Uint8Array(w * h);
    this.owner = new Uint16Array(w * h);
    const midY = Math.floor(h / 2);
    const midX = Math.floor(w / 2);
    this.roadRows = [midY - 1, midY + 1];
    this.roadCols = [midX - 1, midX + 1];
    this.generateBase(seed);
  }

  idx(tx: number, ty: number) {
    return ty * this.w + tx;
  }
  inBounds(tx: number, ty: number) {
    return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h;
  }
  isBlocked(tx: number, ty: number) {
    return !this.inBounds(tx, ty) || this.blocked[this.idx(tx, ty)] === 1;
  }
  setDeco(tx: number, ty: number, d: D) {
    const i = this.idx(tx, ty);
    this.deco[i] = d;
    this.blocked[i] = BLOCKING.has(d) ? 1 : 0;
  }

  private generateBase(seed: number) {
    const { w, h } = this;
    if (!this.roads) return; // empty world: grass only
    const [r0, r1] = this.roadRows;
    const [c0, c1] = this.roadCols;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let g: G = G.Grass;
        if ((y >= r0 && y <= r1) || (x >= c0 && x <= c1)) g = G.Road;
        else if (y === r0 - 1 || y === r1 + 1 || x === c0 - 1 || x === c1 + 1) g = G.Sidewalk;
        this.ground[this.idx(x, y)] = g;
      }
    // little crossroads plaza ring
    for (let y = r0 - 3; y <= r1 + 3; y++)
      for (let x = c0 - 3; x <= c1 + 3; x++) {
        if (!this.inBounds(x, y)) continue;
        const i = this.idx(x, y);
        if (this.ground[i] === G.Grass) this.ground[i] = G.Plaza;
      }
    // street lamps along sidewalks
    for (let x = 3; x < w - 2; x += 8) {
      if (x >= c0 - 4 && x <= c1 + 4) continue;
      this.setDeco(x, r0 - 2, D.Lamp);
      this.setDeco(x, r1 + 2, D.Lamp);
    }
    void seed;
  }

  /**
   * Grow the map to the right / bottom (no hard size limit). Existing tiles are
   * kept; roads, sidewalks and lamps are extended into the new land.
   */
  grow(addW: number, addH: number, seed = 13) {
    const W = this.w + Math.max(0, addW), H = this.h + Math.max(0, addH);
    if (W === this.w && H === this.h) return;
    const ng = new Uint8Array(W * H), nd = new Uint8Array(W * H), nb = new Uint8Array(W * H), no = new Uint16Array(W * H);
    for (let y = 0; y < this.h; y++) {
      ng.set(this.ground.subarray(y * this.w, (y + 1) * this.w), y * W);
      nd.set(this.deco.subarray(y * this.w, (y + 1) * this.w), y * W);
      nb.set(this.blocked.subarray(y * this.w, (y + 1) * this.w), y * W);
      no.set(this.owner.subarray(y * this.w, (y + 1) * this.w), y * W);
    }
    const oldW = this.w, oldH = this.h;
    this.ground = ng;
    this.deco = nd;
    this.blocked = nb;
    this.owner = no;
    this.w = W;
    this.h = H;
    if (this.roads) {
      const [r0, r1] = this.roadRows;
      const [c0, c1] = this.roadCols;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          if (x < oldW && y < oldH) continue;
          let g: G = G.Grass;
          if ((y >= r0 && y <= r1) || (x >= c0 && x <= c1)) g = G.Road;
          else if (y === r0 - 1 || y === r1 + 1 || x === c0 - 1 || x === c1 + 1) g = G.Sidewalk;
          this.ground[this.idx(x, y)] = g;
        }
      for (let x = oldW + 3; x < W - 2; x += 8) {
        this.setDeco(x, r0 - 2, D.Lamp);
        this.setDeco(x, r1 + 2, D.Lamp);
      }
      for (let y = oldH + 3; y < H - 2; y += 8) {
        this.setDeco(c0 - 2, y, D.Lamp);
        this.setDeco(c1 + 2, y, D.Lamp);
      }
    }
    this.scatterNature(seed, { x0: oldW, y0: oldH });
  }

  /** Scatter trees/bushes over leftover grass (call after places are built). Optionally only outside an old area. */
  scatterNature(seed: number, onlyNew?: { x0: number; y0: number }) {
    const rng = makeRng(seed);
    const density = this.roads ? 1 : 0.45; // empty worlds stay open
    for (let y = 1; y < this.h - 1; y++)
      for (let x = 1; x < this.w - 1; x++) {
        if (onlyNew && x < onlyNew.x0 && y < onlyNew.y0) continue;
        const i = this.idx(x, y);
        if (this.ground[i] !== G.Grass || this.deco[i] !== D.None || this.owner[i] !== 0) continue;
        // keep a 1-tile walkway next to sidewalks
        if (this.nearGround(x, y, G.Sidewalk, 1) || this.nearGround(x, y, G.Plaza, 1)) continue;
        if (this.nearOwned(x, y, 1)) continue;
        const r = rng();
        if (r < 0.045 * density) this.setDeco(x, y, D.Tree);
        else if (r < 0.06 * density) this.setDeco(x, y, D.Bush);
        else if (r < 0.07 * density) this.setDeco(x, y, D.Flower);
      }
  }

  private nearGround(x: number, y: number, g: G, r: number) {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (this.inBounds(x + dx, y + dy) && this.ground[this.idx(x + dx, y + dy)] === g) return true;
      }
    return false;
  }
  private nearOwned(x: number, y: number, r: number) {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (this.inBounds(x + dx, y + dy) && this.owner[this.idx(x + dx, y + dy)] !== 0) return true;
      }
    return false;
  }

  /** Is a rect (with 1-tile margin) free grass, so a place can be built there? */
  rectFree(tx: number, ty: number, tw: number, th: number) {
    for (let y = ty - 1; y <= ty + th; y++)
      for (let x = tx - 1; x <= tx + tw; x++) {
        if (!this.inBounds(x, y)) return false;
        const i = this.idx(x, y);
        if (this.owner[i] !== 0) return false;
        const g = this.ground[i];
        const inside = x >= tx && x < tx + tw && y >= ty && y < ty + th;
        if (inside && g !== G.Grass) return false;
        if (inside && this.deco[i] === D.Lamp) return false;
      }
    return true;
  }

  /**
   * Find a lot for a new place, preferring spots hugging a sidewalk (so the
   * door faces the street) and close to (prefX, prefY) in tiles.
   */
  findLot(tw: number, th: number, prefX?: number, prefY?: number): { tx: number; ty: number; doorSide: 'top' | 'bottom' } | null {
    const [r0, r1] = this.roadRows;
    let best: { tx: number; ty: number; doorSide: 'top' | 'bottom'; score: number } | null = null;
    const px = prefX ?? this.w / 2;
    const py = prefY ?? this.h / 2;
    for (let ty = 1; ty + th < this.h - 1; ty++) {
      for (let tx = 1; tx + tw < this.w - 1; tx++) {
        if (!this.rectFree(tx, ty, tw, th)) continue;
        const bottom = ty + th; // first row below
        const top = ty - 1;
        const doorSide: 'top' | 'bottom' = ty + th / 2 < r0 ? 'bottom' : 'top';
        // distance from the street (rows near sidewalks are best)
        const streetDist = doorSide === 'bottom' ? Math.abs(r0 - 2 - bottom) : Math.abs(top - (r1 + 2));
        const d = Math.hypot(tx + tw / 2 - px, ty + th / 2 - py);
        const score = streetDist * 3 + d * 0.6 + (tx % 2) * 0.01;
        if (!best || score < best.score) best = { tx, ty, doorSide, score };
      }
    }
    return best ? { tx: best.tx, ty: best.ty, doorSide: best.doorSide } : null;
  }

  /** Stamp a place's floor, walls, door and furniture. Returns seats. */
  buildPlace(p: Place, doorSide: 'top' | 'bottom', seed: number) {
    const rng = makeRng(seed);
    const ownerIndex = this.ownerIds.length;
    this.ownerIds.push(p.id);
    const { tx, ty, tw, th } = p;
    const floor: Record<PlaceStyle, G> = {
      cafe: G.Wood, karaoke: G.Carpet, store: G.Tile, library: G.Wood, home: G.Wood, office: G.Tile, park: G.Grass, plaza: G.Plaza, factory: G.Tile,
    };
    for (let y = ty; y < ty + th; y++)
      for (let x = tx; x < tx + tw; x++) {
        const i = this.idx(x, y);
        this.ground[i] = floor[p.style];
        this.owner[i] = ownerIndex;
        this.setDeco(x, y, D.None);
      }
    const seats: { tx: number; ty: number }[] = [];
    const workSpots: { tx: number; ty: number }[] = [];
    const doorX = tx + Math.floor(tw / 2);
    const doorY = doorSide === 'bottom' ? ty + th - 1 : ty;

    if (p.style === 'park' || p.style === 'plaza') {
      // open area: dirt path, trees on rim, benches, fountain or flowers
      for (let x = tx; x < tx + tw; x++) this.ground[this.idx(x, ty + Math.floor(th / 2))] = p.style === 'park' ? G.Dirt : G.Plaza;
      for (let y = ty; y < ty + th; y++) this.ground[this.idx(doorX, y)] = p.style === 'park' ? G.Dirt : G.Plaza;
      const cx = doorX;
      const cy = ty + Math.floor(th / 2);
      if (p.style === 'plaza') this.setDeco(cx, cy, D.Fountain);
      for (let x = tx; x < tx + tw; x++)
        for (let y = ty; y < ty + th; y++) {
          const edge = x === tx || y === ty || x === tx + tw - 1 || y === ty + th - 1;
          if (edge && x !== doorX && rng() < 0.55) this.setDeco(x, y, p.style === 'park' ? D.Tree : D.Flower);
        }
      const benchSpots = [
        [cx - 2, cy - 1], [cx + 2, cy - 1], [cx - 2, cy + 1], [cx + 2, cy + 1], [cx - 4, cy - 1], [cx + 4, cy + 1],
      ];
      for (const [bx, by] of benchSpots) {
        if (bx > tx && bx < tx + tw - 1 && by > ty && by < ty + th - 1) {
          this.setDeco(bx, by, D.Bench);
          seats.push({ tx: bx, ty: by });
        }
      }
      if (p.style === 'park') {
        for (let k = 0; k < 4; k++) {
          const fx = tx + 1 + Math.floor(rng() * (tw - 2));
          const fy = ty + 1 + Math.floor(rng() * (th - 2));
          if (this.deco[this.idx(fx, fy)] === D.None && fx !== doorX && fy !== cy) this.setDeco(fx, fy, D.Flower);
        }
      }
      return { seats, workSpots, door: { tx: doorX, ty: doorSide === 'bottom' ? ty + th : ty - 1 } };
    }

    // walls
    for (let x = tx; x < tx + tw; x++) {
      this.setDeco(x, ty, D.Wall);
      this.setDeco(x, ty + th - 1, D.Wall);
    }
    for (let y = ty; y < ty + th; y++) {
      this.setDeco(tx, y, D.Wall);
      this.setDeco(tx + tw - 1, y, D.Wall);
    }
    this.setDeco(doorX, doorY, D.Door);
    if (tw >= 9) this.setDeco(doorX - 1, doorY, D.Door);

    const ix0 = tx + 1, ix1 = tx + tw - 2, iy0 = ty + 1, iy1 = ty + th - 2;
    const backY = doorSide === 'bottom' ? iy0 : iy1; // wall opposite the door
    const frontY = doorSide === 'bottom' ? iy1 : iy0;
    const inward = doorSide === 'bottom' ? 1 : -1;
    const keepClear = (x: number, y: number) => Math.abs(x - doorX) <= 1 && (y === frontY || y === frontY - inward);
    const spot = (x: number, y: number) => {
      if (x < ix0 || x > ix1 || y < iy0 || y > iy1 || keepClear(x, y)) return;
      if (!this.isBlocked(x, y) && !workSpots.some((s) => s.tx === x && s.ty === y)) workSpots.push({ tx: x, ty: y });
    };
    const put = (x: number, y: number, d: D) => {
      if (x < ix0 || x > ix1 || y < iy0 || y > iy1 || keepClear(x, y)) return false;
      this.setDeco(x, y, d);
      if (d === D.Chair || d === D.Sofa || d === D.Bench) seats.push({ tx: x, ty: y });
      return true;
    };

    switch (p.style) {
      case 'cafe': {
        for (let x = ix0; x <= ix0 + 3; x++) put(x, backY, D.Counter);
        spot(ix0 + 1, backY + inward);
        spot(ix0 + 3, backY + inward);
        for (const [x, y] of [[ix0 + 1, backY + inward * 2], [ix0 + 4, backY + inward * 2], [ix1 - 1, backY + inward * 1]] as const) {
          if (put(x, y, D.Table)) {
            put(x - 1, y, D.Chair);
            put(x + 1, y, D.Chair);
          }
        }
        put(ix1, frontY, D.Lamp);
        break;
      }
      case 'karaoke': {
        put(Math.floor((ix0 + ix1) / 2), backY, D.Screen);
        put(Math.floor((ix0 + ix1) / 2) + 1, backY, D.Screen);
        for (let x = ix0; x <= ix1; x++) if (x !== Math.floor((ix0 + ix1) / 2) && x !== Math.floor((ix0 + ix1) / 2) + 1) put(x, backY, D.Sofa);
        put(ix0, backY + inward, D.Sofa);
        put(ix1, backY + inward, D.Sofa);
        put(Math.floor((ix0 + ix1) / 2), backY + inward * 2, D.Table);
        put(Math.floor((ix0 + ix1) / 2) + 1, backY + inward * 2, D.Table);
        put(ix1, frontY, D.Counter);
        spot(ix1 - 1, frontY);
        break;
      }
      case 'store': {
        for (let x = ix0; x <= ix1 - 2; x += 2) for (let k = 0; k < th - 4; k++) put(x, backY + inward * k, D.Shelf);
        put(ix1, frontY - inward, D.Counter);
        put(ix1 - 1, frontY - inward, D.Counter);
        spot(ix1, frontY - inward * 2);
        spot(ix1 - 1, frontY - inward * 2);
        break;
      }
      case 'library': {
        for (let x = ix0; x <= ix1; x++) put(x, backY, D.Bookshelf);
        put(ix0, backY + inward, D.Bookshelf);
        put(ix1, backY + inward, D.Bookshelf);
        put(ix0, frontY - inward, D.Counter);
        spot(ix0 + 1, frontY - inward);
        for (const x of [ix0 + 2, ix1 - 2]) {
          if (put(x, backY + inward * 3, D.Table)) {
            put(x, backY + inward * 2, D.Chair);
            put(x - 1, backY + inward * 3, D.Chair);
            put(x + 1, backY + inward * 3, D.Chair);
          }
        }
        break;
      }
      case 'home': {
        put(ix0, backY, D.Bed);
        put(ix0 + 1, backY, D.Bed);
        put(ix1, backY, D.Shelf);
        if (put(ix1 - 1, backY + inward * 2, D.Table)) put(ix1 - 2, backY + inward * 2, D.Chair);
        put(ix0, backY + inward * 2, D.Sofa);
        break;
      }
      case 'office': {
        for (const x of [ix0 + 1, ix0 + 4, ix1 - 1]) {
          if (put(x, backY + inward, D.Desk) && put(x, backY + inward * 2, D.Chair)) {
            seats.pop(); // desk chairs are for workers
            workSpots.push({ tx: x, ty: backY + inward * 2 });
          }
        }
        put(ix0, backY, D.Shelf);
        put(ix1, backY, D.Shelf);
        if (put(ix1 - 3, frontY - inward, D.Table)) put(ix1 - 2, frontY - inward, D.Chair);
        break;
      }
      case 'factory': {
        for (let x = ix0 + 1; x <= ix1 - 1; x += 3) {
          put(x, backY, D.Machine);
          put(x + 1, backY, D.Machine);
          spot(x, backY + inward);
          spot(x + 1, backY + inward);
        }
        for (let x = ix0 + 1; x <= ix1 - 1; x++) put(x, backY + inward * 3, D.Counter);
        spot(ix0 + 2, backY + inward * 4);
        put(ix0, frontY - inward, D.Bench);
        put(ix0, frontY - inward * 2, D.Bench);
        break;
      }
    }
    // A place with no seat still needs a standing spot.
    if (seats.length === 0) seats.push({ tx: doorX, ty: frontY - inward });
    return { seats, workSpots, door: { tx: doorX, ty: doorSide === 'bottom' ? ty + th : ty - 1 } };
  }

  /** Remove a place's tiles (back to grass). */
  clearPlace(p: Place) {
    const oi = this.ownerIds.indexOf(p.id);
    for (let y = p.ty; y < p.ty + p.th; y++)
      for (let x = p.tx; x < p.tx + p.tw; x++) {
        const i = this.idx(x, y);
        if (this.owner[i] === oi) {
          this.owner[i] = 0;
          this.ground[i] = G.Grass;
          this.setDeco(x, y, D.None);
        }
      }
  }

  placeIdAt(tx: number, ty: number): string | null {
    if (!this.inBounds(tx, ty)) return null;
    const o = this.owner[this.idx(tx, ty)];
    return o ? this.ownerIds[o] : null;
  }

  isOutdoor(tx: number, ty: number) {
    const id = this.placeIdAt(tx, ty);
    if (!id) return true;
    const g = this.ground[this.idx(tx, ty)];
    return g === G.Grass || g === G.Plaza || g === G.Dirt;
  }

  randomWalkable(rng: () => number, near?: { tx: number; ty: number; r: number }): { tx: number; ty: number } {
    for (let k = 0; k < 200; k++) {
      const tx = near ? near.tx + Math.round((rng() * 2 - 1) * near.r) : Math.floor(rng() * this.w);
      const ty = near ? near.ty + Math.round((rng() * 2 - 1) * near.r) : Math.floor(rng() * this.h);
      if (!this.isBlocked(tx, ty) && this.ground[this.idx(tx, ty)] !== G.Road) return { tx, ty };
    }
    return { tx: this.roadCols[0] - 1, ty: this.roadRows[0] - 1 };
  }

  nearestWalkable(tx: number, ty: number): { tx: number; ty: number } {
    if (!this.isBlocked(tx, ty)) return { tx, ty };
    for (let r = 1; r < 12; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (!this.isBlocked(tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
        }
    return { tx, ty };
  }

  /** 8-directional A* without corner cutting. Returns tile path (excl. start). */
  findPath(sx: number, sy: number, gx: number, gy: number, maxNodes = 6000): { tx: number; ty: number }[] | null {
    const goal = this.nearestWalkable(gx, gy);
    gx = goal.tx;
    gy = goal.ty;
    if (sx === gx && sy === gy) return [];
    const W = this.w;
    const N = W * this.h;
    const gScore = new Float32Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heap: number[] = [];
    const fOf = new Float32Array(N);
    const push = (i: number) => {
      heap.push(i);
      let c = heap.length - 1;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (fOf[heap[p]] <= fOf[heap[c]]) break;
        [heap[p], heap[c]] = [heap[c], heap[p]];
        c = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let c = 0;
        for (;;) {
          const l = c * 2 + 1, r = l + 1;
          let m = c;
          if (l < heap.length && fOf[heap[l]] < fOf[heap[m]]) m = l;
          if (r < heap.length && fOf[heap[r]] < fOf[heap[m]]) m = r;
          if (m === c) break;
          [heap[m], heap[c]] = [heap[c], heap[m]];
          c = m;
        }
      }
      return top;
    };
    const h = (x: number, y: number) => {
      const dx = Math.abs(x - gx), dy = Math.abs(y - gy);
      return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
    };
    const start = sy * W + sx;
    gScore[start] = 0;
    fOf[start] = h(sx, sy);
    push(start);
    let expanded = 0;
    const goalI = gy * W + gx;
    while (heap.length) {
      const cur = pop();
      if (cur === goalI) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (++expanded > maxNodes) return null;
      const cx = cur % W, cy = (cur / W) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx, ny = cy + dy;
          if (this.isBlocked(nx, ny)) continue;
          if (dx && dy && (this.isBlocked(cx + dx, cy) || this.isBlocked(cx, cy + dy))) continue;
          const ni = ny * W + nx;
          if (closed[ni]) continue;
          // roads cost a bit more so people prefer sidewalks
          const roadCost = this.ground[ni] === G.Road ? 0.6 : 0;
          const ng = gScore[cur] + (dx && dy ? Math.SQRT2 : 1) + roadCost;
          if (ng < gScore[ni]) {
            gScore[ni] = ng;
            came[ni] = cur;
            fOf[ni] = ng + h(nx, ny);
            push(ni);
          }
        }
    }
    if (came[goalI] === -1) return null;
    const out: { tx: number; ty: number }[] = [];
    for (let c = goalI; c !== start; c = came[c]) out.push({ tx: c % W, ty: (c / W) | 0 });
    out.reverse();
    return out;
  }
}
