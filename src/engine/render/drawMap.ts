// Procedural tile & furniture drawing (visible tiles only).

import { D, G, TILE, type TileMap } from '../TileMap';
import type { Place } from '../types';
import { hashString, shade } from '../util';
import type { Theme } from './theme';

export function drawGround(ctx: CanvasRenderingContext2D, map: TileMap, th: Theme, x0: number, y0: number, x1: number, y1: number) {
  const [r0, r1] = map.roadRows;
  const [c0, c1] = map.roadCols;
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      const i = map.idx(tx, ty);
      const g = map.ground[i];
      const px = tx * TILE, py = ty * TILE;
      let col: string;
      switch (g) {
        case G.Road: col = th.road; break;
        case G.Sidewalk: col = th.sidewalk; break;
        case G.Wood: col = th.wood; break;
        case G.Tile: col = th.tile; break;
        case G.Carpet: col = th.carpet; break;
        case G.Plaza: col = th.plaza; break;
        case G.Dirt: col = th.dirt; break;
        default: col = (tx * 7 + ty * 13) % 5 === 0 ? th.grass[1] : th.grass[0];
      }
      ctx.fillStyle = col;
      ctx.fillRect(px, py, TILE + 0.5, TILE + 0.5);

      // texture details
      if (g === G.Grass && (tx * 31 + ty * 17) % 7 === 0) {
        ctx.fillStyle = shade(th.grass[0], 0.12);
        ctx.fillRect(px + 8, py + 12, 2, 4);
        ctx.fillRect(px + 20, py + 22, 2, 3);
      } else if (g === G.Wood) {
        ctx.fillStyle = shade(th.wood, -0.12);
        ctx.fillRect(px, py + 15, TILE, 1);
        ctx.fillRect(px + ((ty % 2) * 16), py, 1, 15);
      } else if (g === G.Tile) {
        ctx.strokeStyle = shade(th.tile, -0.1);
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);
      } else if (g === G.Sidewalk || g === G.Plaza) {
        ctx.fillStyle = shade(col, -0.08);
        ctx.fillRect(px, py + TILE - 1, TILE, 1);
        ctx.fillRect(px + TILE - 1, py, 1, TILE);
      } else if (g === G.Road) {
        // center dashes
        const midRow = (r0 + r1) / 2, midCol = (c0 + c1) / 2;
        ctx.fillStyle = th.roadLine;
        const inCross = ty >= r0 && ty <= r1 && tx >= c0 && tx <= c1;
        if (!inCross && ty === midRow && tx % 2 === 0) ctx.fillRect(px + 4, py + 15, 22, 3);
        if (!inCross && tx === midCol && ty % 2 === 0) ctx.fillRect(px + 15, py + 4, 3, 22);
        if (th.id === 'apocalypse' && (tx * 13 + ty * 7) % 11 === 0) {
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.beginPath();
          ctx.moveTo(px + 4, py + 6);
          ctx.lineTo(px + 14, py + 16);
          ctx.lineTo(px + 12, py + 26);
          ctx.stroke();
        }
      }
    }
}

/** Furniture / walls / trees. Called after ground, before characters with y-sorting by row. */
export function drawDecoRow(ctx: CanvasRenderingContext2D, map: TileMap, th: Theme, ty: number, x0: number, x1: number, t: number) {
  for (let tx = x0; tx <= x1; tx++) {
    const d = map.deco[map.idx(tx, ty)];
    if (d === D.None) continue;
    if (d === D.Tree) {
      drawTree(ctx, tx * TILE, ty * TILE, th, hashString(`${tx},${ty}`), t);
      continue;
    }
    const sprite = STATIC_DECO.has(d) ? cachedDeco(d, th, tx, ty, map) : null;
    if (sprite) ctx.drawImage(sprite as CanvasImageSource, tx * TILE - DECO_O.x, ty * TILE - DECO_O.y);
    else drawDeco(ctx, d, tx * TILE, ty * TILE, th, tx, ty, map, t);
  }
}

