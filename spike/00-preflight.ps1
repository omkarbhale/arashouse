# Read-only inventory of the host before the spike, and (on a second run) a check that the deny-listed installs are unchanged.
# The inventory itself always runs and changes nothing; -Apply additionally writes out\00-preflight.json
# (and out\00-preflight.baseline.json on the first run). No elevation is needed. Windows PowerShell 5.1.
# Never prints or stores a secret. The install roots' config files are hashed (a 16-hex prefix is kept), never read into the output.
param(
    [switch]$Apply,
    # Flavors whose staged MSI (staging\<flavor>\...\InnovatorSetup.msi) should be described: names and non-secret default values only.
    [string[]]$Flavor = @('12sp9', '23', '35')
)
. "$PSScriptRoot/lib/SpikeCommon.ps1"

$sensitiveKeyPattern = 'PASSWORD|PWD|SECRET|LICENSEKEY|LICENSE_KEY|ACT_KEY|TOKEN|CERT_PASS'

function Get-RegValue($path, $name) {
    try { return (Get-ItemProperty -LiteralPath $path -Name $name -ErrorAction Stop).$name } catch { return $null }
}

function Get-MsiInfo([string]$msi) {
    # ProductVersion, property names, and the default values of properties whose names do not look secret.
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $db = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($msi, 0))
    $props = [ordered]@{}
    $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @('SELECT `Property`,`Value` FROM `Property`'))
    $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
    while ($true) {
        $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
        if (-not $rec) { break }
        $n = $rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, @(1))
        $v = $rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, @(2))
        $props[$n] = if ($n -match $sensitiveKeyPattern) { '<not recorded>' } else { $v }
    }
    $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
    $dirs = @()
    $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @('SELECT `Directory`,`DefaultDir` FROM `Directory`'))
    $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
    while ($true) {
        $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
        if (-not $rec) { break }
        $dirs += $rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, @(1))
    }
    $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
    return [ordered]@{
        productVersion = $props['ProductVersion']
        propertyCount = $props.Count
        properties = $props
        directoryKeys = $dirs
        directoryLikeProperties = @($props.Keys | Where-Object { $_ -match 'DIR|FOLDER|PATH|LOCATION' })
    }
}

