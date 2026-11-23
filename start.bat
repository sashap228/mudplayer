@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MudPlayer
where node >nul 2>nul
if errorlevel 1 (
  echo [MudPlayer] Node.js не найден. Установи LTS с https://nodejs.org и запусти снова.
  start https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules\electron (
  echo [MudPlayer] Первый запуск: ставлю зависимости ^(Electron ~100 МБ^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo [MudPlayer] npm install упал, смотри ошибку выше. & pause & exit /b 1 )
)
echo [MudPlayer] Запуск...
call npm start
if errorlevel 1 pause
