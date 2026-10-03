@echo off
setlocal
rem Run by the "OrderBook Master Update" scheduled task, elevated (see electron/lib/staged-update.ts).
rem
rem The task runs as an account whose environment its other programs can change, so
rem nothing from it may steer Node, Electron or the .NET that PowerShell is: every
rem NODE_*, ELECTRON_*, COR_*, CORECLR_*, COMPlus_* and DOTNET_* variable is cleared
rem first (a .NET profiler variable would load a DLL into an elevated process), then
rem the one that makes the program run as plain Node is set. The script it starts
rem builds the environment of everything it runs from nothing.
for /f "delims==" %%A in ('set NODE_ 2^>nul') do set "%%A="
for /f "delims==" %%A in ('set ELECTRON_ 2^>nul') do set "%%A="
for /f "delims==" %%A in ('set COR_ 2^>nul') do set "%%A="
for /f "delims==" %%A in ('set CORECLR_ 2^>nul') do set "%%A="
for /f "delims==" %%A in ('set COMPLUS_ 2^>nul') do set "%%A="
for /f "delims==" %%A in ('set DOTNET_ 2^>nul') do set "%%A="
set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\OrderBook Master Panel.exe" "%~dp0apply-staged-update.js"
exit /b %ERRORLEVEL%
