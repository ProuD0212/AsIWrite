// Fake Web Audio: count what the music scheduler plays per world theme (time runs 20× faster).
const t0 = Date.now();
const notes: { type: string; bend: boolean; filtered: boolean }[] = [];
const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} });
class FakeAC {
  state = 'running';
  destination = {};
  get currentTime() { return ((Date.now() - t0) / 1000) * 2; }
  resume() {}
  sampleRate = 44100;
  createBuffer(_c: number, n: number) { return { getChannelData: () => new Float32Array(n) }; }
  createBufferSource() { return { buffer: null, connect(n: unknown) { return n; }, start() {}, stop() {} }; }
  createDelay() { return { delayTime: param(), connect(n: unknown) { return n; } }; }
  createGain() { return { gain: param(), connect(n: unknown) { return n; }, disconnect() {} }; }
  createBiquadFilter() { const f = { type: '', frequency: param(), connect(n: unknown) { return n; } }; return f; }
  createOscillator() {
    const o: any = { type: 'sine', frequency: param(), detune: { ...param(), setValueAtTime() { o.bent = true; } }, connect(n: any) { return n; }, start() { notes.push({ type: o.type, bend: !!o.bent, filtered: false }); }, stop() {} };
    return o;
  }
}
(FakeAC.prototype as any).sampleRate = 44100;
(FakeAC.prototype as any).createBuffer = (_c: number, n: number) => ({ getChannelData: () => new Float32Array(n) });
(FakeAC.prototype as any).createBufferSource = () => ({ buffer: null, connect(n: unknown) { return n; }, start() {}, stop() {} });
(globalThis as any).AudioContext = FakeAC;
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? pass++ : fail++, console.log(c ? 'PASS' : 'FAIL', m));
// a leftover loop from an "older copy" of the module
let oldStopped = false;
(globalThis as any).__asiwriteMusicStop = () => (oldStopped = true);
const { music } = await import('../src/audio/music');
music.setEnabled(true);
music.start();
ok(oldStopped && music.playing, 'starting stops a leftover loop from an older copy (hot reload)');
// another tab starts playing → this one goes quiet
const other = new BroadcastChannel('asiwrite-music');
other.postMessage('playing');
await new Promise((r) => setTimeout(r, 200));
ok(!music.playing, 'another tab started music → this tab stops');
// and it can play again later (the newest tab wins)
music.start();
const n0 = notes.length;
await new Promise((r) => setTimeout(r, 1500));
ok(music.playing && notes.length > n0, `plays again when started (${notes.length - n0} oscillators in 3 s)`);
// starting twice never makes two loops
music.start(); music.start();
const n1 = notes.length;
await new Promise((r) => setTimeout(r, 1500));
const rate1 = notes.length - n1;
ok(rate1 < (notes.length - n0) * 1.5 + 20, `double start keeps one loop (${rate1} in the next 3 s)`);
other.close();
music.stop();
console.log(`=== ${pass} passed, ${fail} failed ===`);
process.exit(0);
