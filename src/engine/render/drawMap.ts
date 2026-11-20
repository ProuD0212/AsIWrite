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
    drawDeco(ctx, d, tx * TILE, ty * TILE, th, tx, ty, map, t);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawDeco(ctx: CanvasRenderingContext2D, d: number, px: number, py: number, th: Theme, tx: number, ty: number, map: TileMap, t: number) {
  const h = hashString(`${tx},${ty}`);
  switch (d) {
    case D.Wall: {
      const broken = th.id === 'apocalypse' && h % 9 === 0;
      ctx.fillStyle = th.wall;
      ctx.fillRect(px, py + (broken ? 14 : 4), TILE, TILE - (broken ? 14 : 4));
      ctx.fillStyle = th.wallTop;
      ctx.fillRect(px, py + (broken ? 10 : 0), TILE, 7);
      if (th.id === 'cyber') {
        ctx.fillStyle = 'rgba(0,224,255,0.55)';
        ctx.fillRect(px, py + 6, TILE, 1);
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
