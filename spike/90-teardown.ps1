# Removes everything the spike created, and nothing else: IIS applications under /ah-spike-* and pools ah-spike-*, services
# ArasHouseAgent_spike_*, MSI registrations whose install location is under the spike folder, databases and logins arashouse_spike_*,
# local users arashouse_spike_*, folders under C:\aras_installations\spike (not out\ and not the scripts), ASP.NET temp folders
# ah-spike-*, and a stale Defender exclusion for the spike folder. Dry run by default; -Apply makes changes (elevated).
# Windows PowerShell 5.1. Afterwards re-run 00-preflight.ps1 -Apply: denyListUnchangedSinceBaseline must be true.
param(
    [switch]$Apply,
    [ValidateSet('Sa', 'Windows')][string]$SqlAuth = 'Sa'
)
. "$PSScriptRoot/lib/SpikeCommon.ps1"

# Folders of the spike root that a run creates. The scripts and out\ are kept; staging\ is not under the spike root.
$spikeFolders = @('golden-build', 'vaults', 'sqldata', 'golden-test', 'logs')

try {
    Start-Spike -Name '90-teardown' -Apply $Apply.IsPresent -NeedsElevation
    $ctx = @{ sqlPassword = $null }

    Invoke-SpikeStep 'stop and delete services named ArasHouseAgent_spike_*' {
        $removed = @()
        foreach ($svc in @(Get-CimInstance Win32_Service -Filter "Name LIKE 'ArasHouseAgent[_]spike[_]%'")) {
            Assert-SpikeName -Kind Service -Name $svc.Name
            if ($svc.State -ne 'Stopped') { Stop-Service -Name $svc.Name -Force -ErrorAction SilentlyContinue }
            & sc.exe delete $svc.Name | Out-Null
            $removed += $svc.Name
        }
        Add-SpikeFact 'servicesRemoved' $removed
    }

    Invoke-SpikeStep 'remove every IIS application under /ah-spike-* and every pool named ah-spike-*' {
        $r = Remove-SpikeIisApps
        Add-SpikeFact 'iisRemoved' $r
    }

    Invoke-SpikeStep 'uninstall MSI registrations whose InstallLocation is under the spike folder (msiexec /x, REMOVE_DATABASES=0; databases are dropped below)' {
        $done = @()
        foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
            foreach ($k in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
                $e = Get-ItemProperty -LiteralPath $k.PSPath
                $loc = Get-SpikeProperty $e 'InstallLocation'
                if (-not $loc -or -not (Test-SpikeUnder ($loc.TrimEnd('\')) $script:SpikeRoot)) { continue }
                if ($k.PSChildName -notmatch '^\{[0-9A-Fa-f-]{36}\}$') { continue }
                $p = Start-Process -FilePath msiexec.exe -ArgumentList @('/x', $k.PSChildName, '/qn', 'REMOVE_DATABASES=0', '/norestart') -Wait -PassThru
                $done += [ordered]@{ productCode = $k.PSChildName; exitCode = $p.ExitCode }
            }
        }
        Add-SpikeFact 'msiUninstalled' $done
    }

    if ($SqlAuth -eq 'Sa') {
        Invoke-SpikeStep 'prompt (hidden) for the SQL sa password' { $ctx.sqlPassword = Read-SpikeSecret -Prompt 'SQL sa password (hidden)' }
    }

    Invoke-SpikeStep 'drop databases arashouse_spike_* (single-user, roll back connections) and logins arashouse_spike_*' {
        $conn = if ($SqlAuth -eq 'Sa') { New-SpikeSqlConnection -Auth Sa -Password $ctx.sqlPassword } else { New-SpikeSqlConnection -Auth Windows }
        try {
            $dbs = @(Invoke-SpikeSql -Connection $conn -Query "SELECT name FROM sys.databases WHERE name LIKE N'arashouse[_]spike[_]%'" | ForEach-Object { $_.name })
            foreach ($db in $dbs) {
                Assert-SpikeName -Kind Database -Name $db
                $q = Format-SpikeSqlIdent $db
                Invoke-SpikeSql -Connection $conn -Query "ALTER DATABASE $q SET SINGLE_USER WITH ROLLBACK IMMEDIATE" | Out-Null
                Invoke-SpikeSql -Connection $conn -Query "DROP DATABASE $q" | Out-Null
            }
            $logins = @(Invoke-SpikeSql -Connection $conn -Query "SELECT name FROM sys.server_principals WHERE type = 'S' AND name LIKE N'arashouse[_]spike[_]%'" | ForEach-Object { $_.name })
            foreach ($l in $logins) {
                Assert-SpikeName -Kind Login -Name $l
                Invoke-SpikeSql -Connection $conn -Query ("DROP LOGIN " + (Format-SpikeSqlIdent $l)) | Out-Null
            }
            Add-SpikeFact 'databasesDropped' $dbs
            Add-SpikeFact 'loginsDropped' $logins
        } finally { $conn.Dispose() }
    }

    Invoke-SpikeStep 'remove local users named arashouse_spike_*' {
        $removed = @()
        foreach ($u in @(Get-LocalUser -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'arashouse_spike_*' })) {
            Assert-SpikeName -Kind Login -Name $u.Name
            Remove-LocalUser -Name $u.Name
            $removed += $u.Name
        }
        Add-SpikeFact 'localUsersRemoved' $removed
    }

    Invoke-SpikeStep "remove the spike's folders under $($script:SpikeRoot): golden-build, slot-*, measure-*, vaults, sqldata, golden-test, logs, empty-* (not out\ and not the scripts)" {
        $removed = @()
        $candidates = @()
        foreach ($f in $spikeFolders) { $candidates += (Join-Path $script:SpikeRoot $f) }
        foreach ($pattern in @('slot-*', 'measure-*', 'empty-*')) {
            $candidates += @(Get-ChildItem -LiteralPath $script:SpikeRoot -Directory -Filter $pattern -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
        }
        foreach ($c in $candidates) {
            if (Test-Path -LiteralPath $c) { Remove-SpikeTree -Path $c; $removed += $c.Substring($script:SpikeRoot.Length).TrimStart('\') }
        }
        Add-SpikeFact 'foldersRemoved' $removed
    }

    Invoke-SpikeStep 'remove ASP.NET temporary-file folders named ah-spike-* under the .NET Framework directories' {
        $removed = 0
        foreach ($fw in @('Framework', 'Framework64')) {
            $base = Join-Path $env:windir "Microsoft.NET\$fw\v4.0.30319\Temporary ASP.NET Files"
            if (-not (Test-Path -LiteralPath $base)) { continue }
            foreach ($d in @(Get-ChildItem -LiteralPath $base -Directory -Filter 'ah-spike-*' -ErrorAction SilentlyContinue)) {
                Assert-SpikeName -Kind Alias -Name $d.Name
                Remove-Item -LiteralPath $d.FullName -Recurse -Force
                $removed++
            }
        }
        Add-SpikeFact 'aspNetTempFoldersRemoved' $removed
    }

    Invoke-SpikeStep 'remove a Defender exclusion for the spike folder if one was left behind' {
        try {
            if (@((Get-MpPreference).ExclusionPath) -contains $script:SpikeRoot) { Remove-MpPreference -ExclusionPath $script:SpikeRoot; Add-SpikeFact 'defenderExclusionRemoved' $true }
            else { Add-SpikeFact 'defenderExclusionRemoved' $false }
        } catch { Add-SpikeFact 'defenderExclusionRemoved' 'not available' }
    }

    Invoke-SpikeStep 'check that nothing with a spike prefix is left (counts; all must be 0)' {
        $mgr = Get-SpikeIisManager
        try {
            $apps = @($mgr.Sites['Default Web Site'].Applications | Where-Object { $_.Path -like '/ah-spike-*' }).Count
            $pools = @($mgr.ApplicationPools | Where-Object { $_.Name -like 'ah-spike-*' }).Count
        } finally { $mgr.Dispose() }
        $svcs = @(Get-CimInstance Win32_Service -Filter "Name LIKE 'ArasHouseAgent[_]spike[_]%'").Count
        $dirs = @(Get-ChildItem -LiteralPath $script:SpikeRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin @('out', 'lib') }).Count
        Add-SpikeFact 'leftover' ([ordered]@{ iisApps = $apps; iisPools = $pools; services = $svcs; spikeFolders = $dirs })
        if (($apps + $pools + $svcs + $dirs) -gt 0) { Write-Host 'warning: something with a spike prefix is left; see leftover in the results' }
    }

    if ($Apply) { Write-Host 'next: run 00-preflight.ps1 -Apply and confirm denyListUnchangedSinceBaseline is true' }
    else { Write-Host 'would do: nothing more; afterwards run 00-preflight.ps1 -Apply and confirm denyListUnchangedSinceBaseline is true' }
    Complete-Spike
} catch {
    Exit-SpikeFailure $_.Exception.Message
}
