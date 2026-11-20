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

/**
 * Zoom steps. Gentle ratios (×1.33–1.5 per step instead of ×2) so one wheel notch never jumps
 * too far, and deep overview steps so a big (resized) map still fits on screen.
 * The buffer is upscaled by a whole number (round(z)), so pixel art stays crisp enough.
 */
export const ZOOMS = [0.125, 0.1875, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4] as const;

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
    // bigger than the screen: keep the view on the map (small margins for the HUD).
    // smaller than the screen: don't pin it to the centre — let the player slide the map around
    // until one of its edges reaches the screen edge (it never leaves the screen).
    // free camera: roam well past the edges (an arrow points back to the town once it's off screen);
    // the generous bound only stops the view drifting off forever
    const mx = Math.max(worldW, hw * 2) * 2, my = Math.max(worldH, hh * 2) * 2;
    this.x = clamp(this.x, -mx, worldW + mx);
    this.y = clamp(this.y, -my, worldH + my);
  }
  /** factor > 1 zooms in one step, < 1 zooms out one step (keeps the point under the cursor fixed) */
  zoomAt(sx: number, sy: number, factor: number) {
    // after a smooth (Shift) zoom we may sit between steps: go to the next step in that direction
    const next = factor > 1 ? (ZOOMS.find((z) => z > this.zoom + 1e-6) ?? ZOOMS[ZOOMS.length - 1]) : ([...ZOOMS].reverse().find((z) => z < this.zoom - 1e-6) ?? ZOOMS[0]);
    if (next === this.zoom) return;
    this.zoomTo(sx, sy, next);
  }
  /** continuous zoom (Shift + wheel): any value between the smallest and largest step */
  zoomSmooth(sx: number, sy: number, factor: number) {
    this.zoomTo(sx, sy, clamp(this.zoom * factor, ZOOMS[0], ZOOMS[ZOOMS.length - 1]));
  }
  private zoomTo(sx: number, sy: number, next: number) {
    const before = this.screenToWorld(sx, sy);
    this.zoom = next;
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }
  /** largest zoom step at which the whole map fits on screen, centred on it */
  fit(worldW: number, worldH: number) {
    const z = Math.min(this.w / (worldW + 64), this.h / (worldH + 160));
    this.zoom = [...ZOOMS].reverse().find((s) => s <= z) ?? ZOOMS[0];
    this.x = worldW / 2;
    this.y = worldH / 2;
    this.followId = null;
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

    // placement ghost for a Will / animal: the real sprite, see-through
    if (this.ghost?.kind === 'agent') {
      const g = this.ghost;
      ctx.save();
      ctx.globalAlpha = 0.55;
      const fake = { kind: g.person ? 'person' : 'animal', layers: g.layers, x: g.x, y: g.y, facing: 'down', moving: false, animPhase: t * 1.6, mood: 60, ai: { mode: 'idle' }, emote: null } as unknown as Agent;
      drawAgent(ctx, fake, { t, seated: false, raining: false, selected: false, hovered: false });
      ctx.restore();
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
    if (this.edit) this.drawEditOverlay(world);
    this.drawPlaceGhost();
    this.drawHomeArrow(world, t);
  }

  /** where the canvas sits on the page (for menus opened from the keyboard) */
  canvasRect() {
    return this.uctx.canvas.getBoundingClientRect();
  }
  /** screen position of the "town is that way" arrow (null while any of the map is on screen) — Game uses it for clicks */
  homeArrow: { x: number; y: number } | null = null;
  private drawHomeArrow(world: World, t: number) {
    const cam = this.camera, u = this.uctx;
    const a = cam.worldToScreen(0, 0), b = cam.worldToScreen(world.map.w * TILE, world.map.h * TILE);
    // still see a good bit of land → no arrow
    const visW = Math.min(b.x, cam.w) - Math.max(a.x, 0), visH = Math.min(b.y, cam.h) - Math.max(a.y, 0);
    if (visW > 80 && visH > 80) return void (this.homeArrow = null);
    const cx = cam.w / 2, cy = cam.h / 2;
    const tx = (a.x + b.x) / 2, ty = (a.y + b.y) / 2;
    const ang = Math.atan2(ty - cy, tx - cx);
    // where the ray from the centre meets the screen edge (inset)
    const m = 46;
    const sx = Math.cos(ang), sy = Math.sin(ang);
    const k = Math.min(Math.abs((cx - m) / (sx || 1e-6)), Math.abs((cy - m) / (sy || 1e-6)));
    const pulse = 1 + Math.sin(t * 5) * 0.08;
    const x = cx + sx * k, y = cy + sy * k;
    this.homeArrow = { x, y };
    u.save();
    u.translate(x, y);
    u.fillStyle = 'rgba(20,17,13,0.82)';
    u.beginPath();
    u.arc(0, 0, 24, 0, Math.PI * 2);
    u.fill();
    u.strokeStyle = '#ffcf6e';
    u.lineWidth = 2;
    u.stroke();
    u.rotate(ang);
    u.scale(pulse, pulse);
    u.fillStyle = '#ffcf6e';
    u.beginPath();
    u.moveTo(15, 0);
    u.lineTo(-7, -10);
    u.lineTo(-2, 0);
    u.lineTo(-7, 10);
    u.closePath();
    u.fill();
    u.restore();
    const dist = Math.round(Math.hypot(tx - cx, ty - cy) / cam.zoom / TILE);
    u.font = `11px ${UI_FONT}`;
    u.textAlign = 'center';
    u.textBaseline = 'top';
    const label = `🏘 마을 ${dist}칸 · 클릭/H`;
    const lw = u.measureText(label).width + 10;
    const ly = y + (sy > 0.5 ? -48 : 28);
    u.fillStyle = 'rgba(20,17,13,0.82)';
    u.fillRect(Math.round(x - lw / 2), ly, Math.round(lw), 16);
    u.fillStyle = '#f3e6c8';
    u.fillText(label, Math.round(x), ly + 2);
  }

  /** map-edit mode state, set by Game every frame (null = not editing) */
  edit: { resize: { dl: number; dt: number; dr: number; db: number } | null; hover: { tx: number; ty: number } | null; size: number; valid: boolean; line: { tx: number; ty: number }[] | null } | null = null;

  /** translucent "this is where it will go" preview for placing / moving things */
  ghost:
    | { kind: 'place'; tx: number; ty: number; tw: number; th: number; ok: boolean; label: string; door: 'top' | 'bottom' | 'left' | 'right' }
    | { kind: 'agent'; x: number; y: number; layers: Agent['layers']; person: boolean }
    | null = null;

  private drawPlaceGhost() {
    const g = this.ghost;
    if (!g || g.kind !== 'place') return;
    const u = this.uctx;
    const cam = this.camera;
    const a = cam.worldToScreen(g.tx * TILE, g.ty * TILE), b = cam.worldToScreen((g.tx + g.tw) * TILE, (g.ty + g.th) * TILE);
    u.save();
    u.fillStyle = g.ok ? 'rgba(120,220,150,0.22)' : 'rgba(255,90,90,0.22)';
    u.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    u.strokeStyle = g.ok ? 'rgba(140,240,170,0.9)' : 'rgba(255,110,110,0.9)';
    u.lineWidth = 2;
    u.setLineDash([5, 4]);
    u.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    u.setLineDash([]);
    // where the door will be
    u.fillStyle = u.strokeStyle;
    if (g.door === 'left' || g.door === 'right') {
      const dy = (a.y + b.y) / 2, dx = g.door === 'left' ? a.x : b.x;
      u.fillRect(dx - 3, dy - 8, 6, 16);
    } else {
      const dx = (a.x + b.x) / 2, dy = g.door === 'top' ? a.y : b.y;
      u.fillRect(dx - 8, dy - 3, 16, 6);
    }
    u.font = `bold 12px ${UI_FONT}`;
    u.textAlign = 'center';
    u.textBaseline = 'middle';
    const text = g.ok ? g.label : `${g.label} — 여기엔 지을 수 없어요`;
    const tw = u.measureText(text).width + 14;
    u.fillStyle = 'rgba(0,0,0,0.65)';
    const cx = (a.x + b.x) / 2;
    u.fillRect(cx - tw / 2, (a.y + b.y) / 2 - 11, tw, 22);
    u.fillStyle = g.ok ? '#e9d8b4' : '#ffb3b3';
    u.fillText(text, cx, (a.y + b.y) / 2);
    u.restore();
  }

  /** Edit mode: the map's border with window-style grab handles, the resize preview, the brush cursor. */
  private drawEditOverlay(world: World) {
    const u = this.uctx;
    const cam = this.camera;
    const e = this.edit!;
    const W = world.map.w, H = world.map.h;
    const a = cam.worldToScreen(0, 0), b = cam.worldToScreen(W * TILE, H * TILE);
    u.save();
    // faint tile grid helps aiming the brush
    if (cam.zoom >= 1) {
      u.strokeStyle = 'rgba(255,255,255,0.06)';
      u.lineWidth = 1;
      const step = TILE * cam.zoom;
      u.beginPath();
      for (let x = a.x; x <= b.x; x += step) if (x >= 0 && x <= cam.w) (u.moveTo(Math.round(x) + 0.5, Math.max(0, a.y)), u.lineTo(Math.round(x) + 0.5, Math.min(cam.h, b.y)));
      for (let y = a.y; y <= b.y; y += step) if (y >= 0 && y <= cam.h) (u.moveTo(Math.max(0, a.x), Math.round(y) + 0.5), u.lineTo(Math.min(cam.w, b.x), Math.round(y) + 0.5));
      u.stroke();
    }
    // the map's edge
    u.strokeStyle = 'rgba(255,207,110,0.9)';
    u.lineWidth = 2;
    u.setLineDash([6, 4]);
    u.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    u.setLineDash([]);
    // grab handles: corners and edge midpoints, like a window
    u.fillStyle = '#ffcf6e';
    const hs = 9;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    for (const [x, y] of [[a.x, a.y], [mx, a.y], [b.x, a.y], [b.x, my], [b.x, b.y], [mx, b.y], [a.x, b.y], [a.x, my]]) u.fillRect(x - hs / 2, y - hs / 2, hs, hs);
    // live resize preview
    if (e.resize) {
      const r = e.resize;
      const p0 = cam.worldToScreen(-r.dl * TILE, -r.dt * TILE), p1 = cam.worldToScreen((W + r.dr) * TILE, (H + r.db) * TILE);
      u.fillStyle = e.valid ? 'rgba(120,200,255,0.12)' : 'rgba(255,90,90,0.15)';
      u.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      u.strokeStyle = e.valid ? '#7cc8ff' : '#ff6b6b';
      u.lineWidth = 2;
      u.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      u.font = `bold 13px ${UI_FONT}`;
      u.textAlign = 'center';
      u.textBaseline = 'middle';
      const label = `${W + r.dl + r.dr} × ${H + r.dt + r.db}칸`;
      const lx = (p0.x + p1.x) / 2, ly = Math.max(16, Math.min(cam.h - 16, (p0.y + p1.y) / 2));
      u.fillStyle = 'rgba(0,0,0,0.65)';
      u.fillRect(lx - 52, ly - 12, 104, 24);
      u.fillStyle = e.valid ? '#e9d8b4' : '#ffb3b3';
      u.fillText(label, lx, ly);
    } else if (e.line && e.line.length) {
      // straight stroke preview: what will be painted on release
      const r0 = -Math.floor((e.size - 1) / 2);
      const s = e.size * TILE * cam.zoom;
      u.fillStyle = 'rgba(255,255,255,0.28)';
      u.strokeStyle = 'rgba(255,255,255,0.8)';
      u.lineWidth = 1;
      for (const t of e.line) {
        const q = cam.worldToScreen((t.tx + r0) * TILE, (t.ty + r0) * TILE);
        u.fillRect(q.x, q.y, s, s);
      }
      const f = e.line[0], l = e.line[e.line.length - 1];
      u.font = `bold 12px ${UI_FONT}`;
      const q = cam.worldToScreen((l.tx + 1) * TILE, l.ty * TILE);
      u.fillStyle = 'rgba(0,0,0,0.65)';
      u.fillRect(q.x + 6, q.y - 10, 54, 20);
      u.fillStyle = '#e9d8b4';
      u.textAlign = 'left';
      u.textBaseline = 'middle';
      u.fillText(`${Math.max(Math.abs(l.tx - f.tx), Math.abs(l.ty - f.ty)) + 1}칸`, q.x + 12, q.y);
    } else if (e.hover) {
      // brush footprint
      const r0 = -Math.floor((e.size - 1) / 2);
      const q = cam.worldToScreen((e.hover.tx + r0) * TILE, (e.hover.ty + r0) * TILE);
      const s = e.size * TILE * cam.zoom;
      u.strokeStyle = 'rgba(255,255,255,0.85)';
      u.lineWidth = 2;
      u.strokeRect(q.x, q.y, s, s);
    }
    u.restore();
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
      } else if (e.kind === 'rainbow') {
        const fade = Math.min(1, age / 4, (e.life - age) / 6) * 0.42;
        const cols = ['#ff5a5a', '#ffa64a', '#ffe14a', '#6ad46a', '#4ab0ff', '#6a6aff', '#b06aff'];
        ctx.lineWidth = 9;
        cols.forEach((c, i) => {
          ctx.strokeStyle = c;
          ctx.globalAlpha = fade;
          ctx.beginPath();
          ctx.arc(e.x, e.y + 260, 420 - i * 9, Math.PI * 1.08, Math.PI * 1.92);
          ctx.stroke();
        });
        ctx.globalAlpha = 1;
      } else if (e.kind === 'meteor') {
        const fade = Math.min(1, age / 2, (e.life - age) / 4);
        for (let i = 0; i < 7; i++) {
          const period = 2.2 + (i % 3) * 0.7;
          const ph = ((age + i * 0.83) % period) / period;
          if (ph > 0.45) continue;
          const sx = e.x - 420 + ((i * 197) % 840) + ph * 260;
          const sy = e.y - 200 + ((i * 113) % 220) + ph * 150;
          const g = ctx.createLinearGradient(sx, sy, sx - 60, sy - 35);
          g.addColorStop(0, `rgba(255,255,230,${0.95 * fade * (1 - ph * 2)})`);
          g.addColorStop(1, 'rgba(255,255,230,0)');
          ctx.strokeStyle = g;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx - 60, sy - 35);
          ctx.stroke();
        }
      } else if (e.kind === 'confetti') {
        const cols = ['#ff6b8a', '#ffd84a', '#6ad4ff', '#8aff8a', '#c08aff'];
        for (let i = 0; i < 26; i++) {
          const ang = i * 2.39996;
          const r = 10 + (i % 7) * 9 + k * 30;
          const fall = k * 40 + Math.sin(t * 3 + i) * 3;
          ctx.fillStyle = cols[i % cols.length];
          ctx.globalAlpha = 1 - k;
          ctx.fillRect(e.x + Math.cos(ang) * r, e.y - 40 + Math.sin(ang) * r * 0.5 + fall, 3, 2);
        }
        ctx.globalAlpha = 1;
      } else if (e.kind === 'notes') {
        // music notes drifting up and fading
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        for (let i = 0; i < 5; i++) {
          const ph = (k + i * 0.18) % 1;
          ctx.globalAlpha = Math.max(0, 1 - ph) * Math.min(1, (1 - k) * 3);
          ctx.fillStyle = ['#ffd84a', '#ff9ac0', '#9ad8ff', '#c8ff9a', '#ffffff'][i];
          ctx.fillText(i % 2 ? '♫' : '♪', e.x + Math.sin(t * 2 + i * 1.7) * 10 + (i - 2) * 6, e.y - ph * 34);
        }
        ctx.globalAlpha = 1;
      } else if (e.kind === 'stage') {
        // a soft pool of light on the stage (brighter after dark)
        const fade = Math.min(1, age / 1.5, (e.life - age) / 2);
        const pulse = 0.85 + Math.sin(t * 2.2) * 0.15;
        const g = ctx.createRadialGradient(e.x, e.y, 2, e.x, e.y, 46);
        g.addColorStop(0, `rgba(255,236,170,${0.38 * fade * pulse})`);
        g.addColorStop(1, 'rgba(255,236,170,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(e.x, e.y, 52, 30, 0, 0, Math.PI * 2);
        ctx.fill();
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
    const blackout = world.blackoutUntil > world.meta.minutes;
    if (blackout) dark = Math.max(dark * 1.35, 0.35);
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
    if (!blackout)
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const d = map.deco[map.idx(tx, ty)];
        if (d === D.Lamp) hole((tx + 0.5) * TILE, ty * TILE + 4, 120, 0.95);
        else if (d === D.Screen || d === D.Desk) hole((tx + 0.5) * TILE, (ty + 0.5) * TILE, 60, 0.7);
      }
    // building interiors glow softly at night
    for (const p of world.places) {
      if (p.style === 'park' || p.style === 'plaza' || blackout) continue;
      hole((p.tx + p.tw / 2) * TILE, (p.ty + p.th / 2) * TILE, Math.max(p.tw, p.th) * TILE * 0.6, 0.55);
    }
    lctx.globalCompositeOperation = 'source-over';
    this.ctx.drawImage(light, 0, 0);
    // warm lamp tint
    if (dark > 0.25 && !blackout) {
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
      // zoomed out: still shown, with smaller type and long lines shortened (the full line is in the story log)
      if (a.bubble) {
        const age = world.simTime - a.bubble.born;
        const k = age / a.bubble.life;
        ctx.globalAlpha = k > 0.85 ? (1 - k) / 0.15 : Math.min(1, age * 6);
        const sc = z >= 1 || isSel ? 1 : z >= 0.5 ? 0.86 : 0.74;
        this.bubble(a.bubble.text, head.x, head.y - (z >= 1 ? 6 : 3), !!a.bubble.thought, sc, !isSel && z < 0.5);
        ctx.globalAlpha = 1;
      }
    }
  }

  private placed: { x: number; y: number; w: number; h: number }[] = [];

  private bubble(text: string, x: number, y: number, thought: boolean, sc = 1, skipIfCrowded = false) {
    const ctx = this.uctx;
    x = Math.round(x);
    const fs = Math.max(8, Math.round(11 * sc * 2) / 2);
    ctx.font = `${fs}px ${UI_FONT}`;
    const lh = Math.round(fs * 1.36);
    if (sc < 1) {
      const max = sc >= 0.85 ? 48 : 26;
      if (text.length > max) text = text.slice(0, max - 1).replace(/s+S*$/, '') + '…';
    }
    const maxW = (text.length > 60 ? 250 : 170) * sc;
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
    const bw = Math.ceil(lw) + Math.round(14 * sc), bh = lines.length * lh + Math.round(8 * sc);
    const bx = Math.round(x - bw / 2);
    let by = Math.round(y - bh - 8);
    // stack upward while overlapping an already-drawn bubble
    for (let guard = 0; guard < 6; guard++) {
      const hit = this.placed.find((r) => bx < r.x + r.w && bx + bw > r.x && by < r.y + r.h && by + bh > r.y);
      if (!hit) break;
      // far out, a crowd would bury the map under bubbles: two levels of stacking at most
      if (skipIfCrowded && guard >= 2) return;
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
    lines.forEach((l, i) => ctx.fillText(l, x, by + Math.round(5 * sc) + i * lh));
  }
}
