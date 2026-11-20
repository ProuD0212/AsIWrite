// 의미 모델 보정 측정: 비슷한 쌍 / 다른 쌍의 코사인 분포 — node embed-calib.mjs <모델> <dtype>
// 예) node embed-calib.mjs jhgan/ko-sroberta-multitask fp32 · Xenova/paraphrase-multilingual-MiniLM-L12-v2 q8
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const T = await import('@huggingface/transformers');
// downloaded models live outside the repo (default: <repo>/../model-cache); override with MODEL_CACHE
T.env.cacheDir = process.env.MODEL_CACHE ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../model-cache');
const [EMB_MODEL, EMB_DTYPE] = [process.argv[2] ?? 'jhgan/ko-sroberta-multitask', process.argv[3] ?? 'fp32'];
const fe = await T.pipeline('feature-extraction', EMB_MODEL, { dtype: EMB_DTYPE });
const cache = new Map();
const vec = async (t) => (cache.has(t) ? cache.get(t) : (cache.set(t, (await fe(t, { pooling: 'mean', normalize: true })).data), cache.get(t)));
const cos = async (a, b) => { const x = await vec(a), y = await vec(b); let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * y[i]; return s; };
const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
// trait SENTENCES: same theme vs different theme
const S = [
  ['고양이를 정말 좋아한다', '길고양이에게 몰래 밥을 챙겨준다', '언젠간 고양이를 키우고 싶다'],
  ['노래방에서 노래하는 걸 좋아한다', '몰래 노래방에서 애니송을 부른다', '밴드로 데뷔하는 것이 꿈이다'],
  ['도서관에서 책 읽는 것을 가장 좋아한다', '추리 소설 마니아다', '책 냄새를 좋아한다'],
  ['매일 야근에 지쳐 있다', '회사 일이 너무 많아 피곤하다', '퇴근만 기다리며 산다'],
  ['비 오는 날을 싫어한다', '장마철이면 우울해진다', '빗소리를 들으면 기분이 가라앉는다'],
  ['운동하는 걸 좋아한다', '매일 아침 조깅을 한다', '헬스장에 가는 게 낙이다'],
  ['커피 향을 사랑한다', '하루에 커피를 세 잔 마신다', '라떼 아트를 연습한다'],
];
const pos = [], neg = [];
for (let gi = 0; gi < S.length; gi++) for (let i = 0; i < S[gi].length; i++) {
  for (let j = i + 1; j < S[gi].length; j++) pos.push(await cos(S[gi][i], S[gi][j]));
  for (let hi = gi + 1; hi < S.length; hi++) for (const b of S[hi]) neg.push(await cos(S[gi][i], b));
}
console.log(`sentences: pos median ${q(pos,.5).toFixed(3)} p25 ${q(pos,.25).toFixed(3)} | neg p90 ${q(neg,.9).toFixed(3)} max ${Math.max(...neg).toFixed(3)}`);
