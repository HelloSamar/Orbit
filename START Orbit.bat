@echo off
chcp 65001 >nul
title Orbit
color 05
echo.
echo  ◉  ORBIT 2.0
echo  Private sharing for your own devices
echo  ─────────────────────────────────────
echo.
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo  [ERROR] Node.js not installed!
    echo  Download from: https://nodejs.org
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
if not defined ORBIT_PIN (
    set /p ORBIT_PIN= Set a PIN to protect Orbit ^(press Enter to skip^): 
)
if defined ORBIT_PIN (echo  PIN protection: ON) else (echo  PIN protection: OFF - anyone on your Wi-Fi can use Orbit)
echo.

start /b powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:%PORT%'"
echo  Starting... browser opens in 2 seconds.
echo  Keep this window open. Ctrl+C to stop.
echo.
node server.js
pause
