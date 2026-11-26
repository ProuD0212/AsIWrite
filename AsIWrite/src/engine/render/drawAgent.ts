// Procedural 6-layer top-down (3/4 chibi) character renderer.
// Layers: 1 hair · 2 headgear · 3 outfit · 4 face accessory · 5 back/held prop
// · 6 body scale & gait. Drawn at the agent's feet (0,0), facing-aware.

import type { Agent, AppearanceLayers, Facing } from '../types';
import { shade } from '../util';

type Ctx = CanvasRenderingContext2D;

function ell(ctx: Ctx, x: number, y: number, rx: number, ry: number, fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}
function circ(ctx: Ctx, x: number, y: number, r: number, fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

export interface DrawOpts {
  t: number;
  seated: boolean;
  raining: boolean;
  selected: boolean;
  hovered: boolean;
  /** simulation clock (emotes are stamped with it) — lets a Will "pop" when an emote appears */
  sim?: number;
}

export function gaitOf(a: Agent): 'bouncy' | 'normal' | 'slouch' {
  if (a.mood >= 80) return 'bouncy';
  if (a.mood <= 22 || a.ai.mode === 'break') return 'slouch';
  return a.layers.gait;
}

// ───────────────────────── sprite pieces (cached) ─────────────────────────
// A Will is drawn from three cached pieces per facing — hair behind the head, the body, the head —
// each rendered once into a tiny canvas with crisp (thresholded) pixels and a 1-px outline. The parts
// that move every frame (legs, hands, face, held props) are drawn live on top. Squash & stretch, bounce
// and lean are applied when the pieces are placed. Generated at run time: no image files (0 MB).

type Piece = HTMLCanvasElement | OffscreenCanvas;
const PW = 46, PH = 50;
const HEAD_O = { x: 23, y: 26 }; // head centre inside a head/hair piece
const FEET_O = { x: 23, y: 46 }; // feet inside the body piece
export const OUTLINE = '#2e2433';
const canMake = typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined';
const pieces = new Map<string, Piece>();
const keyOf = new WeakMap<AppearanceLayers, string>();
function layersKey(L: AppearanceLayers) {
  let k = keyOf.get(L);
  if (!k) keyOf.set(L, (k = JSON.stringify(L)));
  return k;
}
function makeCanvas(w: number, h: number): Piece {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
/** crisp pixel edges + a 1-px outline around whatever was drawn */
export function crispOutline(raw: Piece, w: number, h: number, outline = OUTLINE): Piece {
  const rc = raw.getContext('2d', { willReadFrequently: true }) as Ctx;
  const img = rc.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 110 ? 255 : 0;
  rc.putImageData(img, 0, 0);
  const out = makeCanvas(w, h);
  const oc = out.getContext('2d') as Ctx;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) oc.drawImage(raw as CanvasImageSource, dx, dy);
  oc.globalCompositeOperation = 'source-in';
  oc.fillStyle = outline;
  oc.fillRect(0, 0, w, h);
  oc.globalCompositeOperation = 'source-over';
  oc.drawImage(raw as CanvasImageSource, 0, 0);
  return out;
}
/** facing 'right' is drawn as a mirrored 'left', so only down/left/up are cached */
function piece(L: AppearanceLayers, part: 'hairBack' | 'body' | 'head', f: 'down' | 'left' | 'up'): Piece | null {
  if (!canMake) return null;
  const k = `${layersKey(L)}|${part}|${f}`;
  const hit = pieces.get(k);
  if (hit) return hit;
  if (pieces.size > 3000) pieces.clear();
  const raw = makeCanvas(PW, PH);
  const c = raw.getContext('2d', { willReadFrequently: true }) as Ctx;
  const side = f === 'left', back = f === 'up';
  if (part === 'body') {
    c.translate(FEET_O.x, FEET_O.y);
    if (!back) drawBackProp(c, L, side);
    drawBody(c, L, side, back, false);
    const covered = L.outfitStyle === 'cloak' || L.outfitStyle === 'armor' || L.outfitStyle === 'dress';
    if (!covered && (L.bottom === 'skirt' || L.bottom === 'longSkirt')) drawSkirt(c, L, side, L.bottom === 'longSkirt', 0);
    // toy-like shading: a soft light on the upper left of the torso
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = 'rgba(255,255,255,0.16)';
    c.fillRect(-8, -15, 7, 4);
    c.globalCompositeOperation = 'source-over';
    if (back) drawBackProp(c, L, false, true);
  } else {
    c.translate(HEAD_O.x, HEAD_O.y);
    if (part === 'hairBack') {
      if (!back) drawHairBack(c, L, 0, side);
    } else {
      // head: shaded skin, then hair and headgear
      circ(c, 0, 0, 8, shade(L.skinColor, -0.12));
      circ(c, -0.7, -0.8, 7.5, L.skinColor);
      if (back) drawHairBackView(c, L, 0);
      else drawHairFront(c, L, 0, side);
      drawHeadgear(c, L, 0, side, back);
    }
  }
  const out = crispOutline(raw, PW, PH);
  pieces.set(k, out);
  return out;
}

/** a stable 0..1 per Will, so a crowd never blinks or fidgets in unison */
function phaseOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}
function hash2(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h % 1000) / 1000;
}

interface Pose {
  bob: number; // body lift (px, negative = up)
  sy: number; // vertical squash/stretch (1 = none)
  tilt: number; // lean (radians, + = forward)
  headDY: number;
  headDX: number;
  lookX: number; // eyes glance sideways
  armL: number; // 0 = hanging … 1 = raised
  armR: number;
  swing: number; // walking arm swing (-1..1)
  legPhase: number;
  walking: boolean;
  blink: boolean;
  mouth: 'smile' | 'flat' | 'frown' | 'open' | 'grin';
  sad: boolean;
  lying: boolean;
}

