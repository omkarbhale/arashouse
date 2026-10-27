# Quiesce checks on the clone slot: does app_offline.htm release file locks (versus a pool stop), is a mirrored tree picked up without a
# recycle (and does the slot still log in), and can a non-admin user start and stop the slot's agent service after an sdset? Dry run by
# default; -Apply makes changes (elevated). Windows PowerShell 5.1. Results are booleans, counts and seconds only.
#
# The service check needs a service named ArasHouseAgent_spike_<flavor>_<suffix>. A baseline installed with INSTALL_AGENT_SERVICE=0 has no
# agent executable (ticket 05), so when the clone has none the check registers a stand-in service of that name (cmd.exe as LocalService,
# demand start, never a real agent) for the permission test only, and deletes it afterwards. The service ACL check does not depend on the binary.
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
    $ctx = @{ edited = @(); layout = @(); files = [ordered]@{}; pw = $null; dbId = $null }

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

    # Folders whose files a running slot may hold open: the Innovator server's assemblies (ASP.NET shadow-copies them, so they are
    # expected unlocked), generated method DLLs, temp and logs; the ASP.NET Core OAuth and Vault servers load their DLLs in place.
    $candidateRoots = [ordered]@{
        serverBin = @('Innovator\Server\bin', '*'); serverDll = @('Innovator\Server\dll', '*'); serverTemp = @('Innovator\Server\temp', '*')
        serverLogs = @('Innovator\Server\logs', '*'); oauthDlls = @('OAuthServer', '*.dll'); oauthAppData = @('OAuthServer\App_Data', '*')
        vaultDlls = @('VaultServer', '*.dll')
    }

    function Get-Candidates {
        # Up to 60 files per candidate root, keyed by the root's label.
        $found = [ordered]@{}
        foreach ($k in $candidateRoots.Keys) {
            $p = Join-Path $slot $candidateRoots[$k][0]
            $found[$k] = @()
            if (-not (Test-Path -LiteralPath $p)) { continue }
            $recurse = $candidateRoots[$k][1] -eq '*'
            $found[$k] = @(Get-ChildItem -LiteralPath $p -File -Recurse:$recurse -Force -Filter $candidateRoots[$k][1] -ErrorAction SilentlyContinue | Select-Object -First 60 | ForEach-Object { $_.FullName })
        }
        return $found
    }

    function Get-AllCandidates { $all = @(); foreach ($k in $ctx.files.Keys) { $all += $ctx.files[$k] }; return $all }

    function Get-LockedByRoot {
        $row = [ordered]@{}
        foreach ($k in $ctx.files.Keys) { $row[$k] = [ordered]@{ files = $ctx.files[$k].Count; locked = (Get-LockedCount $ctx.files[$k]) } }
        return $row
    }

    function Invoke-WarmUp {
        # One login and one OData request, so the server, OAuth and Vault workers are loaded and their files open.
        [void](Get-SpikeHttpStatus "http://localhost/$($names.Alias)/Client/")
        $token = Get-SpikeArasToken -Alias $names.Alias -DatabaseId $ctx.dbId -ArasPassword $ctx.pw
        if ($token) {
            $plain = ConvertTo-SpikePlainText $token
            try {
                $req = [Net.HttpWebRequest]::Create("http://localhost/$($names.Alias)/Server/odata/User?`$top=1")
                $req.Headers.Add('Authorization', "Bearer $plain")
                $req.Timeout = 120000
                try { $res = $req.GetResponse(); $res.Close() } catch [Net.WebException] { }
            } finally { $plain = $null }
        }
        [void](Get-SpikeHttpStatus "http://localhost/$($names.Alias)/Vault/")
        return [bool]$token
    }

    Invoke-SpikeStep "read the clone's recorded IIS layout and edited files from $cloneJson; warm up /$($names.Alias) (log in, one OData request)" {
        if (-not (Test-Path -LiteralPath $cloneJson)) { throw "PRECONDITION: $cloneJson is missing; run 20-clone-slot.ps1 first." }
        $c = Get-Content -LiteralPath $cloneJson -Raw | ConvertFrom-Json
        $base = Get-Content -LiteralPath (Join-Path $script:SpikeOutDir "10-baseline-install-$Flavor-$SourceSuffix.json") -Raw | ConvertFrom-Json
        $ctx.layout = @($base.iisLayout)
        $ctx.edited = @($c.editedFiles | ForEach-Object { Join-Path $slot $_.file })
        $ctx.pw = Get-SpikeArasPassword
        $ctx.dbId = Get-SpikeDbId -ConfigPath (Find-SpikeFile -Root $slot -Name 'InnovatorServerConfig.xml')
        Restart-SpikePools -Alias $names.Alias
        Add-SpikeFact 'warmLoggedIn' (Invoke-WarmUp)
        $ctx.files = Get-Candidates
        Add-SpikeFact 'candidateLockFiles' @(Get-AllCandidates).Count
        Add-SpikeFact 'lockedBeforeAnyQuiesce' (Get-LockedByRoot)
    }

    Invoke-SpikeStep 'quiesce method 1: app_offline.htm in every application folder; seconds until no candidate file is locked (null = still locked at the timeout)' {
        Set-AppOffline $true
        Add-SpikeFact 'appOfflineSecondsToUnlocked' (Wait-Unlocked (Get-AllCandidates))
        Add-SpikeFact 'appOfflineLockedAtEnd' (Get-LockedByRoot)
    }

    Invoke-SpikeStep 'mirror the baseline over the slot while app_offline is up (the edited config files are excluded so the slot keeps its identity), then remove app_offline and check the instance serves the mirrored tree without a recycle' {
        $marker = Assert-SpikePath -Path (Join-Path $slot 'Innovator\Client\spike-marker.txt') -Mode Write
        [IO.File]::WriteAllText($marker, 'marker')
        Set-AppOffline $false
        Add-SpikeFact 'markerServedBeforeMirror' ((Get-SpikeHttpStatus "http://localhost/$($names.Alias)/Client/spike-marker.txt") -eq 200)
        Set-AppOffline $true
        # app_offline.htm is not in the baseline, so /MIR would delete it and bring the slot online mid-mirror: exclude it too.
        $offline = @($ctx.layout | ForEach-Object { Join-Path (Join-Path $slot $_.physicalRelative) 'app_offline.htm' })
        $r = Invoke-SpikeRobocopy -Source $golden -Destination $slot -Mirror -Threads 16 -ExcludeFiles ($ctx.edited + $offline)
        Add-SpikeFact 'mirrorWhileOfflineSeconds' $r.seconds
        Add-SpikeFact 'mirrorWhileOfflineExit' $r.exitCode
        Set-AppOffline $false
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $status = Get-SpikeHttpStatus "http://localhost/$($names.Alias)/Client/"
        Add-SpikeFact 'firstRequestAfterOfflineSeconds' ([math]::Round($sw.Elapsed.TotalSeconds, 1))
        Add-SpikeFact 'firstRequestAfterOfflineStatus' $status
        Add-SpikeFact 'markerGoneWithoutRecycle' ((Get-SpikeHttpStatus "http://localhost/$($names.Alias)/Client/spike-marker.txt") -eq 404)
        Add-SpikeFact 'loginAfterMirrorWithoutRecycle' (Test-SpikeArasLogin -Alias $names.Alias -DatabaseId $ctx.dbId -ArasPassword $ctx.pw)
        if ($script:SpikeLastLoginError) { Add-SpikeFact 'loginAfterMirrorRefusal' $script:SpikeLastLoginError }
    }

    Invoke-SpikeStep 'quiesce method 2: stop the pools instead; seconds until no candidate file is locked; start them again' {
        Restart-SpikePools -Alias $names.Alias
        [void](Invoke-WarmUp)
        $ctx.files = Get-Candidates
        Add-SpikeFact 'lockedBeforePoolStop' (Get-LockedByRoot)
        Restart-SpikePools -Alias $names.Alias -Stop
        Add-SpikeFact 'poolStopSecondsToUnlocked' (Wait-Unlocked (Get-AllCandidates))
        Add-SpikeFact 'poolStopLockedAtEnd' (Get-LockedByRoot)
        Restart-SpikePools -Alias $names.Alias -Start
    }

    Invoke-SpikeStep "non-admin service control: create local user $userName (random password, never shown), try sc start as that user, sc sdset $($names.Service) to let it start and stop, try sc start and sc stop again, then restore the descriptor and delete the user (a failure here is recorded, not fatal)" {
        $standIn = $false
        try {
            $svc = Get-CimInstance Win32_Service -Filter "Name='$($names.Service)'"
            $standIn = -not $svc
            if ($standIn) {
                # No agent in the tree: a stand-in of the same name, so the ACL test runs (sc start then ends in 1053, which is not 5).
                & sc.exe create $names.Service binPath= "$env:windir\System32\cmd.exe /c exit 0" start= demand obj= 'NT AUTHORITY\LocalService' | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "SC: creating the stand-in service $($names.Service) failed ($LASTEXITCODE)." }
            }
            Add-SpikeFact 'serviceControlStandIn' $standIn
            $pw = New-SpikePassword
            New-LocalUser -Name $userName -Password $pw -PasswordNeverExpires -AccountNeverExpires | Out-Null
            $original = ((& sc.exe sdshow $names.Service) -join '').Trim()
            $cred = New-Object Management.Automation.PSCredential(("$env:COMPUTERNAME\$userName"), $pw)
            function Invoke-ScAsUser([string]$verb) {
                $outFile = Join-Path $script:SpikeOutDir "50-sc-$verb.txt"
                try {
                    $p = Start-Process -FilePath "$env:windir\System32\sc.exe" -ArgumentList @($verb, $names.Service) -Credential $cred -LoadUserProfile -Wait -PassThru -RedirectStandardOutput $outFile -WorkingDirectory $env:windir
                    # sc exit 5 = access denied; any other code means the permission check passed.
                    return [ordered]@{ exitCode = $p.ExitCode; permissionGranted = ($p.ExitCode -ne 5) }
                } finally { Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue }
            }
            try {
                $res = [ordered]@{ startBeforeSdset = (Invoke-ScAsUser 'start') }
                $sid = (Get-LocalUser -Name $userName).SID.Value
                $idx = $original.IndexOf('S:')
                $dacl = if ($idx -ge 0) { $original.Substring(0, $idx) } else { $original }
                $sacl = if ($idx -ge 0) { $original.Substring($idx) } else { '' }
                & sc.exe sdset $names.Service ($dacl + "(A;;LCRPWP;;;$sid)" + $sacl) | Out-Null
                $res.start = Invoke-ScAsUser 'start'
                $res.stop = Invoke-ScAsUser 'stop'
                Add-SpikeFact 'serviceControl' $res
            } finally {
                & sc.exe sdset $names.Service $original | Out-Null
            }
        } catch {
            Add-SpikeFact 'serviceControl' ('failed: ' + $_.Exception.Message)
        } finally {
            Remove-LocalUser -Name $userName -ErrorAction SilentlyContinue
            if ($standIn) { & sc.exe delete $names.Service | Out-Null }
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
