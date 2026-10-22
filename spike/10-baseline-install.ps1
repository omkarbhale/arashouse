# Unattended install of a flavor's InnovatorSetup.msi into C:\aras_installations\spike\golden-build\<flavor> with a throw-away
# alias, database and (optionally) nothing else. Records what the MSI created. Dry run by default; -Apply makes changes (elevated).
# Windows PowerShell 5.1.
#
# Secrets (the sa password, the licence key) are typed at hidden prompts and passed to the installer in-process through the
# Windows Installer COM API, so they are never on a process command line. The log is written without verbose property dumps,
# the secret-looking property names are listed in MsiHiddenProperties, and the log is scanned and deleted if a secret is found.
param(
    [switch]$Apply,
    [ValidateSet('12sp9', '23', '35')][string]$Flavor = '12sp9',
    # a, b, ... The first baseline is 'a'; a second install for the INSTALL_DATABASE=0 check is 'c'.
    [ValidatePattern('^[a-z0-9]{1,8}$')][string]$Suffix = 'a',
    # Msi: INSTALL_DATABASE=1 (the MSI creates the database; needs sa). None: INSTALL_DATABASE=0 (no SQL rights needed, restore the .bak later).
    [ValidateSet('Msi', 'None')][string]$DatabaseMode = 'Msi',
    # Com: in-process Windows Installer API (default). Msiexec: msiexec.exe, refused whenever a secret would be on its command line.
    [ValidateSet('Com', 'Msiexec')][string]$Engine = 'Com',
    # sa: prompt for the sa password. Windows: the elevated user's own SQL login (the captain's fallback).
    [ValidateSet('Sa', 'Windows')][string]$SqlAuth = 'Sa',
    # Prompt for the licence key and pass it as LICENSEKEY (only if the MSI refuses to run without one).
    [switch]$WithLicence,
    [string]$MsiPath,
    # Non-secret property overrides, e.g. -MsiProperty @{ IS_SQLSERVER_AUTHENTICATION = 'SQL' }. Names must exist in the MSI.
    [hashtable]$MsiProperty = @{},
    # The MSI property that carries the install directory (the Property table has none; INSTALLDIR is the Directory-table standard).
    [string]$InstallDirProperty = 'INSTALLDIR',
    # Overrides, mainly for the guard tests. Defaults are derived from -Flavor and -Suffix.
    [string]$Alias,
    [string]$DatabaseName,
    [string]$InstallDir
)
. "$PSScriptRoot/lib/SpikeCommon.ps1"

$secretPattern = 'PASSWORD|PWD|SECRET|LICENSEKEY|LICENSE_KEY|ACT_KEY|TOKEN'

function Open-MsiProperties([string]$msi) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $db = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($msi, 0))
    $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @('SELECT `Property`,`Value` FROM `Property`'))
    $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
    $props = [ordered]@{}
    while ($true) {
        $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
        if (-not $rec) { break }
        $props[$rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, @(1))] = $rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, @(2))
    }
    $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
    return $props
}