function poseOf(a: Agent, o: DrawOpts, gait: string): Pose {
  const ph = phaseOf(a.id);
  const t = o.t;
  const energy = a.persona?.energy ?? 0;
  const arrived = a.ai.pathIndex >= (a.ai.path?.length ?? 0);
  const p: Pose = { bob: 0, sy: 1, tilt: 0, headDY: 0, headDX: 0, lookX: 0, armL: 0, armR: 0, swing: 0, legPhase: 0, walking: false, blink: false, mouth: 'smile', sad: gait === 'slouch', lying: false };
  // blink every 2.5–5 s for ~0.13 s
  const bp = 2.5 + ph * 2.5;
  p.blink = ((t + ph * 9) % bp) < 0.13;
  const speaking = !!a.bubble && !a.bubble.thought && a.bubble.text !== '…';
  p.mouth = a.mood >= 80 ? 'grin' : a.mood <= 30 ? 'frown' : a.mood <= 45 ? 'flat' : 'smile';
  if (speaking) p.mouth = Math.floor(t * 9 + ph * 5) % 2 ? 'open' : p.mouth === 'frown' ? 'flat' : 'smile';

  if (a.ai.sleeping && a.ai.mode === 'visit' && arrived && !a.moving) {
    p.lying = true;
    p.blink = true;
    p.sy = 1 + Math.sin(t * 1.3 + ph * 6) * 0.03;
    p.mouth = 'flat';
    return p;
  }
  if (a.moving) {
    const k = gait === 'bouncy' ? 1.25 : gait === 'slouch' ? 0.85 : 1;
    const ang = a.animPhase * k;
    const up = Math.abs(Math.sin(ang));
    const amp = (gait === 'bouncy' ? 3.2 : gait === 'slouch' ? 0.9 : 1.9) * (1 + energy * 0.2);
    p.walking = true;
    p.legPhase = ang;
    p.bob = -up * amp;
    p.sy = gait === 'slouch' ? 1 : 0.93 + up * 0.11; // squash on landing, stretch in the air
    p.headDY = (Math.abs(Math.sin(ang - 0.6)) - up) * 1.2; // the head lags a beat behind the body
    p.tilt = gait === 'bouncy' ? 0.1 : gait === 'slouch' ? 0.02 : 0.06;
    p.swing = Math.sin(ang);
  } else {
    // breathing
    const br = Math.sin(t * (p.sad ? 1.4 : 2.1) + ph * 6.28);
    p.sy = 1 + br * (p.sad ? 0.014 : 0.024);
    p.headDY = -br * 0.35;
    const chatting = a.ai.mode === 'chat';
    const working = !!a.ai.working && a.ai.mode === 'visit' && arrived;
    if (working) {
      // busy hands: typing, stirring, hammering — whatever the job is, it looks like work
      const w = Math.sin(t * 9 + ph * 6);
      p.armL = w > 0 ? 0.45 : 0.15;
      p.armR = w > 0 ? 0.15 : 0.45;
      p.headDY += 0.6;
      p.bob = -Math.max(0, w) * 0.5;
    } else if (chatting) {
      // talking with the hands; nodding while listening
      const g = Math.sin(t * 2.6 + ph * 6);
      if (speaking) p.armR = Math.max(0, g) * 0.75;
      else p.headDY += Math.max(0, Math.sin(t * 4.5 + ph * 3)) * 0.8;
    } else {
      // small idle actions every ~4–6 s: look around, stretch, scratch, hop, sway
      const period = 4 + ph * 2;
      const cyc = (t + ph * 17) / period;
      const ci = Math.floor(cyc);
      const u = cyc - ci;
      if (u < 0.3) {
        const s = Math.sin((u / 0.3) * Math.PI);
        const r = hash2(ci, Math.floor(ph * 1000));
        const happy = a.mood >= 65 && !p.sad;
        if (r < 0.32) p.lookX = (hash2(ci, 7) < 0.5 ? -1 : 1) * 1.3 * s;
        else if (r < 0.46) {
          p.armL = p.armR = s;
          p.sy += 0.05 * s;
        } else if (r < 0.58) p.armR = 0.85 * s;
        else if (r < 0.74 && happy) {
          p.bob = -3.4 * s;
          p.sy += s > 0.6 ? 0.05 : -0.06;
        } else if (r < 0.86) p.tilt = (hash2(ci, 3) < 0.5 ? -1 : 1) * 0.07 * s;
      }
      if (gait === 'bouncy' && !p.bob) p.bob = -Math.abs(Math.sin(t * 4 + ph * 6)) * 1.2;
    }
  }
  // an emote just appeared: a little pop
  if (o.sim !== undefined && a.emote) {
    const age = o.sim - a.emote.born;
    if (age >= 0 && age < 0.35) {
      const s = Math.sin((age / 0.35) * Math.PI);
      p.bob -= 2.5 * s;
      p.sy += 0.06 * s;
    }
  }
  if (p.sad) p.headDY += 1.4;
  return p;
}

