// On the server PC: the open game tab works for visitors. It long-polls the share server for AI
// jobs from other PCs, runs them on this PC's storyteller / meaning model, and posts the results.
// Does nothing when the game isn't served by the dev/preview server (no /__ai endpoint).

import { embeddings } from './embeddings';
import { storyteller } from './storyteller';
import { f32ToB64, isRemotePage } from './remote';
import type { ChatMsg } from './protocol';

let running = false;
export const relayStats = { served: 0 };

export function startRelayHost() {
  if (running || isRemotePage() || typeof fetch === 'undefined') return;
  running = true;
  const loop = async () => {
    for (;;) {
      const story = storyteller.state === 'ready' && storyteller.backend() !== 'off';
      const embed = embeddings.state === 'ready';
      let r: Response;
      try {
        r = await fetch(`/__ai/poll?story=${story ? 1 : 0}&embed=${embed ? 1 : 0}&label=${encodeURIComponent(story ? storyteller.label() : '')}`);
      } catch {
        await new Promise((ok) => setTimeout(ok, 5000));
        continue;
      }
      if (r.status === 404 || !(r.headers.get('content-type') ?? '').includes('json')) {
        if (r.status === 204) continue;
        running = false; // not served by our dev/preview server: no relay
        return;
      }
      const job = (await r.json().catch(() => null)) as { id: number; kind: 'gen' | 'embed'; payload: unknown } | null;
      if (!job) continue;
      void run(job); // don't block the next poll: jobs queue in the storyteller
    }
  };
  void loop();
}

async function run(job: { id: number; kind: 'gen' | 'embed'; payload: unknown }) {
  let ok = false;
  let result: unknown = null;
  try {
    if (job.kind === 'gen') {
      const p = job.payload as { messages: ChatMsg[]; maxTokens: number; temperature: number; kind?: string };
      const text = await storyteller.generateRaw(p.messages, Math.min(400, p.maxTokens || 120), p.temperature ?? 0.5);
      ok = text !== null;
      result = { text };
    } else {
      const p = job.payload as { texts: string[] };
      const v = await embeddings.embedBatch((p.texts ?? []).slice(0, 64));
      ok = !!v;
      if (v) result = { dim: v.dim, data: f32ToB64(v.data) };
    }
  } catch {
    ok = false;
  }
  if (ok) relayStats.served++;
  await fetch('/__ai/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, ok, result }) }).catch(() => undefined);
}
