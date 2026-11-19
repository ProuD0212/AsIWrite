// Self-calibration of the embedding → 0..1 similarity mapping.
//
// Instead of hand-picked thresholds, we measure the model on our own anchor
// sentences: pairs that mean the same thing (same command intent, same
// personality pole) vs pairs that don't. Then
//   lo = 90th percentile of different-meaning cosines (≈ "unrelated" ceiling)
//   hi = median of same-meaning cosines (≈ "clearly the same")
// The numbers are kept for the research telemetry / report.

import { semanticCalib } from '../engine/semantic';
import { INTENT_ANCHORS } from '../commands/intents';
import { embeddings } from './embeddings';

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : 0;
};

/** Try to calibrate; returns true once done (needs all anchors embedded). */
export function tryCalibrate(): boolean {
  if (semanticCalib.calibrated || embeddings.state !== 'ready') return semanticCalib.calibrated;
  const groups = Object.values(INTENT_ANCHORS);
  const all = groups.flat();
  if (all.some((t) => !embeddings.get(t))) {
    embeddings.request(all);
    return false;
  }
  const pos: number[] = [];
  const neg: number[] = [];
  groups.forEach((g, gi) => {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) pos.push(embeddings.cosine(g[i], g[j]) ?? 0);
      groups.forEach((h, hi) => {
        if (hi <= gi) return;
        for (const b of h) neg.push(embeddings.cosine(g[i], b) ?? 0);
      });
    }
  });
  const lo = quantile(neg, 0.9);
  const hi = quantile(pos, 0.5);
  if (hi - lo >= 0.1) {
    semanticCalib.lo = lo;
    semanticCalib.hi = hi;
  }
  semanticCalib.posMedian = hi;
  semanticCalib.negP90 = lo;
  semanticCalib.pairs = pos.length + neg.length;
  semanticCalib.calibrated = true;
  return true;
}

/** Keep trying as vectors arrive; stops itself once calibrated. */
export function autoCalibrate() {
  const off = embeddings.onUpdate(() => {
    if (tryCalibrate()) off();
  });
  embeddings.onState(() => {
    if (embeddings.state === 'ready') embeddings.request(Object.values(INTENT_ANCHORS).flat());
  });
}
