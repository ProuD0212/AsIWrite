@echo off
chcp 65001 >nul
title 내가 쓰는 대로 — 지우기
cd /d "%~dp0.."
echo 이 폴더의 .runtime (Node.js, 게임 파일, 브라우저 프로필: AI 모델 · 저장 파일 · 설정)을 지워요.
echo 저장한 세계도 함께 지워지니, 필요하면 게임의 「불러오기 / 내보내기」로 먼저 파일로 내보내 두세요.
set /p ans=정말 지울까요? [y/N] 
if /i not "%ans%"=="y" (echo 지우지 않았어요. & pause & exit /b 0)
if exist ".runtime" rmdir /s /q ".runtime"
set /p ans2=개발용 패키지(node_modules)도 지울까요? [y/N] 
if /i "%ans2%"=="y" if exist "node_modules" rmdir /s /q "node_modules"
echo 정리했어요.
pause