// ───────────────────────── cached, outlined furniture ─────────────────────────
// Static furniture is drawn once per (type, theme, variant) into a small canvas, given crisp pixels and
// the same 1-px outline the Wills have (soft shadows are kept), and reused. Animated pieces (screens,
// lamps, machines, ovens, fountains) stay live.
type Canvas = HTMLCanvasElement | OffscreenCanvas;
const STATIC_DECO = new Set<number>([D.Bench, D.Table, D.Chair, D.Counter, D.Shelf, D.Bookshelf, D.Sofa, D.Bed, D.Flower, D.Bush, D.Board, D.Barrel]);
const DECO_O = { x: 8, y: 16 }; // tile origin inside the sprite (room for things that poke out)
const DW = TILE + 16, DH = TILE + 24;
const decoCache = new Map<string, Canvas>();
const OUTLINE = '#2e2433';
function makeCanvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
/** crisp edges + 1-px outline around the solid pixels; translucent pixels (shadows) stay soft */
function outlineKeepSoft(raw: Canvas, w: number, h: number): Canvas {
  const rc = raw.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const img = rc.getImageData(0, 0, w, h);
  const hard = new ImageData(w, h), soft = new ImageData(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3];
    const dst = a >= 110 ? hard.data : soft.data;
    dst[i] = img.data[i];
    dst[i + 1] = img.data[i + 1];
    dst[i + 2] = img.data[i + 2];
    dst[i + 3] = a >= 110 ? 255 : a;
  }
  const hc = makeCanvas(w, h);
  (hc.getContext('2d') as CanvasRenderingContext2D).putImageData(hard, 0, 0);
  const out = makeCanvas(w, h);
  const oc = out.getContext('2d') as CanvasRenderingContext2D;
  oc.putImageData(soft, 0, 0);
  const ol = makeCanvas(w, h);
  const lc = ol.getContext('2d') as CanvasRenderingContext2D;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) lc.drawImage(hc as CanvasImageSource, dx, dy);
  lc.globalCompositeOperation = 'source-in';
  lc.fillStyle = OUTLINE;
  lc.fillRect(0, 0, w, h);
  oc.drawImage(ol as CanvasImageSource, 0, 0);
  oc.drawImage(hc as CanvasImageSource, 0, 0);
  return out;
}
function cachedDeco(d: number, th: Theme, tx: number, ty: number, map: TileMap): Canvas | null {
  if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') return null;
  const v = hashString(`${tx},${ty}`) % 10;
  const key = `${d}|${th.id}|${th.wood}|${v}`;
  let c = decoCache.get(key);
  if (!c) {
    if (decoCache.size > 600) decoCache.clear();
    const raw = makeCanvas(DW, DH);
    drawDeco(raw.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D, d, DECO_O.x, DECO_O.y, th, tx, ty, map, 0);
    c = outlineKeepSoft(raw, DW, DH);
    decoCache.set(key, c);
  }
  return c;
}

