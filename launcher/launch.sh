#!/bin/bash
# 내가 쓰는 대로 — 런처 (macOS / Linux). 「AsIWrite Launcher.command」가 부릅니다.
#
# 필요한 것은 전부 이 폴더의 .runtime 안에만 설치해요 — 컴퓨터의 다른 곳은 건드리지 않아요.
#   · Node.js (버전 고정, 공식 SHA-256 확인)        .runtime/node-v…
#   · 게임 묶음 (GitHub Release, SHA-256 확인)       .runtime/game-…   ← 없으면 소스에서 직접 빌드
#   · 브라우저 프로필 (AI 모델·저장 파일·설정)        .runtime/browser
#   · (크롬·엣지가 없을 때만) 휴대용 크롬              .runtime/chrome-…
# 지우려면 launcher/Uninstall.command 를 실행하거나 .runtime 폴더를 지우면 돼요.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)" || exit 1
cd "$ROOT" || exit 1
RT="$ROOT/.runtime"
LOCK="$ROOT/launcher/runtime.lock"
lock() { grep -E "^$1=" "$LOCK" | head -1 | cut -d= -f2- | tr -d '\r'; }
say() { printf '%s\n' "$*"; }
fail() { say ""; say "[!] $*"; read -r -p "엔터를 누르면 닫혀요." _; exit 1; }
sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }

# ── 이 컴퓨터 ──
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLAT=darwin-arm64; CPLAT=mac-arm64 ;;
  Darwin-x86_64) PLAT=darwin-x64; CPLAT=mac-x64 ;;
  Linux-x86_64) PLAT=linux-x64; CPLAT= ;;
  Linux-aarch64) PLAT=linux-arm64; CPLAT= ;;
  *) fail "이 컴퓨터($(uname -s) $(uname -m))는 아직 지원하지 않아요." ;;
esac
NODE_V="$(lock NODE_VERSION)"
NODE_DIR="$RT/node-v$NODE_V-$PLAT"
NODE="$NODE_DIR/bin/node"
GAME_V="$(lock GAME_VERSION)"
GAME_URL="${ASIWRITE_GAME_URL:-$(lock GAME_URL)}"
GAME_SHA="$(lock GAME_SHA256)"
if [ -n "$GAME_V" ] && [ -n "$GAME_URL" ] && [ -n "$GAME_SHA" ]; then GAME_DIR="$RT/game-$GAME_V"; FROM_SRC=0; else GAME_DIR="$RT/game-src"; FROM_SRC=1; fi

# 소스에서 빌드한 게임은 소스가 바뀌면 다시 빌드
src_changed() { [ ! -f "$GAME_DIR/.built" ] || [ -n "$(find src public index.html package.json package-lock.json server -newer "$GAME_DIR/.built" -print -quit 2>/dev/null)" ]; }

# ── 브라우저 (전용 프로필을 폴더 안에 두려면 크롬 계열이 필요) ──
find_browser() {
  BROWSER=""
  if [ "$(uname -s)" = Darwin ]; then
    for app in "Google Chrome" "Microsoft Edge" "Chromium" "Brave Browser"; do
      for base in "/Applications" "$HOME/Applications"; do
        [ -x "$base/$app.app/Contents/MacOS/$app" ] && { BROWSER="$base/$app.app/Contents/MacOS/$app"; return; }
      done
    done
  else
    for b in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser; do
      command -v "$b" >/dev/null 2>&1 && { BROWSER="$(command -v "$b")"; return; }
    done
  fi
  CHROME_V="$(lock CHROME_VERSION)"
  if [ -n "$CPLAT" ]; then
    local app="$RT/chrome-$CHROME_V-$CPLAT/chrome-$CPLAT/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    [ -x "$app" ] && BROWSER="$app"
  fi
}

# ── 무엇을 설치해야 하나 ──
NEED=()
[ -x "$NODE" ] || NEED+=("Node.js $NODE_V (약 50MB)")
if [ "$FROM_SRC" = 1 ]; then
  if src_changed; then NEED+=("게임을 소스에서 빌드 (패키지 약 600MB, 몇 분)"); fi
else
  [ -f "$GAME_DIR/server.mjs" ] || NEED+=("게임 묶음 $GAME_V (약 10MB)")
fi
find_browser
WANT_CHROME=0
if [ -z "$BROWSER" ] && [ -n "$CPLAT" ]; then WANT_CHROME=1; fi

if [ ${#NEED[@]} -gt 0 ] || [ "$WANT_CHROME" = 1 ]; then
  say "────────────────────────────────────────────"
  say " 내가 쓰는 대로 — 처음 실행 준비"
  say "────────────────────────────────────────────"
  say "다음을 이 폴더 안(.runtime)에만 설치해요. 컴퓨터의 다른 곳은 건드리지 않아요."
  for n in ${NEED[@]+"${NEED[@]}"}; do say "  · $n"; done
  [ "$WANT_CHROME" = 1 ] && say "  · (선택) 휴대용 크롬 $(lock CHROME_VERSION) (약 200MB) — 크롬·엣지가 없어서 필요해요"
  say "받은 파일은 launcher/runtime.lock 에 적힌 SHA-256 값과 맞는지 확인한 뒤에만 설치해요."
  say ""
  read -r -p "설치할까요? [Y/n] " ans
  case "${ans:-y}" in [yY]*|ㅛ*) ;; *) say "설치하지 않았어요. 언제든 다시 실행하면 돼요."; exit 0 ;; esac
  mkdir -p "$RT"