export function drawAgent(ctx: Ctx, a: Agent, o: DrawOpts) {
  const L = a.layers;
  const s = L.bodyScale;
  ctx.save();
  ctx.translate(Math.round(a.x), Math.round(a.y)); // whole pixels → crisp sprites

  // selection ring
  if (o.selected || o.hovered) {
    ctx.strokeStyle = o.selected ? 'rgba(255,207,110,0.95)' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, 13 * s, 6 * s, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  const gait = gaitOf(a);
  if (a.kind === 'animal') {
    ell(ctx, 0, 0, 10 * s, 4 * s, 'rgba(0,0,0,0.22)');
    const up = a.moving ? Math.abs(Math.sin(a.animPhase * (gait === 'bouncy' ? 1.25 : 1))) : 0;
    const bob = a.moving ? -up * 2.2 : Math.sin(o.t * 1.6 + a.animPhase) * 0.4;
    ctx.translate(0, Math.round(bob));
    const sy = a.moving ? 0.94 + up * 0.09 : 1 + Math.sin(o.t * 2 + a.animPhase) * 0.02;
    ctx.scale(s / Math.sqrt(sy), s * sy);
    const fr = animalFrame(a, o);
    if (fr) ctx.drawImage(fr as CanvasImageSource, -AN_O.x, -AN_O.y);
    else drawAnimal(ctx, a, o);
    ctx.restore();
    return;
  }
  const pose = poseOf(a, o, gait);
  // the shadow shrinks while the body is in the air
  const air = Math.min(1, -pose.bob / 4);
  if (pose.lying) ell(ctx, 0, 1, 15 * s, 4 * s, 'rgba(0,0,0,0.18)');
  else ell(ctx, 0, 0, (10 - air * 2.5) * s, (4 - air) * s, `rgba(0,0,0,${0.24 - air * 0.08})`);
  if (pose.lying) {
    // asleep: lying on the bed (head to the left), centred on the spot, breathing slowly
    ctx.translate(0, -4);
    ctx.rotate(-Math.PI / 2);
    ctx.translate(0, 17);
  }
  ctx.translate(0, Math.round(pose.bob) + (o.seated ? 3 : 0));
  ctx.scale(s, s);
  if (a.facing === 'right') ctx.scale(-1, 1);
  ctx.rotate(-pose.tilt * (a.facing === 'left' || a.facing === 'right' ? 1 : 0.4));
  ctx.scale(1 / Math.sqrt(pose.sy), pose.sy); // keep the volume while squashing
  drawPerson(ctx, L, a.facing, pose, o);
  ctx.restore();
}

/** animals: 8 animation frames per facing (walk cycle / idle tail sway) + sleeping, cached and outlined */
const AN_W = 52, AN_H = 44, AN_O = { x: 26, y: 36 };
function animalFrame(a: Agent, o: DrawOpts): Piece | null {
  if (!canMake) return null;
  const sleeping = a.ai.mode === 'idle' && a.emote?.icon === '💤';
  const TAU = Math.PI * 2;
  const frame = a.moving ? Math.floor((((a.animPhase % TAU) + TAU) % TAU) / TAU * 8) : Math.floor((o.t * 2 + phaseOf(a.id) * 8) % 8);
  const k = `${layersKey(a.layers)}|an|${a.facing}|${a.moving ? 'm' : 'i'}${frame}|${sleeping ? 'z' : ''}`;
  const hit = pieces.get(k);
  if (hit) return hit;
  if (pieces.size > 3000) pieces.clear();
  const raw = makeCanvas(AN_W, AN_H);
  const c = raw.getContext('2d', { willReadFrequently: true }) as Ctx;
  c.translate(AN_O.x, AN_O.y);
  const fake = { ...a, animPhase: (frame / 8) * TAU, emote: sleeping ? { icon: '💤', born: 0, life: 1 } : undefined } as Agent;
  drawAnimal(c, fake, { ...o, t: frame / 2 });
  const out = crispOutline(raw, AN_W, AN_H);
  pieces.set(k, out);
  return out;
}

// ───────────────────────── person ─────────────────────────

function drawPerson(ctx: Ctx, L: AppearanceLayers, f: Facing, p: Pose, o: DrawOpts) {
  const side = f === 'left' || f === 'right';
  const back = f === 'up';
  const pf: 'down' | 'left' | 'up' = side ? 'left' : back ? 'up' : 'down';
  const headY = -21 + p.headDY;

  // legs (live: they step)
  drawLegs(ctx, L, side, p, o.seated);
  // hair that hangs behind the head
  const hb = piece(L, 'hairBack', pf);
  if (hb) ctx.drawImage(hb as CanvasImageSource, Math.round(-HEAD_O.x + p.headDX), Math.round(headY - HEAD_O.y));
  else if (!back) drawHairBack(ctx, L, headY, side);
  // body
  const body = piece(L, 'body', pf);
  if (body) ctx.drawImage(body as CanvasImageSource, -FEET_O.x, -FEET_O.y);
  else {
    if (!back) drawBackProp(ctx, L, side);
    drawBody(ctx, L, side, back, false);
  }
  // hands (live: swing, wave, work)
  if (!back) drawHands(ctx, L, side, p);
  // head
  const head = piece(L, 'head', pf);
  if (head) ctx.drawImage(head as CanvasImageSource, Math.round(-HEAD_O.x + p.headDX), Math.round(headY - HEAD_O.y));
  else {
    circ(ctx, 0, headY, 8, L.skinColor);
    if (back) drawHairBackView(ctx, L, headY);
    else drawHairFront(ctx, L, headY, side);
    drawHeadgear(ctx, L, headY, side, back);
  }
  if (!back) {
    drawFace(ctx, L, Math.round(headY), side, p);
    drawFaceAcc(ctx, L, Math.round(headY), side);
  } else drawHands(ctx, L, side, p);
  drawHeldProp(ctx, L, Math.round(headY), side, o.raining);
}

/** legs with an outline, stepping while walking; trousers / bare legs + shoes */
function drawLegs(ctx: Ctx, L: AppearanceLayers, side: boolean, p: Pose, seated: boolean) {
  const covered = L.outfitStyle === 'cloak' || L.outfitStyle === 'armor';
  const bottom = covered ? 'pants' : L.outfitStyle === 'dress' ? 'skirt' : L.bottom;
  const trouser = covered ? shade(L.outfitColor, -0.45) : L.bottomColor;
  const h = seated ? 3 : 6;
  const leg = (x: number, lift: number) => {
    const y = -6 - lift, hh = h;
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(x - 1, y - 0.5, 5, hh + 1.5);
    if (bottom === 'pants') {
      ctx.fillStyle = trouser;
      ctx.fillRect(x, y, 3, hh);
    } else {
      ctx.fillStyle = L.skinColor;
      ctx.fillRect(x, y, 3, hh);
      if (bottom === 'shorts') {
        ctx.fillStyle = trouser;
        ctx.fillRect(x, y, 3, 2.5);
      }
    }
    ctx.fillStyle = '#3a2a24'; // shoes
    ctx.fillRect(x, y + hh - 1.5, 3, 1.5);
  };
  if (!p.walking) {
    if (side) leg(-1.5, 0);
    else {
      leg(-4, 0);
      leg(1, 0);
    }
    return;
  }
  const a = Math.sin(p.legPhase);
  if (side) {
    // one leg forward, one back
    leg(-1.5 - a * 2.6, Math.max(0, -Math.cos(p.legPhase)) * 1.2);
    leg(-1.5 + a * 2.6, Math.max(0, Math.cos(p.legPhase)) * 1.2);
  } else {
    // front/back: the stepping leg lifts
    leg(-4, Math.max(0, a) * 1.6);
    leg(1, Math.max(0, -a) * 1.6);
  }
}

/** mitten hands: hanging, swinging, waving or busy */
function drawHands(ctx: Ctx, L: AppearanceLayers, side: boolean, p: Pose) {
  const hand = (x: number, y: number, r = 2.2) => {
    circ(ctx, x, y, r + 0.8, OUTLINE);
    circ(ctx, x, y, r, L.skinColor);
  };
  const sleeve = shade(L.outfitColor, -0.05);
  if (side) {
    const x = 1 + p.swing * 3 - p.armR * 2;
    const y = -8.5 - p.armR * 9;
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(-0.5, -14.5, 4, 4);
    ctx.fillStyle = sleeve;
    ctx.fillRect(0, -14, 3, 3);
    hand(x, y, 1.8);
    return;
  }
  const lx = -7.5 - p.armL * 1.5, ly = -8 + p.swing * 0.8 - p.armL * 9;
  const rx = 7.5 + p.armR * 1.5, ry = -8 - p.swing * 0.8 - p.armR * 9;
  hand(lx, ly);
  hand(rx, ry);
}

/** a skirt over the hips (flares a little while walking) */
function drawSkirt(ctx: Ctx, L: AppearanceLayers, side: boolean, long: boolean, walk: number) {
  const c = L.bottomColor;
  const top = -5.5, bottomY = long ? -0.8 : -2.4;
  const w0 = side ? 5 : 6.5, flare = (long ? 2.2 : 2.6) + (walk ? Math.abs(Math.sin(walk)) * 0.6 : 0);
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(-w0, top);
  ctx.lineTo(w0, top);
  ctx.lineTo(w0 + flare, bottomY);
  ctx.lineTo(-w0 - flare, bottomY);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(c, -0.22);
  ctx.fillRect(-w0 - flare + 0.5, bottomY - 1, (w0 + flare) * 2 - 1, 1);
  // pleats
  ctx.fillStyle = shade(c, -0.12);
  for (const x of side ? [-1.5, 1.5] : [-3, 0, 3]) ctx.fillRect(x, top + 1, 0.8, bottomY - top - 2);
}

function drawBody(ctx: Ctx, L: AppearanceLayers, side: boolean, back: boolean, slouch: boolean) {
  const c = L.outfitColor;
  const w = side ? 6 : 7.5;
  const top = slouch ? -14 : -15;
  // cloak flares wider and lower
  if (L.outfitStyle === 'cloak') {
    ctx.fillStyle = shade(c, -0.15);
    ctx.beginPath();
    ctx.moveTo(-w - 1, top + 2);
    ctx.lineTo(w + 1, top + 2);
    ctx.lineTo(w + 4, -2);
    ctx.lineTo(-w - 4, -2);
    ctx.closePath();
    ctx.fill();
  }
  if (L.outfitStyle === 'dress') {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(-w + 1, top);
    ctx.lineTo(w - 1, top);
    ctx.lineTo(w + 3, -3);
    ctx.lineTo(-w - 3, -3);
    ctx.closePath();
    ctx.fill();
  }
  // a soft bean: narrower shoulders, rounder belly
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.roundRect(-w + 1, top, w * 2 - 2, 6, [5, 5, 0, 0]);
  ctx.roundRect(-w, top + 3, w * 2, 8.5, [3, 3, 5, 5]);
  ctx.fill();

  // shading
  ctx.fillStyle = shade(c, -0.18);
  ctx.fillRect(-w, top + 8, w * 2, 3);

  if (back) {
    if (L.outfitStyle === 'hoodie' || L.outfitStyle === 'raincoat') ell(ctx, 0, top + 1, 5.5, 3, shade(c, -0.1));
    return;
  }
  switch (L.outfitStyle) {
    case 'suit': {
      ctx.fillStyle = '#f1efe8';
      ctx.beginPath();
      ctx.moveTo(-2.5, top);
      ctx.lineTo(2.5, top);
      ctx.lineTo(0, top + 6);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#b03a3a';
      ctx.fillRect(-0.8, top + 1, 1.6, 5);
      break;
    }
    case 'uniform': {
      ctx.fillStyle = '#f1efe8';
      ctx.beginPath();
      ctx.moveTo(-5, top);
      ctx.lineTo(5, top);
      ctx.lineTo(0, top + 4);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#d0443e';
      ctx.beginPath();
      ctx.moveTo(-3, top + 3);
      ctx.lineTo(3, top + 3);
      ctx.lineTo(0, top + 6);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'armor': {
      ctx.strokeStyle = shade(c, 0.35);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-w + 1, top + 4);
      ctx.lineTo(w - 1, top + 4);
      ctx.moveTo(0, top);
      ctx.lineTo(0, top + 10);
      ctx.stroke();
      circ(ctx, -w + 1, top + 1, 2.6, shade(c, 0.2));
      circ(ctx, w - 1, top + 1, 2.6, shade(c, 0.2));
      break;
    }
    case 'raincoat': {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(-w + 2, top + 2, 2, 6);
      ctx.fillStyle = shade(c, -0.3);
      for (let k = 0; k < 3; k++) circ(ctx, 0, top + 2 + k * 3, 0.9, shade(c, -0.4));
      break;
    }
    case 'hoodie': {
      ctx.strokeStyle = '#f1efe8';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-1.5, top + 1);
      ctx.lineTo(-1.5, top + 5);
      ctx.moveTo(1.5, top + 1);
      ctx.lineTo(1.5, top + 5);
      ctx.stroke();
      ctx.fillStyle = shade(c, -0.12);
      ctx.fillRect(-4, top + 6, 8, 3);
      break;
    }
    case 'apron': {
      ctx.fillStyle = shade(c, 0.1);
      ctx.fillRect(-4.5, top + 2, 9, 9);
      ctx.fillStyle = '#f1efe8';
      ctx.fillRect(-w, top, 3, 3);
      ctx.fillRect(w - 3, top, 3, 3);
      break;
    }
    case 'cloak': {
      circ(ctx, 0, top + 1, 1.8, '#e8c45a');
      break;
    }
    case 'dress': {
      ctx.fillStyle = '#f1efe8';
      ctx.fillRect(-3, top, 6, 2);
      break;
    }
    default: {
      ctx.fillStyle = shade(c, 0.15);
      ctx.fillRect(-3, top, 6, 2);
    }
  }
}