// ───────────────────────── trees ─────────────────────────
// Layered, outlined canopies in a few shapes (round, tall, blossom, pine), lit from the upper left,
// swaying a pixel or two in the breeze. Trunk and canopy are cached; the sway is applied live.
const treeCache = new Map<string, Canvas>();
const TW = 48, TH = 56, T_O = { x: 24, y: 40 }; // tree base inside the sprite
function treeSprite(th: Theme, variant: number, part: 'trunk' | 'canopy'): Canvas {
  const key = `${th.id}|${th.tree[0]}|${variant}|${part}`;
  const hit = treeCache.get(key);
  if (hit) return hit;
  const raw = makeCanvas(TW, TH);
  const c = raw.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  c.translate(T_O.x, T_O.y);
  const dark = shade(th.tree[0], -0.18), base = th.tree[0], mid = th.tree[1], light = shade(th.tree[1], 0.22);
  const blob = (x: number, y: number, r: number, col: string) => {
    c.fillStyle = col;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  };
  const pine = variant === 3;
  if (part === 'trunk') {
    c.fillStyle = '#6b4a2e';
    c.fillRect(-3, -14, 6, 14);
    c.fillStyle = '#563a24';
    c.fillRect(1, -14, 2, 14);
  } else if (pine) {
    for (let k = 0; k < 3; k++) {
      const y = -14 - k * 8, w = 13 - k * 3;
      c.fillStyle = k === 2 ? mid : base;
      c.beginPath();
      c.moveTo(-w, y);
      c.lineTo(0, y - 13);
      c.lineTo(w, y);
      c.closePath();
      c.fill();
      c.fillStyle = light;
      c.fillRect(-3, y - 9, 2, 3);
    }
  } else {
    const tall = variant === 1;
    const R = tall ? 11 : 14;
    const cy = tall ? -28 : -24;
    blob(0, cy + 2, R, dark);
    blob(-5, cy - 1, R * 0.72, base);
    blob(6, cy, R * 0.68, base);
    blob(0, cy - (tall ? 8 : 5), R * 0.7, base);
    if (tall) blob(0, cy - 14, R * 0.55, base);
    blob(-4, cy - (tall ? 9 : 6), R * 0.45, mid);
    blob(-6, cy - (tall ? 11 : 8), R * 0.22, light);
    if (variant === 2) {
      // blossoms / fruit
      const dots = th.id === 'apocalypse' ? '#b8a05a' : th.id === 'space' || th.id === 'cyber' ? '#7ff0ff' : '#ffb3c8';
      for (let k = 0; k < 7; k++) {
        c.fillStyle = dots;
        c.fillRect(-9 + ((k * 7) % 18), cy - 8 + ((k * 5) % 14), 2, 2);
      }
    }
  }
  const out = outlineKeepSoft(raw, TW, TH);
  treeCache.set(key, out);
  return out;
}
function drawTree(ctx: CanvasRenderingContext2D, px: number, py: number, th: Theme, h: number, t: number) {
  const variant = th.id === 'fantasy' || th.id === 'joseon' ? [0, 3, 1, 3][h % 4] : h % 5 === 4 ? 2 : h % 3 === 2 ? 1 : 0;
  const bx = px + 16, by = py + 27;
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath();
  ctx.ellipse(bx + 2, by, 14, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.drawImage(treeSprite(th, variant, 'trunk') as CanvasImageSource, bx - T_O.x, by - T_O.y);
  const sway = Math.round(Math.sin(t * 0.9 + (h % 100)) * 1.2);
  ctx.drawImage(treeSprite(th, variant, 'canopy') as CanvasImageSource, bx - T_O.x + sway, by - T_O.y);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawDeco(ctx: CanvasRenderingContext2D, d: number, px: number, py: number, th: Theme, tx: number, ty: number, map: TileMap, t: number) {
  const h = hashString(`${tx},${ty}`);
  switch (d) {
    case D.Wall: {
      // cutaway walls seen from above: a lit cap everywhere; where nothing is in front (south),
      // a short brick face shows. Edges that face open floor get the outline colour.
      const W = (dx: number, dy: number) => map.inBounds(tx + dx, ty + dy) && (map.deco[map.idx(tx + dx, ty + dy)] === D.Wall || map.deco[map.idx(tx + dx, ty + dy)] === D.Door);
      const broken = th.id === 'apocalypse' && h % 9 === 0;
      const face = !W(0, 1);
      const capH = face ? 12 : TILE;
      const cap = th.wallTop, wall = th.wall;
      // cap (a full tile: insets would show the building's floor around the outside)
      const l = 0, r = 0, top = 0;
      ctx.fillStyle = cap;
      ctx.fillRect(px + l, py + top + (broken ? 6 : 0), TILE - l - r, capH - top - (broken ? 6 : 0));
      ctx.fillStyle = shade(cap, 0.18);
      if (!W(0, -1)) ctx.fillRect(px + l, py + top, TILE - l - r, 1);
      if (!W(-1, 0)) ctx.fillRect(px + l, py + top, 1, capH - top);
      ctx.fillStyle = shade(cap, -0.1);
      if (!W(1, 0)) ctx.fillRect(px + TILE - r - 1, py + top, 1, capH - top);
      if (face) {
        // brick face
        ctx.fillStyle = wall;
        ctx.fillRect(px + l, py + capH, TILE - l - r, TILE - capH - 4);
        ctx.fillStyle = shade(wall, -0.18);
        for (let row = 0; row < 3; row++) {
          const yy = py + capH + 2 + row * 5;
          if (yy > py + TILE - 6) break;
          ctx.fillRect(px + l, yy + 4, TILE - l - r, 1);
          for (let xx = px + l + ((row + tx) % 2) * 5; xx < px + TILE - r; xx += 10) ctx.fillRect(xx, yy, 1, 4);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(px + l, py + TILE - 5, TILE - l - r, 1);
      }
      // outline toward open floor
      ctx.fillStyle = '#2e2433';
      if (!W(0, -1)) ctx.fillRect(px + l, py + top - 1, TILE - l - r, 1);
      if (!W(-1, 0)) ctx.fillRect(px + l - 1, py + top, 1, TILE - top - (face ? 4 : 0));
      if (!W(1, 0)) ctx.fillRect(px + TILE - r, py + top, 1, TILE - top - (face ? 4 : 0));
      if (face) ctx.fillRect(px + l, py + TILE - 4, TILE - l - r, 1);
      if (th.id === 'cyber') {
        ctx.fillStyle = 'rgba(0,224,255,0.55)';
        ctx.fillRect(px + l, py + capH - 1, TILE - l - r, 1);
      }
      break;
    }
    case D.Door: {
      ctx.fillStyle = shade(th.wood, -0.25);
      ctx.fillRect(px + 2, py + 12, TILE - 4, 8);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(px + 2, py + 18, TILE - 4, 2);
      break;
    }
    case D.Tree: {
      const sway = Math.sin(t * 0.8 + h) * 1.2;
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      ctx.ellipse(px + 16, py + 26, 13, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#6b4a2e';
      ctx.fillRect(px + 13, py + 14, 6, 12);
      ctx.fillStyle = th.tree[0];
      ctx.beginPath();
      ctx.arc(px + 16 + sway, py + 8, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = th.tree[1];
      ctx.beginPath();
      ctx.arc(px + 11 + sway, py + 3, 8, 0, Math.PI * 2);
      ctx.arc(px + 21 + sway, py + 6, 7, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case D.Bush: {
      ctx.fillStyle = th.tree[0];
      ctx.beginPath();
      ctx.arc(px + 11, py + 18, 8, 0, Math.PI * 2);
      ctx.arc(px + 21, py + 19, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = th.tree[1];
      ctx.beginPath();
      ctx.arc(px + 14, py + 14, 5, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case D.Flower: {
      const cols = ['#f2a0bf', '#f2cf48', '#f1efe8', '#d0443e', '#8a5cc8'];
      for (let k = 0; k < 5; k++) {
        ctx.fillStyle = '#3f7342';
        ctx.fillRect(px + 5 + k * 5, py + 18 + ((h >> k) & 3), 1.5, 6);
        ctx.fillStyle = cols[(h + k) % cols.length];
        ctx.beginPath();
        ctx.arc(px + 6 + k * 5, py + 17 + ((h >> k) & 3), 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case D.Bench: {
      ctx.fillStyle = '#7a5236';
      ctx.fillRect(px + 2, py + 12, TILE - 4, 9);
      ctx.fillStyle = '#9a6a46';
      ctx.fillRect(px + 2, py + 10, TILE - 4, 3);
      ctx.fillStyle = '#3a3430';
      ctx.fillRect(px + 4, py + 21, 2, 5);
      ctx.fillRect(px + TILE - 6, py + 21, 2, 5);
      break;
    }
    case D.Table: {
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.fillRect(px + 5, py + 9, 24, 20);
      ctx.fillStyle = shade(th.wood, 0.18);
      roundRect(ctx, px + 3, py + 5, 26, 20, 4);
      ctx.fill();
      ctx.fillStyle = '#f1efe8';
      ctx.beginPath();
      ctx.arc(px + 12, py + 13, 3, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case D.Chair: {
      ctx.fillStyle = shade(th.wood, -0.2);
      roundRect(ctx, px + 9, py + 9, 14, 14, 3);
      ctx.fill();
      break;
    }
    case D.Sofa: {
      ctx.fillStyle = shade(th.carpet, 0.3);
      roundRect(ctx, px + 1, py + 6, TILE - 2, 22, 5);
      ctx.fill();
      ctx.fillStyle = shade(th.carpet, 0.45);
      roundRect(ctx, px + 4, py + 10, TILE - 8, 12, 4);
      ctx.fill();
      break;
    }
    case D.Counter: {
      ctx.fillStyle = shade(th.wood, -0.3);
      ctx.fillRect(px, py + 4, TILE, 24);
      ctx.fillStyle = shade(th.wood, 0.1);
      ctx.fillRect(px, py + 4, TILE, 6);
      if (h % 3 === 0) {
        ctx.fillStyle = '#c9ccd4';
        ctx.fillRect(px + 10, py + 1, 10, 8);
      }
      break;
    }
    case D.Shelf:
    case D.Bookshelf: {
      ctx.fillStyle = shade(th.wood, -0.35);
      ctx.fillRect(px + 1, py + 2, TILE - 2, TILE - 4);
      const cols = d === D.Bookshelf ? ['#a8685a', '#4f5d6e', '#c9a25c', '#5c8a6e', '#7c6aa8'] : ['#f2cf48', '#d0443e', '#3f6fd0', '#f1efe8', '#ec8a3a'];
      for (let k = 0; k < 6; k++) {
        ctx.fillStyle = cols[(h + k) % cols.length];
        ctx.fillRect(px + 3 + k * 4.4, py + 5 + ((h >> k) & 1) * 2, 3.4, 9);
        ctx.fillStyle = cols[(h + k + 2) % cols.length];
        ctx.fillRect(px + 3 + k * 4.4, py + 17, 3.4, 9);
      }
      break;
    }
    case D.Screen: {
      ctx.fillStyle = '#1a1c26';
      ctx.fillRect(px, py + 4, TILE, 14);
      const hue = (t * 60 + tx * 40) % 360;
      ctx.fillStyle = `hsl(${hue} 80% 60%)`;
      ctx.fillRect(px + 2, py + 6, TILE - 4, 10);
      break;
    }
    case D.Bed: {
      ctx.fillStyle = '#f1efe8';
      roundRect(ctx, px + 2, py + 2, TILE - 4, TILE - 4, 4);
      ctx.fill();
      ctx.fillStyle = '#6b7fa8';
      ctx.fillRect(px + 2, py + 14, TILE - 4, TILE - 16);
      break;
    }
    case D.Desk: {
      ctx.fillStyle = '#9aa3ad';
      ctx.fillRect(px + 2, py + 6, TILE - 4, 16);
      ctx.fillStyle = '#1a1c26';
      ctx.fillRect(px + 9, py + 7, 14, 8);
      ctx.fillStyle = `rgba(120,200,255,${0.5 + Math.sin(t * 2 + h) * 0.2})`;
      ctx.fillRect(px + 10, py + 8, 12, 6);
      break;
    }
    case D.Lamp: {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath();
      ctx.ellipse(px + 16, py + 27, 5, 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#3a3a40';
      ctx.fillRect(px + 15, py + 2, 2.5, 25);
      ctx.fillStyle = th.id === 'cyber' ? '#00e0ff' : '#ffe8b0';
      ctx.beginPath();
      ctx.arc(px + 16, py + 2, 4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case D.Oven: {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(px + 3, py + 6, TILE - 2, TILE - 4);
      ctx.fillStyle = th.id === 'fantasy' || th.id === 'joseon' ? '#8a5a3a' : '#c9ccd1';
      ctx.fillRect(px + 1, py + 2, TILE - 2, TILE - 5);
      ctx.fillStyle = '#2a2420';
      ctx.fillRect(px + 5, py + 9, TILE - 10, 12);
      ctx.fillStyle = `rgba(255,${140 + Math.round(Math.sin(t * 3 + h) * 30)},60,0.85)`;
      ctx.fillRect(px + 7, py + 15, TILE - 14, 5);
      ctx.fillStyle = '#e8e2d6';
      ctx.fillRect(px + 6, py + 4, 4, 3);
      ctx.fillRect(px + 13, py + 4, 4, 3);
      break;
    }
    case D.Equipment: {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(px + 3, py + 8, TILE - 4, TILE - 8);
      if (h % 2) {
        // treadmill
        ctx.fillStyle = '#3a3d44';
        ctx.fillRect(px + 3, py + 12, TILE - 6, 14);
        ctx.fillStyle = '#6a6e78';
        const off = (t * 30) % 4;
        for (let k = 0; k < 6; k++) ctx.fillRect(px + 4 + ((k * 4 + off) % (TILE - 8)), py + 14, 1, 10);
        ctx.fillStyle = '#9aa3ad';
        ctx.fillRect(px + 4, py + 3, 3, 10);
        ctx.fillRect(px + TILE - 7, py + 3, 3, 10);
        ctx.fillStyle = '#ff6b6b';
        ctx.fillRect(px + 8, py + 3, TILE - 16, 4);
      } else {
        // dumbbell rack
        ctx.fillStyle = '#7d8794';
        ctx.fillRect(px + 2, py + 18, TILE - 4, 3);
        ctx.fillStyle = '#2a2d34';
        for (let k = 0; k < 3; k++) {
          ctx.fillRect(px + 4 + k * 9, py + 10, 3, 8);
          ctx.fillRect(px + 7 + k * 9, py + 12, 2, 4);
        }
      }
      break;
    }
    case D.Board: {
      ctx.fillStyle = '#8a6a48';
      ctx.fillRect(px, py + 3, TILE, 18);
      ctx.fillStyle = th.id === 'cyber' || th.id === 'space' ? '#1d3a4a' : '#2f5a3e';
      ctx.fillRect(px + 1, py + 5, TILE - 2, 14);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillRect(px + 4 + (h % 6), py + 8, 10, 1);
      ctx.fillRect(px + 6, py + 12, 14 - (h % 5), 1);
      break;
    }
    case D.Barrel: {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath();
      ctx.ellipse(px + 17, py + 27, 11, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#8a5a36';
      roundRect(ctx, px + 6, py + 5, TILE - 12, TILE - 9, 5);
      ctx.fill();
      ctx.fillStyle = '#4a3a2a';
      ctx.fillRect(px + 6, py + 10, TILE - 12, 2);
      ctx.fillRect(px + 6, py + 20, TILE - 12, 2);
      break;
    }
    case D.Machine: {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(px + 3, py + 6, TILE - 2, TILE - 4);
      ctx.fillStyle = th.id === 'fantasy' ? '#6d5a48' : '#7d8794';
      ctx.fillRect(px + 1, py + 2, TILE - 2, TILE - 6);
      ctx.fillStyle = th.id === 'fantasy' ? '#e07a3a' : '#4a5260';
      ctx.fillRect(px + 5, py + 6, TILE - 10, 9);
      const on = Math.sin(t * 4 + h) > 0;
      ctx.fillStyle = on ? '#7ccf7a' : '#2f4f2f';
      ctx.beginPath();
      ctx.arc(px + TILE - 7, py + 21, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      const off = (t * 20) % 6;
      for (let k = 0; k < 5; k++) {
        ctx.moveTo(px + 4 + k * 6 + off * 0.3, py + 24);
        ctx.lineTo(px + 6 + k * 6 + off * 0.3, py + 27);
      }
      ctx.stroke();
      break;
    }
    case D.Fountain: {
      ctx.fillStyle = '#9aa3ad';
      ctx.beginPath();
      ctx.arc(px + 16, py + 16, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#7fb6e0';
      ctx.beginPath();
      ctx.arc(px + 16, py + 16, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      const r = 3 + Math.sin(t * 3) * 1.5;
      ctx.beginPath();
      ctx.arc(px + 16, py + 16, r, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
  void map;
}

/** Floating place signboard. */
export function drawPlaceLabel(ctx: CanvasRenderingContext2D, p: Place, th: Theme, zoom: number, selected: boolean) {
  const cx = (p.tx + p.tw / 2) * TILE;
  const y = p.ty * TILE - 6;
  const fs = Math.max(10, 12 / Math.max(zoom, 0.6));
  ctx.font = `600 ${fs}px "Noto Sans KR", sans-serif`;
  const w = ctx.measureText(p.name).width + 14;
  ctx.fillStyle = selected ? 'rgba(255,207,110,0.95)' : 'rgba(20,17,13,0.72)';
  roundRect(ctx, cx - w / 2, y - fs - 6, w, fs + 8, 6);
  ctx.fill();
  ctx.fillStyle = selected ? '#14110d' : th.id === 'cyber' ? '#00e0ff' : '#f3e6c8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(p.name, cx, y - fs / 2 - 2);
}
