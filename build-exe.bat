@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MudPlayer — сборка установщика
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установи LTS с https://nodejs.org и запусти снова.
  start https://nodejs.org/
  pause
  exit /b 1
)
taskkill /im MudPlayer.exe /f >nul 2>nul
echo [1/3] Ставлю зависимости (один раз, пара минут)...
call npm install --no-audit --no-fund
if errorlevel 1 ( echo npm install упал, смотри ошибку выше. & pause & exit /b 1 )
echo [2/3] Собираю установщик MudPlayer...
if exist dist rmdir /s /q dist
call npx electron-builder --win nsis --x64 --publish never
if errorlevel 1 (
  echo Повторяю сборку без вшивания иконки в exe...
  call npx electron-builder --win nsis --x64 --publish never -c.win.signAndEditExecutable=false
)
if errorlevel 1 ( echo Сборка не удалась, смотри ошибку выше. & pause & exit /b 1 )
echo [3/3] Запускаю установщик — он поставит MudPlayer и создаст ярлык на рабочем столе.
for %%f in (dist\*.exe) do start "" "%%f"
timeout /t 4 >nul
