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
    # Re-record the facts of an existing baseline (its results were lost) without installing anything: no snapshot, no install, no prompts but the login.
    [switch]$RecordOnly,
    # Overrides, mainly for the guard tests. Defaults are derived from -Flavor and -Suffix.
    [string]$Alias,
    [string]$DatabaseName,
    [string]$InstallDir
)
. "$PSScriptRoot/lib/SpikeCommon.ps1"

$sensitiveKeyPattern = 'PASSWORD|PWD|SECRET|LICENSEKEY|LICENSE_KEY|ACT_KEY|TOKEN'

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

function Test-MsiDirectoryKey([string]$msi, [string]$key) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $db = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @([string]$msi, [int]0))
    $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @("SELECT ``Directory`` FROM ``Directory`` WHERE ``Directory`` = '$key'"))
    $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
    $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
    $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
    return [bool]$rec
}

function Get-MsiTargetPaths([string]$msi, [hashtable]$props, [string]$installDirKey) {
    # Opens the package WITHOUT installing and runs only the costing actions, so every Directory row has its resolved target path.
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $installer.GetType().InvokeMember('UILevel', 'SetProperty', $null, $installer, [object[]]@([int]2)) | Out-Null
    $session = $installer.GetType().InvokeMember('OpenPackage', 'InvokeMethod', $null, $installer, @([string]$msi, [int]0))
    foreach ($k in $props.Keys) { $session.GetType().InvokeMember('Property', 'SetProperty', $null, $session, [object[]]@([string]$k, [string]$props[$k])) | Out-Null }
    foreach ($a in @('CostInitialize', 'FileCost', 'CostFinalize')) { $session.GetType().InvokeMember('DoAction', 'InvokeMethod', $null, $session, @([string]$a)) | Out-Null }
    $db = $session.GetType().InvokeMember('Database', 'GetProperty', $null, $session, $null)
    # Only the folders that components and CreateFolder rows write to; the Directory table also lists unused defaults such as ARAS and INNOVATOR.
    $paths = @{}
    foreach ($sql in @('SELECT `Directory_` FROM `Component`', 'SELECT `Directory_` FROM `CreateFolder`')) {
        $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @($sql))
        $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
        while ($true) {
            $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
            if (-not $rec) { break }
            $key = [string]$rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, [object[]]@([int]1))
            if (-not $paths.ContainsKey($key)) { try { $paths[$key] = [string]$session.GetType().InvokeMember('TargetPath', 'GetProperty', $null, $session, [object[]]@($key)) } catch { } }
        }
        $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
    }
    $paths[$installDirKey] = [string]$session.GetType().InvokeMember('TargetPath', 'GetProperty', $null, $session, [object[]]@([string]$installDirKey))
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($session)
    return $paths
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
    $loginDbo = "$($names.Login)_dbo"
    $loginReg = "$($names.Login)_reg"
    Assert-SpikeName -Kind Login -Name $loginDbo
    Assert-SpikeName -Kind Login -Name $loginReg
    $InstallDir = Assert-SpikePath -Path $InstallDir -Mode Write
    # The vault file store: VAULT_ROOT is a Directory-table key that defaults to C:\, i.e. C:\Aras\Vault, which the captain's Aras12 uses.
    $vaultRoot = Assert-SpikePath -Path (Join-Path $script:SpikeRoot ("vaults\$Flavor-$Suffix")) -Mode Write
    $stageDir = Assert-SpikePath -Path (Join-Path $script:SpikeStagingDir $Flavor) -Mode Read -AllowRoot
    $logDir = Assert-SpikePath -Path (Join-Path $script:SpikeRoot "logs") -Mode Write
    $logFile = Join-Path $logDir "10-msi-$Flavor-$Suffix.log"
    if ($MsiPath) { $MsiPath = Assert-SpikePath -Path $MsiPath -Mode Read }
    foreach ($k in $MsiProperty.Keys) { if ($k -match $sensitiveKeyPattern) { throw "PARAM: secret properties are never passed with -MsiProperty ($k); they come from prompts." } }

    Start-Spike -Name "10-baseline-install-$Flavor-$Suffix" -Apply $Apply.IsPresent -NeedsElevation
    Add-SpikeFact 'flavor' $Flavor
    Add-SpikeFact 'alias' $Alias
    Add-SpikeFact 'database' $DatabaseName
    Add-SpikeFact 'installDir' $InstallDir
    Add-SpikeFact 'databaseMode' $DatabaseMode
    Add-SpikeFact 'engine' $Engine
    Add-SpikeFact 'recordOnly' $RecordOnly.IsPresent

    $sqlPassword = $null
    $licence = $null
    $before = $null
    $state = @{ msi = $MsiPath; props = $null; productCode = $null }

    Invoke-SpikeStep "find InnovatorSetup.msi under $stageDir (the copy with new product codes from 09-new-product-code.ps1 first; extract the CD image zip there if nothing is unpacked: tar.exe -xf)" {
        $instanceMsi = Join-Path $stageDir 'instance\InnovatorSetup.msi'
        if (-not $state.msi -and (Test-Path -LiteralPath $instanceMsi)) { $state.msi = $instanceMsi }
        if (-not $state.msi) {
            $zip = Get-ChildItem -LiteralPath $stageDir -Filter '*.zip' -File -ErrorAction SilentlyContinue | Select-Object -First 1
            $found = Get-ChildItem -LiteralPath $stageDir -Recurse -Filter 'InnovatorSetup.msi' -File -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $found -and $zip) {
                $cd = Assert-SpikePath -Path (Join-Path $stageDir 'cd') -Mode Stage
                if (-not (Test-Path -LiteralPath $cd)) { New-Item -ItemType Directory -Path $cd | Out-Null }
                Write-Host "do: extract $($zip.Name) into $cd"
                # Only the members the install needs. The 12 SP9 image on the source drive is cut short in its last entries, so tar.exe can
                # exit 1 after the early entries (the MSI and the backups) are out intact: judge the result by the MSI opening, not by the exit code.
                & tar.exe -xf $zip.FullName -C $cd 'InnovatorSetup.msi' 'Core*.bak' 'CoreAndSolutions*.bak' 'Utilities/*.exe' 'Utilities/*.sql'
                $tarExit = $LASTEXITCODE
                Add-SpikeFact 'tarExitCode' $tarExit
                $found = Get-ChildItem -LiteralPath $cd -Recurse -Filter 'InnovatorSetup.msi' -File | Select-Object -First 1
                if ($tarExit -ne 0 -and -not $found) { throw "EXTRACT: tar.exe failed ($tarExit) and left no InnovatorSetup.msi; run scripts/spike-sync.sh --media $Flavor from WSL." }
                if ($tarExit -ne 0) { Write-Host "note: tar.exe exited $tarExit (a truncated archive?); continuing because InnovatorSetup.msi was extracted; it must still open as an MSI" }
            }
            if (-not $found) { throw "MEDIA: no InnovatorSetup.msi under $stageDir (run scripts/spike-sync.sh --media $Flavor from WSL)." }
            $state.msi = $found.FullName
        }
        $state.props = Open-MsiProperties $state.msi
        Add-SpikeFact 'msiProductVersion' $state.props['ProductVersion']
        # An MSI whose ProductCode is installed on this host would reconfigure that install instead of making a new one (ticket 05, 2026-10-26).
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $registered = @($installer.GetType().InvokeMember('Products', 'GetProperty', $null, $installer, $null) | ForEach-Object { [string]$_ })
        Add-SpikeFact 'msiProductCodeInstalledOnHost' ($registered -contains $state.props['ProductCode'])
        if (-not $RecordOnly -and $registered -contains $state.props['ProductCode']) { throw "PRECONDITION: $($state.msi) has the ProductCode of a product installed on this host (an existing Aras install); msiexec would reconfigure that install. Run 09-new-product-code.ps1 -Apply and install the copy." }
        Add-SpikeFact 'msiPropertyCount' $state.props.Count
        Add-SpikeFact 'installDirPropertyExists' ($state.props.Contains($InstallDirProperty))
        # INSTALLDIR is a row of the Directory table, not the Property table. It is set on the command line anyway; without it the MSI installs to its
        # default folder, which on this laptop is the captain's own Aras root (ticket 05, 2026-10-26: an install went there). Never run without it.
        $dirKey = Test-MsiDirectoryKey $state.msi $InstallDirProperty
        Add-SpikeFact 'installDirIsDirectoryKey' $dirKey
        if (-not $state.props.Contains($InstallDirProperty) -and -not $dirKey) { throw "PRECONDITION: the MSI has no $InstallDirProperty (neither a property nor a Directory row); an install would go to its default folder." }
    }

    if (-not $RecordOnly) {
        Invoke-SpikeStep "cost the MSI without installing it and refuse if any folder it would write resolves inside an existing Aras root (the first retry wrote into the captain's Aras 14.0.9 root)" {
            $costProps = [ordered]@{}
            $costProps[$InstallDirProperty] = $InstallDir
            $costProps['VAULT_ROOT'] = $vaultRoot
            $targets = Get-MsiTargetPaths $state.msi $costProps $InstallDirProperty
            $vaultTargets = Get-MsiTargetPaths $state.msi $costProps 'VAULT_ROOT'
            $vaultTarget = $vaultTargets['VAULT_ROOT']
            Add-SpikeFact 'costedVaultRoot' $vaultTarget
            if (-not $vaultTarget -or -not (Test-SpikeUnder ($vaultTarget.TrimEnd('\')) $vaultRoot)) { throw "PRECONDITION: costing resolved VAULT_ROOT to '$vaultTarget', not $vaultRoot; nothing was installed." }
            $mine = $targets[$InstallDirProperty]
            Add-SpikeFact 'costedInstallDir' $mine
            if (-not $mine -or -not (Test-SpikeUnder ($mine.TrimEnd('\')) $InstallDir)) { throw "PRECONDITION: costing resolved $InstallDirProperty to '$mine', not $InstallDir; nothing was installed." }
            $bad = @($targets.GetEnumerator() | Where-Object { $_.Value -and (($_.Value.TrimEnd('\') + '\') -ilike 'C:\Program Files*\Aras*') })
            Add-SpikeFact 'costedDirectoriesInsideArasRoots' $bad.Count
            if ($bad.Count -gt 0) { throw "PRECONDITION: $($bad.Count) folders of this MSI resolve inside an existing Aras root (for example $($bad[0].Key)); nothing was installed." }
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
                # Never let the installer restart the host or close the captain's programs on its own (2026-10-26: the laptop restarted during an
                # install; the MSI sets RestartManagerOption=CloseRestart). Standard Windows Installer properties, so not rows of the Property table.
                REBOOT = 'ReallySuppress'
                MSIRESTARTMANAGERCONTROL = 'Disable'
                IS_SQLSERVER_SERVER = '(local)'
                IS_SQLSERVER_DATABASE = $DatabaseName
            }
            $want[$InstallDirProperty] = $InstallDir
            $want['VAULT_ROOT'] = $vaultRoot
            $builtIn = @($InstallDirProperty, 'VAULT_ROOT', 'REBOOT', 'MSIRESTARTMANAGERCONTROL')
            if ($SqlAuth -eq 'Sa') { $want['IS_SQLSERVER_USERNAME'] = 'sa' } else { $want['IS_SQLSERVER_AUTHENTICATION'] = '0' }  # the MSI's own code: 0 is Windows authentication, 1 a SQL login
            # The MSI creates the database owner and regular logins itself; their names default to the shared 'innovator' and
            # 'innovator_regular' that the captain's installs use, so throw-away names are always set (the secret passwords below).
            $want['SQL_SERVER_LOGIN_NAME'] = $loginDbo
            $want['SQL_SERVER_LOGIN_REGULAR_NAME'] = $loginReg
            foreach ($k in $want.Keys) { if ($state.props.Contains($k) -or $k -in $builtIn) { $p[$k] = $want[$k] } }
            foreach ($k in $MsiProperty.Keys) {
                if (-not $state.props.Contains($k)) { throw "PARAM: the MSI has no property '$k'." }
                $p[$k] = [string]$MsiProperty[$k]
            }
            # Plus the secrets the custom actions set or read that are not rows of the Property table: the SQL passwords, and the OAuth signing
            # certificates' password, which a silent install generates when it is empty (SetGeneratedOAuthCertificatesPassword, 12.0 and 14.0).
            $hidden = @(@($state.props.Keys | Where-Object { $_ -match $sensitiveKeyPattern }) + @('IS_SQLSERVER_PASSWORD', 'SQL_SERVER_LOGIN_PASSWORD', 'SQL_SERVER_LOGIN_REGULAR_PASSWORD', 'OAUTH_CERTIFICATES_PASSWORD') | Select-Object -Unique)
            if ($hidden.Count -gt 0) { $p['MsiHiddenProperties'] = ($hidden -join ';') }
            Add-SpikeFact 'propertiesSet' @($p.Keys)
            Add-SpikeFact 'propertiesMissingFromMsi' @($want.Keys | Where-Object { -not $state.props.Contains($_) -and $_ -notin $builtIn })
            Add-SpikeFact 'hiddenProperties' $hidden

            # Secret properties: the first MSI property whose name matches is used, and the choice is recorded by name only.
            $secretProps = @()
            if ($script:sqlPassword) {
                # IS_SQLSERVER_PASSWORD is read by the MSI's custom actions but is not a row of its Property table (names read from the
                # VBScript custom actions in 00-preflight.json); the owner and regular login passwords are rows' siblings of the login names.
                $secretProps += , @('IS_SQLSERVER_PASSWORD', $script:sqlPassword)
            }
            if ($DatabaseMode -eq 'Msi') {
                $secretProps += , @('SQL_SERVER_LOGIN_PASSWORD', (New-SpikePassword))
                $secretProps += , @('SQL_SERVER_LOGIN_REGULAR_PASSWORD', (New-SpikePassword))
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
                $argList = @('/i', ('"' + $state.msi + '"'), '/qn', '/norestart', '/l*', ('"' + $logFile + '"'))
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
            # 3010 / 1641: the install wanted a restart; it was suppressed and is left to the captain.
            Add-SpikeFact 'rebootRequested' ($result -in @(3010, 1641))

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
    }

    if (-not $RecordOnly) {
        Invoke-SpikeStep "give each application of /$Alias its own pool $Alias-<role> (the MSI uses machine-wide pools that the captain's installs share)" {
            Add-SpikeFact 'appsMovedOffSharedPools' @(Move-SpikeAppsToOwnPools -Alias $Alias)
        }
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
        # Without a snapshot (-RecordOnly), services and uninstall entries count as new when they point into the spike folder.
        $newServices = @($after | Where-Object { if ($before) { $before.services -notcontains $_.Name } else { $_.PathName -and ($_.PathName.Trim('"') -like "$($script:SpikeRoot)\*") } })
        Add-SpikeFact 'newServices' @($newServices | ForEach-Object { [ordered]@{ name = $_.Name; startMode = $_.StartMode; imageUnderSpike = [bool]($_.PathName -and ($_.PathName.Trim('"') -like "$($script:SpikeRoot)\*")) } })
        if ($newServices.Count -gt 0) { Write-Host 'warning: the MSI created services; see newServices in the results' }
        $new = @()
        foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
            foreach ($k in (Get-ChildItem $root -ErrorAction SilentlyContinue | Where-Object { -not $before -or $before.uninstall -notcontains $_.PSChildName })) {
                $e = Get-ItemProperty -LiteralPath $k.PSPath
                $loc = if ($e) { $e.PSObject.Properties['InstallLocation'] } else { $null }
                if (-not $before -and -not ($loc -and $loc.Value -and (Test-SpikeUnder ($loc.Value.TrimEnd('\')) $script:SpikeRoot))) { continue }
                $new += [ordered]@{ key = $k.PSChildName; displayName = (Get-SpikeProperty $e 'DisplayName'); displayVersion = (Get-SpikeProperty $e 'DisplayVersion'); installLocationUnderSpike = [bool]($loc -and $loc.Value -and (Test-SpikeUnder ($loc.Value.TrimEnd('\')) $script:SpikeRoot)) }
            }
        }
        Add-SpikeFact 'newUninstallEntries' $new
        $rootsAfter = @(Get-ChildItem 'C:\Program Files (x86)' -Directory -Filter 'Aras*' -ErrorAction SilentlyContinue).Count
        $rootsBefore = if ($before) { $before.rootCount } else { $null }
        Add-SpikeFact 'programFilesAras' ([ordered]@{ rootCountBefore = $rootsBefore; rootCountAfter = $rootsAfter; unchanged = ($rootsBefore -eq $rootsAfter) })
        $vaultConfig = Find-SpikeFile -Root $InstallDir -Name 'vault.config'
        if ($vaultConfig) {
            $local = ([xml](Get-Content -LiteralPath $vaultConfig -Raw)).configuration.appSettings.add | Where-Object { $_.key -eq 'LocalPath' } | Select-Object -First 1
            Add-SpikeFact 'vaultLocalPath' $(if ($local) { $local.value } else { $null })
            Add-SpikeFact 'vaultLocalPathUnderSpike' ([bool]($local -and (Test-SpikeUnder ($local.value.TrimEnd('\')) $script:SpikeRoot)))
        }
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
