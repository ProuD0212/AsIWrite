// Ground, rendered per pixel into cached chunks (16×16 tiles) instead of flat tiles every frame.
//
// The look we're after is a soft, lush toy town: colour patches that drift across tiles (no
// checkerboard), dithered speckle, grass that spills over path edges in a wobbly line, tufts and tiny
// flowers, planks / grout / cobblestones, a curb along the road, and a soft shadow under walls.
// A chunk is redrawn only when its tiles change (building, painting, growing the map, theme switch).

import { D, G, TILE, type TileMap } from '../TileMap';
import type { Theme } from './theme';

const CH = 16; // tiles per chunk side
const PX = CH * TILE;
type Canvas = HTMLCanvasElement | OffscreenCanvas;
const chunks = new Map<string, { sum: number; c: Canvas }>();

function makeCanvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ── deterministic noise ──
function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function smooth(t: number) {
  return t * t * (3 - 2 * t);
}
/** value noise in 0..1 at a given scale (px per cell) */
function noise(x: number, y: number, cell: number): number {
  const gx = x / cell, gy = y / cell;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const fx = smooth(gx - ix), fy = smooth(gy - iy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function lift(c: [number, number, number], k: number): [number, number, number] {
  return k >= 0 ? [c[0] + (255 - c[0]) * k, c[1] + (255 - c[1]) * k, c[2] + (255 - c[2]) * k] : [c[0] * (1 + k), c[1] * (1 + k), c[2] * (1 + k)];
}

/** soft grounds let the grass creep over their edge */
const SOFT = new Set<number>([G.Dirt, G.Plaza, G.Sidewalk]);

function baseColor(th: Theme, g: number): [number, number, number] {
  switch (g) {
    case G.Road: return rgb(th.road);
    case G.Sidewalk: return rgb(th.sidewalk);
    case G.Wood: return rgb(th.wood);
    case G.Tile: return rgb(th.tile);
    case G.Carpet: return rgb(th.carpet);
    case G.Plaza: return rgb(th.plaza);
    case G.Dirt: return rgb(th.dirt);
    default: return rgb(th.grass[0]);
  }
}

function chunkSum(map: TileMap, cx: number, cy: number): number {
  let s = 2166136261 >>> 0;
  for (let ty = cy * CH - 1; ty <= (cy + 1) * CH; ty++)
    for (let tx = cx * CH - 1; tx <= (cx + 1) * CH; tx++) {
      const v = map.inBounds(tx, ty) ? map.ground[map.idx(tx, ty)] * 2 + (map.deco[map.idx(tx, ty)] === D.Wall ? 1 : 0) : 255;
      s = Math.imul(s ^ v, 16777619) >>> 0;
    }
  return s;
}

function renderChunk(map: TileMap, th: Theme, cx: number, cy: number): Canvas {
  const c = makeCanvas(PX, PX);
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const img = ctx.createImageData(PX, PX);
  const d = img.data;
  const ox = cx * PX, oy = cy * PX;
  const grassA = rgb(th.grass[0]), grassB = lift(rgb(th.grass[1]), 0.06), grassDark = lift(grassA, -0.12), grassLight = lift(grassA, 0.1);
  const gAt = (tx: number, ty: number) => (map.inBounds(tx, ty) ? map.ground[map.idx(tx, ty)] : G.Grass);
  const wallAt = (tx: number, ty: number) => map.inBounds(tx, ty) && map.deco[map.idx(tx, ty)] === D.Wall;

  // per tile: does a soft tile touch grass at all? (skip the edge maths otherwise)
  const edgy = new Uint8Array(CH * CH);
  for (let j = 0; j < CH; j++)
    for (let i = 0; i < CH; i++) {
      const tx = cx * CH + i, ty = cy * CH + j;
      if (!map.inBounds(tx, ty) || !SOFT.has(map.ground[map.idx(tx, ty)])) continue;
      for (let dy = -1; dy <= 1 && !edgy[j * CH + i]; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && gAt(tx + dx, ty + dy) === G.Grass) edgy[j * CH + i] = 1;
    }
  // the smooth noises are sampled on a coarse grid (they're low-frequency anyway): 16× / 4× fewer calls
  const n1Row = new Float32Array(PX / 4 + 1), n2Row = new Float32Array(PX / 2 + 1);
  for (let py = 0; py < PX; py++) {
    const wy = oy + py;
    const ty = Math.floor(wy / TILE), ly = wy - ty * TILE;
    if (py % 4 === 0) for (let k = 0; k <= PX / 4; k++) n1Row[k] = noise(ox + k * 4, wy, 96);
    if (py % 2 === 0) for (let k = 0; k <= PX / 2; k++) n2Row[k] = noise(ox + k * 2 + 999, wy, 22);
    for (let px = 0; px < PX; px++) {
      const wx = ox + px;
      const tx = Math.floor(wx / TILE), lx = wx - tx * TILE;
      if (!map.inBounds(tx, ty)) continue;
      let g = map.ground[map.idx(tx, ty)];
      let rim = 0;
      // grass creeping over soft edges, in a wobbly line
      if (edgy[Math.floor(py / TILE) * CH + Math.floor(px / TILE)]) {
        const wob = 1.2 + noise(wx, wy, 5) * 3.2;
        let dist = 99;
        if (gAt(tx - 1, ty) === G.Grass) dist = Math.min(dist, lx);
        if (gAt(tx + 1, ty) === G.Grass) dist = Math.min(dist, TILE - 1 - lx);
        if (gAt(tx, ty - 1) === G.Grass) dist = Math.min(dist, ly);
        if (gAt(tx, ty + 1) === G.Grass) dist = Math.min(dist, TILE - 1 - ly);
        // rounded outer corners
        if (gAt(tx - 1, ty - 1) === G.Grass) dist = Math.min(dist, Math.hypot(lx, ly) - 1);
        if (gAt(tx + 1, ty - 1) === G.Grass) dist = Math.min(dist, Math.hypot(TILE - 1 - lx, ly) - 1);
        if (gAt(tx - 1, ty + 1) === G.Grass) dist = Math.min(dist, Math.hypot(lx, TILE - 1 - ly) - 1);
        if (gAt(tx + 1, ty + 1) === G.Grass) dist = Math.min(dist, Math.hypot(TILE - 1 - lx, TILE - 1 - ly) - 1);
        const lim = g === G.Sidewalk ? wob * 0.45 : wob;
        if (dist < lim) g = G.Grass;
        else if (dist < lim + 1.6) rim = 1;
      }
      let col: [number, number, number];
      const n1 = n1Row[px >> 2], n2 = n2Row[px >> 1], dither = hash(wx, wy);
      if (g === G.Grass) {
        col = mix(grassA, grassB, smooth(Math.min(1, Math.max(0, (n1 - 0.25) * 1.6))));
        // pixel-art dither: three tones instead of smooth noise
        const v = n2 * 0.6 + dither * 0.4;
        if (v < 0.24) col = mix(col, grassDark, 0.55);
        else if (v > 0.8) col = mix(col, grassLight, 0.6);
      } else {
        col = baseColor(th, g);
        const k = (n1 - 0.5) * 0.08 + (dither - 0.5) * (g === G.Road ? 0.08 : g === G.Dirt ? 0.1 : 0.04);
        col = lift(col, k);
        if (rim) col = lift(col, -0.16);
      }
      // a soft shadow on the floor just below a wall
      if (g !== G.Grass && wallAt(tx, ty - 1) && ly < 6) col = lift(col, -0.22 * (1 - ly / 6));
      const i = (py * PX + px) * 4;
      d[i] = col[0];
      d[i + 1] = col[1];
      d[i + 2] = col[2];
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // ── details drawn on top ──
  const [r0, r1] = map.roadRows;
  const [c0, c1] = map.roadCols;
  for (let ty = cy * CH; ty < (cy + 1) * CH; ty++)
    for (let tx = cx * CH; tx < (cx + 1) * CH; tx++) {
      if (!map.inBounds(tx, ty)) continue;
      const g = map.ground[map.idx(tx, ty)];
      const x = tx * TILE - ox, y = ty * TILE - oy;
      const r = (k: number) => hash(tx * 7 + k, ty * 13 - k);
      switch (g) {
        case G.Grass: {
          // tufts
          const n = Math.floor(r(1) * 3.2);
          for (let k = 0; k < n; k++) {
            const tx2 = x + 3 + Math.floor(r(10 + k) * 25), ty2 = y + 5 + Math.floor(r(20 + k) * 24);
            ctx.fillStyle = `rgb(${grassDark.map(Math.round).join(',')})`;
            ctx.fillRect(tx2, ty2, 1, 2);
            ctx.fillRect(tx2 + 2, ty2, 1, 2);
            ctx.fillRect(tx2 + 1, ty2 - 1, 1, 3);
            ctx.fillStyle = `rgb(${grassLight.map(Math.round).join(',')})`;
            ctx.fillRect(tx2 + 1, ty2 - 2, 1, 1);
          }
          // the odd tiny flower
          if (r(5) < 0.12 && th.id !== 'space' && th.id !== 'cyber') {
            const fx = x + 4 + Math.floor(r(6) * 22), fy = y + 4 + Math.floor(r(7) * 22);
            const petal = ['#ffffff', '#ffe27a', '#ffb3c8', '#c9b3ff'][Math.floor(r(8) * 4)];
            ctx.fillStyle = petal;
            ctx.fillRect(fx - 1, fy, 1, 1);
            ctx.fillRect(fx + 1, fy, 1, 1);
            ctx.fillRect(fx, fy - 1, 1, 1);
            ctx.fillRect(fx, fy + 1, 1, 1);
            ctx.fillStyle = '#f2b13a';
            ctx.fillRect(fx, fy, 1, 1);
          }
          break;
        }
        case G.Dirt: {
          for (let k = 0; k < 3; k++) {
            if (r(30 + k) < 0.5) continue;
            const sx = x + 3 + Math.floor(r(40 + k) * 26), sy = y + 3 + Math.floor(r(50 + k) * 26);
            ctx.fillStyle = 'rgba(0,0,0,0.18)';
            ctx.fillRect(sx, sy + 1, 2, 1);
            ctx.fillStyle = 'rgba(255,255,255,0.25)';
            ctx.fillRect(sx, sy, 2, 1);
          }
          break;
        }
        case G.Wood: {
          ctx.fillStyle = 'rgba(0,0,0,0.13)';
          for (let k = 0; k < 4; k++) ctx.fillRect(x, y + k * 8 + 7, TILE, 1);
          for (let k = 0; k < 4; k++) ctx.fillRect(x + ((k * 11 + tx * 5 + ty * 3) % TILE), y + k * 8, 1, 7);
          ctx.fillStyle = 'rgba(255,255,255,0.07)';
          for (let k = 0; k < 4; k++) ctx.fillRect(x, y + k * 8, TILE, 1);
          break;
        }
        case G.Tile: {
          ctx.fillStyle = 'rgba(0,0,0,0.09)';
          ctx.fillRect(x, y + 15, TILE, 1);
          ctx.fillRect(x + 15, y, 1, TILE);
          ctx.fillRect(x, y + 31, TILE, 1);
          ctx.fillRect(x + 31, y, 1, TILE);
          ctx.fillStyle = 'rgba(255,255,255,0.12)';
          ctx.fillRect(x + 1, y + 1, 13, 1);
          ctx.fillRect(x + 17, y + 17, 13, 1);
          break;
        }
        case G.Carpet: {
          ctx.fillStyle = 'rgba(255,255,255,0.07)';
          for (let k = 0; k < 4; k++) for (let m = 0; m < 4; m++) if ((k + m) % 2 === 0) ctx.fillRect(x + k * 8 + 3, y + m * 8 + 3, 2, 2);
          break;
        }
        case G.Plaza: {
          // cobblestones: offset rows of rounded stones
          for (let row = 0; row < 4; row++) {
            const off = (row + ty) % 2 ? 4 : 0;
            for (let col = -1; col < 4; col++) {
              const sx = x + col * 8 + off, sy = y + row * 8;
              if (sx + 7 <= x || sx >= x + TILE) continue;
              ctx.fillStyle = 'rgba(0,0,0,0.12)';
              ctx.fillRect(Math.max(x, sx), sy + 7, Math.min(8, x + TILE - Math.max(x, sx)), 1);
              ctx.fillRect(sx + 7, sy, 1, 7);
              ctx.fillStyle = 'rgba(255,255,255,0.12)';
              ctx.fillRect(Math.max(x, sx + 1), sy + 1, Math.max(0, Math.min(4, x + TILE - (sx + 1))), 1);
            }
          }
          break;
        }
        case G.Sidewalk: {
          ctx.fillStyle = 'rgba(0,0,0,0.08)';
          ctx.fillRect(x, y + 15, TILE, 1);
          ctx.fillRect(x + 15, y, 1, TILE);
          // curb along the road: a lit edge on the walk, a dark drop on the road
          const curb = (dx: number, dy: number) => gAt(tx + dx, ty + dy) === G.Road;
          ctx.fillStyle = 'rgba(255,255,255,0.28)';
          if (curb(0, 1)) ctx.fillRect(x, y + TILE - 3, TILE, 2);
          if (curb(0, -1)) ctx.fillRect(x, y + 1, TILE, 2);
          if (curb(1, 0)) ctx.fillRect(x + TILE - 3, y, 2, TILE);
          if (curb(-1, 0)) ctx.fillRect(x + 1, y, 2, TILE);
          break;
        }
        case G.Road: {
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          if (gAt(tx, ty - 1) === G.Sidewalk) ctx.fillRect(x, y, TILE, 2);
          if (gAt(tx - 1, ty) === G.Sidewalk) ctx.fillRect(x, y, 2, TILE);
          const midRow = (r0 + r1) / 2, midCol = (c0 + c1) / 2;
          const inCross = ty >= r0 && ty <= r1 && tx >= c0 && tx <= c1;
          ctx.fillStyle = th.roadLine;
          if (!inCross && ty === midRow && tx % 2 === 0) ctx.fillRect(x + 4, y + 15, 22, 2);
          if (!inCross && tx === midCol && ty % 2 === 0) ctx.fillRect(x + 15, y + 4, 2, 22);
          break;
        }
      }
    }
  return c;
}

function getChunk(map: TileMap, th: Theme, cx: number, cy: number, render: boolean) {
  const key = `${th.id}|${th.grass[0]}|${cx},${cy}`;
  const sum = chunkSum(map, cx, cy);
  let hit = chunks.get(key);
  if ((!hit || hit.sum !== sum) && render) {
    if (chunks.size > 80) chunks.clear();
    hit = { sum, c: renderChunk(map, th, cx, cy) };
    chunks.set(key, hit);
  }
  return hit && hit.sum === sum ? hit : null;
}

/** draw the visible ground (tile range) from cached chunks; warm one neighbouring chunk per frame */
export function drawGroundChunks(ctx: CanvasRenderingContext2D, map: TileMap, th: Theme, x0: number, y0: number, x1: number, y1: number) {
  const cx0 = Math.floor(x0 / CH), cy0 = Math.floor(y0 / CH), cx1 = Math.floor(x1 / CH), cy1 = Math.floor(y1 / CH);
  let rendered = false;
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cx = cx0; cx <= cx1; cx++) {
      const before = chunks.size;
      const hit = getChunk(map, th, cx, cy, true)!;
      if (chunks.size !== before) rendered = true;
      ctx.drawImage(hit.c as CanvasImageSource, cx * PX, cy * PX);
    }
  if (rendered) return;
  // pre-warm the ring just outside the view, one chunk per frame, so panning finds it ready
  const maxCx = Math.floor((map.w - 1) / CH), maxCy = Math.floor((map.h - 1) / CH);
  for (let cy = Math.max(0, cy0 - 1); cy <= Math.min(maxCy, cy1 + 1); cy++)
    for (let cx = Math.max(0, cx0 - 1); cx <= Math.min(maxCx, cx1 + 1); cx++) {
      if (cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1) continue;
      if (!getChunk(map, th, cx, cy, false)) {
        getChunk(map, th, cx, cy, true);
        return;
      }
    }
}
