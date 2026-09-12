; DIHLSS5 uninstaller hook (picked up automatically by electron-builder from buildResources).
; Runs before any files are removed. On a real uninstall (not an upgrade) it offers to undo
; everything DIHLSS5 changed in your games: DLSS 5 files, ReShade, looks, swapped DLLs.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${ifNot} ${Silent}
      ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION "Also undo DIHLSS5's changes in your games?$\r$\n$\r$\nThis removes the DLSS 5 files, ReShade and looks DIHLSS5 added, and puts back anything it replaced. Choose No to keep your games as they are." IDYES`
        DetailPrint "Restoring your games to how they were before DIHLSS5..."
        ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --restore-all' $0
        DetailPrint "Restore finished (exit code $0)."
      ${EndIf}
    ${endIf}
  ${endIf}
!macroend
