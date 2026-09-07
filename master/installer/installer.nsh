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
