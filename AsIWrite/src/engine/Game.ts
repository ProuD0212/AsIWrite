// Game controller: owns World + Renderer + loop + input, and the single
// dispatch() entry point used by BOTH the chat bar and the GUI.

import type { CommandResult, GameCommand, TargetRef } from '../commands/schema';
import { sfx } from '../audio/sfx';
import { Camera, Renderer } from './render/Renderer';
import { serializeWorld, writeSlot } from './save';
import { parseSheet } from './sheet';
import { TILE } from './TileMap';
import { josa } from './traits';
import type { Agent, Place, PlaceStyle } from './types';
import { STYLE_LABEL, World } from './World';

export type UIRequest = 'settings' | 'load' | 'quit' | 'help';

export interface PlacementTool {
  label: string;
  /** called with the clicked world position; returns the command to dispatch */
  build: (x: number, y: number, hit: Agent | Place | undefined) => GameCommand | null;
}

export class Game {
  world: World;
  camera = new Camera();
  renderer: Renderer | null = null;
  canvas: HTMLCanvasElement | null = null;
  paused = false;
  speed = 1;
  selectedId: string | null = null;
  tool: PlacementTool | null = null;
  fps = 60;
  frameMs = 0;
  onUIRequest: (r: UIRequest) => void = () => {};

  private raf = 0;
  private last = 0;
  private t = 0;
  private listeners = new Set<() => void>();
  private version = 0;
  private notifyAcc = 0;
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
      if (!this.paused) {
        // fixed-ish substeps keep fast-forward stable
        const total = dtReal * this.speed;
        const steps = Math.ceil(total / 0.05);
        for (let i = 0; i < steps; i++) this.world.update(total / steps);
      }
      this.followCamera(dtReal);
      this.camera.clampTo(this.world.map.w * TILE, this.world.map.h * TILE);
      if (this.renderer) {
        this.renderer.selectedId = this.selectedId;
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
    const pos = (e: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      const p = pos(e);
      down = { x: p.x, y: p.y, cx: this.camera.x, cy: this.camera.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const p = pos(e);
      if (down) {
        const dx = p.x - down.x, dy = p.y - down.y;
        if (!down.moved && Math.hypot(dx, dy) > 5) down.moved = true;
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
      if (!down) return;
      const wasDrag = down.moved;
      down = null;
      canvas.style.cursor = this.tool ? 'crosshair' : 'grab';
      if (wasDrag) return;
      const p = pos(e);
      const w = this.camera.screenToWorld(p.x, p.y);
      const hit: Agent | Place | undefined = this.world.agentsAt(w.x, w.y, 20) ?? this.world.placeAt(w.x, w.y);
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
      this.select(hit?.id ?? null);
    };
    // zoom moves in pixel-perfect steps; accumulate trackpad deltas into steps
    let wheelAcc = 0;
    let wheelT = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = performance.now();
      if (now - wheelT > 300) wheelAcc = 0;
      wheelT = now;
      wheelAcc += e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      if (Math.abs(wheelAcc) < 90) return;
      const p = pos(e);
      this.camera.zoomAt(p.x, p.y, wheelAcc < 0 ? 2 : 0.5);
      wheelAcc = 0;
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
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
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
      const ds = this.world.doorSideOf(e);
      return { x: (e.door.tx + 0.5) * TILE + (Math.random() - 0.5) * 40, y: (e.door.ty + 0.5) * TILE + (ds === 'bottom' ? 20 : -20) };
    }
    return { x: e.x + (Math.random() < 0.5 ? -26 : 26), y: e.y + (Math.random() - 0.5) * 16 };
  }

  dispatch(cmd: GameCommand): CommandResult {
    const w = this.world;
    const r = this.exec(cmd, w);
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
            const p = w.addPlace(
              { name: spec.name?.trim() || `새 ${STYLE_LABEL[style]}`, style, appearance: spec.appearance ?? '', traits: spec.traits ?? [] },
              { tx: Math.floor(pos.x / TILE), ty: Math.floor(pos.y / TILE) },
            );
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
            w.setJob(e, undefined);
            return { ok: true, message: `${josa(e.name, '이/가')} 일을 그만두었어요.`, focusId: e.id };
          }
          const p = this.resolve(ch.workplace);
          if (!p || p.kind !== 'place') return { ok: false, message: `일할 곳 "${ch.workplace.name ?? ''}"을(를) 찾지 못했어요.` };
          e.job = '';
          w.setJob(e, p);
          return { ok: true, message: `💼 ${josa(e.name, '이/가')} ${p.name}에서 ${josa(e.job, '으로/로')} 일하게 됐어요.`, focusId: e.id };
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
      case 'SET_WEATHER': {
        w.setWeather(cmd.weather);
        if (cmd.weather === 'storm') sfx.thunder();
        const label = { clear: '☀️ 하늘이 맑게 갰어요.', rain: '🌧️ 비가 내리기 시작했어요.', snow: '❄️ 눈이 내리기 시작했어요.', storm: '⛈️ 폭풍우가 몰아칩니다.' }[cmd.weather];
        return { ok: true, message: label };
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
      case 'SYSTEM': {
        switch (cmd.action) {
          case 'SAVE': {
            const ok = writeSlot('quick', serializeWorld(w));
            return { ok, message: ok ? '💾 저장했어요 (빠른 저장 슬롯).' : '저장에 실패했어요 (브라우저 저장소 사용 불가).' };
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
          case 'HELP':
            this.onUIRequest('help');
            return { ok: true, message: '도움말을 열었어요.' };
          case 'PAUSE':
            this.paused = true;
            return { ok: true, message: '⏸ 시간이 멈췄어요.' };
          case 'RESUME':
            this.paused = false;
            return { ok: true, message: '▶ 시간이 다시 흐릅니다.' };
          case 'SPEED': {
            this.speed = Math.max(1, Math.min(4, Number(cmd.value) || 1));
            this.paused = false;
            return { ok: true, message: `⏩ ${this.speed}배속` };
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
