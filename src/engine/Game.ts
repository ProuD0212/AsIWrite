// Game controller: owns World + Renderer + loop + input, and the single
// dispatch() entry point used by BOTH the chat bar and the GUI.

import type { CommandResult, GameCommand, TargetRef } from '../commands/schema';
import { sfx } from '../audio/sfx';
import { Camera, Renderer } from './render/Renderer';
import { renameSlot, serializeWorld, slotFor, writeSlot } from './save';
import { parseSheet } from './sheet';
import { PLACE_SIZES, TILE, type MapBrush } from './TileMap';
import { josa } from './traits';
import type { Agent, DoorSide, Place, PlaceStyle } from './types';
import { STYLE_LABEL, World, type PaintArea } from './World';
import { randomPlace } from '../presets/traitPools';

export type UIRequest = 'settings' | 'load' | 'quit' | 'help';

export interface PlacementTool {
  label: string;
  /** called with the clicked world position; returns the command to dispatch */
  build: (x: number, y: number, hit: Agent | Place | undefined) => GameCommand | null;
  /** instead of a command: do it directly (moving things) */
  run?: (x: number, y: number) => CommandResult;
  /** translucent preview under the cursor */
  ghost?: { kind: 'place'; style: PlaceStyle; name: string; ignoreId?: string } | { kind: 'agent'; layers: Agent['layers']; person: boolean };
}

export interface UndoEntry {
  label: string;
  undo: () => string | void;
}

export class Game {
  world: World;
  camera = new Camera();
  renderer: Renderer | null = null;
  canvas: HTMLCanvasElement | null = null;
  paused = false;
  speed = 1;
  /** absolute game minute to fast-forward to ("skip the night"), or null */
  skipTo: number | null = null;
  /** fast-forward automatically once every Will is asleep (settings; default on) */
  autoSkipNight = Game.readAutoSkip();
  /** night already auto-skipped (or the player cancelled it) — don't trigger twice */
  private skippedNight = -1;
  selectedId: string | null = null;
  tool: PlacementTool | null = null;
  /** map-edit mode: left-drag paints the brush, right-drag pans, drag the map's edges to resize */
  editMode = false;
  brush: MapBrush = 'road';
  brushSize = 1;
  /** brush strokes: straight line by default (Shift = any angle), or free painting */
  paintMode: 'line' | 'free' = 'line';
  /** tiles a straight stroke will paint when released (drawn as a preview) */
  linePreview: { tx: number; ty: number }[] | null = null;
  /** world position under the cursor (placement ghost) */
  hoverWorld: { x: number; y: number } | null = null;
  /** right-click on a Will / animal / building → the HUD shows a menu there */
  onContextMenu: (target: Agent | Place, screen: { x: number; y: number }) => void = () => {};
  /** UI moments the tutorial can check ("tab:traits", "contextmenu" …) */
  uiSeen = new Set<string>();
  noteUi(k: string) {
    this.uiSeen.add(k);
  }
  /** Ctrl+Z history (newest last) */
  undoStack: UndoEntry[] = [];
  /** while dragging a map edge: tiles added (+) / cut (−) per side, for the live preview */
  resizeDrag: { dl: number; dt: number; dr: number; db: number } | null = null;
  hoverTile: { tx: number; ty: number } | null = null;
  fps = 60;
  frameMs = 0;
  onUIRequest: (r: UIRequest) => void = () => {};
  /** set by the UI: hold time while e.g. a dialog is open (player setting) */
  holdTime: () => boolean = () => false;

  private raf = 0;
  private last = 0;
  private t = 0;
  private listeners = new Set<() => void>();
  private version = 0;
  private notifyAcc = 0;
  /** an inspector tab the UI should switch to (e.g. after talking to a Will from the chat bar) */
  requestTab: string | null = null;
  private keys = new Set<string>();
  private detach: (() => void) | null = null;

  constructor(world: World) {
    this.world = world;
    this.centerOnTown();
    world.onFeed((f) => {
      if (f.kind === 'care') sfx.care();
      if (f.kind === 'break') sfx.warn();
    });
  }

  setWorld(w: World) {
    if (this.world !== w) this.world.dispose();
    this.world = w;
    this.selectedId = null;
    this.camera.followId = null;
    this.centerOnTown();
    w.onFeed((f) => {
      if (f.kind === 'care') sfx.care();
      if (f.kind === 'break') sfx.warn();
    });
    this.notify(true);
  }

  centerOnTown() {
    this.camera.x = (this.world.map.roadCols[0] + 1) * TILE;
    this.camera.y = (this.world.map.roadRows[0] + 1) * TILE;
  }

  // ───────────── subscription for React (throttled) ─────────────
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  notify(force = false) {
    if (force) this.notifyAcc = 1;
    this.version++;
    for (const l of this.listeners) l();
  }