try {
    $names = Get-SpikeNames -Flavor $Flavor -Suffix $Suffix
    if (-not $Alias) { $Alias = $names.Alias }
    if (-not $DatabaseName) { $DatabaseName = $names.Database }
    if (-not $InstallDir) {
        $dirName = if ($Suffix -eq 'a') { $Flavor } else { "$Flavor-$Suffix" }
        $InstallDir = Join-Path $script:SpikeRoot "golden-build\$dirName"
    }
    # Every target is checked before anything is printed or done, in a dry run too.
    Assert-SpikeName -Kind Alias -Name $Alias
    Assert-SpikeName -Kind Database -Name $DatabaseName
    $InstallDir = Assert-SpikePath -Path $InstallDir -Mode Write
    $stageDir = Assert-SpikePath -Path (Join-Path $script:SpikeStagingDir $Flavor) -Mode Read -AllowRoot
    $logDir = Assert-SpikePath -Path (Join-Path $script:SpikeRoot "logs") -Mode Write
    $logFile = Join-Path $logDir "10-msi-$Flavor-$Suffix.log"
    if ($MsiPath) { $MsiPath = Assert-SpikePath -Path $MsiPath -Mode Read }
    foreach ($k in $MsiProperty.Keys) { if ($k -match $secretPattern) { throw "PARAM: secret properties are never passed with -MsiProperty ($k); they come from prompts." } }

    Start-Spike -Name "10-baseline-install-$Flavor-$Suffix" -Apply $Apply.IsPresent -NeedsElevation
    Add-SpikeFact 'flavor' $Flavor
    Add-SpikeFact 'alias' $Alias
    Add-SpikeFact 'database' $DatabaseName
    Add-SpikeFact 'installDir' $InstallDir
    Add-SpikeFact 'databaseMode' $DatabaseMode
    Add-SpikeFact 'engine' $Engine

    $sqlPassword = $null
    $licence = $null
    $before = $null
    $state = @{ msi = $MsiPath; props = $null; productCode = $null }

    Invoke-SpikeStep "find InnovatorSetup.msi under $stageDir (extract the CD image zip there first if it is not unpacked: tar.exe -xf)" {
        if (-not $state.msi) {
            $zip = Get-ChildItem -LiteralPath $stageDir -Filter '*.zip' -File -ErrorAction SilentlyContinue | Select-Object -First 1
            $found = Get-ChildItem -LiteralPath $stageDir -Recurse -Filter 'InnovatorSetup.msi' -File -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $found -and $zip) {
                $cd = Assert-SpikePath -Path (Join-Path $stageDir 'cd') -Mode Stage
                if (-not (Test-Path -LiteralPath $cd)) { New-Item -ItemType Directory -Path $cd | Out-Null }
                Write-Host "do: extract $($zip.Name) into $cd"
                & tar.exe -xf $zip.FullName -C $cd
                if ($LASTEXITCODE -ne 0) { throw "EXTRACT: tar.exe failed ($LASTEXITCODE); use Expand-Archive instead." }
                $found = Get-ChildItem -LiteralPath $cd -Recurse -Filter 'InnovatorSetup.msi' -File | Select-Object -First 1
            }
            if (-not $found) { throw "MEDIA: no InnovatorSetup.msi under $stageDir (run scripts/spike-sync.sh --media $Flavor from WSL)." }
            $state.msi = $found.FullName
        }
        $state.props = Open-MsiProperties $state.msi
        Add-SpikeFact 'msiProductVersion' $state.props['ProductVersion']
        Add-SpikeFact 'msiPropertyCount' $state.props.Count
        Add-SpikeFact 'installDirPropertyExists' ($state.props.Contains($InstallDirProperty))
    }

    Invoke-SpikeStep "check that folder $InstallDir does not exist, alias /$Alias is not in IIS and database $DatabaseName does not exist" {
        if (Test-Path -LiteralPath $InstallDir) { throw "PRECONDITION: $InstallDir already exists; run 90-teardown.ps1 first." }
        if (@(Get-SpikeIisLayout -Alias $Alias).Count -gt 0) { throw "PRECONDITION: IIS already has /$Alias." }
    }

    if ($DatabaseMode -eq 'Msi' -and $SqlAuth -eq 'Sa') {
        Invoke-SpikeStep 'prompt (hidden) for the SQL sa password; it stays in a SecureString and goes to the installer in-process' {
            $script:sqlPassword = Read-SpikeSecret -Prompt 'SQL sa password (hidden)'
        }
    }
    if ($WithLicence) {
        Invoke-SpikeStep 'prompt (hidden) for the licence key; it goes to the installer as LICENSEKEY in-process' {
            $script:licence = Read-SpikeSecret -Prompt 'Licence key (hidden)'
        }
    }

    Invoke-SpikeStep "snapshot services, uninstall entries and the count of Aras install roots (counts and keys only)" {
        $script:before = [pscustomobject]@{
            services = @(Get-CimInstance Win32_Service | ForEach-Object { $_.Name })
            uninstall = @(Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName })
            rootCount = @(Get-ChildItem 'C:\Program Files (x86)' -Directory -Filter 'Aras*' -ErrorAction SilentlyContinue).Count
        }
    }

    Invoke-SpikeStep "install the MSI unattended: $InstallDirProperty=$InstallDir, WEBALIAS=$Alias, database $DatabaseName, INSTALL_DATABASE=$(if ($DatabaseMode -eq 'Msi') { 1 } else { 0 }), INSTALL_AGENT_SERVICE=0, CHANGEGUID=1 (only properties that exist in the MSI are set)" {
        $p = [ordered]@{}
        $want = [ordered]@{
            WEBALIAS = $Alias
            INSTALL_DATABASE = $(if ($DatabaseMode -eq 'Msi') { '1' } else { '0' })
            INSTALL_AGENT_SERVICE = '0'
            CHANGEGUID = '1'
            IS_SQLSERVER_SERVER = '(local)'
            IS_SQLSERVER_DATABASE = $DatabaseName
        }
        $want[$InstallDirProperty] = $InstallDir
        if ($SqlAuth -eq 'Sa') { $want['IS_SQLSERVER_USERNAME'] = 'sa' }
        foreach ($k in $want.Keys) { if ($state.props.Contains($k)) { $p[$k] = $want[$k] } }
        foreach ($k in $MsiProperty.Keys) {
            if (-not $state.props.Contains($k)) { throw "PARAM: the MSI has no property '$k'." }
            $p[$k] = [string]$MsiProperty[$k]
        }
        $hidden = @($state.props.Keys | Where-Object { $_ -match $secretPattern })
        if ($hidden.Count -gt 0) { $p['MsiHiddenProperties'] = ($hidden -join ';') }
        Add-SpikeFact 'propertiesSet' @($p.Keys)
        Add-SpikeFact 'propertiesMissingFromMsi' @($want.Keys | Where-Object { -not $state.props.Contains($_) })
        Add-SpikeFact 'hiddenProperties' $hidden

        # Secret properties: the first MSI property whose name matches is used, and the choice is recorded by name only.
        $secretProps = @()
        if ($script:sqlPassword) {
            $n = @($state.props.Keys | Where-Object { $_ -match 'SQL.*PASSWORD|PASSWORD.*SQL' } | Select-Object -First 1)
            if ($n.Count -eq 0) { throw 'MSI: no SQL password property found; pass the install with -DatabaseMode None.' }
            $secretProps += , @($n[0], $script:sqlPassword)
        }
        if ($script:licence) {
            if (-not $state.props.Contains('LICENSEKEY')) { throw 'MSI: no LICENSEKEY property.' }
            $secretProps += , @('LICENSEKEY', $script:licence)
        }
        Add-SpikeFact 'secretPropertiesPassed' @($secretProps | ForEach-Object { $_[0] })

        if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
        $seconds = $null
        $result = $null
        if ($Engine -eq 'Msiexec') {
            if ($secretProps.Count -gt 0) { throw 'ENGINE: msiexec would put a secret on its command line; use -Engine Com.' }
            $argList = @('/i', ('"' + $state.msi + '"'), '/qn', '/l*', ('"' + $logFile + '"'))
            foreach ($k in $p.Keys) { $argList += ('{0}="{1}"' -f $k, $p[$k]) }
            $seconds = Measure-SpikeSeconds { $proc = Start-Process -FilePath msiexec.exe -ArgumentList $argList -Wait -PassThru; $script:__msiexit = $proc.ExitCode }
            $result = $script:__msiexit
        } else {
            $installer = New-Object -ComObject WindowsInstaller.Installer
            $installer.UILevel = 2
            $installer.EnableLog('iwearucmop', $logFile)
            $cmd = ($p.Keys | ForEach-Object { '{0}="{1}"' -f $_, $p[$_] }) -join ' '
            foreach ($sp in $secretProps) {
                $plain = ConvertTo-SpikePlainText $sp[1]
                $cmd += (' {0}="{1}"' -f $sp[0], $plain.Replace('"', '""'))
                $plain = $null
            }
            $script:__msiexit = 0
            $seconds = Measure-SpikeSeconds {
                try { $installer.InstallProduct($state.msi, $cmd) } catch [Runtime.InteropServices.COMException] { $script:__msiexit = $_.Exception.ErrorCode -band 0xFFFF }
            }
            $cmd = $null
            $result = $script:__msiexit
        }
        Add-SpikeFact 'installSeconds' $seconds
        Add-SpikeFact 'msiExitCode' $result

        # The log: facts only (failed custom actions), then a secret scan that deletes it on a hit.
        $failed = @()
        if (Test-Path -LiteralPath $logFile) {
            $text = [IO.File]::ReadAllText($logFile)
            $failed = @([regex]::Matches($text, 'Action ended [\d:]+: (\w+)\. Return value 3') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
            $leaks = @(Find-SpikeSecretLeaks -Paths @($logDir))
            if ($leaks.Count -gt 0) { Remove-Item -LiteralPath $logFile -Force; Write-Host 'warning: the MSI log held a secret and was deleted' }
        }
        Add-SpikeFact 'failedCustomActions' $failed
        if ($result -ne 0) { Write-Host "warning: the install returned $result; the facts below are what exists anyway" }
    }

    Invoke-SpikeStep "record what the MSI created: version, tree size, IIS apps and pools of /$Alias, new services, new uninstall entry, Program Files untouched" {
        $core = if (Test-Path -LiteralPath $InstallDir) { Find-SpikeFile -Root $InstallDir -Name 'Aras.Server.Core.dll' } else { $null }
        Add-SpikeFact 'serverCoreVersion' $(if ($core) { (Get-Item -LiteralPath $core).VersionInfo.FileVersion } else { $null })
        Add-SpikeFact 'installedUnderRequestedDir' ([bool]$core)
        if ($core) { Add-SpikeFact 'serverCoreRelativePath' $core.Substring($InstallDir.Length).TrimStart('\') }
        if (Test-Path -LiteralPath $InstallDir) {
            Add-SpikeFact 'tree' (Get-SpikeTreeStats -Path $InstallDir)
            Add-SpikeFact 'topLevelFolders' @(Get-ChildItem -LiteralPath $InstallDir -Directory | ForEach-Object { $_.Name })
            Add-SpikeFact 'dbFolderFiles' @(Get-ChildItem -LiteralPath $InstallDir -Recurse -Filter '*.bak' -File | ForEach-Object { $_.FullName.Substring($InstallDir.Length).TrimStart('\') })
            Add-SpikeFact 'configFiles' @(Get-ChildItem -LiteralPath $InstallDir -Recurse -Depth 1 -File -Filter '*Config.xml' | ForEach-Object { $_.FullName.Substring($InstallDir.Length).TrimStart('\') })
        }
        Add-SpikeFact 'iisLayout' @(Get-SpikeIisLayout -Alias $Alias -InstallDir $InstallDir)
        $after = @(Get-CimInstance Win32_Service)
        $newServices = @($after | Where-Object { $before.services -notcontains $_.Name })
        Add-SpikeFact 'newServices' @($newServices | ForEach-Object { [ordered]@{ name = $_.Name; startMode = $_.StartMode; imageUnderSpike = [bool]($_.PathName -and ($_.PathName.Trim('"') -like "$($script:SpikeRoot)\*")) } })
        if ($newServices.Count -gt 0) { Write-Host 'warning: the MSI created services; see newServices in the results' }
        $new = @()
        foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
            foreach ($k in (Get-ChildItem $root -ErrorAction SilentlyContinue | Where-Object { $before.uninstall -notcontains $_.PSChildName })) {
                $e = Get-ItemProperty -LiteralPath $k.PSPath
                $loc = $e.PSObject.Properties['InstallLocation']
                $new += [ordered]@{ key = $k.PSChildName; displayName = (Get-SpikeProperty $e 'DisplayName'); displayVersion = (Get-SpikeProperty $e 'DisplayVersion'); installLocationUnderSpike = [bool]($loc -and $loc.Value -and (Test-SpikeUnder ($loc.Value.TrimEnd('\')) $script:SpikeRoot)) }
            }
        }
        Add-SpikeFact 'newUninstallEntries' $new
        $rootsAfter = @(Get-ChildItem 'C:\Program Files (x86)' -Directory -Filter 'Aras*' -ErrorAction SilentlyContinue).Count
        Add-SpikeFact 'programFilesAras' ([ordered]@{ rootCountBefore = $before.rootCount; rootCountAfter = $rootsAfter; unchanged = ($before.rootCount -eq $rootsAfter) })
        $dbMarker = Join-Path $InstallDir 'DB'
        Add-SpikeFact 'dbFolderExists' (Test-Path -LiteralPath $dbMarker)
    }

    if ($DatabaseMode -eq 'Msi') {
        Invoke-SpikeStep "confirm database $DatabaseName exists and list its users (names only)" {
            $conn = if ($SqlAuth -eq 'Sa') { New-SpikeSqlConnection -Auth Sa -Password $script:sqlPassword } else { New-SpikeSqlConnection -Auth Windows }
            try {
                $row = Invoke-SpikeSql -Connection $conn -Query 'SELECT COUNT(*) AS n FROM sys.databases WHERE name = @n' -Parameters @{ '@n' = $DatabaseName }
                Add-SpikeFact 'databaseExists' ($row[0].n -eq 1)
                if ($row[0].n -eq 1) {
                    $users = Invoke-SpikeSql -Connection $conn -Query ("SELECT name FROM " + (Format-SpikeSqlIdent $DatabaseName) + ".sys.database_principals WHERE type IN ('S','U') AND name NOT IN ('dbo','guest','INFORMATION_SCHEMA','sys')")
                    Add-SpikeFact 'databaseUsers' @($users | ForEach-Object { $_.name })
                }
            } finally { $conn.Dispose() }
        }
    }

    Invoke-SpikeStep "log in as the shipped backup's Aras login and confirm the build matches (prompt hidden; success is a boolean)" {
        $config = Find-SpikeFile -Root $InstallDir -Name 'InnovatorServerConfig.xml'
        if ($config) {
            $id = Get-SpikeDbId -ConfigPath $config
            $pw = Get-SpikeArasPassword
            Add-SpikeFact 'dbId' $id
            Add-SpikeFact 'anonymousClientStatus' (Get-SpikeHttpStatus "http://localhost/$Alias/Client/")
            Add-SpikeFact 'loginOk' (Test-SpikeArasLogin -Alias $Alias -DatabaseId $id -ArasPassword $pw)
        } else { Add-SpikeFact 'loginOk' $false }
    }

    Complete-Spike
} catch {
    Exit-SpikeFailure $_.Exception.Message
}
