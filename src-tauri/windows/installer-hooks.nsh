; Windows Firewall silently blocks inbound connections for an app whose first-run prompt was
; dismissed, which breaks pairing (discovery still works, so it only shows up as a connect
; timeout). The installer opens the app explicitly instead of relying on that prompt.
; Rules are created per executable, so every Link port is covered without listing them.
;
; WinFsp provides the kernel side of mounted phone drives, and ViGEmBus the virtual game
; controllers for the joystick tool. Each bundled installer is run silently when its driver is not
; already present.

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$PROGRAMFILES32\WinFsp\bin\winfsp-x64.dll" winfsp_present 0
    FindFirst $0 $1 "$INSTDIR\vendor\winfsp\*.msi"
    StrCmp $1 "" winfsp_done 0
      nsExec::ExecToLog 'msiexec /i "$INSTDIR\vendor\winfsp\$1" /qn /norestart'
    winfsp_done:
    FindClose $0
  winfsp_present:

  IfFileExists "$SYSDIR\drivers\ViGEmBus.sys" vigembus_present 0
    IfFileExists "$INSTDIR\vendor\vigembus\ViGEmBus_Setup.exe" 0 vigembus_present
      nsExec::ExecToLog '"$INSTDIR\vendor\vigembus\ViGEmBus_Setup.exe" /quiet /norestart'
  vigembus_present:

  ; Clear rules Windows created from earlier prompts (including Block rules, which win over Allow).
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name=all program="$INSTDIR\${MAINBINARYNAME}.exe"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Link" dir=in action=allow program="$INSTDIR\${MAINBINARYNAME}.exe" profile=any enable=yes'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name=all program="$INSTDIR\${MAINBINARYNAME}.exe"'
!macroend
