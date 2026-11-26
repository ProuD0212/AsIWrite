# 내가 쓰는 대로 (As I Write)

한 줄 채팅으로 세상을 써 내려가는 2D 탑뷰 내러티브 갓 샌드박스입니다.
당신이 쓴 대로 세상이 생기고, 그 안에 사는 **윌(Will)** 들은 저마다의 의지로 살아갑니다 — 일하고, 수다 떨고, 소문을 퍼뜨리고, 다투고, 서로 위로하고, 일기를 씁니다.

A 2D top-down narrative god-sandbox: you write the world into being through one chat box, and the Wills who live in it go on with their own will.

---

## 시작하기

| 컴퓨터 | 이렇게 하세요 |
|---|---|
| **Windows 10 / 11** | `AsIWrite Launcher.bat` 더블클릭 |
| **macOS** | `AsIWrite Launcher.command` 더블클릭 (처음 한 번은 우클릭 → 「열기」) |
| Linux | 터미널에서 `bash "AsIWrite Launcher.command"` |

**미리 설치할 것은 없습니다.** 처음 실행하면 무엇을 설치할지 보여 주고 물어본 뒤, 전부 **이 폴더의 `.runtime` 안에만** 설치해요. 컴퓨터의 다른 곳·PATH·관리자 권한은 건드리지 않습니다. 인터넷 연결은 처음 한 번 필요해요.

| 설치되는 것 | 크기 | 위치 |
|---|---|---|
| Node.js 26.13.1 (버전 고정) | 약 30–50MB | `.runtime/node-v…` |
| 게임 묶음 (GitHub Release) | 약 9MB | `.runtime/game-…` |
| 브라우저 전용 프로필 — AI 모델 · 저장한 세계 · 설정이 여기에 | 쓰는 AI에 따라 수백 MB~ | `.runtime/browser` |
| 휴대용 크롬 — 엣지·크롬이 없을 때만, 한 번 더 물어보고 | 약 200MB | `.runtime/chrome-…` |

- **재현성** — 받는 파일의 버전과 SHA-256 값이 [`launcher/runtime.lock`](launcher/runtime.lock)에 고정돼 있고, 값이 다르면 설치하지 않습니다. 게임 묶음을 받을 수 없으면 소스에서 직접 빌드해요(`package-lock.json` 그대로 `npm ci`, 패키지 약 600MB, npm 캐시도 `.runtime` 안).
- 게임은 엣지·크롬을 **이 폴더 안의 전용 프로필**로 연 앱 창에서 실행돼요. 창을 닫거나 타이틀의 「종료」를 누르면 끝납니다.
- **지우기** — `launcher/Uninstall.bat`(Windows) / `launcher/Uninstall.command`(macOS), 또는 `.runtime` 폴더를 지우면 끝. 저장한 세계도 함께 지워지니 먼저 게임의 「불러오기 / 내보내기」로 파일로 내보내 두세요.

API 키나 회원가입 없이 바로 플레이할 수 있어요. 이미지·오디오 파일은 하나도 없고, 그림은 전부 Canvas로 그리며 소리는 Web Audio로 합성합니다.

## 플레이

| 방법 | 내용 |
|---|---|
| 타이틀 입력창 | `시작`, `비 오는 현대 서울에서 윌 8명, 건물 7채, 동물 2마리로 시작`, `튜토리얼`, `불러오기` |
| 상단 채팅창 | `고양이를 좋아하는 샐러리맨 소환`, `갑자기 소나기가 내리게 해줘`, `세계관을 중세 판타지로 변경`, `박철수와 정하늘이 마주치게 해줘`, `광장에서 축제 열어 줘`, `중앙에 인도를 쭉 깔아줘` … (❓ 도움말에 예시가 더 있어요) |
| 채팅 없이 | 왼쪽 도구 막대(소환 · 날씨 · 세계관 · 사건 · 번개 · 축복 · 선물 · 저장 …), 윌·건물 클릭 → 인스펙터(성격 · 관계 · 일기 · 대화), 우클릭 메뉴 |
| 말 걸기 | 윌 선택 → 「💬 대화」 탭, 또는 채팅 `한별에게 "요즘 어때?"` |
| 튜토리얼 | 타이틀에서 「튜토리얼」 — 연습 마을에서 작은 미션으로 기본 조작을 익혀요 |
| 카메라 | 드래그 / WASD · 휠 확대 · `Space` 일시정지 · `1`~`5` 배속 · `X` 맵 편집 · `Shift V` 격자 · `?` 단축키 전체 |

