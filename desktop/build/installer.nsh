!macro customInstall
  DetailPrint "Configuring Windows Firewall rules for Link..."
  nsExec::ExecToLog 'cmd.exe /c netsh advfirewall firewall add rule name="Link App" dir=in action=allow program="$INSTDIR\Link.exe" enable=yes profile=any description="Allow Link peer-to-peer connection over TLS/UDP"'
!macroend

!macro customUninstall
  DetailPrint "Removing Windows Firewall rules for Link..."
  nsExec::ExecToLog 'cmd.exe /c netsh advfirewall firewall delete rule name="Link App"'
!macroend
