// Headless test runner: builds every tests/*.test.ts against the real engine (no browser) and runs it.
// Each test prints "PASS …" / "FAIL …" lines and a "=== n passed, m failed ===" summary.
//   npm test                 all tests
//   npm test -- map rotation only tests whose file name contains one of the words
import { build } from 'vite';
import { spawn } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '.out');
const only = process.argv.slice(2).map((s) => s.toLowerCase());
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => !only.length || only.some((w) => f.toLowerCase().includes(w)))
  .sort();
if (!files.length) {
  console.log('no tests matched');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
console.log(`building ${files.length} test file(s)…`);
await build({
  configFile: false,
  logLevel: 'error',
  root: resolve(here, '..'),
  build: {
    ssr: true,
    outDir: out,
    emptyOutDir: true,
    target: 'node20',
    rollupOptions: { input: Object.fromEntries(files.map((f) => [f.replace(/\.test\.ts$/, ''), join(here, f)])) },
  },
});

const run = (name) =>
  new Promise((done) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [join(out, `${name}.js`)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    p.stdout.on('data', (d) => (text += d));
    p.stderr.on('data', (d) => (text += d));
    p.on('close', (code) => {
      const sums = [...text.matchAll(/=== (\d+) passed, (\d+) failed/g)].map((m) => [+m[1], +m[2]]);
      const passed = sums.reduce((s, x) => s + x[0], 0);
      const failed = sums.reduce((s, x) => s + x[1], 0);
      const crashed = code !== 0 && !failed && !sums.length;
      done({ name, passed, failed, crashed, secs: (Date.now() - t0) / 1000, text, code });
    });
  });

let total = 0, bad = 0;
for (const f of files) {
  const name = f.replace(/\.test\.ts$/, '');
  const r = await run(name);
  total += r.passed;
  const ok = !r.failed && !r.crashed;
  if (!ok) bad++;
  console.log(`${ok ? '✔' : '✘'} ${name.padEnd(16)} ${String(r.passed).padStart(3)} passed${r.failed ? `, ${r.failed} failed` : ''}${r.crashed ? ` — crashed (exit ${r.code})` : ''}  (${r.secs.toFixed(0)}s)`);
  if (!ok) {
    for (const line of r.text.split('\n')) if (/^FAIL|Error|error/.test(line)) console.log('    ' + line.slice(0, 220));
  }
}
console.log(`\n${bad ? '✘' : '✔'} ${total} checks passed${bad ? `, ${bad} file(s) with failures` : ''}`);
process.exit(bad ? 1 : 0);
