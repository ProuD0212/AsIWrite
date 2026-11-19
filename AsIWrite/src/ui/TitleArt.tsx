// Cute pixel-art title scene (no image assets).
// A smiling Earth pops up on the left; a hand holding a fountain pen slides in
// from the right and points at it — "the world is written as I write".
// Everything is drawn into a tiny canvas and enlarged with nearest-neighbour.

import { useEffect, useRef } from 'react';

// Continents in a 200×200 globe space (circle r=80 at 100,100).
const LAND = [
  'M18 62 q14 -16 34 -10 q12 4 10 16 q-2 12 -16 16 q-10 3 -14 12 q-4 10 -16 6 q-12 -5 -10 -20 q2 -12 12 -20z',
  'M78 40 q18 -8 30 4 q8 9 -2 16 q-10 6 -22 2 q-12 -5 -6 -22z',
  'M70 110 q16 -10 30 0 q10 8 6 22 q-4 14 -18 18 q-14 3 -20 -10 q-6 -16 2 -30z',
  'M128 78 q14 -10 28 -2 q14 9 8 24 q-6 14 -22 12 q-14 -2 -18 -14 q-3 -12 4 -20z',
  'M150 140 q10 -6 20 2 q8 8 0 16 q-10 8 -20 0 q-8 -8 0 -18z',
  'M40 150 q10 -4 16 4 q4 8 -4 12 q-10 4 -14 -4 q-3 -8 2 -12z',
].map((d) => new Path2D(d));

// Hand + pen in a 380×200 space, pen nib pointing left at (10,100).
const PALM = new Path2D('M292 76 C 262 60, 214 66, 204 94 C 196 116, 214 140, 246 142 C 270 144, 290 134, 294 116 Z');
const THUMB = new Path2D('M240 82 C 226 70, 198 72, 190 86 C 184 96, 196 102, 214 98 C 228 96, 240 92, 240 82 Z');
const NIB = new Path2D('M44 88 L10 100 L44 112 Z');

const INK = '#3d3f78';
const SKIN = '#ffe0c8';

const easeBack = (x: number) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** A chunky 5-pixel plus/diamond star that twinkles. */
function pixelStar(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, phase: number, color: string, big = false) {
  const k = (Math.sin(t * 3 + phase) + 1) / 2;
  if (k < 0.15) return;
  ctx.fillStyle = color;
  x = Math.round(x);
  y = Math.round(y);
  ctx.fillRect(x, y, 1, 1);
  if (k > 0.4) {
    ctx.fillRect(x - 1, y, 3, 1);
    ctx.fillRect(x, y - 1, 1, 3);
  }
  if (big && k > 0.75) {
    ctx.fillRect(x - 2, y, 5, 1);
    ctx.fillRect(x, y - 2, 1, 5);
  }
}