채팅창으로 할 수 있는 모든 일은 클릭으로도 할 수 있어요. 둘 다 같은 명령(`GameCommand`)을 만들어 `Game.dispatch()` 하나로 처리합니다.

## AI

| 쓰임 | 모델 | 비고 |
|---|---|---|
| ✨ 이야기꾼 — 대사·속마음·소개글을 성격·기분·관계·상황에 맞게 다시 쓰고, 새 윌의 이름·외형·직업·특성을 지어 줌 | **Gemini / Groq API**(선택, 권장 — 모델을 받지 않음) 또는 브라우저 안 **Gemma 4 E2B**(WebLLM, WebGPU · 그래픽 메모리 약 3.4GB) → 안 되면 **Qwen3.5 2B** | 첫 실행 때 고릅니다. 꺼도 게임은 템플릿 문장으로 그대로 돌아가요 |
| 🧠 뜻 비교 — 자유롭게 쓴 특성·명령을 뜻으로 이해 | `jhgan/ko-sroberta-multitask` (약 440MB, Web Worker) | 준비되기 전·실패 시 글자 비교로 대체 |

브라우저 안 모델을 쓰려면 **WebGPU를 지원하는 엣지·크롬**이 필요해요(런처가 자동으로 그 브라우저로 엽니다).

## 개발

```bash
npm ci             # 패키지 설치
npm run dev        # 개발 서버 http://localhost:5173
npm test           # 헤드리스 시험 (브라우저 없이 실제 엔진으로)
npm run build      # 타입 검사 + 빌드
npm run release    # 게임 묶음 zip → release/, SHA-256을 launcher/runtime.lock 에 기록
```

배포: `npm run release` → 출력된 `gh release create …`로 zip을 GitHub Release에 올림 → `launcher/runtime.lock` 커밋.

```
AsIWrite Launcher.bat / .command   런처 (더블클릭)
launcher/       런처 본체(launch.ps1 · launch.sh), runtime.lock(버전·해시), Uninstall
server/         독립 게임 서버(game-server.ts) · 다른 PC 접속 · AI 중계(lanShare.ts)
tools/          release.mjs (게임 묶음 만들기)
src/
  engine/       시뮬레이션: World(상태·업데이트), world/(행동·일과·대화·의뢰·관계·연애·그룹·소문·사건·맵 편집),
                TileMap · 특성 해석 · 소문 · 저장 · Game(조작)
  engine/render/  Canvas 렌더러: 윌·동물 스프라이트(캐시 + 외곽선 + 애니메이션), 땅(청크), 가구·나무, 조명·날씨
  commands/     명령 스키마 · 규칙 파서 · 맵 문장 해석 · 모델 출력 검사
  ai/           이야기꾼 · 문장 임베딩 · API 연결 · 배운 문장 · 다른 PC 중계
  presets/      기본 세계 · 무작위 이름/외형/특성 · 대사 템플릿과 의도
  ui/           React HUD (도구 막대 · 인스펙터 · 창들 · 튜토리얼)
  audio/        효과음 · 배경 음악 (Web Audio로 생성)
tests/          헤드리스 시험
```

## 사용한 외부 자원

- 글꼴: [Galmuri](https://github.com/quiple/galmuri) (SIL OFL 1.1, CDN에서 불러옴)
- AI 모델(Gemma 4 E2B, Qwen3.5 2B, ko-sroberta-multitask): 실행 중 Hugging Face / WebLLM에서 받으며 저장소에는 포함되지 않음. 각 모델의 라이선스를 따릅니다.
- 런타임: Node.js, Chrome for Testing(엣지·크롬이 없을 때만) — 런처가 공식 배포처에서 받음
