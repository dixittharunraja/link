; Windows Firewall silently blocks inbound connections for an app whose first-run prompt was
; dismissed, which breaks pairing (discovery still works, so it only shows up as a connect
; timeout). The installer opens the app explicitly instead of relying on that prompt.
; Rules are created per executable, so every Link port is covered without listing them.
;
; The virtual webcam is registered here so phones can be used as a camera without a UAC prompt on
; first use. Windows 11 (build 22000 and newer) gets Link's Media Foundation camera, which Store apps
; such as WhatsApp can see and which browsers and other apps can see too; the older DirectShow camera
; (Softcam) is removed there, or apps would list two cameras with the same name. Earlier Windows gets
; Softcam. regsvr32 must be the 64-bit one, which a 32-bit installer only reaches through Sysnative.
;
; WinFsp provides the kernel side of mounted phone drives, and ViGEmBus the virtual game
; controllers for the joystick tool. Each bundled installer is run silently when its driver is not
; already present.
;
; The virtual display for Second Screen is Virtual Display Driver (MIT, signed by SignPath Foundation, so
; Windows trusts it without any certificate step). Its package is staged here, and this executable is
; registered as the LinkDisplayHelper service, which adds the virtual monitor while a phone uses it and
; removes it afterwards without a prompt (see core/display_helper.rs). Nothing appears until then.

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

  IfFileExists "$INSTDIR\vendor\vdd\MttVDD.inf" 0 vdd_done
    nsExec::ExecToLog 'pnputil /add-driver "$INSTDIR\vendor\vdd\MttVDD.inf"'
    ; The driver reads its monitor sizes from here; an existing file is the user's and is kept.
    IfFileExists "C:\VirtualDisplayDriver\vdd_settings.xml" vdd_settings_present 0
      CreateDirectory "C:\VirtualDisplayDriver"
      CopyFiles /SILENT "$INSTDIR\vendor\vdd\vdd_settings.xml" "C:\VirtualDisplayDriver\vdd_settings.xml"
    vdd_settings_present:
    nsExec::ExecToLog 'sc create LinkDisplayHelper binPath= "\"$INSTDIR\${MAINBINARYNAME}.exe\" --display-service" start= auto DisplayName= "Link display helper"'
    nsExec::ExecToLog 'sc config LinkDisplayHelper binPath= "\"$INSTDIR\${MAINBINARYNAME}.exe\" --display-service" start= auto'
    nsExec::ExecToLog 'sc start LinkDisplayHelper'
  vdd_done:

  StrCpy $2 "$SYSDIR\regsvr32.exe"
  IfFileExists "$WINDIR\Sysnative\regsvr32.exe" 0 +2
    StrCpy $2 "$WINDIR\Sysnative\regsvr32.exe"
  ReadRegStr $3 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  IntCmp $3 22000 vcam_modern vcam_classic vcam_modern
  vcam_modern:
    IfFileExists "$INSTDIR\vendor\link-vcam\link-vcam-mf.dll" 0 vcam_classic
      nsExec::ExecToLog '"$2" /s "$INSTDIR\vendor\link-vcam\link-vcam-mf.dll"'
      IfFileExists "$INSTDIR\vendor\softcam\softcam.dll" 0 softcam_done
        nsExec::ExecToLog '"$2" /u /s "$INSTDIR\vendor\softcam\softcam.dll"'
      Goto softcam_done
  vcam_classic:
  IfFileExists "$INSTDIR\vendor\softcam\softcam.dll" 0 softcam_done
    nsExec::ExecToLog '"$2" /s "$INSTDIR\vendor\softcam\softcam.dll"'
  softcam_done:
  ; Remove entries left under the camera's former names ("DirectShow Softcam" and "Phone Camera").
  nsExec::ExecToLog 'reg delete "HKCR\CLSID\{860BB310-5D01-11D0-BD3B-00A0C911CE86}\Instance\DirectShow Softcam" /f'
  nsExec::ExecToLog 'reg delete "HKCR\CLSID\{860BB310-5D01-11D0-BD3B-00A0C911CE86}\Instance\Phone Camera" /f'

  ; Clear rules Windows created from firewall prompts, including Block rules, which win over Allow.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name=all program="$INSTDIR\${MAINBINARYNAME}.exe"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Link" dir=in action=allow program="$INSTDIR\${MAINBINARYNAME}.exe" profile=any enable=yes'
!macroend

; Windows' camera service keeps a camera component loaded while an app uses it, which would block
; replacing or deleting the file; it restarts by itself the next time a camera app needs it.
!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'net stop FrameServer /y'
  ; The service runs this executable, which would otherwise be locked during an update.
  nsExec::ExecToLog 'sc stop LinkDisplayHelper'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'net stop FrameServer /y'
  nsExec::ExecToLog 'sc stop LinkDisplayHelper'
  nsExec::ExecToLog 'sc delete LinkDisplayHelper'
  StrCpy $2 "$SYSDIR\regsvr32.exe"
  IfFileExists "$WINDIR\Sysnative\regsvr32.exe" 0 +2
    StrCpy $2 "$WINDIR\Sysnative\regsvr32.exe"
  IfFileExists "$INSTDIR\vendor\link-vcam\link-vcam-mf.dll" 0 vcam_unreg_done
    nsExec::ExecToLog '"$2" /u /s "$INSTDIR\vendor\link-vcam\link-vcam-mf.dll"'
  vcam_unreg_done:
  IfFileExists "$INSTDIR\vendor\softcam\softcam.dll" 0 softcam_unreg_done
    nsExec::ExecToLog '"$2" /u /s "$INSTDIR\vendor\softcam\softcam.dll"'
  softcam_unreg_done:
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name=all program="$INSTDIR\${MAINBINARYNAME}.exe"'
!macroend