/** eyes that blink and glance, rosy cheeks, a mouth that follows the mood (and moves while talking) */
function drawFace(ctx: Ctx, L: AppearanceLayers, hy: number, side: boolean, p: Pose) {
  const ey = hy + 1 + (p.sad ? 0.5 : 0);
  const dark = '#2a2028';
  const eye = (x: number) => {
    if (p.blink) {
      ctx.fillStyle = dark;
      ctx.fillRect(x - 1.2, ey + 0.4, 2.4, 0.9);
      return;
    }
    if (p.mouth === 'grin' && !p.sad) {
      // happy ^ ^ eyes
      ctx.fillStyle = dark;
      ctx.fillRect(x - 1.4, ey + 0.2, 1, 1);
      ctx.fillRect(x - 0.5, ey - 0.6, 1, 1);
      ctx.fillRect(x + 0.4, ey + 0.2, 1, 1);
      return;
    }
    ctx.fillStyle = dark;
    ctx.fillRect(x - 1, ey - 1.5, 2, 3);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - 1, ey - 1.5, 1, 1);
  };
  const mouthAt = (x: number, y: number, w: number) => {
    ctx.fillStyle = '#6a3038';
    switch (p.mouth) {
      case 'open':
        ctx.fillRect(x - 1, y - 0.5, 2, 1.8);
        break;
      case 'grin':
        ctx.fillRect(x - w, y - 0.5, w * 2, 1);
        ctx.fillRect(x - w + 0.6, y + 0.5, w * 2 - 1.2, 0.8);
        break;
      case 'smile':
        ctx.fillRect(x - w + 0.5, y, w * 2 - 1, 0.9);
        ctx.fillRect(x - w, y - 0.6, 0.7, 0.7);
        ctx.fillRect(x + w - 0.7, y - 0.6, 0.7, 0.7);
        break;
      case 'frown':
        ctx.fillRect(x - w + 0.5, y - 0.4, w * 2 - 1, 0.9);
        ctx.fillRect(x - w, y + 0.4, 0.7, 0.7);
        ctx.fillRect(x + w - 0.7, y + 0.4, 0.7, 0.7);
        break;
      default:
        ctx.fillRect(x - w * 0.7, y, w * 1.4, 0.8);
    }
  };
  ctx.fillStyle = 'rgba(242,140,160,0.55)';
  if (side) {
    eye(-4.6 + p.lookX * 0.5);
    ctx.fillRect(-6.5, hy + 3, 2.2, 1.2);
    mouthAt(-5.6, hy + 4.6, 1.1);
  } else {
    ctx.fillRect(-6.2, hy + 3, 2.4, 1.3);
    ctx.fillRect(3.8, hy + 3, 2.4, 1.3);
    eye(-3 + p.lookX);
    eye(3 + p.lookX);
    if (p.sad) {
      ctx.fillStyle = shade(L.hairColor, -0.2);
      ctx.fillRect(-4.6 + p.lookX, ey - 3.2, 2, 0.8);
      ctx.fillRect(2.6 + p.lookX, ey - 3.2, 2, 0.8);
    }
    mouthAt(p.lookX * 0.5, hy + 4.4, 1.6);
  }
}

