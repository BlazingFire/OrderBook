@echo off
rem Double-click this to open the Office Panel in its own window (not a
rem browser tab) against the live dev server, so UI edits show up instantly
rem via Vite hot reload. Safe to double-click again later - it reuses
rem whatever is already running instead of starting a second copy.

setlocal EnableDelayedExpansion
title OrderBook Office Panel launcher

set "ROOT=%~dp0"
set "BACKEND_PORT=4200"
set "DEV_PORT=5200"

echo Office Panel launcher
echo ======================

netstat -ano | findstr /r /c:":%BACKEND_PORT% .*LISTENING" >nul
if errorlevel 1 (
    echo Starting the Office server on port %BACKEND_PORT% ...
    start "OrderBook Office - server" cmd /k "cd /d "%ROOT%" && npm run dev"
) else (
    echo Office server already running on port %BACKEND_PORT%.
)

netstat -ano | findstr /r /c:":%DEV_PORT% .*LISTENING" >nul
if errorlevel 1 (
    echo Starting the live dev UI on port %DEV_PORT% ...
    start "OrderBook Office - dev UI" cmd /k "cd /d "%ROOT%web" && npm run dev"
    echo Waiting for it to come up...
    ping -n 5 127.0.0.1 >nul
) else (
    echo Dev UI already running on port %DEV_PORT%.
)

echo Opening the panel window...
start "" msedge --app=http://localhost:%DEV_PORT% --window-size=1400,900

endlocal
