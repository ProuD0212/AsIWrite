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
}

export function gaitOf(a: Agent): 'bouncy' | 'normal' | 'slouch' {
  if (a.mood >= 80) return 'bouncy';
  if (a.mood <= 22 || a.ai.mode === 'break') return 'slouch';
  return a.layers.gait;
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
  ell(ctx, 0, 0, 10 * s, 4 * s, 'rgba(0,0,0,0.22)');

  const gait = gaitOf(a);
  const amp = gait === 'bouncy' ? 3.2 : gait === 'slouch' ? 0.8 : 1.6;
  const freq = gait === 'bouncy' ? 1.25 : 1;
  const bob = a.moving ? -Math.abs(Math.sin(a.animPhase * freq)) * amp : gait === 'bouncy' ? -Math.abs(Math.sin(o.t * 4)) * 1.2 : Math.sin(o.t * 1.6 + a.animPhase) * 0.4;
  ctx.translate(0, Math.round(bob) + (o.seated ? 3 : 0));
  ctx.scale(s, s);
  if (a.kind === 'animal') drawAnimal(ctx, a, o);
  else drawPerson(ctx, L, a.facing, gait, o, a.moving ? a.animPhase : 0);
  ctx.restore();
}

// ───────────────────────── person ─────────────────────────

function drawPerson(ctx: Ctx, L: AppearanceLayers, f: Facing, gait: string, o: DrawOpts, walk: number) {
  const slouch = gait === 'slouch';
  const headY = slouch ? -19 : -21;
  const flip = f === 'right' ? -1 : 1;
  if (f === 'right') ctx.scale(-1, 1);
  const side = f === 'left' || f === 'right';
  const back = f === 'up';

  // legs
  const legSwing = Math.sin(walk) * 2.5;
  ctx.fillStyle = shade(L.outfitColor, -0.45);
  if (side) {
    ctx.fillRect(-2 + legSwing, -6, 3, 6);
    ctx.fillRect(-1 - legSwing, -6, 3, 6);
  } else {
    ctx.fillRect(-4, -6, 3, 6 + (walk ? legSwing * 0.3 : 0));
    ctx.fillRect(1, -6, 3, 6 - (walk ? legSwing * 0.3 : 0));
  }

  // ── layer 5a: back props (behind body unless facing up) ──
  if (!back) drawBackProp(ctx, L, side);

  // ── layer 1a: hair behind head ──
  if (!back) drawHairBack(ctx, L, headY, side);

  // ── layer 3: outfit / body ──
  drawBody(ctx, L, side, back, slouch);

  // arms
  ctx.fillStyle = L.skinColor;
  const armSwing = walk ? Math.sin(walk) * 2 : 0;
  if (side) circ(ctx, 1 + armSwing, -9, 2.2, L.skinColor);
  else {
    circ(ctx, -7.5, -8 + armSwing * 0.4, 2.2, L.skinColor);
    circ(ctx, 7.5, -8 - armSwing * 0.4, 2.2, L.skinColor);
  }

  // head
  circ(ctx, 0, headY, 8, L.skinColor);

  if (back) {
    drawHairBackView(ctx, L, headY);
  } else {
    drawFace(ctx, L, headY, side, slouch);
    // ── layer 4: face accessories ──
    drawFaceAcc(ctx, L, headY, side);
    // ── layer 1b: front hair / bangs ──
    drawHairFront(ctx, L, headY, side);
  }
  // ── layer 2: headgear ──
  drawHeadgear(ctx, L, headY, side, back);
  // ── layer 5b: held props & back prop when facing away ──
  if (back) drawBackProp(ctx, L, false, true);
  drawHeldProp(ctx, L, headY, side, o.raining);
  void flip;
}

function drawBody(ctx: Ctx, L: AppearanceLayers, side: boolean, back: boolean, slouch: boolean) {
  const c = L.outfitColor;
  const w = side ? 6.5 : 8;
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
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.roundRect(-w, top, w * 2, 11, 4);
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

function drawFace(ctx: Ctx, L: AppearanceLayers, hy: number, side: boolean, slouch: boolean) {
  const eyeY = hy + 1 + (slouch ? 1 : 0);
  ctx.fillStyle = '#2a2420';
  if (side) {
    ctx.fillRect(-5, eyeY - 1, 1.8, slouch ? 1.2 : 2.6);
    ctx.fillStyle = shade(L.skinColor, -0.15);
    ctx.fillRect(-8.5, hy + 2, 1.5, 2);
  } else {
    const h = slouch ? 1.2 : 2.8;
    ctx.fillRect(-3.6, eyeY - 1, 1.8, h);
    ctx.fillRect(1.8, eyeY - 1, 1.8, h);
    // mouth
    ctx.strokeStyle = shade(L.skinColor, -0.45);
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    if (slouch) {
      ctx.moveTo(-1.5, hy + 5.4);
      ctx.lineTo(1.5, hy + 5.0);
    } else ctx.arc(0, hy + 4.2, 1.6, 0.2, Math.PI - 0.2);
    ctx.stroke();
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
  }
}

function drawHairFront(ctx: Ctx, L: AppearanceLayers, hy: number, side: boolean) {
  const c = L.hairColor;
  if (L.hairShape === 'bald') {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ell(ctx, -2.5, hy - 5, 2.5, 1.5, 'rgba(255,255,255,0.35)');
    return;
  }
  ctx.fillStyle = c;
  ctx.beginPath();
  // skull cap
  ctx.arc(0, hy, 8.4, Math.PI * 1.02, Math.PI * 1.98);
  ctx.closePath();
  ctx.fill();
  // bangs
  ctx.beginPath();
  if (side) {
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
  if (L.hairShape === 'bob' || L.hairShape === 'long' || L.hairShape === 'twintails') {
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
