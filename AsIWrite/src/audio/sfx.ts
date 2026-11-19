// Synthesized sound effects (Web Audio). No audio files in the repo.

let ac: AudioContext | null = null;
let master: GainNode | null = null;
let volume = 0.5;
let muted = false;

try {
  const v = localStorage.getItem('asiwrite.volume');
  if (v !== null) volume = Math.max(0, Math.min(1, parseFloat(v)));
  muted = localStorage.getItem('asiwrite.muted') === '1';
} catch {
  /* storage unavailable */
}

function ctx(): AudioContext | null {
  if (muted) return null;
  try {
    if (!ac) {
      ac = new AudioContext();
      master = ac.createGain();
      master.gain.value = volume * 0.5;
      master.connect(ac.destination);
    }
    if (ac.state === 'suspended') void ac.resume();
    return ac;
  } catch {
    return null;
  }
}

export function setVolume(v: number) {
  volume = v;
  if (master) master.gain.value = v * 0.5;
  try {
    localStorage.setItem('asiwrite.volume', String(v));
  } catch {
    /* ignore */
  }
}
export function getVolume() {
  return volume;
}
export function setMuted(m: boolean) {
  muted = m;
  try {
    localStorage.setItem('asiwrite.muted', m ? '1' : '0');
  } catch {
    /* ignore */
  }
}
export function isMuted() {
  return muted;
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.3, delay = 0, slideTo?: number) {
  const a = ctx();
  if (!a || !master) return;
  const t0 = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

function noise(dur: number, gain = 0.3, filterFreq = 1200, delay = 0) {
  const a = ctx();
  if (!a || !master) return;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = filterFreq;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(master);
  src.start(a.currentTime + delay);
}

export const sfx = {
  type() {
    tone(1400 + Math.random() * 300, 0.03, 'square', 0.03);
  },
  submit() {
    tone(660, 0.12, 'triangle', 0.18);
    tone(990, 0.18, 'triangle', 0.14, 0.06);
  },
  error() {
    tone(220, 0.15, 'square', 0.08);
    tone(180, 0.2, 'square', 0.08, 0.08);
  },
  genesis() {
    // "빛이 있으라": rising shimmer
    [262, 330, 392, 523, 659].forEach((f, i) => tone(f, 1.4, 'sine', 0.12, i * 0.09));
    tone(130, 1.8, 'triangle', 0.1, 0, 196);
  },
  whoosh() {
    noise(0.6, 0.18, 900);
  },
  spawn() {
    tone(523, 0.12, 'sine', 0.15);
    tone(784, 0.2, 'sine', 0.12, 0.07);
  },
  thunder() {
    noise(1.6, 0.6, 400);
    noise(0.3, 0.4, 3000);
  },
  select() {
    tone(880, 0.06, 'sine', 0.08);
  },
  care() {
    [523, 659, 784].forEach((f, i) => tone(f, 0.5, 'sine', 0.1, i * 0.12));
  },
  /** revolver-cylinder click */
  tick() {
    tone(2200, 0.025, 'square', 0.05);
    noise(0.04, 0.12, 2600);
  },
  warn() {
    tone(330, 0.3, 'sawtooth', 0.05);
    tone(294, 0.4, 'sawtooth', 0.05, 0.25);
  },
};
