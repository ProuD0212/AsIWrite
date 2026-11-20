#!/bin/bash
# macOS: 더블클릭으로 실행 (처음 한 번은 우클릭 → 열기)
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js가 설치되어 있지 않아요. https://nodejs.org 에서 LTS 버전을 설치해 주세요."
  read -r -p "엔터를 누르면 닫혀요."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "처음 실행이라 필요한 파일을 설치합니다. 잠시만 기다려 주세요..."
  npm install || { read -r -p "[!] 설치 실패. 엔터를 누르면 닫혀요."; exit 1; }
fi

echo
echo "내가 쓰는 대로 를 시작합니다. 잠시 후 브라우저가 열려요."
echo "게임을 끝내려면 타이틀의 「종료」를 누르거나, 이 창을 닫거나 Ctrl+C 를 누르세요."
echo
npm run dev -- --open
