// Generative background music (Web Audio, no audio files). Soft notes and pads that follow the
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

function tick() {
  const a = audioContext();
  if (!a || !out) return;
  const S = STYLES[mood.theme] ?? STYLES.modern;
  const night = mood.hour >= 20 || mood.hour < 6;
  const storm = mood.weather === 'storm';
  const rain = mood.weather === 'rain' || mood.weather === 'snow';
  const beat = S.beat * (night ? 1.5 : rain ? 1.25 : 1);
  const harsh = S.lead === 'square' || S.lead === 'sawtooth';
  // schedule a little ahead so timing stays smooth even if the tab is busy
  while (nextAt < a.currentTime + 0.5) {
    if (nextAt < a.currentTime) nextAt = a.currentTime + 0.05;
    const scale = night ? S.night : S.day;
    const root = night ? S.rootNight : S.rootDay * (mood.happiness >= 65 ? 1.06 : 1);
    const padEvery = Math.max(4, Math.round(6 / S.beat));
    if (S.pad && step % padEvery === 0 && !storm) {
      const base = scale[Math.floor(step / padEvery) % scale.length];
      const padType = S.pad;
      for (const s of [base - 12, base - 5, base]) note(a, hz(root, s), nextAt, beat * padEvery * 1.05, rain ? 0.014 : 0.018, padType, { lowpass: padType === 'sine' ? undefined : 900 });
    }
    if (S.drone && step % (padEvery * 2) === 0) note(a, hz(root, -24), nextAt, beat * padEvery * 2.1, 0.02, 'sine');
    const accent = S.rhythm ? S.rhythm[step % S.rhythm.length] === 1 : true;
    const p = storm ? 0 : (night ? 0.6 : rain ? 0.55 : 1) * (S.density + (mood.happiness - 50) / 250);
    if (accent && Math.random() < p) {
      const s = scale[Math.floor(Math.random() * scale.length)] + (Math.random() < 0.3 ? 12 : 0);
      const gain = (night ? 0.03 : 0.042) * (harsh ? 0.6 : 1);
      if (S.arp) {
        // three quick notes up the scale
        const i = scale.indexOf(s % 12) >= 0 ? scale.indexOf(s % 12) : 0;
        for (let k = 0; k < 3; k++) note(a, hz(root, scale[(i + k * 2) % scale.length] + (k === 2 ? 12 : 0)), nextAt + k * (beat / 3), S.leadDur, gain, S.lead, { lowpass: 1600 });
      } else note(a, hz(root, s), nextAt, S.leadDur * (night ? 1.4 : 1), gain, S.lead, { pluck: S.pluck, bend: S.bend, lowpass: harsh ? 1400 : undefined });
    }
    if (S.bells && !storm && Math.random() < 0.08) note(a, hz(root, scale[Math.floor(Math.random() * scale.length)] + 24), nextAt, 2.8, 0.02, 'sine', { pluck: true });
    step++;
    nextAt += beat;
  }
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
    timer = setInterval(tick, 250);
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
