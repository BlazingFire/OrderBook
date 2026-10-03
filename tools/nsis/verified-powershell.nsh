; Run a PowerShell script the installer has extracted somewhere another program
; running as the same account can write, without trusting it (1.4 R8).
;
; Used by the Master installer (the update folders' script and the uninstall
; sweep) and the Office installer (the uninstall sweep). All of them run elevated.
;
; What it does, in the one command line it builds:
;  1. pins PSModulePath to $PSHOME\Modules. `-NoProfile` does NOT stop PowerShell
;     auto-loading modules from the user's Documents\WindowsPowerShell\Modules,
;     which that account can write: a planted `Microsoft.PowerShell.Management`
;     loads on the first cmdlet. This is the first statement, and nothing before it
;     is a cmdlet (only .NET and language keywords);
;  2. reads the script file ONCE and compares its SHA-256 with the one baked in at
;     compile time (tools/bake-script-hashes.cjs, run by `!system` in the installer
;     header): a different file is exit 9 and nothing runs;
;  3. runs *those bytes from memory* (a script block), never the file, so a swap
;     after the check changes nothing;
;  4. wraps the call in try/catch, so a binding error cannot fall through to a
;     success exit. FALLTHROUGH is the exit code if the script returns without
;     calling `exit` itself: 1 for a script whose success matters, 0 for a sweep.
;
; The path of the script is handed over in the OB_SCRIPT environment variable, and
; any path in ARGUMENTS the same way (OB_INSTDIR), set with SetEnvironmentVariable:
; a value that arrives as data is never parsed as code, so a `$` or a quote in an
; install path cannot be expanded or break out of a literal.
;
; `$$` is NSIS for a literal `$`. The program is the system's own PowerShell, by
; absolute path ($SYSDIR), never found through PATH.
;
; Leaves the process exit code on the stack (nsExec::ExecToLog).
!macro orderbookRunVerified SCRIPT SHA256 ARGUMENTS FALLTHROUGH
  System::Call 'Kernel32::SetEnvironmentVariable(t "OB_SCRIPT", t "${SCRIPT}")'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$env:PSModulePath=$$PSHOME+'\Modules'; $$b=[IO.File]::ReadAllBytes($$env:OB_SCRIPT); $$h=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($$b))).Replace('-','').ToLower(); if ($$h -ne '${SHA256}') { exit 9 }; try { $$s=[scriptblock]::Create([Text.Encoding]::UTF8.GetString($$b).TrimStart([char]0xFEFF)); & $$s ${ARGUMENTS} } catch { exit 1 }; exit ${FALLTHROUGH}"`
!macroend
