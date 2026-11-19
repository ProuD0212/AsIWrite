// Frame renderer: camera, y-sorted world, weather particles, day/night lighting,
// speech bubbles, emotes and effects. 100% procedural, pixel-art presentation.

import { TILE } from '../TileMap';
import type { World } from '../World';
import type { Agent } from '../types';
import { clamp } from '../util';
import { drawAgent } from './drawAgent';
import { drawDecoRow, drawGround } from './drawMap';
import { themeFor, type Theme } from './theme';
import { D } from '../TileMap';

/** Pixel-perfect zoom steps: world pixels map to whole screen pixels (½ = overview). */
export const ZOOMS = [0.5, 1, 2, 3, 4] as const;

export class Camera {
  x = 0; // world center
  y = 0;
  zoom = 2;
  w = 800; // screen css px (= canvas css size)
  h = 600;
  followId: string | null = null;

  worldToScreen(wx: number, wy: number) {
    return { x: (wx - this.x) * this.zoom + this.w / 2, y: (wy - this.y) * this.zoom + this.h / 2 };
  }
  screenToWorld(sx: number, sy: number) {
    return { x: (sx - this.w / 2) / this.zoom + this.x, y: (sy - this.h / 2) / this.zoom + this.y };
  }
  clampTo(worldW: number, worldH: number) {
    const hw = this.w / 2 / this.zoom, hh = this.h / 2 / this.zoom;
    this.x = worldW > hw * 2 ? clamp(this.x, hw - 64, worldW - hw + 64) : worldW / 2;
    this.y = worldH > hh * 2 ? clamp(this.y, hh - 96, worldH - hh + 64) : worldH / 2;
  }
  /** factor > 1 zooms in one step, < 1 zooms out one step (keeps the point under the cursor fixed) */
  zoomAt(sx: number, sy: number, factor: number) {
    const i = ZOOMS.indexOf(this.zoom as (typeof ZOOMS)[number]);
    const next = ZOOMS[clamp((i < 0 ? 2 : i) + (factor > 1 ? 1 : -1), 0, ZOOMS.length - 1)];
    if (next === this.zoom) return;
    const before = this.screenToWorld(sx, sy);
    this.zoom = next;
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }
  /** visible world rect */
  view() {
    const hw = this.w / 2 / this.zoom, hh = this.h / 2 / this.zoom;
    return { x0: this.x - hw, y0: this.y - hh, x1: this.x + hw, y1: this.y + hh };
  }
}

interface Drop {
  x: number;
  y: number;
  v: number;
  l: number;
}

const UI_FONT = '"Galmuri11", "Noto Sans KR", sans-serif';

