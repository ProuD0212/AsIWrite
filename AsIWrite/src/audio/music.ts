// Generative background music (Web Audio, no audio files). Soft pentatonic notes and pads that
// follow the world: bright and lively by day, lower and slower at night, sparse in the rain,
// almost silent in a storm, a little brighter when the town is happy.

import { audioContext, isMuted } from './sfx';

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

let enabled = read(ON_KEY) !== '0';
let volume = Math.max(0, Math.min(1, parseFloat(read(VOL_KEY) ?? '0.35')));
let out: GainNode | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let nextAt = 0;
let step = 0;
const mood = { hour: 12, weather: 'clear', happiness: 60 };

const DAY = [0, 2, 4, 7, 9]; // major pentatonic
const NIGHT = [0, 3, 5, 7, 10]; // minor pentatonic
const hz = (root: number, semis: number) => root * Math.pow(2, semis / 12);

function note(a: AudioContext, freq: number, at: number, dur: number, gain: number, type: OscillatorType) {
  if (!out) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + Math.min(0.6, dur * 0.25));
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(out);
  o.start(at);
  o.stop(at + dur + 0.05);
}

function tick() {
  const a = audioContext();
  if (!a || !out) return;
  const night = mood.hour >= 20 || mood.hour < 6;
  const storm = mood.weather === 'storm';
  const rain = mood.weather === 'rain' || mood.weather === 'snow';
  const beat = night ? 2.4 : rain ? 2.0 : 1.5; // seconds per step
  // schedule a little ahead so timing stays smooth even if the tab is busy
  while (nextAt < a.currentTime + 0.5) {
    if (nextAt < a.currentTime) nextAt = a.currentTime + 0.05;
    const scale = night ? NIGHT : DAY;
    const root = night ? 220 : mood.happiness >= 65 ? 293.66 : 261.63;
    // a soft pad every 4 steps
    if (step % 4 === 0 && !storm) {
      const base = scale[(step / 4) % scale.length];
      for (const s of [base - 12, base - 5, base]) note(a, hz(root, s), nextAt, beat * 4.2, rain ? 0.018 : 0.022, 'sine');
    }
    // melody notes, sparser at night / in the rain, none in a storm
    const p = storm ? 0 : night ? 0.35 : rain ? 0.3 : 0.55 + (mood.happiness - 50) / 200;
    if (Math.random() < p) {
      const s = scale[Math.floor(Math.random() * scale.length)] + (Math.random() < 0.3 ? 12 : 0);
      note(a, hz(root, s), nextAt, night ? 2.2 : 1.3, night ? 0.035 : 0.045, 'triangle');
    }
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
  /** what the world feels like right now */
  update(m: { hour: number; weather: string; happiness: number }) {
    Object.assign(mood, m);
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
