@echo off
chcp 65001 >nul
title Orbit
color 05
echo.
echo  ◉  ORBIT 1.0
echo  Private sharing for your own devices
echo  ─────────────────────────────────────
echo.
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo  [ERROR] Node.js not installed!
    echo  Download from: https://nodejs.org
    echo  ^(or use the ready-made orbit-win-x64.exe from the Releases page^)
    echo.
    pause & exit /b 1
)
cd /d "%~dp0"

if not exist node_modules (
    echo  First run: installing dependencies...
    call npm install --omit=dev
    if %errorlevel% neq 0 (
        color 0C
        echo  [ERROR] npm install failed. Check your internet connection.
        pause & exit /b 1
    )
)

if not defined PORT set PORT=3000
set ORBIT_OPEN=1
echo  Starting... your browser opens automatically.
echo  Keep this window open. Ctrl+C to stop.
echo.
node server.js
pause
