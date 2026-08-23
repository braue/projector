; Close a running Projector before installing over it.
;
; The stock check does not reliably terminate the app in a per-user one-click
; install, and a running Projector holds its own program files open — so the
; copy stalls forever at "Installing, please wait..." with no way forward. Ask
; nicely first, then insist.
;
; Losing the process costs nothing: every project write lands on disk when the
; API call is made, and all state lives in %APPDATA%\Projector, outside the
; install directory the installer is about to replace.

!macro customInit
  DetailPrint "Closing Projector if it is running..."
  ; WM_CLOSE first, so the app shuts its server down on its own terms.
  nsExec::Exec 'taskkill /IM "Projector.exe"'
  Pop $0
  Sleep 2000
  ; Anything still holding the directory goes, along with its child processes.
  nsExec::Exec 'taskkill /F /T /IM "Projector.exe"'
  Pop $0
  Sleep 500
!macroend
