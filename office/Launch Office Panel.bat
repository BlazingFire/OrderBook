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
rem How long to wait for each server before opening the window anyway. This
rem panel owns no database, so it listens within a second or two of launch -
rem the allowance is for a cold Node start on a slow shop PC, not for setup.
set "BACKEND_WAIT=60"
set "DEV_WAIT=30"

echo Office Panel launcher
echo ======================

call :is_listening %BACKEND_PORT%
if errorlevel 1 (
    echo Starting the Office server on port %BACKEND_PORT% ...
    start "OrderBook Office - server" cmd /k "cd /d "%ROOT%" && npm run dev"
) else (
    echo Office server already running on port %BACKEND_PORT%.
)

call :is_listening %DEV_PORT%
if errorlevel 1 (
    echo Starting the live dev UI on port %DEV_PORT% ...
    start "OrderBook Office - dev UI" cmd /k "cd /d "%ROOT%web" && npm run dev"
) else (
    echo Dev UI already running on port %DEV_PORT%.
)

rem Wait for the ports to actually accept connections rather than guessing at a
rem delay. The old version slept four seconds and opened the window regardless,
rem so on any slower start the panel loaded before its server could answer.
call :wait_for %BACKEND_PORT% %BACKEND_WAIT% "Office server"
call :wait_for %DEV_PORT% %DEV_WAIT% "dev UI"

echo Opening the panel window...
start "" msedge --app=http://localhost:%DEV_PORT% --window-size=1400,900

endlocal
exit /b 0

rem --- helpers --------------------------------------------------------------

rem Sets errorlevel 0 when something is LISTENING on the given port.
:is_listening
netstat -ano | findstr /r /c:":%~1 .*LISTENING" >nul
exit /b %errorlevel%

rem Polls a port once a second up to a limit, then gives up and carries on.
rem Carrying on is deliberate: the panel itself now shows a "waiting for this
rem PC's server" screen that clears when the server arrives, so opening the
rem window early is untidy rather than broken.
:wait_for
set "_port=%~1"
set "_limit=%~2"
set "_what=%~3"
set /a _waited=0

:wait_loop
call :is_listening %_port%
if not errorlevel 1 goto :wait_done
if %_waited% GEQ %_limit% (
    echo   %_what% has not come up after %_limit%s - opening the window anyway.
    goto :wait_done
)
if %_waited%==0 echo Waiting for the %_what% on port %_port% ...
ping -n 2 127.0.0.1 >nul
set /a _waited+=1
goto :wait_loop

:wait_done
exit /b 0
