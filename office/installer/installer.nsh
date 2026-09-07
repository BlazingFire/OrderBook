; The Office Panel needs no inbound firewall rules.
;
; Its server binds 127.0.0.1 only — nothing on the network talks to it. It makes
; outbound connections to the Master and receives the discovery reply on an
; ephemeral port, both of which Windows allows by default. Adding rules here
; would open ports nothing listens on, which is the wrong direction.
;
; It does need the same leftovers sweep on uninstall as the Master: NSIS removes
; the program folder and nothing else, and this panel still leaves an Electron
; profile, an updater cache, shortcuts and registry entries behind. That is what
; tools/uninstall/uninstall-orderbook.ps1 clears.

!macro customInstall
!macroend

; The sweep script has to be taken out of the program folder while there still
; is one. `customUnInit` runs from `un.onInit`, before anything is deleted;
; `customUnInstall` — where the script is actually run — runs *after*
; `RMDir /r $INSTDIR`, so reading it from `$INSTDIR\resources` there would find
; nothing (node_modules/app-builder-lib/templates/nsis/uninstaller.nsh).
;
; A folder of our own under $TEMP rather than a bare file: the Master Panel
; copies the same script name, and the two uninstalls can overlap.
!macro customUnInit
  CreateDirectory "$TEMP\OrderBook-uninstall-office"
  CopyFiles /SILENT "$INSTDIR\resources\uninstall\uninstall-orderbook.ps1" "$TEMP\OrderBook-uninstall-office"
!macroend

!macro customUnInstall
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
      ; that flag it is "0" and the panel's files stay where they are.
      ${If} $isDeleteAppData == "1"
        StrCpy $R7 ""
      ${EndIf}
      Goto orderbookDataAnswered
    ${EndIf}

    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Also delete all OrderBook data on this PC?$\r$\n$\r$\nThat is this panel's settings, cached files and saved sign-in. The company's records live on the Master Panel and are not touched.$\r$\n$\r$\nChoose No to keep them for a later reinstall." /SD IDNO IDNO orderbookDataAnswered
    StrCpy $R7 ""

    orderbookDataAnswered:

    IfFileExists "$TEMP\OrderBook-uninstall-office\uninstall-orderbook.ps1" 0 orderbookSweepSkipped
    nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TEMP\OrderBook-uninstall-office\uninstall-orderbook.ps1" -Panel office -LeftoversOnly -Yes $R7'
    orderbookSweepSkipped:
  ${EndIf}

  Delete "$TEMP\OrderBook-uninstall-office\uninstall-orderbook.ps1"
  RMDir "$TEMP\OrderBook-uninstall-office"
!macroend
