// The standalone game server the launcher starts (AsIWrite Launcher.bat / .command) — no packages needed.
//
// It serves the built game (the `game/` folder next to this file) on localhost and mounts the same
// endpoints the Vite dev server has: 「다른 PC에서 접속」 (LAN share), the AI relay and 「종료」.
// tools/release.mjs bundles this file (with lanShare.ts) into a single `server.mjs`.
//
//   node server.mjs [--port 5173] [--port-file path]
// Prints "ASIWRITE_READY http://localhost:PORT" and writes the port to --port-file once listening.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLanShare, type MountableServer } from './lanShare.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'game');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const firstPort = Number(arg('--port') ?? 5173);
const portFile = arg('--port-file');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => unknown;
const mounts: [string, Handler][] = [];
const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';
  // connect-style mounts: "/__share/start" → handler sees "/start"
  for (const [prefix, h] of mounts) {
    if (url === prefix || url.startsWith(prefix + '/') || url.startsWith(prefix + '?')) {
      req.url = url.slice(prefix.length) || '/';
      try {
        await h(req, res);
      } catch (e) {
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.end(String(e));
        }
      }
      return;
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    return res.end();
  }
  // static files (never outside the game folder); unknown paths get the page itself
  let rel = decodeURIComponent(new URL(url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) {
    res.statusCode = 403;
    return res.end();
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  const ext = path.extname(file).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  // hashed build files never change; the page itself always revalidates
  res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.setHeader('Content-Length', fs.statSync(file).size);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
});

const app: MountableServer = { middlewares: { use: (prefix, handler) => void mounts.push([prefix, handler]) }, httpServer: server };
createLanShare()(app);

const listen = (port: number, left: number) => {
  server.once('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE' && left > 0) listen(port + 1, left - 1);
    else {
      console.error(`[!] 서버를 열 수 없어요: ${e.message}`);
      process.exit(1);
    }
  });
  // localhost only — other PCs come in through the LAN-share proxy, and only when the player turns it on
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    if (portFile) fs.writeFileSync(portFile, String(port));
    console.log(`ASIWRITE_READY ${url}`);
  });
};
if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error(`[!] 게임 파일이 없어요: ${root}`);
  process.exit(1);
}
listen(firstPort, 20);
