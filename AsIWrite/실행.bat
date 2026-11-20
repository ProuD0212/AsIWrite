@echo off
chcp 65001 >nul
title 내가 쓰는 대로
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js가 설치되어 있지 않아요.
  echo     https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 처음 실행이라 필요한 파일을 설치합니다. 잠시만 기다려 주세요...
  call npm install
  if errorlevel 1 (
    echo [!] 설치에 실패했어요. 인터넷 연결을 확인해 주세요.
    pause
    exit /b 1
  )
)

echo.
echo 내가 쓰는 대로 를 시작합니다. 잠시 후 브라우저가 열려요.
echo 게임을 끝내려면 타이틀의 「종료」를 누르거나 이 창을 닫으세요.
echo.
call npm run dev -- --open
if errorlevel 1 pause
exit /b 0