function drawFaceAcc(ctx: Ctx, L: AppearanceLayers, hy: number, side: boolean) {
  const ey = hy + 1;
  switch (L.faceAcc) {
    case 'glasses':
      ctx.strokeStyle = '#1e1e24';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (side) ctx.rect(-6.5, ey - 2.5, 4, 4);
      else {
        ctx.rect(-5.2, ey - 2.4, 4.4, 4);
        ctx.rect(0.8, ey - 2.4, 4.4, 4);
        ctx.moveTo(-0.8, ey - 0.6);
        ctx.lineTo(0.8, ey - 0.6);
      }
      ctx.stroke();
      break;
    case 'sunglasses':
      ctx.fillStyle = '#111';
      if (side) ctx.fillRect(-7, ey - 2, 4.5, 3);
      else {
        ctx.beginPath();
        ctx.roundRect(-5.6, ey - 2, 4.8, 3.2, 1);
        ctx.roundRect(0.8, ey - 2, 4.8, 3.2, 1);
        ctx.fill();
        ctx.fillRect(-1, ey - 1.5, 2, 1);
      }
      break;
    case 'eyepatch':
      ctx.fillStyle = '#111';
      if (!side) {
        ctx.beginPath();
        ctx.ellipse(-2.8, ey, 2.6, 2.4, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-8, hy - 3);
      ctx.lineTo(8, hy + 1);
      ctx.stroke();
      break;
    case 'blush':
      ctx.fillStyle = 'rgba(240,110,130,0.55)';
      if (side) ell(ctx, -4, ey + 3, 2, 1.2, 'rgba(240,110,130,0.55)');
      else {
        ell(ctx, -4.5, ey + 3, 2, 1.2, 'rgba(240,110,130,0.55)');
        ell(ctx, 4.5, ey + 3, 2, 1.2, 'rgba(240,110,130,0.55)');
      }
      break;
    case 'beard':
      ctx.fillStyle = shade(L.hairColor, -0.05);
      ctx.beginPath();
      if (side) ctx.ellipse(-3, hy + 5.5, 4, 2.8, 0, 0, Math.PI * 2);
      else ctx.ellipse(0, hy + 5.8, 5, 2.8, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
  }
}

function drawHairBack(ctx: Ctx, L: AppearanceLayers, hy: number, side: boolean) {
  const c = shade(L.hairColor, -0.1);
  switch (L.hairShape) {
    case 'long':
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.roundRect(side ? -2 : -8.5, hy - 2, side ? 10 : 17, 16, 5);
      ctx.fill();
      break;
    case 'ponytail':
      if (side) {
        ell(ctx, 8, hy + 2, 3, 6, c);
      } else ell(ctx, 0, hy - 8.5, 3, 3, c);
      break;
    case 'twintails':
      ell(ctx, -10, hy + 4, 3, 7, c);
      if (!side) ell(ctx, 10, hy + 4, 3, 7, c);
      break;
    case 'bob':
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.roundRect(-9, hy - 3, 18, 11, 5);
      ctx.fill();
      break;
    case 'wavy': {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.roundRect(side ? -2 : -9, hy - 2, side ? 11 : 18, 14, 5);
      ctx.fill();
      for (const x of side ? [0, 4, 8] : [-8, -4, 0, 4, 8]) circ(ctx, x, hy + 12, 2.4, c);
      break;
    }
    case 'braid': {
      const braid = (x: number) => {
        for (let k = 0; k < 4; k++) ell(ctx, x, hy + 3 + k * 2.6, 1.9 - k * 0.15, 1.6, k % 2 ? shade(c, -0.15) : c);
        circ(ctx, x, hy + 13.5, 1.1, '#d0443e'); // hair tie
      };
      if (side) braid(6.5);
      else {
        braid(-7.5);
        braid(7.5);
      }
      break;
    }
    case 'bun':
      circ(ctx, side ? 3 : 0, hy - 9, 3.8, c);
      break;
    case 'curly': {
      for (const [x, y] of [[-8, hy - 2], [8, hy - 2], [-8.5, hy + 2], [8.5, hy + 2], [-6, hy - 6], [6, hy - 6]] as const) if (!side || x > 0) circ(ctx, x, y, 3, c);
      break;
    }
  }
}

function drawHairFront(ctx: Ctx, L: AppearanceLayers, hy: number, side: boolean) {
  const c = L.hairColor;
  if (L.hairShape === 'bald') {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ell(ctx, -2.5, hy - 5, 2.5, 1.5, 'rgba(255,255,255,0.35)');
    return;
  }
  if (L.hairShape === 'buzz') {
    // just a shadow of hair on the scalp
    ctx.fillStyle = c;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.arc(0, hy, 8.3, Math.PI * 1.05, Math.PI * 1.95);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }
  ctx.fillStyle = c;
  ctx.beginPath();
  // skull cap
  ctx.arc(0, hy, 8.4, Math.PI * 1.02, Math.PI * 1.98);
  ctx.closePath();
  ctx.fill();
  if (L.hairShape === 'spiky') {
    for (let k = 0; k < 5; k++) {
      const x = -7 + k * 3.5;
      ctx.beginPath();
      ctx.moveTo(x - 2.2, hy - 5 + Math.abs(x) * 0.25);
      ctx.lineTo(x + (side ? 1.5 : 0), hy - 11.5 + Math.abs(x) * 0.35);
      ctx.lineTo(x + 2.2, hy - 5 + Math.abs(x) * 0.25);
      ctx.fill();
    }
  }
  if (L.hairShape === 'curly') for (let k = 0; k < 5; k++) circ(ctx, -7 + k * 3.5, hy - 5.5 - (k % 2), 2.4, c);
  // bangs
  ctx.beginPath();
  if (L.hairShape === 'sidePart' && !side) {
    // swept to one side, with a parting line
    ctx.moveTo(-8.4, hy - 3);
    ctx.lineTo(-3, hy - 7);
    ctx.quadraticCurveTo(4, hy - 4, 8.4, hy + 0.5);
    ctx.lineTo(8.4, hy - 3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = shade(c, -0.3);
    ctx.fillRect(-3.5, hy - 8, 1, 3);
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(-8.4, hy - 3);
    ctx.lineTo(-8.4, hy - 3);
  } else if (side) {
    ctx.moveTo(-8.4, hy - 1);
    ctx.quadraticCurveTo(-5, hy - 4, 0, hy - 2.5);
    ctx.lineTo(8.4, hy + 1);
    ctx.lineTo(8.4, hy - 2);
    ctx.lineTo(-8.4, hy - 3);
  } else if (L.hairShape === 'messy') {
    ctx.moveTo(-8.4, hy - 1);
    for (let k = 0; k <= 6; k++) ctx.lineTo(-8.4 + k * 2.8, hy - (k % 2 ? 4.5 : 0.5));
    ctx.lineTo(8.4, hy - 3);
    ctx.lineTo(-8.4, hy - 3);
  } else {
    ctx.moveTo(-8.4, hy);
    ctx.quadraticCurveTo(-3, hy - 1, 0, hy - 3.2);
    ctx.quadraticCurveTo(3, hy - 1, 8.4, hy);
    ctx.lineTo(8.4, hy - 3);
    ctx.lineTo(-8.4, hy - 3);
  }
  ctx.closePath();
  ctx.fill();
  if (L.hairShape === 'bob' || L.hairShape === 'long' || L.hairShape === 'twintails' || L.hairShape === 'wavy' || L.hairShape === 'braid') {
    ctx.fillRect(-9, hy - 2, 2.6, side ? 6 : 9);
    if (!side) ctx.fillRect(6.4, hy - 2, 2.6, 9);
  }
  if (L.hairShape === 'messy') {
    circ(ctx, -6, hy - 7, 2.5, c);
    circ(ctx, 5, hy - 8, 2.5, c);
  }
  // highlight
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ell(ctx, -3, hy - 5.5, 3, 1.2, 'rgba(255,255,255,0.18)');
}

function drawHairBackView(ctx: Ctx, L: AppearanceLayers, hy: number) {
  if (L.hairShape === 'bald') {
    circ(ctx, 0, hy, 8, shade(L.skinColor, -0.05));
    return;
  }
  const c = L.hairColor;
  circ(ctx, 0, hy, 8.5, c);
  if (L.hairShape === 'long') {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.roundRect(-8.5, hy, 17, 14, 5);
    ctx.fill();
  } else if (L.hairShape === 'ponytail') {
    ell(ctx, 0, hy + 7, 3, 6, shade(c, -0.1));
  } else if (L.hairShape === 'twintails') {
    ell(ctx, -10, hy + 4, 3, 7, c);
    ell(ctx, 10, hy + 4, 3, 7, c);
  } else if (L.hairShape === 'bob') {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.roundRect(-9, hy - 2, 18, 10, 5);
    ctx.fill();
  } else if (L.hairShape === 'wavy') {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.roundRect(-9, hy, 18, 13, 5);
    ctx.fill();
    for (const x of [-8, -4, 0, 4, 8]) circ(ctx, x, hy + 13, 2.4, c);
  } else if (L.hairShape === 'braid') {
    for (let k = 0; k < 5; k++) ell(ctx, 0, hy + 6 + k * 2.6, 2 - k * 0.15, 1.6, k % 2 ? shade(c, -0.15) : c);
    circ(ctx, 0, hy + 18.5, 1.1, '#d0443e');
  } else if (L.hairShape === 'bun') {
    circ(ctx, 0, hy - 6, 3.8, shade(c, -0.08));
  } else if (L.hairShape === 'curly') {
    for (const [x, y] of [[-7, hy - 4], [0, hy - 7], [7, hy - 4], [-8, hy + 2], [8, hy + 2], [-4, hy + 5], [4, hy + 5]] as const) circ(ctx, x, y, 3, c);
  } else if (L.hairShape === 'spiky') {
    for (let k = 0; k < 4; k++) {
      const x = -5 + k * 3.4;
      ctx.beginPath();
      ctx.moveTo(x - 2, hy - 6);
      ctx.lineTo(x, hy - 11);
      ctx.lineTo(x + 2, hy - 6);
      ctx.fill();
    }
  } else if (L.hairShape === 'buzz') {
    circ(ctx, 0, hy, 8.5, shade(L.skinColor, -0.15));
    ctx.globalAlpha = 0.7;
    circ(ctx, 0, hy, 8.5, c);
    ctx.globalAlpha = 1;
  }
}

function drawHeadgear(ctx: Ctx, L: AppearanceLayers, hy: number, side: boolean, back: boolean) {
  const c = L.headgearColor;
  switch (L.headgear) {
    case 'beret':
      ell(ctx, side ? 1 : 1.5, hy - 7, 8.5, 3.6, c);
      circ(ctx, side ? 1 : 1.5, hy - 10, 1.3, shade(c, -0.2));
      break;
    case 'crown': {
      ctx.fillStyle = '#e8c45a';
      ctx.beginPath();
      ctx.moveTo(-6, hy - 6);
      ctx.lineTo(-6, hy - 12);
      ctx.lineTo(-3, hy - 9);
      ctx.lineTo(0, hy - 13);
      ctx.lineTo(3, hy - 9);
      ctx.lineTo(6, hy - 12);
      ctx.lineTo(6, hy - 6);
      ctx.closePath();
      ctx.fill();
      circ(ctx, 0, hy - 8, 1.2, '#d0443e');
      break;
    }
    case 'hood':
      ctx.fillStyle = shade(L.outfitColor, -0.1);
      ctx.beginPath();
      ctx.arc(0, hy, 10, Math.PI * 0.95, Math.PI * 2.05);
      if (!back) {
        ctx.lineTo(9.5, hy + 4);
        ctx.lineTo(7, hy + 2);
        ctx.arc(0, hy, 7.2, Math.PI * 2, Math.PI, true);
        ctx.lineTo(-9.5, hy + 4);
      } else ctx.lineTo(-10, hy + 6);
      ctx.closePath();
      ctx.fill();
      break;
    case 'catEars': {
      const ear = (x: number) => {
        ctx.fillStyle = L.hairColor === '#f1efe8' ? '#2a2726' : shade(L.hairColor, -0.1);
        ctx.beginPath();
        ctx.moveTo(x - 3.2, hy - 6);
        ctx.lineTo(x, hy - 13);
        ctx.lineTo(x + 3.2, hy - 6);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#f2a0bf';
        ctx.beginPath();
        ctx.moveTo(x - 1.6, hy - 7);
        ctx.lineTo(x, hy - 10.5);
        ctx.lineTo(x + 1.6, hy - 7);
        ctx.closePath();
        ctx.fill();
      };
      ear(-5);
      if (!side) ear(5);
      break;
    }
    case 'helmet':
      ctx.fillStyle = '#9aa3ad';
      ctx.beginPath();
      ctx.arc(0, hy - 1, 9.2, Math.PI, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = shade('#9aa3ad', -0.25);
      ctx.fillRect(-9.2, hy - 2, 18.4, 2);
      if (!back && !side) ctx.fillRect(-0.8, hy - 2, 1.6, 6);
      break;
    case 'starPin': {
      ctx.fillStyle = '#ffd84a';
      const x = side ? -3 : 5, y = hy - 5;
      ctx.beginPath();
      for (let k = 0; k < 10; k++) {
        const r = k % 2 ? 1.4 : 3.2;
        const ang = -Math.PI / 2 + (k * Math.PI) / 5;
        ctx.lineTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'cap':
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(0, hy - 2, 8.6, Math.PI, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      if (!back) {
        ctx.fillStyle = shade(c, -0.2);
        if (side) ctx.fillRect(-13, hy - 3, 7, 2.4);
        else {
          ctx.beginPath();
          ctx.ellipse(0, hy - 2, 8, 2.6, 0, 0, Math.PI);
          ctx.fill();
        }
      }
      break;
    case 'ribbon':
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(0, hy - 8);
      ctx.lineTo(-5, hy - 11);
      ctx.lineTo(-5, hy - 5);
      ctx.closePath();
      ctx.moveTo(0, hy - 8);
      ctx.lineTo(5, hy - 11);
      ctx.lineTo(5, hy - 5);
      ctx.closePath();
      ctx.fill();
      break;
  }
}

function drawBackProp(ctx: Ctx, L: AppearanceLayers, side: boolean, facingAway = false) {
  const c = L.propColor;
  switch (L.prop) {
    case 'guitarCase':
      ctx.save();
      ctx.rotate(facingAway ? 0.35 : -0.35);
      ctx.fillStyle = '#2a2726';
      ctx.beginPath();
      ctx.ellipse(side ? 6 : 5, -6, 4.5, 6, 0, 0, Math.PI * 2);
      ctx.ellipse(side ? 6 : 5, -17, 3, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(side ? 5 : 4, -27, 2.4, 9);
      ctx.restore();
      break;
    case 'backpack':
      ctx.fillStyle = c === '#6b4a30' ? '#d0443e' : c;
      ctx.beginPath();
      if (facingAway) ctx.roundRect(-6, -15, 12, 10, 3);
      else if (side) ctx.roundRect(4, -15, 6, 10, 3);
      else ctx.roundRect(-7, -16, 14, 3, 2);
      ctx.fill();
      break;
    case 'greatsword':
      ctx.save();
      ctx.rotate(0.5);
      ctx.fillStyle = '#c9ccd4';
      ctx.fillRect(-1.5, -32, 3, 24);
      ctx.fillStyle = '#7a5236';
      ctx.fillRect(-4, -10, 8, 2);
      ctx.fillRect(-1, -8, 2, 5);
      ctx.restore();
      break;
  }
}

function drawHeldProp(ctx: Ctx, L: AppearanceLayers, hy: number, side: boolean, raining: boolean) {
  const c = L.propColor;
  const hx = side ? 2 : 8;
  switch (L.prop) {
    case 'umbrella':
      if (raining) {
        // open canopy above head — very readable from top-down
        ctx.fillStyle = c === '#6b4a30' ? '#3f6fd0' : c;
        ctx.beginPath();
        ctx.arc(0, hy - 6, 15, Math.PI, Math.PI * 2);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = -2; k <= 2; k++) {
          ctx.moveTo(0, hy - 21);
          ctx.lineTo(k * 6, hy - 6);
        }
        ctx.stroke();
      } else {
        ctx.fillStyle = c === '#6b4a30' ? '#3f6fd0' : c;
        ctx.fillRect(hx, -16, 2, 14);
      }
      break;
    case 'book':
      ctx.fillStyle = c === '#6b4a30' ? '#a8685a' : c;
      ctx.fillRect(hx - 1, -11, 6, 7);
      ctx.fillStyle = '#f1efe8';
      ctx.fillRect(hx, -10, 4, 1);
      break;
    case 'staff':
      ctx.fillStyle = '#7a5236';
      ctx.fillRect(hx, -30, 2, 30);
      circ(ctx, hx + 1, -31, 3, c === '#6b4a30' ? '#8fdcc0' : c);
      ctx.fillStyle = 'rgba(160,240,220,0.35)';
      ctx.beginPath();
      ctx.arc(hx + 1, -31, 5, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'briefcase':
      ctx.fillStyle = c === '#6b4a30' ? '#4a3426' : c;
      ctx.fillRect(hx - 2, -7, 7, 5);
      ctx.fillRect(hx, -8, 3, 1);
      break;
    case 'greatsword':
      break;
  }
}

// ───────────────────────── animals ─────────────────────────

function drawAnimal(ctx: Ctx, a: Agent, o: DrawOpts) {
  const L = a.layers;
  const f = a.facing;
  if (f === 'right') ctx.scale(-1, 1);
  const c = L.furColor;
  const dark = shade(c, -0.25);
  const sleeping = a.ai.mode === 'idle' && a.emote?.icon === '💤';
  if (drawCritter(ctx, a, o, c, dark, sleeping)) return;
  if (L.species === 'bird') {
    const flap = a.moving ? Math.sin(o.t * 20) * 3 : 0;
    ell(ctx, 0, -6, 4, 3.2, c);
    ell(ctx, -1, -6 - flap * 0.3, 3, 1.4, dark);
    circ(ctx, -3.5, -8, 2.2, c);
    ctx.fillStyle = '#ec8a3a';
    ctx.fillRect(-6.5, -8.4, 2, 1);
    return;
  }
  if (L.species === 'creature') {
    ell(ctx, 0, -8, 9, 7, c);
    circ(ctx, -4, -10, 1.6, '#fff');
    circ(ctx, 3, -10, 1.6, '#fff');
    circ(ctx, -4, -10, 0.8, '#111');
    circ(ctx, 3, -10, 0.8, '#111');
    return;
  }
  const isDog = L.species === 'dog';
  const side = f === 'left' || f === 'right';
  const tailSway = Math.sin(o.t * (isDog ? 9 : 2.5) + a.animPhase) * (isDog ? 0.5 : 0.35);
  const step = a.moving ? Math.sin(a.animPhase * 1.6) * 1.5 : 0;

  if (sleeping) {
    // curled up loaf
    ell(ctx, 0, -4, 8, 5, c);
    if (L.furPattern === 'tabby') {
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1;
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath();
        ctx.moveTo(k * 3, -8.5);
        ctx.lineTo(k * 3 + 1, -5);
        ctx.stroke();
      }
    }
    circ(ctx, -5, -5, 3.6, c);
    return;
  }

  // tail
  ctx.save();
  ctx.translate(side ? 7 : 0, side ? -6 : -4);
  ctx.rotate(tailSway + (side ? -0.6 : 0));
  ctx.fillStyle = L.furPattern === 'tuxedo' ? '#2a2726' : c;
  ctx.fillRect(-1.2, -9, 2.4, 9);
  ctx.restore();

  // legs
  ctx.fillStyle = dark;
  if (side) {
    ctx.fillRect(-5 + step, -3, 2, 3);
    ctx.fillRect(3 - step, -3, 2, 3);
  } else {
    ctx.fillRect(-4, -3, 2, 3);
    ctx.fillRect(2, -3, 2, 3);
  }
  // body
  if (side) ell(ctx, 0, -6, isDog ? 8 : 7, 4.2, c);
  else ell(ctx, 0, -6, 5, 5, c);
  if (L.furPattern === 'calico') {
    ell(ctx, -2, -7, 2.5, 2, '#e1a04a');
    ell(ctx, 2.5, -5, 2.2, 1.8, '#2a2726');
  } else if (L.furPattern === 'tuxedo') {
    ell(ctx, side ? -3 : 0, -5, 2.5, 2.5, '#f1efe8');
  } else if (L.furPattern === 'tabby') {
    ctx.strokeStyle = dark;
    ctx.lineWidth = 1;
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.moveTo(k * 3, -10);
      ctx.lineTo(k * 3 + 0.8, -7);
      ctx.stroke();
    }
  }
  // head
  const hx = side ? -7 : 0;
  const hy = side ? -10 : -11;
  circ(ctx, hx, hy, isDog ? 5 : 4.6, c);
  // ears
  ctx.fillStyle = L.furPattern === 'tuxedo' ? '#2a2726' : c;
  if (isDog) {
    ell(ctx, hx - 4, hy + 0.5, 1.8, 3.5, dark);
    if (!side) ell(ctx, hx + 4, hy + 0.5, 1.8, 3.5, dark);
  } else {
    for (const ex of side ? [hx - 2] : [hx - 3, hx + 3]) {
      ctx.beginPath();
      ctx.moveTo(ex - 2, hy - 2.5);
      ctx.lineTo(ex, hy - 7);
      ctx.lineTo(ex + 2, hy - 2.5);
      ctx.closePath();
      ctx.fill();
    }
  }
  if (f !== 'up') {
    ctx.fillStyle = '#1e1e24';
    if (side) circ(ctx, hx - 2, hy - 0.5, 0.9, '#1e1e24');
    else {
      circ(ctx, hx - 1.8, hy - 0.4, 0.9, '#1e1e24');
      circ(ctx, hx + 1.8, hy - 0.4, 0.9, '#1e1e24');
    }
    circ(ctx, hx + (side ? -4.2 : 0), hy + 1.6, 0.8, isDog ? '#1e1e24' : '#f2a0bf');
  }
}

/** The extra species (rabbit, hamster, birds, fox, horse, dragon…). Returns false for cat/dog/bird/creature. */
function drawCritter(ctx: Ctx, a: Agent, o: DrawOpts, c: string, dark: string, sleeping: boolean): boolean {
  const sp = a.layers.species;
  const bob = a.moving ? Math.abs(Math.sin(a.animPhase * 1.6)) : 0;
  const eye = (x: number, y: number, r = 0.9) => circ(ctx, x, y, r, '#1e1e24');
  switch (sp) {
    case 'rabbit': {
      const hop = a.moving ? Math.abs(Math.sin(o.t * 10 + a.animPhase)) * 3 : 0;
      ell(ctx, 0, -5 - hop, 5, 4, c);
      circ(ctx, 4, -5 - hop, 1.8, '#f1efe8'); // tail
      circ(ctx, -4, -8 - hop, 3.4, c);
      if (!sleeping) {
        ell(ctx, -5, -14 - hop, 1.1, 3.6, c);
        ell(ctx, -3, -14 - hop, 1.1, 3.6, c);
        ell(ctx, -5, -14 - hop, 0.5, 2.4, '#f2a0bf');
        ell(ctx, -3, -14 - hop, 0.5, 2.4, '#f2a0bf');
        eye(-5, -8.5 - hop);
      }
      return true;
    }
    case 'hamster': {
      ell(ctx, 0, -4, 4.5, 3.6 - bob * 0.3, c);
      ell(ctx, -1, -3, 2.6, 2, '#f1efe8');
      circ(ctx, -3, -7, 1.3, dark);
      circ(ctx, 2, -7, 1.3, dark);
      if (!sleeping) {
        eye(-2, -5, 0.7);
        eye(1.5, -5, 0.7);
      }
      return true;
    }
    case 'hedgehog': {
      ctx.fillStyle = dark;
      for (let k = -4; k <= 4; k += 2) {
        ctx.beginPath();
        ctx.moveTo(k - 1.5, -5);
        ctx.lineTo(k + 0.5, -11 + Math.abs(k) * 0.4);
        ctx.lineTo(k + 1.5, -5);
        ctx.fill();
      }
      ell(ctx, 0, -5, 6, 4, c);
      ell(ctx, -5, -4, 2.6, 2, '#e8d2b0');
      circ(ctx, -7.5, -4, 0.8, '#1e1e24');
      if (!sleeping) eye(-5, -5, 0.7);
      return true;
    }
    case 'turtle': {
      const head = sleeping ? 0 : 1;
      ctx.fillStyle = shade(c, 0.2);
      ctx.fillRect(-5, -3, 2, 3);
      ctx.fillRect(3, -3, 2, 3);
      if (head) circ(ctx, -7 - bob * 0.5, -5, 2.2, shade(c, 0.2));
      ell(ctx, 0, -6, 6.5, 4.5, '#6e5a3a');
      ell(ctx, 0, -6.5, 5, 3.4, c);
      ctx.strokeStyle = dark;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-2.5, -9);
      ctx.lineTo(-2.5, -4);
      ctx.moveTo(2.5, -9);
      ctx.lineTo(2.5, -4);
      ctx.stroke();
      if (head) eye(-8, -5.5, 0.6);
      return true;
    }
    case 'duck':
    case 'chicken':
    case 'owl':
    case 'crow': {
      const flap = a.moving ? Math.sin(o.t * 18) * 2 : 0;
      const big = sp === 'duck' || sp === 'chicken' ? 1.25 : sp === 'owl' ? 1.15 : 1;
      ctx.fillStyle = '#ec8a3a';
      if (sp !== 'owl') {
        ctx.fillRect(-2, -2, 1, 2);
        ctx.fillRect(1, -2, 1, 2);
      }
      ell(ctx, 0, -6 * big, 4.2 * big, 3.6 * big, c);
      ell(ctx, 1, -6 * big - flap * 0.3, 3 * big, 1.6 * big, dark);
      if (sp === 'owl') {
        circ(ctx, 0, -10 * big, 3.6, c);
        ctx.fillStyle = dark;
        ctx.fillRect(-3.5, -14.5 * big, 1.5, 2);
        ctx.fillRect(2, -14.5 * big, 1.5, 2);
        circ(ctx, -1.5, -10.5 * big, 1.5, '#f6e7b0');
        circ(ctx, 1.5, -10.5 * big, 1.5, '#f6e7b0');
        if (!sleeping) {
          eye(-1.5, -10.5 * big, 0.8);
          eye(1.5, -10.5 * big, 0.8);
        }
        ctx.fillStyle = '#ec8a3a';
        ctx.fillRect(-0.5, -9.4 * big, 1, 1.2);
        return true;
      }
      circ(ctx, -3.5 * big, -9 * big, 2.4 * big, sp === 'duck' && c === '#f1efe8' ? c : sp === 'duck' ? '#3f8a4a' : c);
      if (sp === 'chicken') {
        ctx.fillStyle = '#e04a3a';
        ctx.fillRect(-4.5 * big, -12.5 * big, 2.5, 1.6);
        ctx.fillRect(-5.6 * big, -8 * big, 1, 1.5);
      }
      ctx.fillStyle = sp === 'crow' ? '#3a3a40' : '#ec8a3a';
      ctx.fillRect(-7 * big, -9.4 * big, sp === 'duck' ? 2.6 : 2, sp === 'duck' ? 1.4 : 1);
      if (!sleeping) eye(-4 * big, -9.6 * big, 0.6);
      return true;
    }
    case 'fox': {
      const side = a.facing === 'left' || a.facing === 'right';
      const sway = Math.sin(o.t * 3 + a.animPhase) * 0.3;
      ctx.save();
      ctx.translate(side ? 6 : 0, -5);
      ctx.rotate(sway + (side ? -1 : 0));
      ell(ctx, 0, -5, 2.6, 5, c);
      circ(ctx, 0, -9.5, 2, '#f1efe8');
      ctx.restore();
      ctx.fillStyle = '#3a2a20';
      ctx.fillRect(-4 + bob, -3, 1.6, 3);
      ctx.fillRect(3 - bob, -3, 1.6, 3);
      ell(ctx, 0, -6, side ? 7 : 5, 4, c);
      ell(ctx, -1, -4.6, 3, 1.6, '#f1efe8');
      const hx = side ? -6.5 : 0;
      circ(ctx, hx, -10, 4, c);
      ctx.fillStyle = c;
      for (const ex of [hx - 2.6, hx + 2.6]) {
        ctx.beginPath();
        ctx.moveTo(ex - 1.8, -12);
        ctx.lineTo(ex, -17);
        ctx.lineTo(ex + 1.8, -12);
        ctx.fill();
      }
      ell(ctx, hx - (side ? 2 : 0), -8.5, 2.4, 1.6, '#f1efe8');
      if (!sleeping && a.facing !== 'up') {
        eye(hx - 1.6, -10.5, 0.8);
        eye(hx + 1.6, -10.5, 0.8);
      }
      circ(ctx, hx - (side ? 4 : 0), -8.2, 0.8, '#1e1e24');
      return true;
    }
    case 'horse': {
      const step = a.moving ? Math.sin(a.animPhase * 1.6) * 2 : 0;
      ctx.fillStyle = dark;
      for (const [lx, d] of [[-6, 1], [-3, -1], [3, 1], [6, -1]] as const) ctx.fillRect(lx + step * d * 0.5, -6, 1.8, 6);
      ell(ctx, 0, -9, 9, 4.5, c);
      ctx.save();
      ctx.translate(8, -10);
      ctx.rotate(0.5 + Math.sin(o.t * 2 + a.animPhase) * 0.2);
      ctx.fillStyle = shade(c, -0.45);
      ctx.fillRect(-1, 0, 2.4, 8);
      ctx.restore();
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(-6, -12);
      ctx.lineTo(-10, -19);
      ctx.lineTo(-6.5, -21);
      ctx.lineTo(-3, -13);
      ctx.fill();
      ell(ctx, -10.5, -19, 2.8, 2, c);
      ctx.fillStyle = shade(c, -0.45);
      ctx.fillRect(-6.5, -21, 2, 8);
      if (!sleeping) eye(-9.5, -20, 0.7);
      return true;
    }
    case 'dragon': {
      const flap = Math.sin(o.t * 6 + a.animPhase) * 3;
      const hover = Math.sin(o.t * 2 + a.animPhase) * 1.5;
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.beginPath();
      ctx.ellipse(0, -1, 8, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = shade(c, -0.3);
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(dir * 2, -12 + hover);
        ctx.lineTo(dir * 13, -19 - flap + hover);
        ctx.lineTo(dir * 10, -10 + hover);
        ctx.fill();
      }
      ell(ctx, 0, -9 + hover, 6, 5, c);
      ell(ctx, 0, -7.5 + hover, 3.6, 2.6, '#f2d88a');
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(4, -6 + hover);
      ctx.lineTo(11, -3 + hover);
      ctx.lineTo(5, -9 + hover);
      ctx.fill();
      circ(ctx, -3, -15 + hover, 4, c);
      ctx.fillStyle = '#f2e8c8';
      ctx.fillRect(-5.5, -21 + hover, 1.4, 3);
      ctx.fillRect(-1.5, -21 + hover, 1.4, 3);
      if (!sleeping) {
        circ(ctx, -4.5, -15.5 + hover, 1.1, '#fff');
        circ(ctx, -1.5, -15.5 + hover, 1.1, '#fff');
        eye(-4.5, -15.5 + hover, 0.6);
        eye(-1.5, -15.5 + hover, 0.6);
      }
      if (Math.sin(o.t * 1.3 + a.animPhase) > 0.96) {
        ctx.fillStyle = 'rgba(255,150,60,0.85)';
        ctx.beginPath();
        ctx.arc(-8, -13 + hover, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      return true;
    }
  }
  return false;
}