/**
 * Two layers:
 *  - `canvas` (world): drawn at LOW resolution and enlarged with nearest-neighbour
 *    → crisp pixel art at every zoom step.
 *  - `ui` overlay: full device resolution for readable Korean text, emoji & bubbles.
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private ui: HTMLCanvasElement;
  private uctx: CanvasRenderingContext2D;
  private dpr = 1;
  private screenW = 800;
  private screenH = 600;
  private bw = 0; // buffer size (world canvas pixels)
  private bh = 0;
  private U = 2; // integer upscale factor buffer → screen
  private S = 1; // world px → buffer px
  private drops: Drop[] = [];
  private light: HTMLCanvasElement;
  private lctx: CanvasRenderingContext2D;
  private lastFlash = -10;
  hoverId: string | null = null;
  selectedId: string | null = null;
  showNames = true;
  canvas: HTMLCanvasElement;
  camera: Camera;

  constructor(canvas: HTMLCanvasElement, camera: Camera) {
    this.canvas = canvas;
    this.camera = camera;
    this.ctx = canvas.getContext('2d')!;
    canvas.classList.add('pixelated');
    this.ui = document.createElement('canvas');
    this.ui.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
    canvas.after(this.ui);
    this.uctx = this.ui.getContext('2d')!;
    this.light = document.createElement('canvas');
    this.lctx = this.light.getContext('2d')!;
  }

  dispose() {
    this.ui.remove();
  }

  resize(w: number, h: number) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.screenW = w;
    this.screenH = h;
    this.bw = 0; // force buffer rebuild
  }

  /** (Re)size the low-res buffer for the current zoom step. */
  private fitBuffer() {
    const z = this.camera.zoom;
    const U = Math.max(1, Math.round(z));
    const bw = Math.ceil(this.screenW / U), bh = Math.ceil(this.screenH / U);
    if (bw === this.bw && bh === this.bh && U === this.U) return;
    this.U = U;
    this.bw = bw;
    this.bh = bh;
    this.canvas.width = bw;
    this.canvas.height = bh;
    const cw = bw * U, ch = bh * U;
    this.canvas.style.width = `${cw}px`;
    this.canvas.style.height = `${ch}px`;
    this.ui.width = Math.floor(cw * this.dpr);
    this.ui.height = Math.floor(ch * this.dpr);
    this.ui.style.width = `${cw}px`;
    this.ui.style.height = `${ch}px`;
    this.light.width = bw;
    this.light.height = bh;
    this.camera.w = cw;
    this.camera.h = ch;
  }

  /** world → buffer pixel */
  private toBuf(wx: number, wy: number) {
    return { x: (wx - this.camera.x) * this.S + this.bw / 2, y: (wy - this.camera.y) * this.S + this.bh / 2 };
  }

  render(world: World, t: number) {
    this.fitBuffer();
    const { ctx, camera: cam } = this;
    this.S = cam.zoom / this.U; // 1, or 0.5 for the overview step
    const th = themeFor(world.meta.context);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#14110d';
    ctx.fillRect(0, 0, this.bw, this.bh);

    ctx.save();
    // snap the camera to the world-pixel grid so tiles never shimmer
    const sx = Math.round(cam.x * this.S) / this.S;
    const sy = Math.round(cam.y * this.S) / this.S;
    ctx.translate(Math.round(this.bw / 2), Math.round(this.bh / 2));
    ctx.scale(this.S, this.S);
    ctx.translate(-sx, -sy);

    const v = cam.view();
    const map = world.map;
    const tx0 = Math.max(0, Math.floor(v.x0 / TILE) - 1);
    const ty0 = Math.max(0, Math.floor(v.y0 / TILE) - 1);
    const tx1 = Math.min(map.w - 1, Math.ceil(v.x1 / TILE) + 1);
    const ty1 = Math.min(map.h - 1, Math.ceil(v.y1 / TILE) + 1);

    drawGround(ctx, map, th, tx0, ty0, tx1, ty1);

    // group rings: only while a Will is selected — under it and under fellow members of each of its groups
    const selA = world.agent(this.selectedId ?? undefined);
    if (selA && selA.kind === 'person') {
      const groups = world.factionsOf(selA.id);
      groups.forEach((f, gi) => {
        for (const id of f.members) {
          const m = world.agent(id);
          if (!m || m.x < v.x0 - 30 || m.x > v.x1 + 30 || m.y < v.y0 - 30 || m.y > v.y1 + 30) continue;
          const r = (14 + gi * 4) * m.layers.bodyScale;
          ctx.strokeStyle = f.color;
          ctx.globalAlpha = id === selA.id ? 1 : 0.85;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.ellipse(Math.round(m.x), Math.round(m.y), r, r * 0.45, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      });
    }

    // Bucket agents by tile row for painter's ordering with furniture/trees.
    const rows = new Map<number, Agent[]>();
    for (const a of world.agents) {
      if (a.x < v.x0 - 40 || a.x > v.x1 + 40 || a.y < v.y0 - 40 || a.y > v.y1 + 60) continue;
      const r = Math.floor(a.y / TILE);
      let list = rows.get(r);
      if (!list) rows.set(r, (list = []));
      list.push(a);
    }
    const raining = world.meta.weather === 'rain' || world.meta.weather === 'storm';
    for (let ty = ty0; ty <= ty1 + 1; ty++) {
      if (ty <= ty1) drawDecoRow(ctx, map, th, ty, tx0, tx1, t);
      const list = rows.get(ty);
      if (list) {
        list.sort((a, b) => a.y - b.y);
        for (const a of list)
          drawAgent(ctx, a, {
            t, seated: world.isSeated(a), raining, selected: a.id === this.selectedId, hovered: a.id === this.hoverId,
          });
      }
    }
    for (const [r, list] of rows) if (r > ty1 + 1 || r < ty0) for (const a of list) drawAgent(ctx, a, { t, seated: false, raining, selected: a.id === this.selectedId, hovered: false });

    const sel = world.place(this.selectedId ?? undefined);
    if (sel) {
      ctx.strokeStyle = 'rgba(255,207,110,0.95)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(sel.tx * TILE + 1, sel.ty * TILE + 1, sel.tw * TILE - 2, sel.th * TILE - 2);
      ctx.setLineDash([]);
    }

    this.drawEffects(world, t);
    ctx.restore();

    this.drawLighting(world, th, v, t);
    this.drawWeather(world, t);

    // crisp overlay: place signs, names, emotes, bubbles
    const u = this.uctx;
    u.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    u.clearRect(0, 0, cam.w, cam.h);
    this.drawPlaceSigns(world, th, v);
    this.drawOverlays(world, t, v);
  }

  private drawPlaceSigns(world: World, th: Theme, v: { x0: number; y0: number; x1: number; y1: number }) {
    const u = this.uctx;
    const cam = this.camera;
    u.font = `11px ${UI_FONT}`;
    u.textAlign = 'center';
    u.textBaseline = 'middle';
    for (const p of world.places) {
      if ((p.tx + p.tw) * TILE < v.x0 || p.tx * TILE > v.x1 || (p.ty + p.th) * TILE < v.y0 - 30 || p.ty * TILE > v.y1 + 30) continue;
      const q = cam.worldToScreen((p.tx + p.tw / 2) * TILE, p.ty * TILE);
      const sel = p.id === this.selectedId;
      const w = Math.ceil(u.measureText(p.name).width) + 12;
      const x = Math.round(q.x - w / 2), y = Math.round(q.y - 22);
      u.fillStyle = 'rgba(0,0,0,0.55)';
      u.fillRect(x + 2, y + 2, w, 16);
      u.fillStyle = sel ? '#ffcf6e' : '#2a2219';
      u.fillRect(x, y, w, 16);
      u.strokeStyle = sel ? '#14110d' : th.id === 'cyber' ? '#00e0ff' : '#8a7a5c';
      u.lineWidth = 1;
      u.strokeRect(x + 0.5, y + 0.5, w - 1, 15);
      u.fillStyle = sel ? '#14110d' : th.id === 'cyber' ? '#00e0ff' : '#f3e6c8';
      u.fillText(p.name, Math.round(q.x), y + 8.5);
    }
  }

  private drawEffects(world: World, t: number) {
    const { ctx } = this;
    for (const e of world.effects) {
      const age = world.simTime - e.born;
      const k = age / e.life;
      if (e.kind === 'lightning') {
        ctx.strokeStyle = `rgba(255,255,220,${1 - k})`;
        ctx.lineWidth = 4 * (1 - k) + 1;
        ctx.beginPath();
        let x = e.x, y = e.y - 420;
        ctx.moveTo(x, y);
        let seed = Math.floor(e.born * 1000);
        while (y < e.y) {
          seed = (seed * 9301 + 49297) % 233280;
          x += ((seed / 233280) - 0.5) * 40;
          y += 40;
          ctx.lineTo(x, Math.min(y, e.y));
        }
        ctx.stroke();
        ctx.fillStyle = `rgba(255,240,180,${0.5 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(e.x, e.y, 40 + k * 30, 0, Math.PI * 2);
        ctx.fill();
        this.lastFlash = world.simTime;
      } else if (e.kind === 'sparkle' || e.kind === 'spawn') {
        for (let i = 0; i < 8; i++) {
          const ang = (i / 8) * Math.PI * 2 + t;
          const r = 6 + k * 22;
          ctx.fillStyle = e.kind === 'spawn' ? `rgba(255,230,160,${1 - k})` : `rgba(255,250,200,${1 - k})`;
          ctx.beginPath();
          ctx.arc(e.x + Math.cos(ang) * r, e.y - 10 + Math.sin(ang) * r * 0.6, 2 * (1 - k) + 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  /** 0 = full day, 1 = deep night */
  static darkness(minutes: number) {
    const h = (minutes % 1440) / 60;
    if (h >= 7 && h <= 17.5) return 0;
    if (h > 17.5 && h < 20) return (h - 17.5) / 2.5;
    if (h >= 20 || h < 5) return 1;
    return 1 - (h - 5) / 2; // 5..7 dawn
  }

  private drawLighting(world: World, th: Theme, v: { x0: number; y0: number; x1: number; y1: number }, t: number) {
    let dark = Renderer.darkness(world.meta.minutes) * 0.62;
    if (world.meta.weather === 'rain' || world.meta.weather === 'storm') dark = Math.max(dark, 0.18);
    if (dark <= 0.01) return;
    const { lctx, light } = this;
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, light.width, light.height);
    lctx.fillStyle = th.night;
    lctx.globalAlpha = dark;
    lctx.fillRect(0, 0, light.width, light.height);
    lctx.globalAlpha = 1;
    lctx.globalCompositeOperation = 'destination-out';
    const map = world.map;
    const tx0 = Math.max(0, Math.floor(v.x0 / TILE) - 3), tx1 = Math.min(map.w - 1, Math.ceil(v.x1 / TILE) + 3);
    const ty0 = Math.max(0, Math.floor(v.y0 / TILE) - 3), ty1 = Math.min(map.h - 1, Math.ceil(v.y1 / TILE) + 3);
    const hole = (wx: number, wy: number, r: number, strength: number) => {
      const p = this.toBuf(wx, wy);
      const R = r * this.S;
      const g = lctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
      g.addColorStop(0, `rgba(0,0,0,${strength})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = g;
      lctx.fillRect(p.x - R, p.y - R, R * 2, R * 2);
    };
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const d = map.deco[map.idx(tx, ty)];
        if (d === D.Lamp) hole((tx + 0.5) * TILE, ty * TILE + 4, 120, 0.95);
        else if (d === D.Screen || d === D.Desk) hole((tx + 0.5) * TILE, (ty + 0.5) * TILE, 60, 0.7);
      }
    // building interiors glow softly at night
    for (const p of world.places) {
      if (p.style === 'park' || p.style === 'plaza') continue;
      hole((p.tx + p.tw / 2) * TILE, (p.ty + p.th / 2) * TILE, Math.max(p.tw, p.th) * TILE * 0.6, 0.55);
    }
    lctx.globalCompositeOperation = 'source-over';
    this.ctx.drawImage(light, 0, 0);
    // warm lamp tint
    if (dark > 0.25) {
      const ctx = this.ctx;
      ctx.globalCompositeOperation = 'lighter';
      for (let ty = ty0; ty <= ty1; ty++)
        for (let tx = tx0; tx <= tx1; tx++) {
          if (map.deco[map.idx(tx, ty)] !== D.Lamp) continue;
          const p = this.toBuf((tx + 0.5) * TILE, ty * TILE + 4);
          const R = 70 * this.S;
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
          const flick = 0.12 + Math.sin(t * 7 + tx) * 0.01;
          g.addColorStop(0, `${th.lampGlow}${flick * dark * 1.6})`);
          g.addColorStop(1, `${th.lampGlow}0)`);
          ctx.fillStyle = g;
          ctx.fillRect(p.x - R, p.y - R, R * 2, R * 2);
        }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  private drawWeather(world: World, t: number) {
    const { ctx } = this;
    const W = this.bw, H = this.bh;
    const w = world.meta.weather;
    const area = (W * H) / (720 * 450);
    const want = Math.round((w === 'rain' ? 200 : w === 'storm' ? 320 : w === 'snow' ? 140 : 0) * area);
    while (this.drops.length < want) this.drops.push({ x: Math.random() * W, y: Math.random() * H, v: 0.6 + Math.random() * 0.6, l: 0.5 + Math.random() });
    if (this.drops.length > want) this.drops.length = want;
    if (want) {
      if (w === 'snow') {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        for (const d of this.drops) {
          d.y += d.v * 0.45;
          d.x += Math.sin(t + d.l * 10) * 0.2;
          if (d.y > H) d.y = -2;
          if (d.x > W) d.x = 0;
          const sz = d.l > 1.1 ? 2 : 1;
          ctx.fillRect(Math.round(d.x), Math.round(d.y), sz, sz);
        }
      } else {
        ctx.fillStyle = 'rgba(190,210,240,0.55)';
        const slant = w === 'storm' ? 2 : 1;
        for (const d of this.drops) {
          d.y += d.v * 7;
          d.x += slant * d.v * 0.5;
          if (d.y > H) {
            d.y = -6;
            d.x = Math.random() * W;
          }
          // a pixel streak: 1px wide, 3–5px tall, stepped for slant
          const len = Math.round(3 + d.l * 2);
          for (let k = 0; k < len; k++) ctx.fillRect(Math.round(d.x - (k * slant) / 3), Math.round(d.y - k), 1, 1);
        }
        if (w === 'storm' && Math.random() < 0.002) this.lastFlash = world.simTime;
      }
    }
    const since = world.simTime - this.lastFlash;
    if (since < 0.25) {
      ctx.fillStyle = `rgba(240,240,255,${0.35 * (1 - since / 0.25)})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  private drawOverlays(world: World, t: number, v: { x0: number; y0: number; x1: number; y1: number }) {
    const { uctx: ctx, camera: cam } = this;
    const z = cam.zoom;
    this.placed.length = 0;
    // draw bottom-most agents' bubbles first so higher ones stack above
    const order = [...world.agents].sort((p, q) => q.y - p.y);
    for (const a of order) {
      if (a.x < v.x0 - 40 || a.x > v.x1 + 40 || a.y < v.y0 - 60 || a.y > v.y1 + 40) continue;
      const s = a.layers.bodyScale;
      const head = cam.worldToScreen(a.x, a.y - (a.kind === 'person' ? 34 : 18) * s);
      const feet = cam.worldToScreen(a.x, a.y);
      const isSel = a.id === this.selectedId;
      // nameplate
      if (this.showNames && (z >= 1 || isSel || a.id === this.hoverId)) {
        ctx.font = `11px ${UI_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = a.name;
        const w = Math.ceil(ctx.measureText(label).width) + 8;
        const x = Math.round(feet.x - w / 2), y = Math.round(feet.y + 4);
        ctx.fillStyle = isSel ? '#ffcf6e' : 'rgba(20,17,13,0.7)';
        ctx.fillRect(x, y, w, 14);
        ctx.fillStyle = isSel ? '#14110d' : '#f3e6c8';
        ctx.fillText(label, Math.round(feet.x), y + 2);
        // tiny square mood pip
        const m = a.mood;
        ctx.fillStyle = m >= 70 ? '#7ccf7a' : m >= 40 ? '#e8c45a' : m >= 20 ? '#ec8a3a' : '#d0443e';
        ctx.fillRect(x + w + 2, y + 4, 5, 5);
      }
      // emote
      if (a.emote) {
        const age = world.simTime - a.emote.born;
        const k = age / a.emote.life;
        const rise = Math.min(1, age * 4) * 8;
        ctx.globalAlpha = k > 0.75 ? (1 - k) * 4 : 1;
        ctx.font = `${16 + Math.min(1, age * 6) * 2}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(a.emote.icon, head.x + 12, head.y - rise + Math.sin(t * 6) * 1);
        ctx.globalAlpha = 1;
      }
      // speech / thought bubble
      if (a.bubble && (z >= 1 || isSel)) {
        const age = world.simTime - a.bubble.born;
        const k = age / a.bubble.life;
        ctx.globalAlpha = k > 0.85 ? (1 - k) / 0.15 : Math.min(1, age * 6);
        this.bubble(a.bubble.text, head.x, head.y - 6, !!a.bubble.thought);
        ctx.globalAlpha = 1;
      }
    }
  }

  private placed: { x: number; y: number; w: number; h: number }[] = [];

  private bubble(text: string, x: number, y: number, thought: boolean) {
    const ctx = this.uctx;
    x = Math.round(x);
    ctx.font = `11px ${UI_FONT}`;
    const maxW = text.length > 60 ? 250 : 170;
    const words = text.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else cur = test;
    }
    if (cur) lines.push(cur);
    const lw = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const bw = Math.ceil(lw) + 14, bh = lines.length * 15 + 8;
    const bx = Math.round(x - bw / 2);
    let by = Math.round(y - bh - 8);
    // stack upward while overlapping an already-drawn bubble
    for (let guard = 0; guard < 6; guard++) {
      const hit = this.placed.find((r) => bx < r.x + r.w && bx + bw > r.x && by < r.y + r.h && by + bh > r.y);
      if (!hit) break;
      by = hit.y - bh - 4;
    }
    this.placed.push({ x: bx, y: by, w: bw, h: bh });
    const tailY = Math.min(y, by + bh + 8);
    // pixel-style box: dark 1px outline, notched corners, hard drop shadow
    const fill = thought ? '#e9eeff' : '#fffaf0';
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(bx + 2, by + 2, bw, bh);
    ctx.fillStyle = '#2a2420';
    ctx.fillRect(bx + 1, by, bw - 2, bh);
    ctx.fillRect(bx, by + 1, bw, bh - 2);
    ctx.fillStyle = fill;
    ctx.fillRect(bx + 1, by + 1, bw - 2, bh - 2);
    if (thought) {
      ctx.fillStyle = '#2a2420';
      ctx.fillRect(x - 6, tailY - 6, 5, 5);
      ctx.fillRect(x - 10, tailY, 3, 3);
      ctx.fillStyle = fill;
      ctx.fillRect(x - 5, tailY - 5, 3, 3);
      ctx.fillRect(x - 9, tailY + 1, 1, 1);
    } else {
      // stepped pixel tail
      for (let k = 0; k < 4; k++) {
        ctx.fillStyle = '#2a2420';
        ctx.fillRect(x - 4 + k, by + bh - 1 + k, 9 - k * 2, 1);
        ctx.fillStyle = fill;
        ctx.fillRect(x - 3 + k, by + bh - 1 + k, Math.max(0, 7 - k * 2), 1);
      }
    }
    ctx.fillStyle = '#2a2420';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, x, by + 5 + i * 15));
  }
}