  // ───────────── lifecycle ─────────────
  attach(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas, this.camera);
    const resize = () => {
      const r = canvas.parentElement!.getBoundingClientRect();
      this.renderer!.resize(r.width, r.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);
    const offInput = this.bindInput(canvas);
    this.last = performance.now();
    const loop = (now: number) => {
      const dtReal = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.fps = this.fps * 0.93 + (1 / Math.max(dtReal, 0.001)) * 0.07;
      const t0 = performance.now();
      this.t += dtReal;
      this.panByKeys(dtReal);
      this.world.watchedId = this.selectedId;
      this.world.viewRect = this.camera.view();
      if (!this.paused && !this.holdTime()) {
        this.maybeAutoSkip();
        // fixed-ish substeps keep fast-forward stable
        const speedNow = this.skipTo !== null ? Game.SKIP_SPEED : this.speed;
        this.world.simSpeed = speedNow; // 3×+: no storyteller · 5×+: conversations summarised
        const total = dtReal * speedNow;
        const steps = Math.ceil(total / 0.05);
        for (let i = 0; i < steps; i++) {
          // big worlds at 10×/60×: never freeze a frame — run a bit slower than asked instead
          if (i > 0 && performance.now() - t0 > 25) break;
          this.world.update(total / steps);
          if (this.skipTo !== null && this.world.meta.minutes >= this.skipTo) {
            this.skipTo = null;
            this.toast({ ok: true, message: '☀️ 아침이 밝았어요. 원래 속도로 돌아왔어요.' });
            break;
          }
        }
      }
      this.followCamera(dtReal);
      this.camera.clampTo(this.world.map.w * TILE, this.world.map.h * TILE);
      if (this.renderer) {
        this.renderer.selectedId = this.selectedId;
        this.renderer.edit = this.editMode
          ? { resize: this.resizeDrag, hover: this.hoverTile, size: this.brushSize, valid: this.resizeDrag ? this.resizeValid(this.resizeDrag) : true, line: this.linePreview }
          : null;
        this.renderer.ghost = this.ghostView();
        this.renderer.render(this.world, this.t);
      }
      this.frameMs = this.frameMs * 0.9 + (performance.now() - t0) * 0.1;
      this.notifyAcc += dtReal;
      if (this.notifyAcc >= 0.2) {
        this.notifyAcc = 0;
        this.notify();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.detach = () => {
      cancelAnimationFrame(this.raf);
      ro.disconnect();
      offInput();
    };
  }

  dispose() {
    this.detach?.();
    this.detach = null;
    this.renderer?.dispose();
    this.renderer = null;
  }

  private followCamera(dt: number) {
    const id = this.camera.followId;
    if (!id) return;
    const a = this.world.agent(id);
    const p = a ? undefined : this.world.place(id);
    const tx = a ? a.x : p ? (p.tx + p.tw / 2) * TILE : null;
    const ty = a ? a.y - 16 : p ? (p.ty + p.th / 2) * TILE : null;
    if (tx === null || ty === null) {
      this.camera.followId = null;
      return;
    }
    const k = 1 - Math.exp(-dt * 5);
    this.camera.x += (tx - this.camera.x) * k;
    this.camera.y += (ty - this.camera.y) * k;
  }

  private panByKeys(dt: number) {
    if (!this.keys.size) return;
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 2.2 : 1;
    const sp = ((520 * fast) / this.camera.zoom) * dt;
    let moved = false;
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) (this.camera.y -= sp), (moved = true);
    if (k.has('KeyS') || k.has('ArrowDown')) (this.camera.y += sp), (moved = true);
    if (k.has('KeyA') || k.has('ArrowLeft')) (this.camera.x -= sp), (moved = true);
    if (k.has('KeyD') || k.has('ArrowRight')) (this.camera.x += sp), (moved = true);
    if (moved) this.camera.followId = null;
  }

  private bindInput(canvas: HTMLCanvasElement) {
    let down: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
    let longTimer: ReturnType<typeof setTimeout> | null = null;
    let trackpadAt = -1e9;
    const pos = (e: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    // ── map-edit mode: edge resize drag / brush painting ──
    let edgeDrag: { edges: { l: boolean; t: boolean; r: boolean; b: boolean }; sx: number; sy: number } | null = null;
    let painting: { start: { tx: number; ty: number }; last: { tx: number; ty: number }; end: { tx: number; ty: number } } | null = null;
    const tileAt = (p: { x: number; y: number }) => {
      const w = this.camera.screenToWorld(p.x, p.y);
      return { tx: Math.floor(w.x / TILE), ty: Math.floor(w.y / TILE) };
    };
    /** which map edges (if any) are under the pointer — 10px grab zone like a window border */
    const edgesAt = (p: { x: number; y: number }) => {
      const a = this.camera.worldToScreen(0, 0), b = this.camera.worldToScreen(this.world.map.w * TILE, this.world.map.h * TILE);
      const tol = 10;
      const inY = p.y > a.y - tol && p.y < b.y + tol, inX = p.x > a.x - tol && p.x < b.x + tol;
      const e = { l: inY && Math.abs(p.x - a.x) < tol, r: inY && Math.abs(p.x - b.x) < tol, t: inX && Math.abs(p.y - a.y) < tol, b: inX && Math.abs(p.y - b.y) < tol };
      return e.l || e.r || e.t || e.b ? e : null;
    };
    const edgeCursor = (e: { l: boolean; t: boolean; r: boolean; b: boolean }) =>
      (e.l && e.t) || (e.r && e.b) ? 'nwse-resize' : (e.r && e.t) || (e.l && e.b) ? 'nesw-resize' : e.l || e.r ? 'ew-resize' : 'ns-resize';
    /** paint every tile on the line between two tiles, so a fast drag leaves no gaps */
    const paintLine = (from: { tx: number; ty: number }, to: { tx: number; ty: number }) => {
      const n = Math.max(Math.abs(to.tx - from.tx), Math.abs(to.ty - from.ty), 1);
      let changed = 0;
      for (let k = 0; k <= n; k++) {
        const tx = Math.round(from.tx + ((to.tx - from.tx) * k) / n), ty = Math.round(from.ty + ((to.ty - from.ty) * k) / n);
        changed += this.world.paintMap(tx, ty, this.brush, this.brushSize);
      }
      if (changed) sfx.tick();
    };

    const onDown = (e: PointerEvent) => {
      const p = pos(e);
      // the "town is that way" arrow
      const ha = this.renderer?.homeArrow;
      if (ha && e.button === 0 && Math.hypot(p.x - ha.x, p.y - ha.y) < 30) {
        this.camera.followId = null;
        this.centerOnTown();
        this.notify(true);
        return;
      }
      if (this.editMode && e.button === 0) {
        const edges = edgesAt(p);
        if (edges) {
          edgeDrag = { edges, sx: p.x, sy: p.y };
          this.resizeDrag = { dl: 0, dt: 0, dr: 0, db: 0 };
        } else {
          const t = tileAt(p);
          painting = { start: t, last: t, end: t };
          this.world.map.journal = new Map();
          if (this.paintMode === 'free') paintLine(t, t);
          else this.linePreview = [t];
        }
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      // right-click on someone/something (outside edit mode): a context menu — Ctrl/⌥ + click does the same on laptops
      const menuClick = e.button === 2 || (e.button === 0 && (e.ctrlKey || e.altKey));
      if (menuClick && !this.editMode && !this.tool) {
        const w = this.camera.screenToWorld(p.x, p.y);
        const hit: Agent | Place | undefined = this.world.agentsAt(w.x, w.y, 20) ?? this.world.placeAt(w.x, w.y);
        if (hit) {
          this.select(hit.id);
          this.onContextMenu(hit, { x: e.clientX, y: e.clientY });
          return;
        }
      }
      // right button pans in edit mode (left is the brush); otherwise left/middle pan as before
      if (e.button !== 0 && e.button !== 1 && !(this.editMode && e.button === 2)) return;
      down = { x: p.x, y: p.y, cx: this.camera.x, cy: this.camera.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
      // press and hold (touchpads, tablets): the right-click menu
      if (longTimer) clearTimeout(longTimer);
      if (e.button === 0 && !this.editMode && !this.tool) {
        const at = { x: e.clientX, y: e.clientY }, sp = { x: p.x, y: p.y };
        longTimer = setTimeout(() => {
          longTimer = null;
          if (!down || down.moved) return;
          const w = this.camera.screenToWorld(sp.x, sp.y);
          const hit: Agent | Place | undefined = this.world.agentsAt(w.x, w.y, 20) ?? this.world.placeAt(w.x, w.y);
          if (!hit) return;
          down = null; // the release won't count as a click
          this.select(hit.id);
          this.onContextMenu(hit, at);
        }, 450);
      }
    };
    const onMove = (e: PointerEvent) => {
      const p = pos(e);
      if (edgeDrag) {
        const d = edgeDrag;
        const dx = Math.round((p.x - d.sx) / this.camera.zoom / TILE), dy = Math.round((p.y - d.sy) / this.camera.zoom / TILE);
        this.resizeDrag = { dl: d.edges.l ? -dx : 0, dr: d.edges.r ? dx : 0, dt: d.edges.t ? -dy : 0, db: d.edges.b ? dy : 0 };
        return;
      }
      if (painting) {
        const t = tileAt(p);
        if (this.paintMode === 'free') {
          if (t.tx !== painting.last.tx || t.ty !== painting.last.ty) {
            paintLine(painting.last, t);
            painting.last = t;
          }
        } else {
          // straight road: snap to the main axis (hold Shift for any angle)
          const s = painting.start;
          const end = e.shiftKey ? t : Math.abs(t.tx - s.tx) >= Math.abs(t.ty - s.ty) ? { tx: t.tx, ty: s.ty } : { tx: s.tx, ty: t.ty };
          painting.end = end;
          const n = Math.max(Math.abs(end.tx - s.tx), Math.abs(end.ty - s.ty), 1);
          const line: { tx: number; ty: number }[] = [];
          for (let k = 0; k <= n; k++) line.push({ tx: Math.round(s.tx + ((end.tx - s.tx) * k) / n), ty: Math.round(s.ty + ((end.ty - s.ty) * k) / n) });
          this.linePreview = line;
        }
        this.hoverTile = t;
        return;
      }
      this.hoverWorld = this.camera.screenToWorld(p.x, p.y);
      if (this.editMode && !down) {
        const edges = edgesAt(p);
        this.hoverTile = edges ? null : tileAt(p);
        canvas.style.cursor = edges ? edgeCursor(edges) : 'crosshair';
        return;
      }
      if (down) {
        const dx = p.x - down.x, dy = p.y - down.y;
        if (!down.moved && Math.hypot(dx, dy) > 5) {
          down.moved = true;
          if (longTimer) clearTimeout(longTimer), (longTimer = null);
        }
        if (down.moved) {
          this.camera.followId = null;
          this.camera.x = down.cx - dx / this.camera.zoom;
          this.camera.y = down.cy - dy / this.camera.zoom;
          canvas.style.cursor = 'grabbing';
        }
      } else if (this.renderer) {
        const w = this.camera.screenToWorld(p.x, p.y);
        const a = this.world.agentsAt(w.x, w.y, 20);
        this.renderer.hoverId = a?.id ?? null;
        canvas.style.cursor = this.tool ? 'crosshair' : a ? 'pointer' : 'grab';
      }
    };
    const onUp = (e: PointerEvent) => {
      if (edgeDrag) {
        const r = this.resizeDrag ?? { dl: 0, dt: 0, dr: 0, db: 0 };
        edgeDrag = null;
        this.resizeDrag = null;
        if (r.dl || r.dt || r.dr || r.db) {
          const before = { tiles: this.world.map.encodeTiles(), rows: [...this.world.map.roadRows] as [number, number], cols: [...this.world.map.roadCols] as [number, number] };
          const res = this.world.resizeMap(r.dl, r.dt, r.dr, r.db);
          if (res.ok) {
            this.pushUndo({
              label: '세계 크기 조절',
              undo: () => {
                const back = this.world.resizeMap(-r.dl, -r.dt, -r.dr, -r.db);
                if (!back.ok) return `되돌리지 못했어요: ${back.message}`;
                this.world.map.applyTiles(before.tiles);
                this.world.map.roadRows = before.rows;
                this.world.map.roadCols = before.cols;
                this.camera.x -= r.dl * TILE;
                this.camera.y -= r.dt * TILE;
              },
            });
            // the world moved under the camera when the left/top edge changed — keep the view still
            this.camera.x += r.dl * TILE;
            this.camera.y += r.dt * TILE;
            sfx.submit();
          } else sfx.error();
          this.toast(res);
        }
        this.notify(true);
        return;
      }
      if (painting) {
        if (this.paintMode === 'line') paintLine(painting.start, painting.end);
        painting = null;
        this.linePreview = null;
        const saved = this.world.map.journal;
        this.world.map.journal = null;
        if (saved && saved.size) {
          const map = this.world.map;
          this.pushUndo({ label: '맵 칠하기', undo: () => map.restoreTiles(saved) });
        }
        this.notify(true);
        return;
      }
      if (longTimer) clearTimeout(longTimer), (longTimer = null);
      if (!down) return;
      const wasDrag = down.moved;
      down = null;
      canvas.style.cursor = this.tool ? 'crosshair' : 'grab';
      if (wasDrag) return;
      const p = pos(e);
      const w = this.camera.screenToWorld(p.x, p.y);
      const hit: Agent | Place | undefined = this.world.agentsAt(w.x, w.y, 20) ?? this.world.placeAt(w.x, w.y);
      if (this.tool?.run) {
        const r = this.tool.run(w.x, w.y);
        if (!e.shiftKey || !r.ok) this.tool = r.ok ? null : this.tool;
        this.toast(r);
        this.notify(true);
        return;
      }
      if (this.tool) {
        const cmd = this.tool.build(w.x, w.y, hit);
        if (!e.shiftKey) this.tool = null;
        if (cmd) {
          const r = this.dispatch(cmd);
          this.toast(r);
        }
        this.notify(true);
        return;
      }
      // several Wills under the cursor: each click on the same spot picks the next one
      const crowd = this.world.agentsAtAll(w.x, w.y, 20);
      if (crowd.length > 1 && this.selectedId) {
        const i = crowd.findIndex((a) => a.id === this.selectedId);
        if (i >= 0) return this.select(crowd[(i + 1) % crowd.length].id);
      }
      this.select(hit?.id ?? null);
    };
    // zoom moves in pixel-perfect steps; accumulate trackpad deltas into steps
    let wheelAcc = 0;
    let wheelT = 0;
    let zoomCooldown = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 30 : 1;
      // Shift + wheel: slow, continuous zoom (browsers often turn Shift+wheel into deltaX, so take either)
      if (e.shiftKey && !e.ctrlKey) {
        const d = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * unit;
        const p = pos(e);
        this.camera.zoomSmooth(p.x, p.y, Math.exp(-d * 0.0005));
        return;
      }
      // pinch on a touchpad arrives as Ctrl + wheel: smooth zoom (and keep the browser from zooming the page)
      if (e.ctrlKey) {
        const p = pos(e);
        this.camera.zoomSmooth(p.x, p.y, Math.exp(-e.deltaY * unit * 0.01));
        return;
      }
      // two-finger scrolling on a touchpad (small/fractional deltas or any sideways part) pans the map
      const now0 = performance.now();
      if (e.deltaMode === 0 && (e.deltaX !== 0 || !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 40)) trackpadAt = now0;
      const scroll = this.scrollMode === 'auto' ? (now0 - trackpadAt < 800 ? 'pan' : 'zoom') : this.scrollMode;
      if (scroll === 'pan') {
        this.camera.x += (e.deltaX * unit) / this.camera.zoom;
        this.camera.y += (e.deltaY * unit) / this.camera.zoom;
        this.camera.followId = null;
        return;
      }
      // sideways: a two-finger trackpad swipe (deltaX) pans instead of zooming
      const side = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
      if (side) {
        this.camera.x += (side * unit) / this.camera.zoom;
        this.camera.followId = null; // panning by hand stops following, like dragging does
        return;
      }
      const now = performance.now();
      // calmer zoom: a bigger push per step and a short pause after each step, so a trackpad
      // flick (dozens of events) moves one or two steps instead of all the way
      if (now - wheelT > 300) wheelAcc = 0;
      wheelT = now;
      if (now < zoomCooldown) return;
      wheelAcc += e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      if (Math.abs(wheelAcc) < 150) return;
      const p = pos(e);
      this.camera.zoomAt(p.x, p.y, wheelAcc < 0 ? 2 : 0.5);
      wheelAcc = 0;
      zoomCooldown = now + 140;
    };
    // Physical-key (e.code) camera controls so they work with the Korean IME on.
    // Every other shortcut lives in ui/shortcuts.ts (handled by the HUD).
    const PAN = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.type === 'keyup') {
        this.keys.delete(e.code);
        return;
      }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[data-modal-open]')) return;
      if (PAN.has(e.code)) {
        this.keys.add(e.code);
        if (e.code.startsWith('Arrow')) e.preventDefault();
      }
      const cx = this.camera.w / 2, cy = this.camera.h / 2;
      if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'PageUp') {
        e.preventDefault();
        this.camera.zoomAt(cx, cy, 1.15);
      }
      if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.code === 'PageDown') {
        e.preventDefault();
        this.camera.zoomAt(cx, cy, 1 / 1.15);
      }
    };
    const onBlur = () => this.keys.clear();
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    // edit mode pans with the right button — keep the browser menu out of the way
    const onContext = (e: MouseEvent) => e.preventDefault(); // right button = our menu / panning
    canvas.addEventListener('contextmenu', onContext);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }

  select(id: string | null) {
    this.selectedId = id;
    if (id) sfx.select();
    this.notify(true);
  }

  focus(id: string) {
    this.selectedId = id;
    this.camera.followId = id;
    this.notify(true);
  }

  // ───────────── speed · skipping the night ─────────────
  static readonly SPEEDS = [1, 2, 3, 5, 10];
  /** night fast-forward: 23:00 → 6:30 (450 game minutes) takes about 7–8 real seconds */
  static readonly SKIP_SPEED = 60;
  static readonly AUTO_SKIP_KEY = 'asiwrite.autoSkipNight';
  static readAutoSkip(): boolean {
    try {
      return localStorage.getItem(Game.AUTO_SKIP_KEY) !== '0';
    } catch {
      return true;
    }
  }
  // ───────────── undo (Ctrl+Z) ─────────────
  pushUndo(e: UndoEntry) {
    this.undoStack.push(e);
    if (this.undoStack.length > 60) this.undoStack.shift();
  }
  undo(): CommandResult {
    const e = this.undoStack.pop();
    if (!e) return { ok: false, message: '되돌릴 작업이 없어요.' };
    const msg = e.undo();
    this.notify(true);
    return msg ? { ok: false, message: msg } : { ok: true, message: `↩️ 되돌렸어요: ${e.label}` };
  }
  /**
   * Before a command runs, capture what's needed to take it back. Happenings (lightning,
   * festivals, rumors…) are not undoable — they already happened in the Wills' lives.
   */
  private prepareUndo(cmd: GameCommand): (() => UndoEntry | null) | null {
    const w = this.world;
    switch (cmd.type) {
      case 'SPAWN_ENTITY': {
        const before = new Set([...w.agents.map((a) => a.id), ...w.places.map((p) => p.id)]);
        return () => {
          const made = [...w.agents.map((a) => a.id), ...w.places.map((p) => p.id)].filter((id) => !before.has(id));
          return made.length ? { label: '소환', undo: () => void made.forEach((id) => w.removeEntity(id)) } : null;
        };
      }
      case 'DELETE_ENTITY': {
        const e = this.resolve(cmd.target);
        if (!e) return null;
        if (e.kind === 'place') {
          const snap = w.snapshotPlace(e);
          return () => ({ label: `${e.name} 삭제`, undo: () => (w.restorePlace(snap) ? undefined : '그 자리에 다른 것이 있어 되살리지 못했어요.') });
        }
        const snap = w.snapshotAgent(e);
        return () => ({ label: `${e.name} 삭제`, undo: () => void w.restoreAgent(snap) });
      }
      case 'MODIFY_ENTITY': {
        const e = this.resolve(cmd.target);
        if (!e) return null;
        if (e.kind === 'place') {
          const old = { name: e.name, appearance: e.appearance, traits: [...e.traits] };
          return () => ({ label: `${old.name} 수정`, undo: () => void (Object.assign(e, old), w.invalidateFavor(e.id)) });
        }
        const sheet = w.sheetOf(e), jobId = e.jobId, workPin = e.workPin;
        return () => ({
          label: `${e.name} 수정`,
          undo: () => {
            w.updateAgent(e, parseSheet(sheet).sheet);
            e.jobId = jobId;
            e.workPin = workPin;
          },
        });
      }
      case 'SET_WEATHER': {
        const prev = w.meta.weather;
        return () => ({ label: '날씨 바꾸기', undo: () => w.setWeather(prev) });
      }
      case 'SET_WORLD_CONTEXT': {
        const prev = w.meta.context;
        return () => ({ label: '세계관 바꾸기', undo: () => void w.setContext(prev) });
      }
      case 'GROUP': {
        const snap = JSON.parse(JSON.stringify(w.factions));
        return () => ({ label: '그룹 변경', undo: () => void (w.factions = snap) });
      }
      case 'SYSTEM':
        if (cmd.action === 'EXPAND') {
          const tiles = w.map.encodeTiles();
          return () => ({ label: '세계 넓히기', undo: () => (w.resizeMap(0, 0, -24, -16).ok ? void w.map.applyTiles(tiles) : '넓힌 땅에 건물이 있어 되돌리지 못했어요.') });
        }
        return null;
      case 'PAINT_MAP': {
        w.map.journal = new Map();
        return () => {
          const saved = w.map.journal;
          w.map.journal = null;
          return saved && saved.size ? { label: '맵 칠하기', undo: () => void w.map.restoreTiles(saved) } : null;
        };
      }
      case 'RESIZE_MAP': {
        const tiles = w.map.encodeTiles();
        const { left = 0, top = 0, right = 0, bottom = 0 } = cmd;
        return () => ({ label: '맵 크기 바꾸기', undo: () => (w.resizeMap(-left, -top, -right, -bottom).ok ? void w.map.applyTiles(tiles) : '바뀐 땅에 건물이 있어 되돌리지 못했어요.') });
      }
      default:
        return null;
    }
  }

  /** top-left tile so a building of this style is centred on (x, y) — same as the placement ghost */
  static topLeftFor(style: PlaceStyle, x: number, y: number, turned = false) {
    const [tw0, th0] = PLACE_SIZES[style];
    const [tw, th] = turned ? [th0, tw0] : [tw0, th0];
    return { tx: Math.floor(x / TILE) - Math.floor(tw / 2), ty: Math.floor(y / TILE) - Math.floor(th / 2) };
  }
  /** what scrolling does: auto (touchpad → move the map, mouse wheel → zoom), or always one of them */
  scrollMode: 'auto' | 'pan' | 'zoom' = (() => {
    try {
      const v = localStorage.getItem('asiwrite.scrollMode');
      return v === 'pan' || v === 'zoom' ? v : 'auto';
    } catch {
      return 'auto';
    }
  })();
  setScrollMode(m: 'auto' | 'pan' | 'zoom') {
    this.scrollMode = m;
    try {
      localStorage.setItem('asiwrite.scrollMode', m);
    } catch {
      /* ignore */
    }
  }
  /** keyboard "." / menu key: the right-click menu for whatever is selected, at its spot on screen */
  openMenuForSelected(): boolean {
    const e = this.world.agent(this.selectedId ?? undefined) ?? this.world.place(this.selectedId ?? undefined);
    if (!e || !this.renderer) return false;
    const wx = e.kind === 'place' ? (e.tx + e.tw / 2) * TILE : e.x, wy = e.kind === 'place' ? (e.ty + e.th / 2) * TILE : e.y;
    const s = this.camera.worldToScreen(wx, wy);
    const r = this.renderer.canvasRect();
    this.onContextMenu(e, { x: r.left + s.x, y: r.top + s.y });
    return true;
  }
  /** the door the player turned the ghost to with R (null = automatic: facing the nearest street) */
  placeDoor: DoorSide | null = null;
  private ghostDoor(style: PlaceStyle, x: number, y: number, moving?: Place): DoorSide {
    if (this.placeDoor) return this.placeDoor;
    if (moving) return this.world.doorSideOf(moving);
    const tl = Game.topLeftFor(style, x, y);
    return this.world.doorSideAt(tl.tx, tl.ty, PLACE_SIZES[style][0]);
  }
  /** R while placing or moving a building: turn it 90° clockwise (door bottom → left → top → right) */
  rotatePlacement(): boolean {
    const g = this.tool?.ghost;
    if (!g || g.kind !== 'place') return false;
    const w = this.hoverWorld ?? { x: this.camera.x, y: this.camera.y };
    const cur = this.ghostDoor(g.style, w.x, w.y, g.ignoreId ? this.world.place(g.ignoreId) : undefined);
    const order: DoorSide[] = ['bottom', 'left', 'top', 'right'];
    this.placeDoor = order[(order.indexOf(cur) + 1) % 4];
    this.notify(true);
    return true;
  }
  /** What the placement ghost looks like right now (or null). */
  private ghostView(): Renderer['ghost'] {
    const g = this.tool?.ghost;
    if (g?.kind !== 'place') this.placeDoor = null; // the turn only lasts while placing
    if (!g || !this.hoverWorld) return null;
    const { x, y } = this.hoverWorld;
    if (g.kind === 'place') {
      const ignore = g.ignoreId ? this.world.place(g.ignoreId) : undefined;
      const door = this.ghostDoor(g.style, x, y, ignore);
      const turned = door === 'left' || door === 'right';
      const tl = Game.topLeftFor(g.style, x, y, turned);
      const [tw0, th0] = PLACE_SIZES[g.style];
      const [tw, th] = turned ? [th0, tw0] : [tw0, th0];
      return { kind: 'place', tx: tl.tx, ty: tl.ty, tw, th, ok: this.world.canBuildAt(g.style, tl.tx, tl.ty, ignore, turned), label: `${g.name} · R 회전`, door };
    }
    return { kind: 'agent', x, y, layers: g.layers, person: g.person };
  }
  /** Pick something up and put it down with the next click (buildings show a ghost of their footprint). */
  startMove(e: Agent | Place) {
    if (e.kind === 'place') {
      const from = { tx: e.tx, ty: e.ty };
      this.tool = {
        label: `🏗️ ${e.name} — 옮길 곳을 클릭하세요 (Esc 취소)`,
        ghost: { kind: 'place', style: e.style, name: e.name, ignoreId: e.id },
        build: () => null,
        run: (x, y) => {
          const fromDoor = this.world.doorSideOf(e);
          const door = this.placeDoor ?? fromDoor;
          const tl = Game.topLeftFor(e.style, x, y, door === 'left' || door === 'right');
          const r = this.world.movePlace(e, tl.tx, tl.ty, door);
          if (r.ok) this.pushUndo({ label: `${e.name} 이동`, undo: () => (this.world.movePlace(e, from.tx, from.ty, fromDoor).ok ? undefined : '원래 자리가 막혀 되돌리지 못했어요.') });
          return r;
        },
      };
    } else {
      const from = { x: e.x, y: e.y };
      this.tool = {
        label: `${e.name} — 옮길 곳을 클릭하세요 (Esc 취소)`,
        ghost: { kind: 'agent', layers: e.layers, person: e.kind === 'person' },
        build: () => null,
        run: (x, y) => {
          this.world.teleport(e, x, y);
          this.pushUndo({ label: `${e.name} 이동`, undo: () => this.world.teleport(e, from.x, from.y) });
          return { ok: true, message: `${josa(e.name, '을/를')} 옮겼어요.` };
        },
      };
    }
    this.notify(true);
  }
  /** zoom out so the whole map is on screen */
  fitView() {
    this.camera.fit(this.world.map.w * TILE, this.world.map.h * TILE);
    this.notify(true);
  }

  // ───────────── map editing ─────────────
  setEditMode(on: boolean) {
    this.editMode = on;
    this.tool = null;
    this.resizeDrag = null;
    this.hoverTile = null;
    if (this.canvas) this.canvas.style.cursor = on ? 'crosshair' : 'grab';
    this.notify(true);
  }
  /** would this resize preview be accepted? (size limits, no building cut) — drawn red if not */
  resizeValid(r: { dl: number; dt: number; dr: number; db: number }) {
    const W = this.world.map.w + r.dl + r.dr, H = this.world.map.h + r.dt + r.db;
    if (W < World.MAP_MIN.w || H < World.MAP_MIN.h || W > World.MAP_MAX.w || H > World.MAP_MAX.h) return false;
    return this.world.places.every((p) => p.tx + r.dl >= 1 && p.ty + r.dt >= 1 && p.tx + r.dl + p.tw <= W - 1 && p.ty + r.dt + p.th <= H - 1);
  }

  setAutoSkip(on: boolean) {
    this.autoSkipNight = on;
    try {
      localStorage.setItem(Game.AUTO_SKIP_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }
  /** the night that `minutes` belongs to: 23:00 and the following 6:00 share one key */
  private static nightKey(minutes: number) {
    return Math.floor((minutes + 60) / 1440);
  }
  /** next 6:30 after now */
  private nextMorning() {
    const m = this.world.meta.minutes;
    let target = Math.floor(m / 1440) * 1440 + 390;
    if (m >= target) target += 1440;
    return target;
  }
  /** fast-forward to the next morning; returns false when it's already daytime work hours */
  skipNight(): boolean {
    const h = (this.world.meta.minutes % 1440) / 60;
    if (h >= 6.5 && h < 18) return false; // nothing to skip in broad daylight
    this.skipTo = this.nextMorning();
    this.skippedNight = Game.nightKey(this.world.meta.minutes);
    this.paused = false;
    return true;
  }
  cancelSkip() {
    if (this.skipTo === null) return;
    this.skipTo = null;
    this.skippedNight = Game.nightKey(this.world.meta.minutes); // the player chose to watch this night
  }
  private maybeAutoSkip() {
    if (!this.autoSkipNight || this.skipTo !== null || !this.world.isNight()) return;
    const key = Game.nightKey(this.world.meta.minutes);
    if (key === this.skippedNight) return;
    const wills = this.world.agents.filter((a) => a.kind === 'person');
    // asleep — or quietly on a night shift (owls at the 24h store, the bar …); anyone else still up = keep watching
    if (!wills.length || !wills.every((a) => a.ai.sleeping || a.ai.working)) return;
    this.skipNight();
    this.toast({ ok: true, message: '🌙 깨어 있는 윌이 없어요 — 아침까지 빨리 감는 중… (Space나 숫자 키로 멈춤)' });
  }

  // toast hook (set by UI)
  toast: (r: CommandResult) => void = () => {};

  // ───────────── the ONE dispatcher ─────────────
  resolve(ref: TargetRef | undefined): Agent | Place | undefined {
    if (!ref) return undefined;
    if (ref.id) return this.world.agent(ref.id) ?? this.world.place(ref.id);
    if (ref.selected) return this.selectedId ? this.world.agent(this.selectedId) ?? this.world.place(this.selectedId) : undefined;
    if (ref.name) return this.world.findByName(ref.name);
    return undefined;
  }

  private posNear(e: Agent | Place): { x: number; y: number } {
    if (e.kind === 'place') {
      const inn = this.world.inwardOf(e);
      // just outside the door
      return { x: (e.door.tx + 0.5) * TILE - inn.dx * 20 + (inn.dx ? 0 : (Math.random() - 0.5) * 40), y: (e.door.ty + 0.5) * TILE - inn.dy * 20 + (inn.dy ? 0 : (Math.random() - 0.5) * 40) };
    }
    return { x: e.x + (Math.random() < 0.5 ? -26 : 26), y: e.y + (Math.random() - 0.5) * 16 };
  }

  dispatch(cmd: GameCommand): CommandResult {
    const w = this.world;
    const prepared = this.prepareUndo(cmd);
    const r = this.exec(cmd, w);
    if (r.ok && prepared) {
      const entry = prepared();
      if (entry) this.pushUndo(entry);
    }
    if (r.ok && cmd.type !== 'SYSTEM') w.pushFeed({ kind: 'system', text: r.message });
    this.notify(true);
    return r;
  }

  private exec(cmd: GameCommand, w: World): CommandResult {
    switch (cmd.type) {
      case 'SPAWN_ENTITY': {
        const spec = cmd.entity;
        const nearE = cmd.at?.near ? this.resolve(cmd.at.near) : undefined;
        if (cmd.at?.near && !nearE && !cmd.at.near.selected) {
          // unknown anchor: still spawn, near camera center
        }
        const count = Math.max(1, Math.min(5, cmd.count ?? 1));
        let first: Agent | Place | null = null;
        for (let i = 0; i < count; i++) {
          let pos = cmd.at?.x !== undefined && cmd.at?.y !== undefined ? { x: cmd.at.x, y: cmd.at.y } : nearE ? this.posNear(nearE) : { x: this.camera.x + (Math.random() - 0.5) * 120, y: this.camera.y + (Math.random() - 0.5) * 120 };
          if (i > 0) pos = { x: pos.x + (Math.random() - 0.5) * 50, y: pos.y + (Math.random() - 0.5) * 30 };
          if (spec.kind === 'place') {
            const style: PlaceStyle = spec.style ?? 'cafe';
            // no name given (e.g. "식당 하나 지어 줘"): a name that fits the world instead of "새 식당"
            const auto = randomPlace(style, Math.floor(Math.random() * 1e9), w.meta.context);
            // a bare facility word ("노래방 지어 줘" → "노래방") isn't a name either
            const given = spec.name?.trim() && spec.name.trim() !== STYLE_LABEL[style] && !/^새 /.test(spec.name.trim()) ? spec.name.trim() : '';
            const preset = { name: given || auto.name, style, appearance: spec.appearance || auto.appearance, traits: spec.traits?.length ? spec.traits : auto.traits };
            const door = cmd.at?.door ?? (cmd.at?.x !== undefined && this.tool?.ghost?.kind === 'place' ? this.placeDoor ?? undefined : undefined);
            const tl = Game.topLeftFor(style, pos.x, pos.y, door === 'left' || door === 'right');
            const exact = cmd.at?.x !== undefined ? w.addPlaceAt(preset, tl.tx, tl.ty, door) : null;
            const p = exact ?? w.addPlace(preset, { tx: Math.floor(pos.x / TILE), ty: Math.floor(pos.y / TILE) });
            if (!p) return { ok: false, message: '건물을 지을 빈 땅이 부족해요. 다른 건물을 지우거나 다른 곳을 골라 주세요.' };
            first ??= p;
          } else if (spec.sheet) {
            const parsed = parseSheet(spec.sheet);
            const traits = parsed.sheet.traits.length ? parsed.sheet.traits : undefined;
            const a = w.spawnRandomized({ kind: parsed.kind, name: parsed.sheet.name, category: parsed.sheet.category, appearance: parsed.sheet.appearance, traits, mood: parsed.sheet.mood, job: parsed.sheet.job, treasure: parsed.sheet.treasure }, pos.x, pos.y);
            first ??= a;
          } else {
            const a = w.spawnRandomized({ kind: spec.kind, name: spec.name, category: spec.category, appearance: spec.appearance, traits: spec.traits, mood: spec.mood, job: spec.job }, pos.x, pos.y);
            first ??= a;
          }
        }
        sfx.spawn();
        if (!first) return { ok: false, message: '소환에 실패했어요.' };
        this.selectedId = first.id;
        if (first.kind === 'place') this.camera.followId = first.id;
        const where = nearE ? ` (${nearE.name} 근처)` : '';
        const born = first.kind === 'person' ? `새로운 윌, ${josa(first.name, '이/가')} 태어났어요` : `${josa(first.name, '이/가')} 나타났어요`;
        return { ok: true, message: `✨ ${born}${count > 1 ? ` (외 ${count - 1})` : ''}${where}.`, focusId: first.id };
      }
      case 'MODIFY_ENTITY': {
        const e = this.resolve(cmd.target);
        if (!e) return { ok: false, message: `"${cmd.target.name ?? '선택한 대상'}"을(를) 찾지 못했어요.` };
        const ch = cmd.changes;
        if (e.kind === 'place') {
          if (ch.name) e.name = ch.name;
          if (ch.appearance) e.appearance = ch.appearance;
          if (ch.traits) e.traits = ch.traits;
          if (ch.addTraits) e.traits.push(...ch.addTraits);
          if (ch.removeTraits) e.traits = e.traits.filter((t) => !ch.removeTraits!.includes(t));
          w.invalidateFavor(e.id);
          return { ok: true, message: `${e.name} 정보를 고쳤어요.`, focusId: e.id };
        }
        if (ch.sheet) {
          const { sheet, kind } = parseSheet(ch.sheet);
          if (kind !== e.kind) e.kind = kind;
          w.updateAgent(e, sheet);
          w.log(e, 'mutation', '신의 손길로 존재가 새로 쓰였다.');
          return { ok: true, message: `📝 ${e.name}의 양식을 적용했어요.`, focusId: e.id };
        }
        if (ch.workplace !== undefined) {
          if (ch.workplace === null) {
            w.setJob(e, 'none');
            return { ok: true, message: `${josa(e.name, '이/가')} 당분간 일을 쉬어요.`, focusId: e.id };
          }
          if (ch.workplace.id === 'free') {
            w.setJob(e, undefined);
            return { ok: true, message: `💼 ${josa(e.name, '이/가')} 그날그날 일할 곳을 골라요 (프리랜서).`, focusId: e.id };
          }
          const p = this.resolve(ch.workplace);
          if (!p || p.kind !== 'place') return { ok: false, message: `일할 곳 "${ch.workplace.name ?? ''}"을(를) 찾지 못했어요.` };
          w.setJob(e, p);
          return { ok: true, message: `💼 ${josa(e.name, '이/가')} 이제 ${p.name}에서 일해요.`, focusId: e.id };
        }
        const traits = ch.traits ?? [...e.traits.filter((t) => !(ch.removeTraits ?? []).includes(t)), ...(ch.addTraits ?? [])];
        w.updateAgent(e, { name: ch.name, category: ch.category, appearance: ch.appearance, traits, mood: ch.mood, job: ch.job, treasure: ch.treasure });
        if (ch.addTraits?.length) w.log(e, 'mutation', `새로운 성향이 생겼다: "${ch.addTraits.join('", "')}"`);
        return { ok: true, message: `${e.name}에게 변화가 생겼어요.`, focusId: e.id };
      }
      case 'DELETE_ENTITY': {
        const e = this.resolve(cmd.target);
        if (!e) return { ok: false, message: `"${cmd.target.name ?? '선택한 대상'}"을(를) 찾지 못했어요.` };
        w.removeEntity(e.id);
        if (this.selectedId === e.id) this.selectedId = null;
        return { ok: true, message: `${josa(e.name, '이/가')} 세상에서 사라졌어요.` };
      }
      case 'PAINT_MAP': {
        const find = (ref: TargetRef | undefined) => (ref ? this.resolve(ref) : undefined);
        const a = cmd.area;
        let area: PaintArea;
        if (a.kind === 'around') {
          const t = find(a.target);
          if (!t) return (w.map.journal = null), { ok: false, message: `「${'name' in a.target ? a.target.name : '선택한 대상'}」을 찾지 못했어요.` };
          area = { kind: 'around', target: t, radius: a.radius };
        } else if (a.kind === 'path') {
          const to = find(a.to), from = find(a.from);
          if (!to || (a.from && !from)) return (w.map.journal = null), { ok: false, message: `「${[a.from, a.to].filter((r) => r && !find(r)).map((r) => ('name' in r! ? r.name : '선택한 대상')).join('」, 「')}」을 찾지 못했어요.` };
          area = { kind: 'path', from, to };
        } else area = a;
        const r = w.paintArea(cmd.brush, area, { width: cmd.width, count: cmd.count, density: cmd.density, only: cmd.only });
        if (!r.ok) w.map.journal = null;
        return { ok: r.ok, message: r.message };
      }
      case 'RESIZE_MAP': {
        const r = w.resizeMap(cmd.left ?? 0, cmd.top ?? 0, cmd.right ?? 0, cmd.bottom ?? 0);
        if (!r.ok) return r;
        if (this.renderer) this.renderer.camera.clampTo?.(w.map.w * TILE, w.map.h * TILE);
        return { ok: true, message: `🗺️ 맵 크기가 ${w.map.w}×${w.map.h}칸이 됐어요.` };
      }
      case 'RENAME_WORLD': {
        const name = cmd.name.trim().slice(0, 30);
        if (!name) return { ok: false, message: '이름이 비어 있어요.' };
        const prev = w.meta.name;
        if (prev) renameSlot(slotFor(prev), slotFor(name));
        w.meta.name = name;
        writeSlot(slotFor(name), serializeWorld(w));
        return { ok: true, message: `📛 이 세계의 이름은 이제 「${name}」이에요. (저장도 이 이름으로)` };
      }
      case 'TALK': {
        const e = this.resolve(cmd.target);
        if (!e || e.kind !== 'person') return { ok: false, message: '말을 걸 윌을 찾지 못했어요.' };
        this.selectedId = e.id;
        this.requestTab = 'talk';
        w.talkTo(e, cmd.text, () => this.notify(true));
        return { ok: true, message: `💬 ${e.name}에게 말을 걸었어요.`, focusId: e.id };
      }
      case 'SET_WEATHER': {
        w.setWeather(cmd.weather);
        if (cmd.weather === 'storm') sfx.thunder();
        const label = { clear: '☀️ 하늘이 맑게 갰어요.', rain: '🌧️ 비가 내리기 시작했어요.', snow: '❄️ 눈이 내리기 시작했어요.', storm: '⛈️ 폭풍우가 몰아칩니다.' }[cmd.weather];
        return { ok: true, message: label };
      }
      case 'GROUP': {
        const find = (n?: string) => (n ? w.factions.find((f) => f.id === n || f.name === n || f.name === '#' + n.replace(/^#/, '')) : undefined);
        if (cmd.action === 'FORM') {
          const ids = (cmd.members ?? []).map((r) => this.resolve(r)).filter((e): e is Agent => !!e && e.kind === 'person').map((a) => a.id);
          const uniq = [...new Set(ids)];
          if (uniq.length < 2) return { ok: false, message: '그룹을 만들려면 윌이 두 명 이상 필요해요.' };
          const f = w.formFaction(uniq, { name: cmd.name, origin: 'player' });
          return f ? { ok: true, message: `🎌 ${f.name} 결성! (${f.members.length}명)` } : { ok: false, message: '그룹을 만들지 못했어요.' };
        }
        const f = find(cmd.group);
        if (!f) return { ok: false, message: `그룹 「${cmd.group ?? ''}」을(를) 찾지 못했어요.` };
        if (cmd.action === 'DISBAND') {
          w.disbandFaction(f.id, '신의 뜻으로 해산했다.');
          return { ok: true, message: `${f.name} 해산` };
        }
        if (cmd.action === 'RENAME') {
          if (!cmd.name) return { ok: false, message: '새 이름을 적어 주세요.' };
          w.renameFaction(f.id, cmd.name);
          return { ok: true, message: `이름을 ${f.name}${josa(f.name, '으로/로').slice(f.name.length)} 바꿨어요.` };
        }
        const who = (cmd.members ?? []).map((r) => this.resolve(r)).filter((e): e is Agent => !!e && e.kind === 'person');
        if (!who.length) return { ok: false, message: '대상 윌을 찾지 못했어요.' };
        for (const a of who) {
          if (cmd.action === 'ADD' && !f.members.includes(a.id)) {
            f.members.push(a.id);
            f.logs.push({ t: w.meta.minutes, text: `${josa(a.name, '이/가')} 합류했다.` });
            w.log(a, 'event', `${f.name}에 들어갔다.`);
          }
          if (cmd.action === 'REMOVE') {
            f.members = f.members.filter((m) => m !== a.id);
            f.logs.push({ t: w.meta.minutes, text: `${josa(a.name, '이/가')} 빠졌다.` });
          }
        }
        if (f.members.length < 2) w.disbandFaction(f.id, '멤버가 거의 남지 않아 흩어졌다.');
        return { ok: true, message: `${f.name}: ${who.map((a) => a.name).join(', ')} ${cmd.action === 'ADD' ? '합류' : '제외'}` };
      }
      case 'SPREAD_RUMOR': {
        const text = cmd.text.trim();
        if (!text) return { ok: false, message: '어떤 소문을 퍼뜨릴지 적어 주세요.' };
        const to = (cmd.whisperTo ?? []).map((r) => this.resolve(r)).filter((e): e is Agent => !!e && e.kind === 'person');
        const r = w.plantRumor(text, to);
        if (!r) return { ok: false, message: '소문을 퍼뜨리지 못했어요.' };
        const who = r.knownBy.map((id) => w.agent(id)?.name).filter(Boolean).join(', ');
        return { ok: true, message: `🤫 ${r.tag} — ${who ? `${who}의 귀에 속삭였어요.` : '소문이 퍼지기 시작했어요.'}` };
      }
      case 'SET_WORLD_CONTEXT': {
        const ctx = cmd.context.trim();
        if (!ctx) return { ok: false, message: '세계관 이름을 적어 주세요.' };
        w.setContext(ctx);
        sfx.whoosh();
        return { ok: true, message: `🌍 세계관이 「${ctx}」${ctx.match(/[가-힣]$/) ? josa(ctx, '으로/로').slice(ctx.length) : '로'} 바뀌었어요.` };
      }
      case 'TRIGGER_EVENT': {
        const targets = cmd.targets.map((t) => this.resolve(t));
        if (cmd.event === 'LIGHTNING') {
          const e = targets[0];
          if (!e) return { ok: false, message: '번개를 내릴 대상을 찾지 못했어요. 대상을 먼저 선택하거나 이름을 적어 주세요.' };
          const x = e.kind === 'place' ? (e.tx + e.tw / 2) * TILE : e.x;
          const y = e.kind === 'place' ? (e.ty + e.th / 2) * TILE : e.y;
          w.lightning(x, y);
          sfx.thunder();
          return { ok: true, message: `⚡ ${e.name}에 번개가 내리쳤어요!` };
        }
        if (cmd.event === 'MEET') {
          const [a, b] = targets;
          if (!a || !b || a.kind === 'place' || b.kind === 'place' || a === b)
            return { ok: false, message: '마주치게 할 두 윌을 찾지 못했어요.' };
          w.meet(a, b);
          return { ok: true, message: `👣 ${josa(a.name, '와/과')} ${josa(b.name, '이/가')} 서로를 향해 걸어가요.` };
        }
        const e = targets[0];
        if (!e || e.kind === 'place') return { ok: false, message: '대상을 찾지 못했어요.' };
        if (cmd.event === 'BLESS') {
          w.bless(e);
          return { ok: true, message: `✨ ${e.name}에게 따스한 기운을 내려주었어요.` };
        }
        w.gift(e);
        return { ok: true, message: `🎁 ${e.name}의 곁에 선물을 몰래 두었어요.` };
      }
      case 'WORLD_EVENT': {
        const t = cmd.target ? this.resolve(cmd.target) : undefined;
        if (cmd.target && !t && !cmd.target.selected) return { ok: false, message: `「${cmd.target.name ?? ''}」을(를) 찾지 못했어요.` };
        const r = w.happen(cmd.event, t);
        if (r.ok) sfx.whoosh();
        return r;
      }
      case 'SYSTEM': {
        switch (cmd.action) {
          case 'SAVE': {
            const ok = writeSlot(slotFor(w.meta.name), serializeWorld(w));
            return { ok, message: ok ? (w.meta.name ? `💾 「${w.meta.name}」을(를) 저장했어요.` : '💾 저장했어요 (빠른 저장 슬롯). 세계에 이름을 지어 주면 따로 저장돼요.') : '저장에 실패했어요 (브라우저 저장소가 가득 찼거나 쓸 수 없어요).' };
          }
          case 'LOAD':
            this.onUIRequest('load');
            return { ok: true, message: '불러오기 창을 열었어요.' };
          case 'SETTINGS':
            this.onUIRequest('settings');
            return { ok: true, message: '설정 창을 열었어요.' };
          case 'QUIT':
            this.onUIRequest('quit');
            return { ok: true, message: '타이틀로 돌아갑니다.' };
          case 'EXPAND': {
            w.growMap(24, 16);
            return { ok: true, message: `🗺️ 세계가 넓어졌어요 (${w.map.w}×${w.map.h}칸). 오른쪽과 아래쪽에 새 땅이 생겼어요.` };
          }
          case 'HELP':
            this.onUIRequest('help');
            return { ok: true, message: '도움말을 열었어요.' };
          case 'PAUSE':
            this.paused = true;
            this.cancelSkip();
            return { ok: true, message: '⏸ 시간이 멈췄어요.' };
          case 'EDIT_MAP':
            this.setEditMode(cmd.value === undefined ? !this.editMode : !!Number(cmd.value));
            return {
              ok: true,
              message: this.editMode
                ? '🛠️ 맵 편집 모드 — 왼쪽 드래그로 칠하기, 오른쪽 드래그로 화면 이동, 지도 테두리·모서리를 끌어 크기 조절 (X로 끝내기)'
                : '🛠️ 맵 편집을 마쳤어요.',
            };
          case 'ADOPT': {
            const pet = w.agent(String(cmd.value ?? ''));
            const owner = cmd.target ? this.resolve(cmd.target) : undefined;
            if (!pet || !owner || owner.kind !== 'person') return { ok: false, message: '입양할 동물과 윌을 찾지 못했어요.' };
            return w.adopt(owner, pet);
          }
          case 'SKIP_NIGHT':
            if (!this.skipNight()) return { ok: false, message: '☀️ 지금은 낮이라 건너뛸 밤이 없어요. (저녁 6시부터 쓸 수 있어요)' };
            return { ok: true, message: '🌙 아침 6시 30분까지 빨리 감아요… (Space나 숫자 키로 멈춤)' };
          case 'RESUME':
            this.paused = false;
            return { ok: true, message: '▶ 시간이 다시 흐릅니다.' };
          case 'SPEED': {
            this.speed = Math.max(0.25, Math.min(10, Number(cmd.value) || 1));
            this.paused = false;
            this.cancelSkip();
            return { ok: true, message: this.speed < 1 ? `🐢 ${this.speed === 0.5 ? '½' : this.speed === 0.25 ? '¼' : this.speed}배속 (느리게)` : `⏩ ${this.speed}배속` };
          }
          case 'FOLLOW': {
            const e = this.resolve(cmd.target);
            if (!e) return { ok: false, message: '따라갈 대상을 찾지 못했어요.' };
            this.focus(e.id);
            return { ok: true, message: `🎥 ${josa(e.name, '을/를')} 따라갑니다.` };
          }
        }
      }
    }
    return { ok: false, message: '알 수 없는 명령이에요.' };
  }
}
