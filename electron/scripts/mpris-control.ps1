param(
  [Parameter(Position = 0)] [string]$Action,
  [Parameter(Position = 1)] [string]$Player,
  [Parameter(Position = 2)] [string]$Value
)

# Enable system WinRT support
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionTimelineProperties,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackInfo,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null

# AsTask helper generic finder
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { 
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' 
})[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}

# Request the Session Manager
$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$sessionManager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) $managerType

if ($Action -eq 'get') {
    $sessions = $sessionManager.GetSessions()
    # Built as real objects and serialized via ConvertTo-Json rather than hand-concatenated
    # strings — the old manual escaping only handled backslash/double-quote, so a track's
    # Title/Artist/Album containing a literal control character (some apps' metadata includes a
    # stray \r or \n) produced JSON that looked fine to PowerShell but was invalid per the JSON
    # spec (control characters inside a string must be escaped), which crashed Node's JSON.parse
    # with "Bad control character in string literal". ConvertTo-Json escapes all of this correctly.
    $objects = @()

    foreach ($session in $sessions) {
        $appId = $session.SourceAppUserModelId
        # Clean app id to look like a friendly name
        $cleanName = $appId
        if ($cleanName.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
            $cleanName = $cleanName.Substring(0, $cleanName.Length - 4)
        }
        # Capitalize first letter
        if ($cleanName.Length -gt 0) {
            $cleanName = $cleanName.Substring(0,1).ToUpper() + $cleanName.Substring(1)
        }

        # Media properties
        $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
        $props = Await ($session.TryGetMediaPropertiesAsync()) $propsType

        # Playback info
        $playback = $session.GetPlaybackInfo()
        $status = $playback.PlaybackStatus.ToString() # e.g. "Playing", "Paused"
        $isPlaying = ($status -eq 'Playing')

        # Timeline properties (Seek / Position / Length)
        $timeline = $session.GetTimelineProperties()
        $lengthMs = [int]($timeline.EndTime.TotalMilliseconds)
        $posMs = [int]($timeline.Position.TotalMilliseconds)

        # Controls info
        $controls = $playback.Controls
        $canPlay = if ($null -ne $controls -and $null -ne $controls.IsPlayEnabled) { $controls.IsPlayEnabled } else { $false }
        $canPause = if ($null -ne $controls -and $null -ne $controls.IsPauseEnabled) { $controls.IsPauseEnabled } else { $false }
        $canGoNext = if ($null -ne $controls -and $null -ne $controls.IsNextEnabled) { $controls.IsNextEnabled } else { $false }
        $canGoPrevious = if ($null -ne $controls -and $null -ne $controls.IsPreviousEnabled) { $controls.IsPreviousEnabled } else { $false }
        $canSeek = if ($null -ne $controls -and $null -ne $controls.IsSeekEnabled) { $controls.IsSeekEnabled } else { $false }

        # Replace ASCII double-quote (0x22), Unicode left (0x201C) and right (0x201D) double
        # quotation marks — all three break ConvertTo-Json string output and crash JSON.parse.
        function CleanStr($s) {
            if (-not $s) { return "" }
            return ([string]$s).Replace([char]0x201C, [char]0x27).Replace([char]0x201D, [char]0x27).Replace([char]0x22, [char]0x27).Replace("`r", "").Replace("`n", " ")
        }
        $cleanTitle  = if ($props.Title)     { CleanStr $props.Title }     else { "Unknown" }
        $cleanArtist = if ($props.Artist)    { CleanStr $props.Artist }    else { "" }
        $cleanAlbum  = if ($props.AlbumTitle){ CleanStr $props.AlbumTitle } else { "" }

        $objects += [PSCustomObject]@{
            player         = [string]$cleanName
            playerId       = [string]$appId
            title          = $cleanTitle
            artist         = $cleanArtist
            album          = $cleanAlbum
            isPlaying      = $isPlaying
            canPlay        = $canPlay
            canPause       = $canPause
            canGoNext      = $canGoNext
            canGoPrevious  = $canGoPrevious
            canSeek        = $canSeek
            length         = $lengthMs
            pos            = $posMs
        }
    }

    if ($objects.Count -eq 0) {
        Write-Output "[]"
    } elseif ($objects.Count -eq 1) {
        Write-Output ("[" + ($objects[0] | ConvertTo-Json -Compress) + "]")
    } else {
        Write-Output ($objects | ConvertTo-Json -Compress)
    }

} elseif ($Action -eq 'control') {
    # Find matching session
    $sessions = $sessionManager.GetSessions()
    $targetSession = $null

    foreach ($session in $sessions) {
        $appId = $session.SourceAppUserModelId
        $cleanName = $appId
        if ($cleanName.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
            $cleanName = $cleanName.Substring(0, $cleanName.Length - 4)
        }
        if ($cleanName.Length -gt 0) {
            $cleanName = $cleanName.Substring(0,1).ToUpper() + $cleanName.Substring(1)
        }

        if ($cleanName -eq $Player -or $appId -eq $Player) {
            $targetSession = $session
            break
        }
    }

    # Fallback to current main session if no match but session exists
    if ($null -eq $targetSession) {
        $targetSession = $sessionManager.GetCurrentSession()
    }

    if ($targetSession) {
        $op = $null
        if ($Value -eq 'PlayPause') {
            $op = $targetSession.TryTogglePlayPauseAsync()
        } elseif ($Value -eq 'Play') {
            $op = $targetSession.TryPlayAsync()
        } elseif ($Value -eq 'Pause') {
            $op = $targetSession.TryPauseAsync()
        } elseif ($Value -eq 'Next') {
            $op = $targetSession.TrySkipNextAsync()
        } elseif ($Value -eq 'Previous') {
            $op = $targetSession.TrySkipPreviousAsync()
        } elseif ($Value -eq 'Stop') {
            $op = $targetSession.TryStopAsync()
        } elseif ($Action -eq 'control' -and $Player -ne '' -and $Value.StartsWith('Seek:')) {
            # Seek action with parameter value
            $posMs = [double]($Value.Substring(5))
            $ticks = [long]($posMs * 10000) # 1 ms = 10,000 ticks
            $op = $targetSession.TryChangePlaybackPositionAsync($ticks)
        }

        if ($null -ne $op) {
            $boolType = [bool]
            $success = Await $op $boolType
            Write-Output "control-result: $success"
        } else {
            Write-Output "control-result: unsupported-action"
        }
    } else {
        Write-Output "control-result: no-player"
    }
}
