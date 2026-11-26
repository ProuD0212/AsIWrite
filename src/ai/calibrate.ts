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
import { PHRASE_GROUPS, SENTENCE_GROUPS } from './anchors';
import type { Calib } from '../engine/semantic';
import { embeddings } from './embeddings';

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : 0;
};

/** same-meaning (inside a group) vs different-meaning (across groups) cosines → a mapping */
function measure(groups: string[][], minGap: number): Calib {
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
  return { lo, hi, ok: hi - lo >= minGap, posMedian: hi, negP90: lo, pairs: pos.length + neg.length };
}

const ALL_ANCHORS = () => [...Object.values(INTENT_ANCHORS).flat(), ...PHRASE_GROUPS.flat(), ...SENTENCE_GROUPS.flat()];

/** Try to calibrate; returns true once done (needs all anchors embedded). */
export function tryCalibrate(): boolean {
  if (semanticCalib.calibrated || embeddings.state !== 'ready') return semanticCalib.calibrated;
  const all = ALL_ANCHORS();
  if (all.some((t) => !embeddings.get(t))) {
    embeddings.request(all);
    return false;
  }
  const intent = measure(Object.values(INTENT_ANCHORS), 0.1);
  if (intent.ok) {
    semanticCalib.lo = intent.lo;
    semanticCalib.hi = intent.hi;
  }
  semanticCalib.posMedian = intent.posMedian;
  semanticCalib.negP90 = intent.negP90;
  semanticCalib.pairs = intent.pairs;
  // a model that can't separate related from unrelated here is simply not used for it
  semanticCalib.phrase = measure(PHRASE_GROUPS, 0.08);
  semanticCalib.sentence = measure(SENTENCE_GROUPS, 0.08);
  semanticCalib.calibrated = true;
  console.info('[의미 모델] 보정', { intent, phrase: semanticCalib.phrase, sentence: semanticCalib.sentence });
  return true;
}

/** Keep trying as vectors arrive; stops itself once calibrated. */
export function autoCalibrate() {
  const off = embeddings.onUpdate(() => {
    if (tryCalibrate()) off();
  });
  embeddings.onState(() => {
    if (embeddings.state === 'ready') embeddings.request(ALL_ANCHORS());
  });
}
