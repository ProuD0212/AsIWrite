// Semantic matching interface used by the simulation.
//
// Phase 1 ships `LexicalMatcher`: Korean character-bigram overlap with a
// stoplist of grammatical endings. It needs no model download, so the game is
// playable instantly. Phase 2 adds `EmbeddingMatcher` (MiniLM, 384-d cosine)
// behind the same interface, falling back to this one while the model loads.

export interface SemanticMatcher {
  readonly name: string;
  /** 0..1 similarity between two short texts */
  similarity(a: string, b: string): number;
}

const STOP = new Set([
  '좋아', '아한', '한다', '하는', '있다', '이다', '는다', '싫어', '어한', '하지', '지만', '않는', '없다', '한테', '에서',
  '에게', '으로', '하고', '해서', '했다', '된다', '되는', '이고', '같다', '보는', '보면', '면서', '정말', '매우', '항상',
  '언제', '가장', '많이', '아하', '어하', '하다', '을좋', '를좋', '를싫', '을싫', '고싶', '싶어', '어한', '주는', '는것',
  '것을', '것이', '이좋', '가좋', '는걸', '걸좋', '하며', '며', '곤한', '곤하', '이다', '수있', '있는',
]);

function grams(s: string): Set<string> {
  const clean = s.toLowerCase().replace(/[\s.,!?~"'()[\]\-#«»…·]/g, '');
  const out = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) {
    const g = clean.slice(i, i + 2);
    if (!STOP.has(g)) out.add(g);
  }
  return out;
}

export class LexicalMatcher implements SemanticMatcher {
  readonly name = 'lexical-bigram';
  private cache = new Map<string, Set<string>>();

  private g(s: string) {
    let v = this.cache.get(s);
    if (!v) {
      v = grams(s);
      if (this.cache.size > 4000) this.cache.clear();
      this.cache.set(s, v);
    }
    return v;
  }

  similarity(a: string, b: string): number {
    const A = this.g(a);
    const B = this.g(b);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    // overlap coefficient, damped for very short strings
    const m = Math.min(A.size, B.size);
    return (inter / m) * Math.min(1, m / 2);
  }
}

export const LIKE_RE = /(좋아|사랑|즐기|즐겨|동경|꿈이|관심|챙겨|마니아|취미|낙이|존경|그리워)/;
export const DISLIKE_RE = /(싫어|무서워|질색|못 견|짜증|두려워|예민)/;

/** Max similarity between a trait and any facet of a target description. */
export function bestMatch(m: SemanticMatcher, trait: string, facets: string[]): number {
  let best = 0;
  for (const f of facets) {
    if (!f) continue;
    const s = m.similarity(trait, f);
    if (s > best) best = s;
  }
  return best;
}
