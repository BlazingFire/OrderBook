@echo off
setlocal
rem Run by the "OrderBook Master Update" scheduled task, elevated (see electron/lib/staged-update.ts).
rem
rem The task runs as an account whose environment its other programs can change, so
rem nothing from it may steer Node or Electron: every NODE_* and ELECTRON_* variable
rem is cleared first, then the one that makes the program run as plain Node is set.
for /f "delims==" %%A in ('set NODE_ 2^>nul') do set "%%A="
for /f "delims==" %%A in ('set ELECTRON_ 2^>nul') do set "%%A="
set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\OrderBook Master Panel.exe" "%~dp0apply-staged-update.js"
exit /b %ERRORLEVEL%
