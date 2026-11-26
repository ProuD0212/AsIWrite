@echo off
chcp 65001 >nul
title 내가 쓰는 대로 (As I Write)
rem 런처: 필요한 것은 이 폴더의 .runtime 안에만 설치해요 (자세한 내용: launcher\launch.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\launch.ps1"
if errorlevel 1 pause
