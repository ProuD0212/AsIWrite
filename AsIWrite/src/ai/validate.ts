// Output validation for the storyteller. Shared by the main thread (every rewrite)
// and the LLM worker (start-up self-check), so it must stay DOM-free.

export type OutputKind = 'line' | 'monologue' | 'bio' | 'rumor';

/** hybrid reasoning models may still emit a <think>…</think> block — never show it */
export function stripThinking(raw: string): string {
  return raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
}

// ── start-up self-check (both workers) ──
export const CHECK_DRAFT = '오늘 날씨가 참 좋네요. 산책이라도 갈까요?';
export const CHECK_MESSAGES: { role: 'system' | 'user'; content: string }[] = [
  { role: 'system', content: '너는 한국어 생활 소설 작가다. 초안 대사를 자연스럽게 다듬어 대사 한 줄만 출력한다. 따옴표나 설명은 붙이지 않는다.' },
  { role: 'user', content: `[초안] ${CHECK_DRAFT}\n다듬은 대사:` },
];
/**
 * The self-check only asks "is the GPU math broken?" — readable Korean vs. garbage.
 * Style rules (no English words, 존댓말, names…) belong to the per-line validator;
 * using it here once rejected a perfectly fine GPU over the word "nice".
 */
export function mathLooksSane(raw: string): boolean {
  const t = stripThinking(raw);
  const hangul = (t.match(/[가-힣]/g) ?? []).length;
  return hangul >= 6 && !looksBroken(t) && !/[一-鿿぀-ヿ]/.test(t);
}

/** Signs of a model melting down (or broken GPU math): stutters, endless runs, word salad. */
export function looksBroken(t: string): boolean {
  if (/([가-힣A-Za-z])\1{3,}/u.test(t)) return true; // 우우우우
  if (/([가-힣]{2,6})\1{2,}/u.test(t.replace(/\s/g, ''))) return true; // the same 2–6 syllables three times in a row
  if (/[가-힣]{14,}/.test(t)) return true; // no real Korean word is that long without a space
  if (/\s\/\s|^\/|\/$/.test(t)) return true; // "A / B / C" fragment lists
  const syl = t.match(/[가-힣]/g) ?? [];
  if (syl.length >= 16 && new Set(syl).size / syl.length < 0.35) return true; // too few distinct syllables
  return false;
}

export type Register = 'polite' | 'casual';

/** Does the text end its sentences politely (해요체/합니다체)? */
export function soundsPolite(t: string): boolean {
  const ends = t.split(/(?<=[.!?…~])\s+/).map((s) => s.replace(/[\s.!?…~"”')]+$/u, '')).filter(Boolean);
  if (!ends.length) return true;
  const polite = ends.filter((s) => /(요|니다|니까|세요|죠|시오)$/.test(s)).length;
  return polite / ends.length >= 0.5;
}

// ordinary words that happen to end in 씨 (not a person being addressed)
const SSI_WORDS = ['날씨', '마음씨', '아저씨', '아가씨', '솜씨', '말씨', '글씨', '불씨', '맵씨', '맘씨', '꽃씨', '말솜씨', '손글씨'];
/** "<name> 씨" — particles may follow ("민수 씨도", "마틴수씨가") */
const SSI_RE = /([가-힣]{1,4})\s?씨/g;

/** "마틴수 씨" when the listener is 김민수: a mangled name breaks the fiction. */
export function wrongNameAddressed(t: string, allowed: string[]): boolean {
  for (const m of t.matchAll(SSI_RE)) {
    const who = m[1];
    if (SSI_WORDS.some((w) => (who + '씨').endsWith(w))) continue;
    if (!allowed.some((n) => n && (who === n || who.endsWith(n)))) return true;
  }
  return false;
}

/** romance words that must not be euphemised away (stems, so 사귄대/사귀는/사귀어 all count) */
const ROMANCE_STEMS = ['사귀', '사귄', '연인', '고백', '데이트', '헤어', '짝사랑', '애인'];

/** Reject anything that isn't clean Korean prose of a sensible length; returns the cleaned text. */
export function cleanOutput(raw: string, kind: OutputKind, draft?: string, register?: Register, names?: string[]): string | null {
  let t = stripThinking(raw);
  t = t.replace(/^(대사|답변|출력|수정된 대사|다듬은 대사|다듬은 이야기|다듬은 소개|소개)\s*[:：]\s*/u, '');
  t = t.replace(/^[A-Za-z가-힣]{1,6}\s*[:：]\s*/u, (m) => (/[가-힣]/.test(m) && m.length <= 6 ? '' : m)); // "민수: …"
  t = t.replace(/^["“'「『]+|["”'」』]+$/gu, '').trim();
  t = t.replace(/\s*[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+/gu, '').trim(); // the prompt says no emoji; some models add them anyway
  if (kind === 'line') t = t.split('\n')[0].trim();
  else t = t.replace(/\n{2,}/g, '\n').trim();
  if (/[一-鿿぀-ヿ]/.test(t)) return null; // Chinese/Japanese leakage
  const hangul = (t.match(/[가-힣]/g) ?? []).length;
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  if (hangul < 4 || latin > hangul * 0.2) return null;
  // spoken lines: lowercase Latin is almost always a broken token ("어ymet은", "힘 up해서"); TV/PC-style acronyms are fine
  if ((kind === 'line' || kind === 'monologue') && /[a-z]/.test(t)) return null;
  if (looksBroken(t)) return null;
  // No "must reuse the draft's words" rule: with a capable model the best rewrites
  // often change most of the wording (tested: it rejected 5 of 8 good EXAONE lines).
  if (draft && kind === 'line') {
    const ratio = t.length / Math.max(1, draft.length);
    if (ratio > 5 || (draft.length >= 12 && ratio < 0.3)) return null;
  }
  // romance words must survive the rewrite: models like to soften "사귄대" into "무슨 일 있는 거 아냐?"
  if (draft) {
    for (const stem of ROMANCE_STEMS) if (draft.includes(stem) && !t.includes(stem)) return null;
  }
  // 존댓말 is required unless the two are close; a stray "민수야" between near-strangers breaks the fiction
  if (register === 'polite' && (kind === 'line' || kind === 'monologue') && !soundsPolite(t)) return null;
  // anyone addressed as "○○ 씨" must be the listener or someone the draft already named
  if (names && (kind === 'line' || kind === 'monologue')) {
    const fromDraft = draft ? [...draft.matchAll(SSI_RE)].map((m) => m[1]) : [];
    if (wrongNameAddressed(t, [...names, ...fromDraft])) return null;
  }
  const max = kind === 'line' ? 90 : kind === 'rumor' ? 70 : 420;
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'), cut.lastIndexOf('…'), cut.lastIndexOf('요'));
    if (end < max * 0.5) return null;
    t = cut.slice(0, end + 1);
  }
  return t;
}
