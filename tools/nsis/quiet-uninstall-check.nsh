; What a setup does when the old version's uninstaller reports a failure.
;
; electron-builder's own check (templates/nsis/include/installUtil.nsh) shows a
; MessageBox with no /SD, so even a /S run stops on it until somebody clicks OK.
; Every update is a /S run with the server already stopped: nobody may be there,
; and the panel would stay down behind a dialog. A silent run says nothing and
; exits with the same code 2. Under --force-run it starts the program that is still
; installed, which reports the failed update through the update-run record.
!include "FileFunc.nsh"

!macro customUnInstallCheck
  IfErrors 0 +3
  DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  Return

  ${if} $R0 != 0
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    ${EndIf}
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    ${GetParameters} $R1
    ClearErrors
    ${GetOptions} $R1 "--force-run" $R2
    ${IfNot} ${Errors}
      ${StdUtils.ExecShellAsUser} $R2 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" ""
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${endif}
!macroend
