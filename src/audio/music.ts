// Generative background music (Web Audio, no audio files): a soft jazz-piano trio feel that follows the
// world: each world theme has its own scale, "instruments" (waveform + envelope) and rhythm;
// on top of that it is brighter by day and lower/slower at night, sparse in the rain, almost
// silent in a storm, and a little brighter when the town is happy.

import { audioContext, isMuted } from './sfx';
import { worldTheme, type WorldTheme } from '../engine/worldTheme';

const ON_KEY = 'asiwrite.music';
const VOL_KEY = 'asiwrite.musicVolume';

function read(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function write(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

/** One world's musical character. Scales are semitones from the root. */
interface Style {
  day: number[];
  night: number[];
  rootDay: number; // Hz
  rootNight: number;
  beat: number; // seconds per step by day (night is slower)
  lead: OscillatorType;
  leadDur: number; // how long a melody note rings
  pluck?: boolean; // fast attack, quick decay (harp, gayageum, music box)
  bend?: number; // cents each lead note slides in from (국악 농현)
  arp?: boolean; // quick 3-note arpeggios (synth)
  pad: OscillatorType | null;
  drone?: boolean; // a low sustained note under everything
  bells?: boolean; // occasional high bell
  rhythm?: number[]; // accent pattern: melody plays on steps where this is 1 (e.g. shanty)
  density: number; // base chance of a melody note per step
}

const STYLES: Record<WorldTheme, Style> = {
  modern: { day: [0, 2, 4, 7, 9], night: [0, 3, 5, 7, 10], rootDay: 261.63, rootNight: 220, beat: 1.5, lead: 'triangle', leadDur: 1.3, pad: 'sine', density: 0.55 },
  fantasy: { day: [0, 2, 4, 6, 7, 9, 11], night: [0, 2, 3, 5, 7, 9, 10], rootDay: 293.66, rootNight: 246.94, beat: 1.7, lead: 'triangle', leadDur: 1.8, pluck: true, pad: 'sine', bells: true, density: 0.6 },
  apocalypse: { day: [0, 3, 5, 7, 10], night: [0, 1, 5, 7, 8], rootDay: 196, rootNight: 164.81, beat: 2.3, lead: 'sine', leadDur: 2.6, pad: 'triangle', drone: true, density: 0.25 },
  cyber: { day: [0, 3, 5, 7, 10], night: [0, 2, 3, 7, 8], rootDay: 220, rootNight: 196, beat: 0.9, lead: 'square', leadDur: 0.35, arp: true, pad: 'sawtooth', density: 0.5 },
  school: { day: [0, 2, 4, 5, 7, 9], night: [0, 2, 4, 7, 9], rootDay: 329.63, rootNight: 261.63, beat: 1.1, lead: 'square', leadDur: 0.5, pluck: true, pad: 'triangle', density: 0.65 },
  pirate: { day: [0, 2, 3, 5, 7, 9, 10], night: [0, 2, 3, 5, 7, 8, 10], rootDay: 246.94, rootNight: 220, beat: 0.75, lead: 'sawtooth', leadDur: 0.6, pad: 'square', rhythm: [1, 0, 1, 1, 0, 1], density: 0.9 },
  space: { day: [0, 2, 4, 6, 9, 11], night: [0, 2, 4, 7, 11], rootDay: 261.63, rootNight: 196, beat: 2.6, lead: 'sine', leadDur: 3.2, pad: 'sine', drone: true, bells: true, density: 0.3 },
  joseon: { day: [0, 2, 5, 7, 9], night: [0, 3, 5, 7, 10], rootDay: 233.08, rootNight: 196, beat: 1.9, lead: 'triangle', leadDur: 2.0, pluck: true, bend: 60, pad: null, drone: true, density: 0.7 },
  // any other world the player imagines ("고양이들이 다스리는 왕국"): a dreamy music box
  other: { day: [0, 2, 4, 6, 8, 10], night: [0, 2, 4, 7, 9], rootDay: 349.23, rootNight: 261.63, beat: 1.4, lead: 'sine', leadDur: 1.6, pluck: true, pad: 'sine', bells: true, density: 0.5 },
};

let enabled = read(ON_KEY) !== '0';
let volume = Math.max(0, Math.min(1, parseFloat(read(VOL_KEY) ?? '0.35')));
let out: GainNode | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let nextAt = 0;
let step = 0;
const mood = { hour: 12, weather: 'clear', happiness: 60, theme: 'modern' as WorldTheme };

const hz = (root: number, semis: number) => root * Math.pow(2, semis / 12);

function note(a: AudioContext, freq: number, at: number, dur: number, gain: number, type: OscillatorType, opts: { pluck?: boolean; bend?: number; lowpass?: number } = {}) {
  if (!out) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  if (opts.bend) {
    // slide into the note from slightly above, like a plucked string being pressed (농현)
    o.detune.setValueAtTime(opts.bend, at);
    o.detune.exponentialRampToValueAtTime(1, at + 0.25);
  }
  const attack = opts.pluck ? 0.01 : Math.min(0.6, dur * 0.25);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  let node: AudioNode = o.connect(g);
  if (opts.lowpass) {
    // soften harsh waveforms (square / saw) so they sit in the background
    const f = a.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = opts.lowpass;
    node = node.connect(f);
  }
  node.connect(out);
  o.start(at);
  o.stop(at + dur + 0.05);
}

// ───────── jazz piano (C105): every world plays a soft jazz-piano trio feel ─────────
// key and tempo per world theme; a few signature colours (bells, drone) now and then
const JAZZ: Record<WorldTheme, { key: number; bpm: number; minor?: boolean }> = {
  modern: { key: 261.63, bpm: 84 },
  fantasy: { key: 293.66, bpm: 76 },
  apocalypse: { key: 196, bpm: 64, minor: true },
  cyber: { key: 220, bpm: 92, minor: true },
  school: { key: 329.63, bpm: 96 },
  pirate: { key: 246.94, bpm: 100 },
  space: { key: 261.63, bpm: 60 },
  joseon: { key: 233.08, bpm: 70 },
  other: { key: 349.23, bpm: 80 },
};
// chords: root (semitones from the key) + voicing (from the chord root)
type Chord = { r: number; v: number[]; scale: number[] };
const maj9: Omit<Chord, 'r'> = { v: [4, 7, 11, 14], scale: [0, 2, 4, 7, 9, 11] };
const min9: Omit<Chord, 'r'> = { v: [3, 7, 10, 14], scale: [0, 2, 3, 5, 7, 10] };
const dom13: Omit<Chord, 'r'> = { v: [4, 10, 14, 21], scale: [0, 2, 4, 7, 9, 10] };
const PROGS_MAJOR: Chord[][] = [
  [{ r: 2, ...min9 }, { r: 7, ...dom13 }, { r: 0, ...maj9 }, { r: 9, ...min9 }], // ii V I vi
  [{ r: 0, ...maj9 }, { r: 9, ...min9 }, { r: 2, ...min9 }, { r: 7, ...dom13 }], // I vi ii V
  [{ r: 5, ...maj9 }, { r: 4, ...min9 }, { r: 2, ...min9 }, { r: 0, ...maj9 }], // IV iii ii I
  [{ r: 4, ...min9 }, { r: 9, ...min9 }, { r: 2, ...min9 }, { r: 7, ...dom13 }], // iii vi ii V
];
const PROGS_MINOR: Chord[][] = [
  [{ r: 0, ...min9 }, { r: 5, ...min9 }, { r: 10, ...dom13 }, { r: 3, ...maj9 }], // i iv bVII bIII
  [{ r: 0, ...min9 }, { r: 8, ...maj9 }, { r: 5, ...min9 }, { r: 7, ...dom13 }], // i bVI iv V
];

let bus: GainNode | null = null; // piano → (dry + room) → out
let jazzBar = 0, jazzStep = 0, prog: Chord[] = PROGS_MAJOR[0], lastMel = 7;

function room(a: AudioContext) {
  if (bus || !out) return;
  bus = a.createGain();
  bus.gain.value = 1;
  bus.connect(out);
  // a small room: two feedback delays through a low-pass, mixed in quietly
  for (const [t, fb] of [[0.137, 0.32], [0.211, 0.28]] as const) {
    const d = a.createDelay(1);
    d.delayTime.value = t;
    const f = a.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2200;
    const g = a.createGain();
    g.gain.value = fb;
    const wet = a.createGain();
    wet.gain.value = 0.22;
    bus.connect(d);
    d.connect(f);
    f.connect(g);
    g.connect(d);
    f.connect(wet);
    wet.connect(out);
  }
}

/** one piano key: a few partials, a hammer-fast attack, brightness that fades with the note */
function piano(a: AudioContext, freq: number, at: number, dur: number, vel: number) {
  if (!bus) return;
  const g = a.createGain();
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(Math.min(6000, 1800 + freq * 3), at);
  f.frequency.exponentialRampToValueAtTime(Math.max(500, freq * 1.5), at + Math.min(1.2, dur));
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vel, at + 0.006);
  g.gain.exponentialRampToValueAtTime(vel * 0.35, at + 0.22);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  g.connect(f);
  f.connect(bus);
  for (const [mult, amp, type, det] of [[1, 1, 'triangle', 0], [1, 0.5, 'sine', 4], [2, 0.35, 'sine', -3], [3, 0.12, 'sine', 2]] as const) {
    const o = a.createOscillator();
    const og = a.createGain();
    o.type = type;
    o.frequency.value = freq * mult;
    o.detune.value = det;
    og.gain.value = amp;
    o.connect(og);
    og.connect(g);
    o.start(at);
    o.stop(at + dur + 0.05);
  }
}

function tick() {
  const a = audioContext();
  if (!a || !out) return;
  room(a);
  const J = JAZZ[mood.theme] ?? JAZZ.modern;
  const S = STYLES[mood.theme] ?? STYLES.modern;
  const night = mood.hour >= 20 || mood.hour < 6;
  const storm = mood.weather === 'storm';
  const rain = mood.weather === 'rain' || mood.weather === 'snow';
  const peaceful = !storm && !rain && mood.happiness >= 55;
  const bpm = J.bpm * (night ? 0.78 : rain ? 0.88 : 1) * (peaceful ? 1 : 0.95);
  const beatDur = 60 / bpm;
  const minor = J.minor || (night && !peaceful) || mood.happiness < 35;
  const key = J.key * (night ? 0.89 : 1);
  while (nextAt < a.currentTime + 0.5) {
    if (nextAt < a.currentTime) nextAt = a.currentTime + 0.05;
    if (jazzStep === 0 && jazzBar % 4 === 0) {
      const set = minor ? PROGS_MINOR : PROGS_MAJOR;
      prog = set[Math.floor(Math.random() * set.length)];
    }
    // at night a chord lasts two bars (ballad)
    const chord = prog[Math.floor(jazzBar / (night ? 2 : 1)) % prog.length];
    const root = hz(key, chord.r - 12);
    const vel = (night ? 0.05 : 0.065) * (rain ? 0.85 : 1);
    if (!storm) {
      // left hand: bass on 1 (and a fifth on 3), the shell voicing on 1 or a syncopated "and of 2"
      if (jazzStep === 0) piano(a, hz(key, chord.r - 24), nextAt, beatDur * 3.2, vel * 0.9);
      if (jazzStep === 4 && !night) piano(a, hz(key, chord.r - 17), nextAt, beatDur * 1.8, vel * 0.6);
      const comp = jazzStep === 0 ? Math.random() < 0.55 : jazzStep === 3 ? Math.random() < (peaceful ? 0.5 : 0.3) : jazzStep === 6 ? Math.random() < 0.2 : false;
      if (comp) for (const v of chord.v) piano(a, root * Math.pow(2, v / 12), nextAt + Math.random() * 0.012, beatDur * (night ? 3 : 1.6), vel * 0.42);
      // right hand: a lazy swung line on chord tones and the chord's scale; more when it's peaceful
      const p = (night ? 0.22 : rain ? 0.25 : peaceful ? 0.5 : 0.36) * (jazzStep % 2 ? 0.7 : 1);
      if (Math.random() < p) {
        const pool = chord.scale.map((x) => x + chord.r).flatMap((x) => [x, x + 12]).sort((x, y) => x - y);
        // step-wise motion from the last note, landing on chord tones on strong beats
        const strong = jazzStep % 2 === 0;
        const tones = strong ? chord.v.map((x) => (x + chord.r) % 12).flatMap((x) => [x, x + 12]) : pool;
        const near = tones.sort((x, y) => Math.abs(x - lastMel) - Math.abs(y - lastMel)).slice(0, 3);
        lastMel = near[Math.floor(Math.random() * near.length)] ?? lastMel;
        if (lastMel > 19) lastMel -= 12;
        piano(a, hz(key, lastMel + (night ? 0 : 12)), nextAt, beatDur * (strong ? 1.4 : 0.8), vel * (strong ? 0.9 : 0.7));
      }
      // the world's own colour, now and then
      if (S.bells && jazzStep === 0 && Math.random() < 0.12) note(a, hz(key, chord.v[1] + chord.r + 24), nextAt, 2.6, 0.016, 'sine', { pluck: true });
      if (S.drone && jazzStep === 0 && jazzBar % 4 === 0) note(a, hz(key, -24), nextAt, beatDur * 16, 0.014, 'sine');
    }
    // swing: the off-beat eighth comes late (2:1)
    const onBeat = jazzStep % 2 === 0;
    nextAt += onBeat ? beatDur * 0.64 : beatDur * 0.36;
    jazzStep = (jazzStep + 1) % 8;
    if (jazzStep === 0) jazzBar++;
    step++;
  }
}

// ───────── title screen: a bright chiptune loop (C112) ─────────
let mode: 'game' | 'title' = 'game';
let noise: AudioBuffer | null = null;
let chipStep = 0;
const CHIP_BPM = 132;
// I – V – vi – IV in C, one chord per bar (semitones from C)
const CHIP_PROG = [
  [0, 4, 7],
  [7, 11, 14],
  [9, 12, 16],
  [5, 9, 12],
];
// a 4-bar hook on eighth notes (semitones from C, null = rest); the second half answers an octave up
const HOOK: (number | null)[] = [
  12, null, 16, 19, 21, 19, 16, null, 14, null, 19, 23, 26, 23, 19, null,
  16, null, 19, 21, 24, 21, 19, 16, 17, null, 16, 14, 12, null, null, null,
];

function chip(a: AudioContext, freq: number, at: number, dur: number, gain: number, type: OscillatorType, sweep?: number) {
  if (!out) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (sweep) o.frequency.exponentialRampToValueAtTime(sweep, at + dur);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.004);
  g.gain.exponentialRampToValueAtTime(gain * 0.5, at + dur * 0.5);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  let node: AudioNode = o.connect(g);
  if (type === 'square' || type === 'sawtooth') {
    const f = a.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 3200;
    node = node.connect(f);
  }
  node.connect(out);
  o.start(at);
  o.stop(at + dur + 0.02);
}
function hat(a: AudioContext, at: number, gain: number) {
  if (!out) return;
  if (!noise) {
    noise = a.createBuffer(1, Math.floor(a.sampleRate * 0.06), a.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = a.createBufferSource();
  s.buffer = noise;
  const f = a.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = 6500;
  const g = a.createGain();
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
  s.connect(f);
  f.connect(g);
  g.connect(out);
  s.start(at);
  s.stop(at + 0.06);
}
function chipTick() {
  const a = audioContext();
  if (!a || !out) return;
  const six = 60 / CHIP_BPM / 4; // a sixteenth
  const C = 261.63;
  while (nextAt < a.currentTime + 0.4) {
    if (nextAt < a.currentTime) nextAt = a.currentTime + 0.05;
    const bar = Math.floor(chipStep / 16) % 4;
    const s16 = chipStep % 16;
    const chord = CHIP_PROG[bar];
    const round = Math.floor(chipStep / 64); // every 4 bars
    // arpeggio on every sixteenth (the classic handheld shimmer)
    chip(a, hz(C, chord[s16 % 3] + 12 * (s16 % 6 < 3 ? 0 : 1)), nextAt, six * 0.9, 0.018, 'square');
    // bass: root / octave on eighths
    if (s16 % 2 === 0) chip(a, hz(C, chord[0] - 24 + (s16 % 4 === 2 ? 12 : 0)), nextAt, six * 1.8, 0.05, 'triangle');
    // kick on 1 and 3, hats on the off-eighths
    if (s16 % 8 === 0) chip(a, 140, nextAt, 0.12, 0.09, 'sine', 45);
    if (s16 % 4 === 2) hat(a, nextAt, 0.035);
    // the hook (eighths), silent every fourth round so it breathes
    if (s16 % 2 === 0 && round % 4 !== 3) {
      const n = HOOK[(Math.floor(chipStep / 2) % 32)];
      if (n !== null) chip(a, hz(C, n + (round % 2 ? 12 : 0)), nextAt, six * 1.7, 0.03, 'square');
    }
    chipStep++;
    nextAt += six;
  }
}

// ───────── in-game chiptune (C118): the title's instruments, the world's mood ─────────
// jazz-flavoured chords played as handheld-style arpeggios: busy and bright on a happy day,
// slow triangle arps at night, minor and sparse in the rain, nearly silent in a storm
let gBar = 0, gStep = 0, gProg: Chord[] = PROGS_MAJOR[0], gMel = 7;
function gameChipTick() {
  const a = audioContext();
  if (!a || !out) return;
  const J = JAZZ[mood.theme] ?? JAZZ.modern;
  const S = STYLES[mood.theme] ?? STYLES.modern;
  const night = mood.hour >= 20 || mood.hour < 6;
  const storm = mood.weather === 'storm';
  const rain = mood.weather === 'rain' || mood.weather === 'snow';
  const peaceful = !storm && !rain && mood.happiness >= 55;
  const minor = J.minor || rain || mood.happiness < 35;
  const bpm = J.bpm * 1.15 * (night ? 0.78 : rain ? 0.88 : 1);
  const six = 60 / bpm / 4;
  const key = J.key * (night ? 0.89 : 1);
  while (nextAt < a.currentTime + 0.4) {
    if (nextAt < a.currentTime) nextAt = a.currentTime + 0.05;
    if (gStep === 0 && gBar % 4 === 0) {
      const set = minor ? PROGS_MINOR : PROGS_MAJOR;
      gProg = set[Math.floor(Math.random() * set.length)];
    }
    const chord = gProg[Math.floor(gBar / (night ? 2 : 1)) % gProg.length];
    const s16 = gStep;
    const tones = [0, ...chord.v].map((v) => chord.r + v);
    if (storm) {
      if (s16 === 0 && gBar % 2 === 0) chip(a, hz(key, chord.r - 24), nextAt, six * 30, 0.03, 'triangle');
    } else {
      // arpeggio: 16ths on a bright day, 8ths otherwise; triangle (softer) at night
      const every = peaceful && !night ? 1 : 2;
      if (s16 % every === 0) {
        const i = Math.floor(s16 / every);
        const n = tones[i % tones.length] + (i % (tones.length * 2) < tones.length ? 0 : 12);
        chip(a, hz(key, n), nextAt, six * every * 0.9, night ? 0.016 : rain ? 0.011 : 0.013, night ? 'triangle' : 'square');
      }
      // bass on 1 (and 3 by day)
      if (s16 === 0 || (s16 === 8 && !night)) chip(a, hz(key, chord.r - 24 + (s16 === 8 ? 7 : 0)), nextAt, six * (night ? 12 : 6), 0.05, 'triangle');
      // drums only when it's light and calm: soft kick on 1, hats on the off-beats
      if (peaceful && !night) {
        if (s16 === 0) chip(a, 130, nextAt, 0.1, 0.06, 'sine', 45);
        if (s16 % 4 === 2) hat(a, nextAt, 0.022);
      } else if (!night && !rain && s16 % 8 === 4) hat(a, nextAt, 0.012);
      // melody on eighths: step-wise, landing on chord tones on strong beats; sparser at night/in rain
      const p = (night ? 0.18 : rain ? 0.22 : peaceful ? 0.42 : 0.3) * (s16 % 4 === 0 ? 1 : 0.6);
      if (s16 % 2 === 0 && Math.random() < p) {
        const pool = (s16 % 4 === 0 ? tones.map((x) => x % 12) : chord.scale.map((x) => (x + chord.r) % 12)).flatMap((x) => [x, x + 12]);
        const near = pool.sort((x, y) => Math.abs(x - gMel) - Math.abs(y - gMel)).slice(0, 3);
        gMel = near[Math.floor(Math.random() * near.length)] ?? gMel;
        if (gMel > 19) gMel -= 12;
        chip(a, hz(key, gMel + 12), nextAt, six * (s16 % 4 === 0 ? 3.2 : 1.8), night ? 0.022 : 0.026, night ? 'triangle' : 'square');
      }
      if (S.bells && s16 === 0 && Math.random() < 0.12) note(a, hz(key, tones[1] + 24), nextAt, 2.4, 0.014, 'sine', { pluck: true });
      if (S.drone && s16 === 0 && gBar % 4 === 0) note(a, hz(key, -24), nextAt, six * 64, 0.012, 'sine');
    }
    nextAt += six;
    gStep = (gStep + 1) % 16;
    if (gStep === 0) gBar++;
    step++;
  }
}
/** in-game style: chiptune (default) or jazz piano */
const STYLE_KEY = 'asiwrite.musicStyle';
let gameStyle: 'chip' | 'jazz' = read(STYLE_KEY) === 'jazz' ? 'jazz' : 'chip';

/** tabs of the game tell each other who's playing (the newest one keeps the music) */
const channel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('asiwrite-music') : null;
channel?.addEventListener('message', (e) => {
  if (e.data === 'playing' && timer) music.stop();
});
function stopSelf() {
  music.stop();
}

export const music = {
  /** start playing (call after a user gesture, e.g. entering the game) */
  start() {
    if (!enabled || isMuted() || timer) return;
    const a = audioContext();
    if (!a) return;
    out = a.createGain();
    out.gain.value = 0.0001;
    out.connect(a.destination);
    out.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * 0.9), a.currentTime + 2);
    nextAt = a.currentTime + 0.3;
    // only one music loop at a time: a leftover loop (an older copy of this module after a hot reload) is stopped
    const g = globalThis as unknown as { __asiwriteMusicStop?: () => void };
    if (g.__asiwriteMusicStop && g.__asiwriteMusicStop !== stopSelf) g.__asiwriteMusicStop();
    g.__asiwriteMusicStop = stopSelf;
    timer = setInterval(() => (mode === 'title' ? chipTick() : gameStyle === 'jazz' ? tick() : gameChipTick()), 200);
    // …and only one tab plays: tell the others to go quiet
    channel?.postMessage('playing');
  },
  stop() {
    if (timer) clearInterval(timer);
    timer = null;
    const a = audioContext();
    if (a && out) {
      const g = out;
      g.gain.cancelScheduledValues(a.currentTime);
      g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 1);
      setTimeout(() => g.disconnect(), 1200);
    }
    out = null;
    bus = null;
  },
  /** title screen (bright chiptune) or the game (jazz piano that follows the world) */
  setMode(m: 'game' | 'title') {
    if (m === mode) return;
    mode = m;
    chipStep = 0;
    step = 0;
  },
  get mode() {
    return mode;
  },
  /** is the loop running in this tab */
  get playing() {
    return !!timer;
  },
  get style() {
    return gameStyle;
  },
  setStyle(st: 'chip' | 'jazz') {
    gameStyle = st;
    write(STYLE_KEY, st);
    gBar = gStep = 0;
  },
  /** what the world feels like right now (context = the world setting, e.g. "중세 판타지 왕국") */
  update(m: { hour: number; weather: string; happiness: number; context?: string }) {
    const theme = m.context ? worldTheme(m.context) : mood.theme;
    if (theme !== mood.theme) step = 0; // a new world: start its phrase from the top
    Object.assign(mood, { hour: m.hour, weather: m.weather, happiness: m.happiness, theme });
  },
  /** which theme is playing (for the settings window) */
  get theme() {
    return mood.theme;
  },
  get enabled() {
    return enabled;
  },
  setEnabled(on: boolean) {
    enabled = on;
    write(ON_KEY, on ? '1' : '0');
    if (!on) this.stop();
  },
  get volume() {
    return volume;
  },
  setVolume(v: number) {
    volume = Math.max(0, Math.min(1, v));
    write(VOL_KEY, String(volume));
    const a = audioContext();
    if (a && out) out.gain.setTargetAtTime(Math.max(0.0001, volume * 0.9), a.currentTime, 0.2);
  },
};

// a hot reload of this file (development) must not leave the old loop playing under the new one
if (import.meta.hot) import.meta.hot.dispose(() => {
  music.stop();
  channel?.close();
});