try {
    Start-Spike -Name '00-preflight' -Apply $Apply.IsPresent
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'HOST: the preflight reads the Windows registry and must run in Windows PowerShell.' }
    Write-Host 'note: the inventory below is read-only and runs in a dry run too'

    $os = Get-CimInstance Win32_OperatingSystem
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
    Add-SpikeFact 'powershell' $PSVersionTable.PSVersion.ToString()
    Add-SpikeFact 'elevated' (Test-SpikeElevated)
    Add-SpikeFact 'os' ([ordered]@{ caption = $os.Caption; build = $os.BuildNumber })
    Add-SpikeFact 'memoryMb' ([ordered]@{ total = [int]($os.TotalVisibleMemorySize / 1024); free = [int]($os.FreePhysicalMemory / 1024) })
    Add-SpikeFact 'diskC' ([ordered]@{ totalGb = [math]::Round($disk.Size / 1GB, 1); freeGb = [math]::Round($disk.FreeSpace / 1GB, 1) })

    # IIS: version and components from the registry (readable without elevation).
    $inet = 'HKLM:\SOFTWARE\Microsoft\InetStp'
    $components = [ordered]@{}
    if (Test-Path "$inet\Components") {
        $c = Get-ItemProperty "$inet\Components"
        foreach ($p in $c.PSObject.Properties) { if ($p.Name -notlike 'PS*') { $components[$p.Name] = $p.Value } }
    }
    Add-SpikeFact 'iis' ([ordered]@{ installed = (Test-Path $inet); major = (Get-RegValue $inet 'MajorVersion'); components = $components })

    # .NET Framework and ASP.NET Core hosting.
    $release = Get-RegValue 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' 'Release'
    $hosting = @()
    foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        foreach ($e in (Get-ItemProperty $key -ErrorAction SilentlyContinue)) {
            $dn = $e.PSObject.Properties['DisplayName']
            if ($dn -and $dn.Value -match 'Hosting Bundle|Windows Server Hosting|ASP\.NET Core.*Module') {
                $hosting += [ordered]@{ name = $dn.Value; version = (Get-SpikeProperty $e 'DisplayVersion') }
            }
        }
    }
    $aspnetShared = 'C:\Program Files\dotnet\shared\Microsoft.AspNetCore.App'
    $moduleDll = 'C:\Program Files\IIS\Asp.Net Core Module\V2\aspnetcorev2.dll'
    Add-SpikeFact 'dotnet' ([ordered]@{
        frameworkRelease = $release
        hostingBundles = $hosting
        aspNetCoreRuntimes = if (Test-Path $aspnetShared) { @(Get-ChildItem $aspnetShared -Directory | ForEach-Object { $_.Name }) } else { @() }
        aspNetCoreModule = if (Test-Path $moduleDll) { (Get-Item $moduleDll).VersionInfo.FileVersion } else { $null }
    })

    # SQL Server: edition, version, login mode and TCP flag from the registry. No connection is made.
    $sqlRoot = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server'
    $instance = Get-RegValue "$sqlRoot\Instance Names\SQL" 'MSSQLSERVER'
    $sql = [ordered]@{ instanceKey = $instance }
    if ($instance) {
        $sql.edition = Get-RegValue "$sqlRoot\$instance\Setup" 'Edition'
        $sql.version = Get-RegValue "$sqlRoot\$instance\Setup" 'Version'
        $mode = Get-RegValue "$sqlRoot\$instance\MSSQLServer" 'LoginMode'
        $sql.loginMode = if ($mode -eq 2) { 'mixed' } elseif ($mode -eq 1) { 'windows-only' } else { $mode }
        $sql.tcpEnabled = Get-RegValue "$sqlRoot\$instance\MSSQLServer\SuperSocketNetLib\Tcp" 'Enabled'
        $svc = Get-CimInstance Win32_Service -Filter "Name='MSSQLSERVER'"
        $sql.serviceAccount = $svc.StartName
        $sql.serviceState = $svc.State
    }
    Add-SpikeFact 'sql' $sql

    # Ports: 80, and the first free ports from 8800 up.
    $listening = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port }
    $free = @()
    for ($p = 8800; $p -lt 8900 -and $free.Count -lt 10; $p++) { if ($listening -notcontains $p) { $free += $p } }
    Add-SpikeFact 'ports' ([ordered]@{ port80Listening = ($listening -contains 80); firstFreeFrom8800 = $free })

    # The deny-list: count the Aras install roots (a number, no names) and hash each InnovatorServerConfig.xml.
    $roots = @(Get-ChildItem 'C:\Program Files (x86)' -Directory -Filter 'Aras*' -ErrorAction SilentlyContinue)
    $hashes = [ordered]@{}
    foreach ($r in $roots) {
        $config = Get-ChildItem -LiteralPath $r.FullName -Recurse -Filter 'InnovatorServerConfig.xml' -File -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1
        $label = 'root' + ($hashes.Count + 1)
        $hashes[$label] = if ($config) { (Get-FileHash -LiteralPath $config.FullName -Algorithm SHA256).Hash.Substring(0, 16) } else { $null }
    }
    $deny = [ordered]@{ installRootCount = $roots.Count; configHashPrefixes = $hashes }
    Add-SpikeFact 'denyList' $deny

    # Staged installers, if any.
    $msis = [ordered]@{}
    foreach ($f in $Flavor) {
        if ($f -notmatch '^(12sp9|23|35)$') { throw "PARAM: unknown flavor '$f'." }
        $dir = Join-Path $script:SpikeStagingDir $f
        $msi = if (Test-Path -LiteralPath $dir) { Get-ChildItem -LiteralPath $dir -Recurse -Filter 'InnovatorSetup.msi' -File -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $null }
        $msis[$f] = if ($msi) { Get-MsiInfo $msi.FullName } else { [ordered]@{ staged = $false } }
    }
    Add-SpikeFact 'stagedInstallers' $msis

    Add-SpikeFact 'spikeFolders' ([ordered]@{
        spike = (Test-Path -LiteralPath $script:SpikeRoot)
        out = (Test-Path -LiteralPath $script:SpikeOutDir)
        staging = (Test-Path -LiteralPath $script:SpikeStagingDir)
    })

    # Compare with the baseline from the first run.
    $baselinePath = Join-Path $script:SpikeOutDir '00-preflight.baseline.json'
    if (Test-Path -LiteralPath $baselinePath) {
        $base = Get-Content -LiteralPath $baselinePath -Raw | ConvertFrom-Json
        $same = ($base.denyList.installRootCount -eq $deny.installRootCount) -and
            (($base.denyList.configHashPrefixes | ConvertTo-Json -Compress) -eq ($deny.configHashPrefixes | ConvertTo-Json -Compress))
        Add-SpikeFact 'denyListUnchangedSinceBaseline' $same
        Write-Host "note: deny-list unchanged since baseline: $same"
    } else {
        Write-Host 'note: no baseline yet; the first -Apply run writes it'
    }

    Write-Host ($script:SpikeFacts | ConvertTo-Json -Depth 8)
    if ($Apply) {
        Complete-Spike
        $baseline = Join-Path $script:SpikeOutDir '00-preflight.baseline.json'
        if (-not (Test-Path -LiteralPath $baseline)) {
            Copy-Item -LiteralPath (Join-Path $script:SpikeOutDir '00-preflight.json') -Destination $baseline
            Write-Host "wrote $baseline"
        }
    } else {
        Write-Host "would do: write the results to $(Join-Path $script:SpikeOutDir '00-preflight.json') (and the baseline copy on the first run)"
    }
} catch {
    Exit-SpikeFailure $_.Exception.Message
}
