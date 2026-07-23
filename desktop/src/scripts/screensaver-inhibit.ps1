# Persistent helper for the screensaver-inhibit plugin. SetThreadExecutionState's effect only
# lasts for the lifetime of the calling thread/process (per MSDN: it's cleared automatically when
# the process that made the call terminates), so this has to be a long-lived process, not a
# one-shot exec like the systemvolume script — killing this process is what turns inhibition off.
$sig = @"
[DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
"@
Add-Type -MemberDefinition $sig -Name "Power" -Namespace "Win32Inhibit"

$ES_CONTINUOUS = [uint32]2147483648
$ES_DISPLAY_REQUIRED = [uint32]0x00000002

[Win32Inhibit.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_DISPLAY_REQUIRED) | Out-Null

while ($true) {
    Start-Sleep -Seconds 30
}
