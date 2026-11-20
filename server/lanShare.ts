// 임시 LAN 공유 서버 (Vite 플러그인)
// The game page asks this dev/preview server to open a second port on all network interfaces
// (0.0.0.0) that simply forwards raw TCP to the local server — so another PC on the same Wi-Fi
// can open http://<this PC's IP>:<port>. Turned on/off from the in-game settings; nothing is
// exposed until the player presses the button. The control endpoints only answer this PC.
//
// AI relay (/__ai/*): visitors' AI work (storyteller lines, replies, command reading, sentence
// embeddings) is queued here and picked up by the game tab open on THIS PC, which runs it on this
// PC's GPU/CPU and posts the answer back — so the heavy lifting happens on the host.

import net from 'node:net';
import os from 'node:os';
import type { Plugin, ViteDevServer, PreviewServer } from 'vite';

const SHARE_PORT = 5180;

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  // private ranges first (Wi-Fi / LAN), virtual adapters last
  return out.sort((x, y) => Number(!/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(x)) - Number(!/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(y)));
}

export function lanShare(): Plugin {
  let proxy: net.Server | null = null;
  let port = 0;
  const sockets = new Set<net.Socket>();
  // ── AI relay ──
  type Job = { id: number; kind: 'gen' | 'embed'; payload: unknown; done: (status: number, body: unknown) => void; at: number };
  const jobs: Job[] = [];
  const waiting = new Map<number, Job>();
  let hostWaiter: ((j: Job | null) => void) | null = null;
  let jobId = 1;
  let host = { at: 0, story: false, embed: false, label: '', served: 0, hidden: false };
  const hostAlive = () => Date.now() - host.at < 35000;
  const giveToHost = () => {
    if (!hostWaiter || !jobs.length) return;
    const j = jobs.shift()!;
    waiting.set(j.id, j);
    const w = hostWaiter;
    hostWaiter = null;
    w(j);
  };
  const readBody = (req: import('node:http').IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      const parts: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        parts.push(c);
        size += c.length;
        if (size > 4_000_000) req.destroy();
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || 'null'));
        } catch {
          resolve(null);
        }
      });
    });
  let target = (): { port: number; host: string } => ({ port: 5173, host: 'localhost' });

  const start = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (proxy) return resolve();
      const srv = net.createServer((client) => {
        sockets.add(client);
        const t = target();
        const upstream = net.connect(t.port, t.host);
        sockets.add(upstream);
        // remote visitors may not switch the server itself
        client.on('data', (chunk) => {
          if (/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD) \/__(share|quit|ai\/(poll|result))/m.test(chunk.toString('latin1', 0, Math.min(chunk.length, 2048)))) {
            client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            upstream.destroy();
            return;
          }
          upstream.write(chunk);
        });
        upstream.pipe(client);
        const close = () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        };
        client.on('error', close).on('close', close);
        upstream.on('error', close).on('close', close);
      });
      const tryListen = (p: number, left: number) => {
        srv.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' && left > 0 ? tryListen(p + 1, left - 1) : reject(e)));
        srv.listen(p, '0.0.0.0', () => {
          proxy = srv;
          port = p;
          resolve();
        });
      };
      tryListen(SHARE_PORT, 10);
    });
  const stop = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      if (!proxy) return resolve();
      proxy.close(() => resolve());
      proxy = null;
      port = 0;
    });

  const install = (server: ViteDevServer | PreviewServer) => {
    const addr = () => server.httpServer?.address();
    target = () => {
      const a = addr();
      // connect where the server really listens (often ::1 only on Windows)
      if (!a || typeof a !== 'object') return { port: 5173, host: 'localhost' };
      const host = a.address === '::' || a.address === '0.0.0.0' ? '127.0.0.1' : a.address;
      return { port: a.port, host };
    };
    server.middlewares.use('/__share', async (req, res) => {
      const local = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? '');
      if (!local) {
        res.statusCode = 403;
        return res.end();
      }
      try {
        if (req.method === 'POST' && req.url?.startsWith('/start')) await start();
        if (req.method === 'POST' && req.url?.startsWith('/stop')) await stop();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ on: !!proxy, port, urls: proxy ? lanAddresses().map((ip) => `http://${ip}:${port}`) : [] }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ on: false, error: String((e as Error)?.message ?? e) }));
      }
    });
    server.middlewares.use('/__ai', async (req, res) => {
      const local = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? '');
      const json = (status: number, body: unknown) => {
        if (res.writableEnded) return;
        res.statusCode = status;
        if (status === 204) return void res.end();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? '';
      if (url.startsWith('/status')) return json(200, { host: hostAlive(), story: hostAlive() && host.story, embed: hostAlive() && host.embed, label: host.label, served: host.served, queued: jobs.length, hidden: host.hidden });
      // the host tab asks for work (long poll) and reports what it can do
      if (url.startsWith('/poll') && local) {
        const q = new URL(url, 'http://x').searchParams;
        host = { ...host, at: Date.now(), story: q.get('story') === '1', embed: q.get('embed') === '1', hidden: q.get('hidden') === '1', label: q.get('label') ?? '' };
        const j = jobs.shift();
        if (j) {
          waiting.set(j.id, j);
          return json(200, { id: j.id, kind: j.kind, payload: j.payload });
        }
        hostWaiter?.(null);
        const timer = setTimeout(() => {
          if (hostWaiter === send) hostWaiter = null;
          json(204, null);
        }, 20000);
        const send = (jj: Job | null) => {
          clearTimeout(timer);
          if (jj) json(200, { id: jj.id, kind: jj.kind, payload: jj.payload });
          else json(204, null);
        };
        hostWaiter = send;
        req.on('close', () => {
          if (hostWaiter === send) hostWaiter = null;
        });
        return;
      }
      if (url.startsWith('/result') && local && req.method === 'POST') {
        const b = (await readBody(req)) as { id?: number; ok?: boolean; result?: unknown } | null;
        const j = b?.id ? waiting.get(b.id) : undefined;
        if (j) {
          waiting.delete(j.id);
          host.served++;
          j.done(b?.ok ? 200 : 502, b?.ok ? b.result : { error: 'host failed' });
        }
        return json(200, { ok: !!j });
      }
      // a visitor's job: wait for the host's answer
      if (url.startsWith('/job') && req.method === 'POST') {
        const b = (await readBody(req)) as { kind?: string; payload?: unknown } | null;
        if (!b || (b.kind !== 'gen' && b.kind !== 'embed')) return json(400, { error: 'bad job' });
        if (!hostAlive() || (b.kind === 'gen' ? !host.story : !host.embed)) return json(503, { error: 'no host' });
        if (jobs.length > 40) return json(503, { error: 'busy' });
        const j: Job = { id: jobId++, kind: b.kind, payload: b.payload, at: Date.now(), done: (s, body) => json(s, body) };
        const timer = setTimeout(() => {
          waiting.delete(j.id);
          const i = jobs.indexOf(j);
          if (i >= 0) jobs.splice(i, 1);
          json(504, { error: 'timeout' });
        }, 90000);
        const orig = j.done;
        j.done = (s, body) => {
          clearTimeout(timer);
          orig(s, body);
        };
        req.on('close', () => {
          if (res.writableEnded) return;
          const i = jobs.indexOf(j);
          if (i >= 0) jobs.splice(i, 1);
        });
        jobs.push(j);
        giveToHost();
        return;
      }
      json(404, { error: 'unknown' });
    });
    // 「종료」 on the title screen: shut the game server down (closes the launcher window too)
    server.middlewares.use('/__quit', (req, res) => {
      const local = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? '');
      if (req.method !== 'POST' || !local) {
        res.statusCode = 403;
        return res.end();
      }
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
      console.log('\n  게임에서 「종료」를 눌러 서버를 끕니다. 안녕히 가세요!\n');
      setTimeout(() => {
        void stop().finally(() => process.exit(0));
      }, 300);
    });
    server.httpServer?.on('close', () => void stop());
  };
  return {
    name: 'asiwrite-lan-share',
    configureServer: install,
    configurePreviewServer: install,
  };
}