function drawGlobe(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: number) {
  const s = r / 80; // globe-space → scene pixels
  ctx.save();
  ctx.translate(cx - 100 * s, cy - 100 * s);
  ctx.scale(s, s);
  // ocean
  const g = ctx.createRadialGradient(80, 70, 10, 100, 100, 85);
  g.addColorStop(0, '#b8ecff');
  g.addColorStop(0.6, '#6cc8ff');
  g.addColorStop(1, '#3f9df0');
  ctx.beginPath();
  ctx.arc(100, 100, 80, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  // rotating continents
  ctx.save();
  ctx.beginPath();
  ctx.arc(100, 100, 80, 0, Math.PI * 2);
  ctx.clip();
  const off = ((t * 200) / 26) % 200;
  for (const ox of [-off, 200 - off]) {
    ctx.save();
    ctx.translate(ox, 0);
    ctx.fillStyle = '#86e08a';
    ctx.strokeStyle = '#4fb35a';
    ctx.lineWidth = 5;
    for (const p of LAND) {
      ctx.fill(p);
      ctx.stroke(p);
    }
    ctx.restore();
  }
  // drifting clouds
  const coff = ((t * 200) / 14) % 200;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  for (const ox of [-coff, 200 - coff]) {
    ctx.fillRect(ox + 20, 44, 44, 9);
    ctx.fillRect(ox + 128, 124, 50, 9);
    ctx.fillRect(ox + 98, 66, 26, 7);
  }
  // shade
  ctx.fillStyle = 'rgba(29,63,143,0.16)';
  ctx.beginPath();
  ctx.arc(126, 126, 80, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // highlight
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(52, 46, 26, 9);
  ctx.fillRect(46, 56, 12, 8);
  // outline
  ctx.beginPath();
  ctx.arc(100, 100, 80, 0, Math.PI * 2);
  ctx.lineWidth = 10;
  ctx.strokeStyle = INK;
  ctx.stroke();
  // ^ ^ face + blush
  ctx.lineWidth = 11;
  ctx.lineCap = 'square';
  ctx.beginPath();
  ctx.moveTo(66, 108);
  ctx.lineTo(77, 97);
  ctx.lineTo(88, 108);
  ctx.moveTo(112, 108);
  ctx.lineTo(123, 97);
  ctx.lineTo(134, 108);
  ctx.stroke();
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(90, 124);
  ctx.lineTo(100, 132);
  ctx.lineTo(110, 124);
  ctx.stroke();
  ctx.fillStyle = '#ff8fb3';
  ctx.fillRect(50, 116, 22, 11);
  ctx.fillRect(128, 116, 22, 11);
  ctx.restore();
}

function drawHand(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, tilt: number) {
  const s = w / 380;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ctx.scale(s, s);
  ctx.lineJoin = 'miter';
  // pen (behind fingers)
  ctx.save();
  ctx.translate(200, 100);
  ctx.rotate(-0.1);
  ctx.translate(-200, -100);
  ctx.fillStyle = '#f7cc52';
  ctx.fill(NIB);
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#a87a10';
  ctx.stroke(NIB);
  ctx.fillStyle = '#a87a10';
  ctx.fillRect(16, 98, 24, 5);
  ctx.fillStyle = '#4b5bc4';
  ctx.fillRect(42, 86, 210, 28);
  ctx.lineWidth = 7;
  ctx.strokeStyle = '#26307a';
  ctx.strokeRect(42, 86, 210, 28);
  ctx.fillStyle = '#f7cc52';
  ctx.fillRect(62, 87, 12, 26);
  ctx.fillRect(162, 87, 10, 26);
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillRect(96, 92, 50, 6);
  ctx.restore();
  // sleeve with pink cuff
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(288, 62, 110, 82);
  ctx.lineWidth = 8;
  ctx.strokeStyle = INK;
  ctx.strokeRect(288, 62, 110, 82);
  ctx.fillStyle = '#ffb3cf';
  ctx.fillRect(288, 62, 28, 82);
  ctx.strokeRect(288, 62, 28, 82);
  ctx.fillStyle = '#9fd8ff';
  ctx.fillRect(340, 84, 12, 12);
  ctx.fillStyle = '#ffd84a';
  ctx.fillRect(360, 112, 10, 10);
  // palm, fingers, thumb
  ctx.fillStyle = SKIN;
  ctx.fill(PALM);
  ctx.lineWidth = 8;
  ctx.stroke(PALM);
  for (let i = 0; i < 3; i++) {
    const fx = 206 + i * 22, fy = 98 + (i === 1 ? 2 : 0);
    ctx.fillStyle = SKIN;
    ctx.fillRect(fx, fy, 24, 34);
    ctx.lineWidth = 7;
    ctx.strokeRect(fx, fy, 24, 34);
  }
  ctx.fillStyle = SKIN;
  ctx.fill(THUMB);
  ctx.lineWidth = 7;
  ctx.stroke(THUMB);
  ctx.fillStyle = 'rgba(255,140,175,0.55)';
  ctx.fillRect(258, 118, 20, 9);
  ctx.restore();
}

/**
 * The globe + hand scene. `px` is the on-screen size of one art pixel.
 * Virtual canvas: 200×110 art pixels.
 */
export function PixelScene({ px }: { px: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const W = 200, H = 110;
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const start = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const t = (now - start) / 1000;
      ctx.clearRect(0, 0, W, H);
      // globe pop (0–0.76s) then float
      const pop = easeBack(clamp01(t / 0.76));
      const fy = Math.round(Math.sin(t * 1.5) * 2);
      const gx = 54, gy = 52 + fy;
      // shadow
      const sh = 1 - fy * 0.06;
      ctx.fillStyle = 'rgba(61,63,120,0.18)';
      ctx.fillRect(Math.round(gx - 18 * sh * pop), 94, Math.round(36 * sh * pop), 3);
      ctx.fillRect(Math.round(gx - 13 * sh * pop), 93, Math.round(26 * sh * pop), 5);
      // orbit ring (dotted)
      if (pop > 0.6) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        for (let k = 0; k < 28; k++) {
          const a = (k / 28) * Math.PI * 2;
          const ex = Math.cos(a) * 44, ey = Math.sin(a) * 13;
          const rx = ex * Math.cos(-0.32) - ey * Math.sin(-0.32), ry = ex * Math.sin(-0.32) + ey * Math.cos(-0.32);
          if (k % 2 === 0) ctx.fillRect(Math.round(gx + rx), Math.round(gy + ry), 1, 1);
        }
      }
      if (pop > 0.01) drawGlobe(ctx, gx, gy, Math.max(0.5, 32 * pop), t);
      // orbiting star
      if (pop > 0.6) {
        const a = t * 0.9;
        const ex = Math.cos(a) * 44, ey = Math.sin(a) * 13;
        const rx = ex * Math.cos(-0.32) - ey * Math.sin(-0.32), ry = ex * Math.sin(-0.32) + ey * Math.cos(-0.32);
        if (ry < 0 || Math.hypot(rx, ry) > 34) pixelStar(ctx, gx + rx, gy + ry, t, 0, '#ffd84a', true);
      }
      pixelStar(ctx, 14, 22, t, 1.2, '#ffffff', true);
      pixelStar(ctx, 96, 18, t, 2.4, '#ffd84a', true);
      pixelStar(ctx, 20, 92, t, 0.4, '#b9a8ff');
      pixelStar(ctx, 104, 88, t, 3.1, '#ffb3cf');
      // hand slides in (0.45–1.35s), then points with a little writing bob
      const hk = easeBack(clamp01((t - 0.45) / 0.9));
      if (hk > 0) {
        const bob = t > 1.4 ? Math.sin((t - 1.4) * 2.4) : 0;
        const hx = Math.round(98 + (1 - hk) * 120 - Math.max(0, bob) * 3);
        drawHand(ctx, hx, 26, 100, bob * -0.04);
        // sparkle at the nib — the moment of writing
        if (hk > 0.9) pixelStar(ctx, hx + 1, 52, t * 1.6, 0, '#ffd84a', true);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="pixelated" style={{ width: 200 * px, height: 110 * px }} aria-label="웃는 지구를 만년필로 가리키는 손" />;
}

/** Full-screen pixel sky: banded pastel gradient, drifting pixel clouds, twinkles. */
export function PixelSky() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    const P = 4; // one sky pixel = 4 css px
    const bands = ['#fff4dc', '#ffeedd', '#ffe6ea', '#ffe1f0', '#f2e2fb', '#e3e8ff', '#d9f0ff', '#cfeeff'];
    const clouds = Array.from({ length: 6 }, (_, i) => ({ x: Math.random(), y: 0.08 + (i % 3) * 0.28 + Math.random() * 0.08, s: 0.6 + Math.random() * 0.8, v: 0.004 + Math.random() * 0.006 }));
    const stars = Array.from({ length: 26 }, () => ({ x: Math.random(), y: Math.random(), p: Math.random() * 6 }));
    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => {
      const t = (now - start) / 1000;
      const W = Math.ceil(c.clientWidth / P), H = Math.ceil(c.clientHeight / P);
      if (c.width !== W || c.height !== H) {
        c.width = W;
        c.height = H;
      }
      for (let i = 0; i < bands.length; i++) {
        ctx.fillStyle = bands[i];
        ctx.fillRect(0, Math.floor((i * H) / bands.length), W, Math.ceil(H / bands.length) + 1);
      }
      for (const cl of clouds) {
        cl.x -= cl.v / 60;
        if (cl.x < -0.3) cl.x = 1.1;
        const x = Math.round(cl.x * W), y = Math.round(cl.y * H), s = cl.s;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, y, Math.round(26 * s), Math.round(5 * s));
        ctx.fillRect(x + Math.round(5 * s), y - Math.round(4 * s), Math.round(12 * s), Math.round(5 * s));
        ctx.fillRect(x + Math.round(14 * s), y - Math.round(2 * s), Math.round(9 * s), Math.round(3 * s));
        ctx.fillStyle = '#f3ecff';
        ctx.fillRect(x + 1, y + Math.round(5 * s) - 1, Math.round(24 * s), 1);
      }
      for (const st of stars) pixelStar(ctx, st.x * W, st.y * H, t, st.p, 'rgba(255,255,255,0.95)');
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="pixelated absolute inset-0 h-full w-full" />;
}
