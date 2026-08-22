@echo off
title Orbit
color 05
echo.
echo  ◉  ORBIT — iPhone + Windows 11
echo  No PIN. Just open and share.
echo  ─────────────────────────────────────
echo.
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo  [ERROR] Node.js not installed!
    echo  Download from: https://nodejs.org
    echo.
    pause & exit /b
)
cd /d "%~dp0"
start /b powershell -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"
echo  Starting... browser opens in 2 seconds.
echo  Keep this window open. Ctrl+C to stop.
echo.
node server.js
pause
