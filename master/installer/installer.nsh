; Firewall rules for the Master Panel, and the leftovers sweep on uninstall.
;
; Without the rules Windows prompts on first run — and if whoever is standing
; there clicks "Cancel", panel discovery silently stops working with no error
; anyone can see. TCP 4100 is the API and socket every panel syncs through; UDP
; 45789 is the discovery broadcast that lets a panel find this Master without
; anybody typing an IP address (shared/src/protocol/discovery.ts).
;
; Removed on uninstall: a rule for software that is gone is a hole nobody is
; watching. So are the Electron profile, the updater cache, the shortcuts and
; the registry entries NSIS does not know about, which is what the sweep below
; hands to tools/uninstall/uninstall-orderbook.ps1.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall add rule name="OrderBook Master (TCP 4100)" dir=in action=allow protocol=TCP localport=4100'
  nsExec::Exec 'netsh advfirewall firewall add rule name="OrderBook Discovery (UDP 45789)" dir=in action=allow protocol=UDP localport=45789'

  ; The nightly update (1.4). This installer is running elevated, once, with the
  ; administrator's approval; it uses that to register a task that can install
  ; the next version with nobody present. The task runs a fixed script from the
  ; program folder, and that script trusts nothing it is handed: it verifies the
  ; signed manifest and the setup file's hash itself (electron/lib/staged-update.ts).
  ;
  ;  - `staged-update` is where the (unelevated) Master app leaves what it wants
  ;    installed. Anyone may write it, so nothing in it is believed.
  ;  - `elevated` is administrators-and-SYSTEM only: the task copies the setup file
  ;    there and hashes the copy, so it cannot be swapped between the check and
  ;    the run. (Well-known SIDs, so the names work on any Windows language.)
  ;
  ; Everything below is done by `update-dirs.ps1 -Mode Install`, and the task is
  ; registered only if it succeeds. It does what a plain `icacls` could not:
  ;  - a program folder that was made by a standard user, or inherits Users:Modify
  ;    from a custom install location, is taken over (owner Administrators, a
  ;    protected ACL, Users read-and-run) and checked for links inside it;
  ;  - `%ProgramData%\OrderBook` is never reused as found: a link is removed, a
  ;    folder owned by anybody else is moved aside, and the new one is created
  ;    Administrators-owned with a protected ACL, then re-read and verified;
  ;  - the folders are found by the known-folder API, not an environment variable.
  ; The script is extracted to $PLUGINSDIR (this installer's private temp folder) and
  ; run from there with the system's own PowerShell, by absolute path.
  Push $R0
  Push $R1
  InitPluginsDir
  File "/oname=$PLUGINSDIR\update-dirs.ps1" "${BUILD_RESOURCES_DIR}\apply-update\update-dirs.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\update-dirs.ps1" -Mode Install -InstallDir "$INSTDIR"'
  Pop $R1
  ${If} $R1 == "0"
    ; Highest privileges, as the account running this installer; never started by a
    ; schedule (the start time is a placeholder), only by `schtasks /Run` from the app.
    nsExec::Exec 'schtasks /Create /F /TN "OrderBook Master Update" /SC ONCE /ST 00:00 /RL HIGHEST /TR "\"$INSTDIR\resources\apply-update\apply-update.cmd\""'
    Pop $R1
  ${Else}
    ; Not registered, and any task left by an earlier version is removed: without
    ; trustworthy folders the nightly update falls back to asking for approval.
    nsExec::Exec 'schtasks /Delete /F /TN "OrderBook Master Update"'
    Pop $R1
    DetailPrint "The nightly update task was not registered: its folders could not be made trustworthy."
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

; The sweep script has to be taken out of the program folder while there still
; is one. `customUnInit` runs from `un.onInit`, before anything is deleted;
; `customUnInstall` — where the script is actually run — runs *after*
; `RMDir /r $INSTDIR`, so reading it from `$INSTDIR\resources` there would find
; nothing (node_modules/app-builder-lib/templates/nsis/uninstaller.nsh).
;
; A folder of our own under $TEMP rather than a bare file: the Office Panel
; copies the same script name, and the two uninstalls can overlap.
!macro customUnInit
  CreateDirectory "$TEMP\OrderBook-uninstall-master"
  CopyFiles /SILENT "$INSTDIR\resources\uninstall\uninstall-orderbook.ps1" "$TEMP\OrderBook-uninstall-master"
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="OrderBook Master (TCP 4100)"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="OrderBook Discovery (UDP 45789)"'

  ; Never during an update. `isUpdated` means a new version is being installed
  ; over this one, and the sweep would delete the data directory and the profile
  ; that the version now being staged is about to open.
  ${IfNot} ${isUpdated}
    ; The nightly update's task and folders go with the program. Not during an
    ; update: the task may be what started it, and customInstall re-registers it.
    nsExec::Exec 'schtasks /Delete /F /TN "OrderBook Master Update"'
    Push $R0
    ReadEnvStr $R0 ProgramData
    ${If} $R0 == ""
      StrCpy $R0 "C:\ProgramData"
    ${EndIf}
    RMDir /r "$R0\OrderBook\elevated"
    RMDir /r "$R0\OrderBook\staged-update"
    RMDir "$R0\OrderBook"
    Pop $R0

    ; $R7 is the script's data flag either way, so both branches below answer
    ; the same parameter and an unanswered question keeps the data.
    StrCpy $R7 "-KeepData"

    ${If} ${Silent}
      ; Nobody is standing there to ask. `$isDeleteAppData` is the template's
      ; own answer, set just above this macro from `--delete-app-data`; without
      ; that flag it is "0" and the company's records stay where they are.
      ${If} $isDeleteAppData == "1"
        StrCpy $R7 ""
      ${EndIf}
      Goto orderbookDataAnswered
    ${EndIf}

    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Also delete all OrderBook data on this PC?$\r$\n$\r$\nThat is the database, the uploaded photos and the settings. Every party, lead and order kept on this PC goes with them, and it cannot be undone.$\r$\n$\r$\nChoose No to keep the data for a later reinstall." /SD IDNO IDNO orderbookDataAnswered
    StrCpy $R7 ""

    orderbookDataAnswered:

    IfFileExists "$TEMP\OrderBook-uninstall-master\uninstall-orderbook.ps1" 0 orderbookSweepSkipped
    nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TEMP\OrderBook-uninstall-master\uninstall-orderbook.ps1" -Panel master -LeftoversOnly -Yes $R7'
    orderbookSweepSkipped:
  ${EndIf}

  Delete "$TEMP\OrderBook-uninstall-master\uninstall-orderbook.ps1"
  RMDir "$TEMP\OrderBook-uninstall-master"
!macroend
