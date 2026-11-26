// Build the game bundle the launchers install (게임 묶음).
//
//   node tools/release.mjs                 → release/asiwrite-game-<version>.zip + SHA-256 written to launcher/runtime.lock
//   node tools/release.mjs --version 1.0.0 → same, with an explicit version
//   node tools/release.mjs --out <dir>     → build straight into <dir> (the launchers' "build from source" path)
//
// The bundle = the built page (game/) + one dependency-free server.mjs (server/game-server.ts + server/lanShare.ts).
// Upload the zip as a GitHub Release asset (the command is printed), then commit launcher/runtime.lock.

import { build } from 'vite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const outDir = arg('--out') ? path.resolve(arg('--out')) : path.join(root, 'release', 'stage');
const zipMode = !arg('--out');
const version = arg('--version') ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
console.log(`· 게임 화면 빌드 → ${path.relative(root, path.join(outDir, 'game')) || outDir}`);
await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: path.join(outDir, 'game'), emptyOutDir: true } });
console.log('· 서버 묶기 → server.mjs');
await build({
  root, configFile: false, logLevel: 'warn',
  publicDir: false,
  build: { ssr: path.join(root, 'server/game-server.ts'), outDir, emptyOutDir: false, target: 'node22', rollupOptions: { output: { entryFileNames: 'server.mjs', format: 'es' } } },
});
fs.writeFileSync(path.join(outDir, 'VERSION'), `${version}\n`);
if (!zipMode) {
  fs.writeFileSync(path.join(outDir, '.built'), new Date().toISOString());
  console.log(`✔ ${outDir}`);
  process.exit(0);
}

// zip it (bsdtar on macOS/Windows; zip on Linux)
const relDir = path.join(root, 'release');
const name = `asiwrite-game-${version}.zip`;
const zip = path.join(relDir, name);
fs.rmSync(zip, { force: true });
try {
  // name the entries explicitly: a leading "./" trips up Windows' Expand-Archive
  execFileSync('tar', ['-a', '-cf', zip, '-C', outDir, ...fs.readdirSync(outDir)], { stdio: 'inherit' });
  if (!fs.existsSync(zip) || fs.readFileSync(zip).subarray(0, 2).toString() !== 'PK') throw new Error('not a zip');
} catch {
  fs.rmSync(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: outDir, stdio: 'inherit' });
}
const sha = createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
const url = `https://github.com/ProuD0212/AsIWrite/releases/download/game-v${version}/${name}`;

// record it in runtime.lock (the launchers only install a file with exactly this hash)
const lockFile = path.join(root, 'launcher', 'runtime.lock');
let lock = fs.readFileSync(lockFile, 'utf8');
const set = (k, v) => {
  lock = new RegExp(`^${k}=.*$`, 'm').test(lock) ? lock.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : lock + `${k}=${v}\n`;
};
set('GAME_VERSION', version);
set('GAME_URL', url);
set('GAME_SHA256', sha);
fs.writeFileSync(lockFile, lock);
const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
console.log(`\n✔ ${path.relative(root, zip)} (${mb} MB)\n  SHA-256 ${sha}\n  runtime.lock 갱신됨.\n`);
console.log(`올리기:  gh release create game-v${version} "${path.relative(root, zip)}" --target main --title "게임 묶음 ${version}" --notes "AsIWrite Launcher 가 자동으로 받는 게임 파일"`);
console.log('그다음 launcher/runtime.lock 을 커밋하세요.');