fi

# download URL FILE SHA256
download() {
  say "  내려받는 중: $(basename "$2")"
  curl -fL --progress-bar -o "$2.part" "$1" || { rm -f "$2.part"; return 1; }
  local got; got="$(sha256 "$2.part")"
  if [ "$got" != "$3" ]; then rm -f "$2.part"; say "  [!] 파일이 예상과 달라요 (SHA-256 불일치). 설치하지 않았어요."; return 1; fi
  mv "$2.part" "$2"
}

# ── Node.js ──
if [ ! -x "$NODE" ]; then
  say ""
  say "▶ Node.js $NODE_V"
  f="$RT/node-v$NODE_V-$PLAT.tar.gz"
  download "https://nodejs.org/dist/v$NODE_V/node-v$NODE_V-$PLAT.tar.gz" "$f" "$(lock "NODE_SHA256_$PLAT")" || fail "Node.js를 받지 못했어요. 인터넷 연결을 확인해 주세요."
  tar -xzf "$f" -C "$RT" && rm -f "$f" || fail "Node.js 압축을 풀지 못했어요."
fi
export PATH="$NODE_DIR/bin:$PATH"
export npm_config_cache="$RT/npm-cache"      # npm 캐시도 폴더 안에
export npm_config_update_notifier=false

# ── 게임 ──
build_from_source() {
  say ""
  say "▶ 소스에서 게임 빌드 (처음 한 번, 몇 분 걸려요)"
  npm ci --no-audit --no-fund || fail "패키지 설치에 실패했어요. 인터넷 연결을 확인해 주세요."
  node tools/release.mjs --out "$GAME_DIR" || fail "빌드에 실패했어요."
}
if [ "$FROM_SRC" = 1 ]; then
  src_changed && build_from_source
elif [ ! -f "$GAME_DIR/server.mjs" ]; then
  say ""
  say "▶ 게임 묶음 $GAME_V"
  z="$RT/game-$GAME_V.zip"
  if download "$GAME_URL" "$z" "$GAME_SHA"; then
    mkdir -p "$GAME_DIR" && (cd "$GAME_DIR" && unzip -q -o "$z") && rm -f "$z" || fail "게임 묶음 압축을 풀지 못했어요."
  else
    say "  게임 묶음을 받지 못해 소스에서 직접 빌드할게요."
    GAME_DIR="$RT/game-src"
    src_changed && build_from_source
  fi
fi

# ── 휴대용 크롬 (선택) ──
if [ "$WANT_CHROME" = 1 ]; then
  say ""
  read -r -p "휴대용 크롬을 받을까요? 받지 않으면 기본 브라우저로 열고, 그때는 AI 모델·저장 파일이 브라우저 쪽에 저장돼요. [Y/n] " ans
  case "${ans:-y}" in
    [yY]*|ㅛ*)
      CHROME_V="$(lock CHROME_VERSION)"
      cz="$RT/chrome-$CHROME_V-$CPLAT.zip"
      if download "${ASIWRITE_CHROME_URL:-https://storage.googleapis.com/chrome-for-testing-public/$CHROME_V/$CPLAT/chrome-$CPLAT.zip}" "$cz" "$(lock "CHROME_SHA256_$CPLAT")"; then
        mkdir -p "$RT/chrome-$CHROME_V-$CPLAT" && (cd "$RT/chrome-$CHROME_V-$CPLAT" && unzip -q -o "$cz") && rm -f "$cz"
        find_browser
      fi ;;
  esac
fi

# ── 실행 ──
say ""
say "내가 쓰는 대로 를 시작합니다."
rm -f "$RT/port"
"$NODE" "$GAME_DIR/server.mjs" --port 5173 --port-file "$RT/port" &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 1 100); do [ -s "$RT/port" ] && break; kill -0 $SRV 2>/dev/null || fail "게임 서버가 시작되지 않았어요."; sleep 0.2; done
[ -s "$RT/port" ] || fail "게임 서버가 응답하지 않아요."
URL="http://localhost:$(cat "$RT/port")"
say "  $URL"
if [ -n "${ASIWRITE_NO_BROWSER:-}" ]; then
  say "  (브라우저를 열지 않음) 끝내려면 Ctrl+C"
  wait $SRV
elif [ -n "$BROWSER" ]; then
  say "  게임 창을 닫거나 타이틀의 「종료」를 누르면 끝나요."
  START=$(date +%s)
  "$BROWSER" --user-data-dir="$RT/browser" --app="$URL" --no-first-run --no-default-browser-check --window-size=1440,900 >/dev/null 2>&1
  # 이미 열린 게임 창에 넘겨주고 바로 끝난 경우엔 서버를 계속 둬요
  if [ $(( $(date +%s) - START )) -lt 5 ]; then say "  (이미 열린 게임 창이 있어요. 끝내려면 이 창을 닫으세요.)"; wait $SRV; fi
else
  say "  기본 브라우저로 열어요. 끝내려면 타이틀의 「종료」를 누르거나 이 창을 닫으세요."
  if [ "$(uname -s)" = Darwin ]; then open "$URL"; else xdg-open "$URL" >/dev/null 2>&1 || say "  브라우저에서 $URL 을 열어 주세요."; fi
  wait $SRV
fi
