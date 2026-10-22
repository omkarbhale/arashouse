# Quiesce checks on the clone slot: does app_offline.htm release file locks (versus a pool stop), is a mirrored tree picked up without a
# recycle, and can a non-admin user start and stop the slot's agent service after an sdset? Dry run by default; -Apply makes changes
# (elevated). Windows PowerShell 5.1. Results are booleans, counts and seconds only.
param(
    [switch]$Apply,
    [ValidateSet('12sp9', '23', '35')][string]$Flavor = '12sp9',
    [ValidatePattern('^[a-z0-9]{1,8}$')][string]$SourceSuffix = 'a',
    [ValidatePattern('^[a-z0-9]{1,8}$')][string]$SlotSuffix = 'b',
    # Give up waiting for locks to release after this many seconds.
    [ValidateRange(10, 600)][int]$LockWaitSeconds = 120
)
. "$PSScriptRoot/lib/SpikeCommon.ps1"

try {
    $names = Get-SpikeNames -Flavor $Flavor -Suffix $SlotSuffix
    $golden = Assert-SpikePath -Path (Join-Path $script:SpikeRoot ("golden-build\" + $(if ($SourceSuffix -eq 'a') { $Flavor } else { "$Flavor-$SourceSuffix" }))) -Mode Read
    $slot = Assert-SpikePath -Path (Join-Path $script:SpikeRoot "slot-$Flavor-$SlotSuffix") -Mode Write
    Assert-SpikeName -Kind Alias -Name $names.Alias
    Assert-SpikeName -Kind Service -Name $names.Service
    $userName = "arashouse_spike_nonadmin"
    Assert-SpikeName -Kind Login -Name $userName
    $cloneJson = Join-Path $script:SpikeOutDir "20-clone-slot-$Flavor-$SlotSuffix.json"

    Start-Spike -Name "50-quiesce-$Flavor" -Apply $Apply.IsPresent -NeedsElevation
    $ctx = @{ edited = @(); layout = @(); files = @() }

    function Get-LockedCount([string[]]$files) {
        $locked = 0
        foreach ($f in $files) {
            try { $s = [IO.File]::Open($f, 'Open', 'ReadWrite', 'None'); $s.Dispose() } catch [IO.IOException] { $locked++ } catch { }
        }
        return $locked
    }

    function Wait-Unlocked([string[]]$files) {
        # Seconds until no candidate file is locked, or $null on timeout.
        $sw = [Diagnostics.Stopwatch]::StartNew()
        while ($sw.Elapsed.TotalSeconds -lt $LockWaitSeconds) {
            if ((Get-LockedCount $files) -eq 0) { return [math]::Round($sw.Elapsed.TotalSeconds, 1) }
            Start-Sleep -Milliseconds 500
        }
        return $null
    }

    function Set-AppOffline([bool]$on) {
        foreach ($app in $ctx.layout) {
            $dir = Join-Path $slot $app.physicalRelative
            $file = Assert-SpikePath -Path (Join-Path $dir 'app_offline.htm') -Mode Write
            if ($on) { [IO.File]::WriteAllText($file, '<html><body>offline for spike</body></html>') }
            elseif (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
        }
    }

    function Get-Candidates {
        # Files that a running Aras worker may hold open: loaded assemblies, generated method DLLs, sqlite files.
        $roots = @('Innovator\Server\bin', 'Innovator\Server\dll', 'Innovator\OAuthServer\App_Data', 'Innovator\Server\logs')
        $found = @()
        foreach ($r in $roots) {
            $p = Join-Path $slot $r
            if (Test-Path -LiteralPath $p) { $found += @(Get-ChildItem -LiteralPath $p -File -Recurse -Force -ErrorAction SilentlyContinue | Select-Object -First 60 | ForEach-Object { $_.FullName }) }
        }
        return $found
    }

    Invoke-SpikeStep "read the clone's recorded IIS layout and edited files from $cloneJson; warm up /$($names.Alias)" {
        if (-not (Test-Path -LiteralPath $cloneJson)) { throw "PRECONDITION: $cloneJson is missing; run 20-clone-slot.ps1 first." }
        $c = Get-Content -LiteralPath $cloneJson -Raw | ConvertFrom-Json
        $base = Get-Content -LiteralPath (Join-Path $script:SpikeOutDir "10-baseline-install-$Flavor-$SourceSuffix.json") -Raw | ConvertFrom-Json
        $ctx.layout = @($base.iisLayout)
        $ctx.edited = @($c.editedFiles | ForEach-Object { Join-Path $slot $_.file })
        Restart-SpikePools -Alias $names.Alias
        Add-SpikeFact 'warmStatus' (Get-SpikeHttpStatus "http://localhost/$($names.Alias)/Client/")
        $ctx.files = @(Get-Candidates)
        Add-SpikeFact 'candidateLockFiles' $ctx.files.Count
        Add-SpikeFact 'lockedBeforeAnyQuiesce' (Get-LockedCount $ctx.files)
    }

    Invoke-SpikeStep 'quiesce method 1: app_offline.htm in every application folder; seconds until no candidate file is locked (null = still locked at the timeout)' {
        Set-AppOffline $true
        Add-SpikeFact 'appOfflineSecondsToUnlocked' (Wait-Unlocked $ctx.files)
        Add-SpikeFact 'appOfflineLockedAtEnd' (Get-LockedCount $ctx.files)
    }

    Invoke-SpikeStep 'mirror the baseline over the slot while app_offline is up (the edited config files are excluded so the slot keeps its identity), then remove app_offline and check the instance serves the mirrored tree without a recycle' {
        $marker = Assert-SpikePath -Path (Join-Path $slot 'Innovator\Client\spike-marker.txt') -Mode Write
        [IO.File]::WriteAllText($marker, 'marker')
        Set-AppOffline $false
        Add-SpikeFact 'markerServedBeforeMirror' ((Get-SpikeHttpStatus "http://localhost/$($names.Alias)/Client/spike-marker.txt") -eq 200)
        Set-AppOffline $true
        $r = Invoke-SpikeRobocopy -Source $golden -Destination $slot -Mirror -Threads 16 -ExcludeFiles $ctx.edited
        Add-SpikeFact 'mirrorWhileOfflineSeconds' $r.seconds
        Add-SpikeFact 'mirrorWhileOfflineExit' $r.exitCode
        Set-AppOffline $false
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $status = Get-SpikeHttpStatus "http://localhost/$($names.Alias)/Client/"
        Add-SpikeFact 'firstRequestAfterOfflineSeconds' ([math]::Round($sw.Elapsed.TotalSeconds, 1))
        Add-SpikeFact 'firstRequestAfterOfflineStatus' $status
        Add-SpikeFact 'markerGoneWithoutRecycle' ((Get-SpikeHttpStatus "http://localhost/$($names.Alias)/Client/spike-marker.txt") -eq 404)
    }

    Invoke-SpikeStep 'quiesce method 2: stop the pools instead; seconds until no candidate file is locked; start them again' {
        Restart-SpikePools -Alias $names.Alias
        [void](Get-SpikeHttpStatus "http://localhost/$($names.Alias)/Client/")
        $ctx.files = @(Get-Candidates)
        $sw = [Diagnostics.Stopwatch]::StartNew()
        Restart-SpikePools -Alias $names.Alias -Stop
        Add-SpikeFact 'poolStopSecondsToUnlocked' (Wait-Unlocked $ctx.files)
        Add-SpikeFact 'poolStopLockedAtEnd' (Get-LockedCount $ctx.files)
        Restart-SpikePools -Alias $names.Alias -Start
    }

    Invoke-SpikeStep "non-admin service control: create local user $userName (random password, never shown), sc sdset $($names.Service) to let it start and stop, try sc start and sc stop as that user, then restore the descriptor and delete the user" {
        $svc = Get-CimInstance Win32_Service -Filter "Name='$($names.Service)'"
        if (-not $svc) { Add-SpikeFact 'serviceControl' 'skipped: the agent service was not created by script 20'; return }
        $pw = New-SpikePassword
        New-LocalUser -Name $userName -Password $pw -PasswordNeverExpires -AccountNeverExpires | Out-Null
        $original = ((& sc.exe sdshow $names.Service) -join '').Trim()
        try {
            $sid = (Get-LocalUser -Name $userName).SID.Value
            $idx = $original.IndexOf('S:')
            $dacl = if ($idx -ge 0) { $original.Substring(0, $idx) } else { $original }
            $sacl = if ($idx -ge 0) { $original.Substring($idx) } else { '' }
            $new = $dacl + "(A;;LCRPWP;;;$sid)"
            & sc.exe sdset $names.Service ($new + $sacl) | Out-Null
            $cred = New-Object Management.Automation.PSCredential(("$env:COMPUTERNAME\$userName"), $pw)
            $res = [ordered]@{}
            foreach ($verb in @('start', 'stop')) {
                $outFile = Join-Path $script:SpikeOutDir "50-sc-$verb.txt"
                $p = Start-Process -FilePath "$env:windir\System32\sc.exe" -ArgumentList @($verb, $names.Service) -Credential $cred -LoadUserProfile -Wait -PassThru -RedirectStandardOutput $outFile -WorkingDirectory $env:windir
                # sc exit 5 = access denied; any other code means the permission check passed.
                $res[$verb] = [ordered]@{ exitCode = $p.ExitCode; permissionGranted = ($p.ExitCode -ne 5) }
                Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
            }
            Add-SpikeFact 'serviceControl' $res
        } finally {
            & sc.exe sdset $names.Service $original | Out-Null
            Remove-LocalUser -Name $userName -ErrorAction SilentlyContinue
        }
    }

    Invoke-SpikeStep "remove the marker file if it is still there" {
        $marker = Join-Path $slot 'Innovator\Client\spike-marker.txt'
        if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
    }

    Complete-Spike
} catch {
    Exit-SpikeFailure $_.Exception.Message
}
