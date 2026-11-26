#!/bin/bash
# 내가 쓰는 대로 — 런처가 설치한 것 지우기 (이 폴더의 .runtime 만 지워요)
cd "$(dirname "$0")/.." || exit 1
echo "이 폴더의 .runtime (Node.js, 게임 파일, 브라우저 프로필: AI 모델 · 저장 파일 · 설정)을 지워요."
echo "저장한 세계도 함께 지워지니, 필요하면 게임의 「불러오기 / 내보내기」로 먼저 파일로 내보내 두세요."
read -r -p "정말 지울까요? [y/N] " ans
case "$ans" in [yY]*|ㅛ*) rm -rf .runtime ;; *) echo "지우지 않았어요."; exit 0 ;; esac
read -r -p "개발용 패키지(node_modules)도 지울까요? [y/N] " ans2
case "$ans2" in [yY]*|ㅛ*) rm -rf node_modules ;; esac
echo "정리했어요."
