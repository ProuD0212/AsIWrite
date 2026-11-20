# model-lab — 모델 비교·측정 도구

게임에 쓸 언어 모델과 문장 임베딩 모델을 고를 때 쓴 측정 스크립트입니다. 게임 실행에는 필요 없어서 `main`에서 분리해 두었습니다.

모델 파일(수 GB)은 git에 넣지 않습니다. 처음 실행할 때 Hugging Face에서 내려받아 저장소 **바깥** `../model-cache`(저장소 폴더와 같은 위치)에 보관합니다. 다른 곳을 쓰려면 `MODEL_CACHE` 환경 변수를 지정하세요.

모든 스크립트는 앱 폴더(`AsIWrite/`)에서 `npm install`을 한 뒤 실행합니다.

## 1. 대사 다듬기 비교 — `lines-compare.mjs`

같은 대사 10개를 게임의 실제 프롬프트(규칙·예시 2개)로 다듬게 하고, 게임의 실제 출력 검사기(`src/ai/validate.ts`)로 통과 여부를 셉니다.

```
cd AsIWrite/model-lab
node lines-compare.mjs onnx-community/gemma-4-E2B-it-ONNX q4
node lines-compare.mjs onnx-community/Qwen3.5-2B-ONNX q4
```

지금까지의 결과(Node, CPU):

| 모델 | 통과 | 읽어 본 인상 |
|---|---|---|
| Gemma 4 E2B | 10/10 | 가장 자연스러움, 반말·존댓말 정확 → 기본 내장 모델 |
| Qwen3.5 2B | 10/10 | 매끄럽지만 뜻이 바뀌는 경우가 잦음(질문 → 감탄 등) → 대체 모델 |
| Gemma 3 1B | 8/10 | 가끔 어색함 → 제외 |
| Qwen2.5 0.5B | — | 한국어가 깨짐 → 제외 |

검사 통과는 최소 조건일 뿐이라, 출력 문장을 직접 읽어 보고 판단했습니다.

## 2. 의미 모델 보정 — `embed-calib.mjs`

"비슷한 뜻" 쌍과 "다른 뜻" 쌍의 코사인 유사도 분포를 재서, 그 모델로 뜻을 구분할 수 있는지(두 분포가 갈라지는지) 봅니다.

```
node embed-calib.mjs jhgan/ko-sroberta-multitask fp32
node embed-calib.mjs Xenova/paraphrase-multilingual-MiniLM-L12-v2 q8
```

MiniLM은 한국어 짧은 구절에서 무관한 쌍이 더 높게 나와 쓸 수 없었고, ko-sroberta를 채택했습니다(예: 문장 — 비슷한 쌍 중앙값 0.478, 다른 쌍 상위 10% 0.227).

## 3. 명령 해석 — `command-llm.ts`

규칙 해석기가 모르는 문장을 언어 모델이 게임 명령(JSON)으로 번역하게 하고, 게임의 검사(`src/commands/validate.ts`, 근거 검사 `grounded`)를 거쳐 실제 게임에서 실행해 봅니다.

```
cd AsIWrite
npx vite build --ssr model-lab/command-llm.ts --outDir model-lab/.out && node model-lab/.out/command-llm.js
# 다른 모델: LLM_MODEL=onnx-community/Qwen3.5-2B-ONNX LLM_DTYPE=q4 …
```

Gemma 4 E2B 결과: 규칙이 모르는 문장 19개 중 17개를 의도대로 이해, 잡담 3개는 모두 걸러냄.

## 참고

- 브라우저의 게임은 이 캐시를 쓰지 않습니다(브라우저가 따로 내려받아 저장).
- 캐시를 지워도 스크립트를 다시 실행하면 내려받습니다.
