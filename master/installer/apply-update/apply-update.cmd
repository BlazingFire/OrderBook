@echo off
rem Run by the "OrderBook Master Update" scheduled task, elevated (see electron/lib/staged-update.ts).
rem The program is started as plain Node, with no window, to run the verifying script beside this file.
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\OrderBook Master Panel.exe" "%~dp0apply-staged-update.js"
exit /b %ERRORLEVEL%
