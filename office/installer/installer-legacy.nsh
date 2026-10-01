; The Windows 7 Office installer (electron-builder.legacy.yml): everything
; installer.nsh does, plus one check before installing.
;
; The Windows 7 build expects the Universal C Runtime, which Windows 7 and 8.1
; get from update KB2999226 (Windows 10 has it built in). A PC that never took
; Windows Updates lacks it, and OrderBook can then fail to start with a
; missing-DLL error that names none of this. The check only warns: the install
; goes ahead, and the message says what to install.
;
; ${__FILEDIR__} is this file's own folder, so the include does not depend on
; the folder makensis runs in.
!include "${__FILEDIR__}\installer.nsh"

!macro customInit
  IfFileExists "$SYSDIR\ucrtbase.dll" orderbookUcrtFound 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "This PC is missing the Windows Universal C Runtime (update KB2999226).$\r$\n$\r$\nOrderBook will install, but it may not start until that update is installed. Install it from Windows Update, or from the Microsoft Update Catalog on a USB stick, and then start OrderBook." /SD IDOK
  orderbookUcrtFound:
!macroend
