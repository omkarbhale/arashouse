# Shared plumbing for the slice 0 spike scripts: name and path guards, dry run, secrets, results, SQL and IIS helpers.
# Dot-source it: . (Join-Path $PSScriptRoot 'lib\SpikeCommon.ps1')
# Windows PowerShell 5.1 compatible. Nothing here prints, logs or stores a secret.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:SpikeInstallRoot = 'C:\aras_installations'
$script:SpikeRoot = 'C:\aras_installations\spike'
$script:SpikeOutDir = 'C:\aras_installations\spike\out'
$script:SpikeStagingDir = 'C:\aras_installations\staging'

# ---- the deny-list: what exists on the captain's laptop today. Nothing here is ever touched. ----
$script:DenyDatabases = @('12sp9', 'OLM_Local', 'InnovatorSolutions', 'RabbitDemo1', 'InnovatorSolutions28')
$script:DenyAliases = @('12sp9', 'InnovatorServer', 'InnovatorServer23')
$script:DenyAliasPatterns = @('InnovatorServer*')
$script:DenyServicePatterns = @('ArasInnovatorAgent_*')
$script:DenyFolderPatterns = @('C:\Program Files (x86)\Aras*', 'C:\Program Files\Aras*', 'C:\Aras', 'C:\Aras\*', 'C:\Aras12*', 'C:\Aras28*')
# Any name containing these is refused whatever its kind.
$script:DenyFragments = @('olm', 'prod')

# ---- the allowlist: the only names a spike script may create, change or delete. ----
$script:AllowDatabase = '^arashouse_spike_[a-z0-9_]{1,40}$'
$script:AllowLogin = '^arashouse_spike_[a-z0-9_]{1,40}$'
$script:AllowAlias = '^ah-spike-[a-z0-9-]{1,40}$'
$script:AllowPool = '^ah-spike-[a-z0-9-]{1,60}$'
$script:AllowService = '^ArasHouseAgent_spike_[A-Za-z0-9_]{1,40}$'

function Test-SpikeDenied {
    # Returns the reason a name is on the deny-list, or $null.
    param([string]$Kind, [string]$Name)
    $lower = $Name.ToLowerInvariant()
    foreach ($fragment in $script:DenyFragments) {
        if ($lower.Contains($fragment)) { return "contains '$fragment'" }
    }
    switch ($Kind) {
        'Database' {
            foreach ($d in $script:DenyDatabases) { if ($Name -ieq $d) { return 'a database that exists on this laptop' } }
        }
        'Login' {
            foreach ($d in $script:DenyDatabases) { if ($Name -ieq $d) { return 'a name that exists on this laptop' } }
        }
        { $_ -in @('Alias', 'Pool') } {
            foreach ($d in $script:DenyAliases) { if ($Name -ieq $d) { return 'a web alias that exists on this laptop' } }
            foreach ($p in $script:DenyAliasPatterns) { if ($Name -ilike $p) { return "matches '$p'" } }
        }
        'Service' {
            foreach ($p in $script:DenyServicePatterns) { if ($Name -ilike $p) { return "matches '$p'" } }
        }
    }
    return $null
}

function Assert-SpikeName {
    # Throws unless the name is not deny-listed and matches the spike allowlist for its kind. Folders: use Assert-SpikePath.
    param(
        [Parameter(Mandatory)][ValidateSet('Database', 'Login', 'Alias', 'Pool', 'Service')][string]$Kind,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Name
    )
    $reason = Test-SpikeDenied -Kind $Kind -Name $Name
    if ($reason) { throw "DENY-LIST: $Kind '$Name' is refused ($reason)." }
    $pattern = switch ($Kind) {
        'Database' { $script:AllowDatabase }
        'Login' { $script:AllowLogin }
        'Alias' { $script:AllowAlias }
        'Pool' { $script:AllowPool }
        'Service' { $script:AllowService }
    }
    if ($Name -cnotmatch $pattern) { throw "ALLOWLIST: $Kind '$Name' does not match the spike prefix ($pattern)." }
}

function ConvertTo-SpikeFullPath {
    # Platform-independent path normalisation: drive-letter absolute only, no '..', backslashes, no trailing slash.
    param([string]$Path)
    $p = $Path.Replace('/', '\').TrimEnd('\')
    if ($p -notmatch '^[A-Za-z]:\\') { throw "PATH: '$Path' is not an absolute drive-letter path." }
    $segments = $p.Split('\')
    foreach ($s in $segments) {
        if ($s -eq '..' -or $s -eq '.') { throw "PATH: '$Path' contains a relative segment." }
    }
    return ($segments -join '\')
}

function Get-SpikeProperty {
    # A property of an object, or $null when it has none (safe under strict mode).
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

function Test-SpikeUnder {
    param([string]$Path, [string]$Root)
    return ($Path -ieq $Root) -or $Path.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-SpikePath {
    # Mode Write: under C:\aras_installations\spike. Mode Stage: also under ...\staging. Mode Read: spike or staging.
    # Returns the normalised path. Refuses the deny-list and any path that crosses a junction or symlink.
    param(
        [Parameter(Mandatory)][string]$Path,
        [ValidateSet('Read', 'Write', 'Stage')][string]$Mode = 'Write',
        [switch]$AllowRoot
    )
    $full = ConvertTo-SpikeFullPath $Path
    foreach ($pattern in $script:DenyFolderPatterns) {
        if ($full -ilike $pattern) { throw "DENY-LIST: folder '$full' is refused (matches '$pattern')." }
    }
    $inSpike = Test-SpikeUnder $full $script:SpikeRoot
    $inStaging = Test-SpikeUnder $full $script:SpikeStagingDir
    $ok = switch ($Mode) {
        'Write' { $inSpike }
        'Stage' { $inSpike -or ($inStaging -and $full -ine $script:SpikeStagingDir) }
        'Read' { $inSpike -or $inStaging }
    }
    if (-not $ok) { throw "ALLOWLIST: folder '$full' is not under $($script:SpikeRoot) (mode $Mode)." }
    if (($full -ieq $script:SpikeRoot -or $full -ieq $script:SpikeStagingDir) -and -not $AllowRoot) {
        throw "ALLOWLIST: '$full' is a spike root itself; name a folder inside it."
    }
    if ([Environment]::OSVersion.Platform -eq 'Win32NT') {
        $walk = $script:SpikeInstallRoot
        $relative = $full.Substring($script:SpikeInstallRoot.Length).TrimStart('\')
        foreach ($segment in $relative.Split('\')) {
            if (-not $segment) { continue }
            $walk = $walk + '\' + $segment
            if (Test-Path -LiteralPath $walk) {
                $attributes = (Get-Item -LiteralPath $walk -Force).Attributes
                if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw "ALLOWLIST: '$walk' is a junction or symlink." }
            }
        }
    }
    return $full
}

# ---- run state, dry run and steps ----
$script:SpikeApply = $false
$script:SpikeName = ''
$script:SpikeFacts = [ordered]@{}
$script:SpikeSecrets = New-Object System.Collections.ArrayList
$script:SpikeStopwatch = $null
$script:SpikeStartedUtc = $null
$script:SpikeLastLoginError = $null

function Test-SpikeElevated {
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') { return $false }
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Start-Spike {
    param([Parameter(Mandatory)][string]$Name, [bool]$Apply, [switch]$NeedsElevation)
    $script:SpikeName = $Name
    $script:SpikeApply = $Apply
    $script:SpikeFacts = [ordered]@{}
    $script:SpikeStopwatch = [Diagnostics.Stopwatch]::StartNew()
    $script:SpikeStartedUtc = [DateTime]::UtcNow.AddSeconds(-2)
    if ($Apply) {
        if ($NeedsElevation -and -not (Test-SpikeElevated)) {
            throw 'ELEVATION: -Apply for this script needs an elevated PowerShell (Run as administrator).'
        }
        Write-Host "apply: $Name (every change is printed before it is made)"
    } else {
        Write-Host "dry run: $Name changes nothing; pass -Apply to make changes"
    }
}

function Exit-SpikeFailure {
    # One line on stderr, exit code 2. (Write-Error under $ErrorActionPreference Stop would end the script with exit 1.)
    param([Parameter(Mandatory)][string]$Message)
    [Console]::Error.WriteLine("error: $Message")
    exit 2
}

function Write-SpikePlan {
    # A line of the plan. Dry run prints "would do:", apply prints "do:".
    param([Parameter(Mandatory)][string]$Text)
    if ($script:SpikeApply) { Write-Host "do: $Text" } else { Write-Host "would do: $Text" }
}

function Invoke-SpikeStep {
    # Prints the step, and runs it only under -Apply.
    param([Parameter(Mandatory)][string]$Description, [Parameter(Mandatory)][scriptblock]$Action)
    Write-SpikePlan $Description
    if ($script:SpikeApply) { & $Action }
}

function Add-SpikeFact {
    # Records one non-secret fact for the results file. Values: booleans, numbers, versions, names, lists, hashtables.
    param([Parameter(Mandatory)][string]$Key, $Value)
    $script:SpikeFacts[$Key] = $Value
}

function Measure-SpikeSeconds {
    param([Parameter(Mandatory)][scriptblock]$Action)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $Action | Out-Null
    $sw.Stop()
    return [math]::Round($sw.Elapsed.TotalSeconds, 2)
}

function Complete-Spike {
    # Writes out\<name>.json, then scans the out folder for every secret this run handled. Fails loudly on a hit.
    $file = Join-Path $script:SpikeOutDir ($script:SpikeName + '.json')
    if (-not $script:SpikeApply) {
        Write-Host "would do: write the non-secret results to $file"
        Write-Host 'would do: scan the out folder for the secrets this script handled and fail if any is found'
        return
    }
    Add-SpikeFact -Key 'finishedUtc' -Value ([DateTime]::UtcNow.ToString('o'))
    Add-SpikeFact -Key 'elapsedSeconds' -Value ([math]::Round($script:SpikeStopwatch.Elapsed.TotalSeconds, 1))
    $outDir = Assert-SpikePath -Path $script:SpikeOutDir -Mode Write
    if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
    $json = $script:SpikeFacts | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText($file, $json, (New-Object Text.UTF8Encoding($false)))
    Write-Host "wrote $file"
    Assert-SpikeNoSecretLeaks -Paths @($script:SpikeOutDir)
}

# ---- secrets: SecureString in, plain text only inside the call that needs it ----
function Register-SpikeSecret {
    # -ContextOnly: a low-entropy secret that is also an ordinary word in Aras data (the shipped backup's well-known login password equals the
    # stock SQL login name), so the scan flags it only right after 'password' or 'pwd', not wherever the word appears.
    param([Parameter(Mandatory)][securestring]$Secure, [switch]$ContextOnly)
    [void]$script:SpikeSecrets.Add([pscustomobject]@{ Secure = $Secure; ContextOnly = $ContextOnly.IsPresent })
}

function ConvertTo-SpikePlainText {
    param([Parameter(Mandatory)][securestring]$Secure)
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Read-SpikeSecret {
    # Hidden prompt. Never echoed. Registered so the end-of-run scan looks for it.
    param([Parameter(Mandatory)][string]$Prompt, [switch]$AllowEmpty, [switch]$ContextOnly)
    # A worker that was authorised to supply the local sa password leaves it as a DPAPI blob (ConvertFrom-SecureString, bound to this
    # Windows user) in spike\handoff\sa.dpapi; it is never on a command line. The blob is one-shot: deleted as soon as it is read.
    $handoff = Join-Path $script:SpikeRoot 'handoff\sa.dpapi'
    if ($Prompt -like 'SQL sa password*' -and (Test-Path -LiteralPath $handoff)) {
        $fromFile = ConvertTo-SecureString -String ([IO.File]::ReadAllText($handoff).Trim())
        Remove-Item -LiteralPath $handoff -Force
        Register-SpikeSecret $fromFile
        Add-SpikeFact 'saHandoffUsed' $true
        return $fromFile
    }
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    if ($secure.Length -eq 0 -and -not $AllowEmpty) { throw "PROMPT: nothing was entered for '$Prompt'." }
    if ($secure.Length -gt 0) { Register-SpikeSecret $secure -ContextOnly:$ContextOnly }
    return $secure
}

function Get-SpikeArasPassword {
    # The password of the shipped backup's Aras login. From a hidden prompt, or from the environment variable
    # ARASHOUSE_SPIKE_ARAS_PASSWORD when the captain exported it in this session (to type it once per sitting).
    $handoff = Join-Path $script:SpikeRoot 'handoff\aras.dpapi'
    if (Test-Path -LiteralPath $handoff) {
        $fromFile = ConvertTo-SecureString -String ([IO.File]::ReadAllText($handoff).Trim())
        Register-SpikeSecret $fromFile -ContextOnly
        return $fromFile
    }
    $fromEnv = [Environment]::GetEnvironmentVariable('ARASHOUSE_SPIKE_ARAS_PASSWORD')
    if ($fromEnv) {
        $secure = New-Object Security.SecureString
        foreach ($c in $fromEnv.ToCharArray()) { $secure.AppendChar($c) }
        $secure.MakeReadOnly()
        Register-SpikeSecret $secure -ContextOnly
        return $secure
    }
    return (Read-SpikeSecret -Prompt 'Aras login password of the shipped backup (hidden; used to log in only)' -ContextOnly)
}

function New-SpikePassword {
    # A random 24-character password as a SecureString (letters and digits, one of each class at least).
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
    try {
        $bytes = New-Object byte[] 24
        $rng.GetBytes($bytes)
        $secure = New-Object Security.SecureString
        for ($i = 0; $i -lt 24; $i++) { $secure.AppendChar($chars[$bytes[$i] % $chars.Length]) }
        $secure.AppendChar('7')
        $secure.AppendChar('x')
        $secure.AppendChar('Q')
    } finally { $rng.Dispose() }
    $secure.MakeReadOnly()
    Register-SpikeSecret $secure
    return $secure
}

function Find-SpikeSecretLeaks {
    # File paths under -Paths whose text contains a registered secret. Only paths are returned, never the secret.
    param([Parameter(Mandatory)][string[]]$Paths)
    # Only files this run wrote are scanned (and so can be deleted): another script's results are not this run's to judge.
    $plain = @()
    foreach ($s in $script:SpikeSecrets) { $plain += [pscustomobject]@{ Text = (ConvertTo-SpikePlainText $s.Secure); ContextOnly = $s.ContextOnly } }
    $leaks = New-Object System.Collections.ArrayList
    if ($plain.Count -eq 0) { return @() }
    foreach ($root in $Paths) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($f in (Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue)) {
            if ($f.Length -gt 64MB) { continue }
            if ($script:SpikeStartedUtc -and $f.LastWriteTimeUtc -lt $script:SpikeStartedUtc) { continue }
            $text = [IO.File]::ReadAllText($f.FullName)
            foreach ($p in $plain) {
                if (-not $p.Text) { continue }
                $word = [regex]::Escape($p.Text) + '(?![A-Za-z0-9_])'
                $hit = if ($p.ContextOnly) { $text -match ('(?i)(pass(word)?|pwd)[^A-Za-z0-9\r\n]{0,4}' + $word) }
                    elseif ($p.Text.Length -lt 6) { $text -cmatch ('(?<![A-Za-z0-9_])' + $word) } else { $text.Contains($p.Text) }
                if ($hit) { [void]$leaks.Add($f.FullName); break }
            }
        }
    }
    return @($leaks)
}

function Assert-SpikeNoSecretLeaks {
    # Deletes any of this script's own result or log files that contain a handled secret, then fails loudly.
    param([Parameter(Mandatory)][string[]]$Paths)
    $leaks = @(Find-SpikeSecretLeaks -Paths $Paths)
    if ($leaks.Count -eq 0) { Write-Host 'secret scan: clean'; return }
    foreach ($leak in $leaks) { Remove-Item -LiteralPath $leak -Force -ErrorAction SilentlyContinue }
    $names = ($leaks -join '; ')
    throw "SECRET LEAK: a secret this script handled was found in: $names. Those files were deleted. The secret is not shown. Treat it as exposed and rotate it."
}

# ---- SQL Server, always from Windows over shared memory; never a deny-listed database ----
function Format-SpikeSqlIdent {
    param([Parameter(Mandatory)][string]$Name)
    return '[' + $Name.Replace(']', ']]') + ']'
}

function Format-SpikeSqlString {
    param([Parameter(Mandatory)][string]$Text)
    return "N'" + $Text.Replace("'", "''") + "'"
}

function Assert-SpikeSqlCatalog {
    # The only catalogs a spike connection may open: master, or an allowlisted spike database.
    param([string]$Catalog)
    if ($Catalog -ieq 'master') { return }
    Assert-SpikeName -Kind Database -Name $Catalog
}

function New-SpikeSqlConnection {
    # Auth 'Sa' uses a SecureString through SqlCredential (no plain text in the connection string); 'Windows' uses the
    # current Windows identity; 'Login' is a spike login.
    param(
        [string]$Catalog = 'master',
        [ValidateSet('Sa', 'Windows', 'Login')][string]$Auth = 'Sa',
        [securestring]$Password,
        [string]$LoginName = 'sa'
    )
    Assert-SpikeSqlCatalog $Catalog
    if ($Auth -eq 'Login') { Assert-SpikeName -Kind Login -Name $LoginName }
    Add-Type -AssemblyName System.Data
    $integrated = if ($Auth -eq 'Windows') { 'True' } else { 'False' }
    $cs = "Data Source=lpc:.;Initial Catalog=$Catalog;Integrated Security=$integrated;Connect Timeout=15;Application Name=arashouse-spike"
    if ($Auth -eq 'Windows') {
        $conn = New-Object System.Data.SqlClient.SqlConnection($cs)
    } else {
        if (-not $Password) { throw 'SQL: a password is required for this authentication.' }
        $ro = $Password.Copy()
        $ro.MakeReadOnly()
        $cred = New-Object System.Data.SqlClient.SqlCredential($LoginName, $ro)
        $conn = New-Object System.Data.SqlClient.SqlConnection($cs, $cred)
    }
    $conn.Open()
    return $conn
}

function Invoke-SpikeSql {
    # Runs one batch; returns rows as PSCustomObjects. -Parameters is a hashtable of @name values.
    param(
        [Parameter(Mandatory)][System.Data.SqlClient.SqlConnection]$Connection,
        [Parameter(Mandatory)][string]$Query,
        [hashtable]$Parameters = @{},
        [int]$TimeoutSeconds = 600
    )
    $cmd = $Connection.CreateCommand()
    $cmd.CommandText = $Query
    $cmd.CommandTimeout = $TimeoutSeconds
    foreach ($k in $Parameters.Keys) { [void]$cmd.Parameters.AddWithValue($k, $Parameters[$k]) }
    $reader = $cmd.ExecuteReader()
    $rows = New-Object System.Collections.ArrayList
    try {
        do {
            while ($reader.Read()) {
                $row = [ordered]@{}
                for ($i = 0; $i -lt $reader.FieldCount; $i++) {
                    $v = $reader.GetValue($i)
                    $row[$reader.GetName($i)] = if ($v -is [DBNull]) { $null } else { $v }
                }
                [void]$rows.Add([pscustomobject]$row)
            }
        } while ($reader.NextResult())
    } finally { $reader.Dispose(); $cmd.Dispose() }
    return @($rows)
}

function Get-SpikeSqlServiceAccount {
    $svc = Get-CimInstance -ClassName Win32_Service -Filter "Name='MSSQLSERVER'"
    if (-not $svc) { return $null }
    return $svc.StartName
}

function Get-SpikeBackupFileMap {
    # RESTORE ... WITH MOVE clauses that put the data and log files of a spike database under spike\sqldata\<db>\.
    param(
        [Parameter(Mandatory)][System.Data.SqlClient.SqlConnection]$Connection,
        [Parameter(Mandatory)][string]$BackupPath,
        [Parameter(Mandatory)][string]$Database
    )
    Assert-SpikeName -Kind Database -Name $Database
    $bak = Assert-SpikePath -Path $BackupPath -Mode Read
    $dataDir = Assert-SpikePath -Path (Join-Path $script:SpikeRoot "sqldata\$Database") -Mode Write
    $files = Invoke-SpikeSql -Connection $Connection -Query ("RESTORE FILELISTONLY FROM DISK = " + (Format-SpikeSqlString $bak))
    $moves = New-Object System.Collections.ArrayList
    $n = 0
    foreach ($f in $files) {
        $n++
        $ext = if ($f.Type -eq 'L') { '.ldf' } elseif ($n -eq 1) { '.mdf' } else { '.ndf' }
        $target = Join-Path $dataDir ("{0}_{1}{2}" -f $Database, $n, $ext)
        [void]$moves.Add("MOVE " + (Format-SpikeSqlString $f.LogicalName) + " TO " + (Format-SpikeSqlString $target))
    }
    return [pscustomobject]@{ DataDir = $dataDir; Moves = ($moves -join ', ') }
}

function Restore-SpikeDatabase {
    # RESTORE DATABASE <spike db> from a .bak, files under spike\sqldata. Returns elapsed seconds.
    param(
        [Parameter(Mandatory)][System.Data.SqlClient.SqlConnection]$Connection,
        [Parameter(Mandatory)][string]$BackupPath,
        [Parameter(Mandatory)][string]$Database,
        [switch]$Replace
    )
    Assert-SpikeName -Kind Database -Name $Database
    $map = Get-SpikeBackupFileMap -Connection $Connection -BackupPath $BackupPath -Database $Database
    if (-not (Test-Path -LiteralPath $map.DataDir)) { New-Item -ItemType Directory -Path $map.DataDir | Out-Null }
    $with = if ($Replace) { 'REPLACE, ' } else { '' }
    $sql = "RESTORE DATABASE " + (Format-SpikeSqlIdent $Database) + " FROM DISK = " + (Format-SpikeSqlString $BackupPath) + " WITH " + $with + $map.Moves + ", STATS = 100"
    return (Measure-SpikeSeconds { Invoke-SpikeSql -Connection $Connection -Query $sql | Out-Null })
}

function Grant-SpikeSqlServiceAccess {
    # Gives the SQL Server service account modify on a spike folder (data files) or read on a spike file.
    param([Parameter(Mandatory)][string]$Path, [ValidateSet('Modify', 'Read')][string]$Right = 'Modify')
    $full = Assert-SpikePath -Path $Path -Mode Stage
    $account = Get-SpikeSqlServiceAccount
    if (-not $account) { throw 'SQL: the MSSQLSERVER service was not found.' }
    $perm = if ($Right -eq 'Modify') { '(OI)(CI)M' } else { '(OI)(CI)R' }
    & icacls.exe $full /grant ("{0}:{1}" -f $account, $perm) | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "ICACLS: granting the SQL service account $Right on '$full' failed ($LASTEXITCODE)." }
}

# ---- IIS (Microsoft.Web.Administration; needs elevation to read applicationHost.config) ----
function Get-SpikeIisManager {
    $dll = Join-Path $env:windir 'System32\inetsrv\Microsoft.Web.Administration.dll'
    if (-not (Test-Path -LiteralPath $dll)) { throw 'IIS: Microsoft.Web.Administration.dll was not found; is IIS installed?' }
    Add-Type -Path $dll
    return (New-Object Microsoft.Web.Administration.ServerManager)
}

function Get-SpikeIisLayout {
    # The applications of one spike alias (the alias app and its sub-applications) and their pools, as plain data.
    param([Parameter(Mandatory)][string]$Alias, [string]$SiteName = 'Default Web Site', [string]$InstallDir)
    Assert-SpikeName -Kind Alias -Name $Alias
    $mgr = Get-SpikeIisManager
    try {
        $site = $mgr.Sites[$SiteName]
        if (-not $site) { throw "IIS: site '$SiteName' was not found." }
        $apps = @()
        foreach ($app in $site.Applications) {
            if ($app.Path -ine "/$Alias" -and -not $app.Path.StartsWith("/$Alias/", [StringComparison]::OrdinalIgnoreCase)) { continue }
            $physical = $app.VirtualDirectories['/'].PhysicalPath
            $relative = $physical
            if ($InstallDir -and (Test-SpikeUnder $physical $InstallDir)) { $relative = $physical.Substring($InstallDir.Length).TrimStart('\') }
            $pool = $mgr.ApplicationPools[$app.ApplicationPoolName]
            $apps += [pscustomobject]@{
                subPath = $app.Path.Substring(("/$Alias").Length)
                physicalRelative = $relative
                underInstallDir = [bool]($InstallDir -and (Test-SpikeUnder $physical $InstallDir))
                pool = [pscustomobject]@{
                    name = $pool.Name
                    managedRuntimeVersion = $pool.ManagedRuntimeVersion
                    pipelineMode = $pool.ManagedPipelineMode.ToString()
                    enable32Bit = $pool.Enable32BitAppOnWin64
                    identityType = $pool.ProcessModel.IdentityType.ToString()
                    idleTimeout = $pool.ProcessModel.IdleTimeout.ToString()
                    startMode = $pool.StartMode.ToString()
                }
            }
        }
        return $apps
    } finally { $mgr.Dispose() }
}

function Get-SpikePoolRole {
    param([string]$SubPath)
    $role = $SubPath.Trim('/').ToLowerInvariant() -replace '[^a-z0-9]+', '-'
    if (-not $role) { return 'root' }
    return $role
}

function New-SpikeIisApps {
    # Creates a spike alias with the same application and pool layout as a recorded one.
    param(
        [Parameter(Mandatory)][string]$NewAlias,
        [Parameter(Mandatory)][string]$NewTree,
        [Parameter(Mandatory)]$Layout,
        [string]$SiteName = 'Default Web Site'
    )
    Assert-SpikeName -Kind Alias -Name $NewAlias
    $tree = Assert-SpikePath -Path $NewTree -Mode Write
    $mgr = Get-SpikeIisManager
    $created = @()
    $specificUserFallback = $false
    try {
        $site = $mgr.Sites[$SiteName]
        if (-not $site) { throw "IIS: site '$SiteName' was not found." }
        foreach ($entry in $Layout) {
            $poolName = "$NewAlias-" + (Get-SpikePoolRole $entry.subPath)
            Assert-SpikeName -Kind Pool -Name $poolName
            if ($mgr.ApplicationPools[$poolName]) { throw "IIS: pool '$poolName' already exists." }
            $physical = Assert-SpikePath -Path (Join-Path $tree $entry.physicalRelative) -Mode Write -AllowRoot
            $pool = $mgr.ApplicationPools.Add($poolName)
            $pool.ManagedRuntimeVersion = $entry.pool.managedRuntimeVersion
            $pool.ManagedPipelineMode = [Microsoft.Web.Administration.ManagedPipelineMode]$entry.pool.pipelineMode
            $pool.Enable32BitAppOnWin64 = [bool]$entry.pool.enable32Bit
            $identity = $entry.pool.identityType
            if ($identity -eq 'SpecificUser') { $identity = 'ApplicationPoolIdentity'; $specificUserFallback = $true }
            $pool.ProcessModel.IdentityType = [Microsoft.Web.Administration.ProcessModelIdentityType]$identity
            $pool.ProcessModel.IdleTimeout = [TimeSpan]::Parse($entry.pool.idleTimeout)
            $path = "/$NewAlias" + $entry.subPath
            $app = $site.Applications.Add($path, $physical)
            $app.ApplicationPoolName = $poolName
            $created += [pscustomobject]@{ path = $path; pool = $poolName }
        }
        $mgr.CommitChanges()
    } finally { $mgr.Dispose() }
    return [pscustomobject]@{ created = $created; specificUserFallback = $specificUserFallback }
}

function Remove-SpikeIisApps {
    # Removes every application under /ah-spike-* and every pool named ah-spike-*. Returns the counts removed.
    param([string]$SiteName = 'Default Web Site')
    $mgr = Get-SpikeIisManager
    $apps = 0
    $pools = 0
    try {
        $site = $mgr.Sites[$SiteName]
        if ($site) {
            foreach ($app in @($site.Applications)) {
                $segment = $app.Path.TrimStart('/').Split('/')[0]
                if ($segment -ilike 'ah-spike-*') {
                    Assert-SpikeName -Kind Alias -Name $segment
                    $site.Applications.Remove($app)
                    $apps++
                }
            }
        }
        foreach ($pool in @($mgr.ApplicationPools)) {
            if ($pool.Name -ilike 'ah-spike-*') {
                Assert-SpikeName -Kind Pool -Name $pool.Name
                $mgr.ApplicationPools.Remove($pool)
                $pools++
            }
        }
        $mgr.CommitChanges()
    } finally { $mgr.Dispose() }
    return [pscustomobject]@{ apps = $apps; pools = $pools }
}

function Move-SpikeAppsToOwnPools {
    # The MSI puts its applications into fixed, machine-wide pools ("Aras Innovator AppPool ASP.NET 4.0" and so on) that the captain's own installs
    # share. Gives every application of one spike alias its own pool "<alias>-<role>" with the same settings, so recycling a spike never touches theirs.
    param([Parameter(Mandatory)][string]$Alias, [string]$SiteName = 'Default Web Site')
    Assert-SpikeName -Kind Alias -Name $Alias
    $mgr = Get-SpikeIisManager
    $moved = @()
    try {
        $site = $mgr.Sites[$SiteName]
        foreach ($app in @($site.Applications | Where-Object { $_.Path -eq "/$Alias" -or $_.Path -like "/$Alias/*" })) {
            $sub = $app.Path.Substring($Alias.Length + 1)
            $poolName = "$Alias-" + (Get-SpikePoolRole $sub)
            Assert-SpikeName -Kind Pool -Name $poolName
            if ($app.ApplicationPoolName -eq $poolName) { continue }
            $from = $mgr.ApplicationPools[$app.ApplicationPoolName]
            $pool = $mgr.ApplicationPools[$poolName]
            if (-not $pool) {
                $pool = $mgr.ApplicationPools.Add($poolName)
                if ($from) {
                    $pool.ManagedRuntimeVersion = $from.ManagedRuntimeVersion
                    $pool.ManagedPipelineMode = $from.ManagedPipelineMode
                    $pool.Enable32BitAppOnWin64 = $from.Enable32BitAppOnWin64
                    $pool.ProcessModel.IdentityType = $from.ProcessModel.IdentityType
                    $pool.ProcessModel.IdleTimeout = $from.ProcessModel.IdleTimeout
                }
            }
            $moved += [pscustomobject]@{ path = $app.Path; fromPool = $app.ApplicationPoolName; toPool = $poolName }
            $app.ApplicationPoolName = $poolName
        }
        $mgr.CommitChanges()
    } finally { $mgr.Dispose() }
    return $moved
}
function Restart-SpikePools {
    # Recycles (or starts) every pool of one spike alias.
    param([Parameter(Mandatory)][string]$Alias, [switch]$Stop, [switch]$Start)
    Assert-SpikeName -Kind Alias -Name $Alias
    $mgr = Get-SpikeIisManager
    try {
        foreach ($pool in $mgr.ApplicationPools) {
            if ($pool.Name -notlike "$Alias-*") { continue }
            Assert-SpikeName -Kind Pool -Name $pool.Name
            if ($Stop) {
                if ($pool.State -eq [Microsoft.Web.Administration.ObjectState]::Started) { [void]$pool.Stop() }
                # Stop returns before the worker process has gone; a Start in that window fails with 0x80070425.
                for ($i = 0; $i -lt 60 -and $pool.State -ne [Microsoft.Web.Administration.ObjectState]::Stopped; $i++) { Start-Sleep -Milliseconds 500 }
            } elseif ($Start) {
                for ($i = 0; $i -lt 60 -and $pool.State -eq [Microsoft.Web.Administration.ObjectState]::Stopping; $i++) { Start-Sleep -Milliseconds 500 }
                if ($pool.State -ne [Microsoft.Web.Administration.ObjectState]::Started) { [void]$pool.Start() }
            } else {
                if ($pool.State -eq [Microsoft.Web.Administration.ObjectState]::Started) { [void]$pool.Recycle() } else { [void]$pool.Start() }
            }
        }
    } finally { $mgr.Dispose() }
}

function Get-SpikePoolWorkingSetMb {
    # Working set in MB of the w3wp processes that serve the pools of one spike alias (0 when none is running).
    param([Parameter(Mandatory)][string]$Alias)
    Assert-SpikeName -Kind Alias -Name $Alias
    $total = 0
    foreach ($p in (Get-CimInstance -ClassName Win32_Process -Filter "Name='w3wp.exe'")) {
        if ($p.CommandLine -and $p.CommandLine.ToLowerInvariant().Contains('"' + $Alias.ToLowerInvariant() + '-')) { $total += $p.WorkingSetSize }
    }
    return [math]::Round($total / 1MB, 1)
}

# ---- HTTP and Aras login (status codes and booleans only) ----
function Get-SpikeHttpStatus {
    param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSeconds = 120)
    $req = [Net.HttpWebRequest]::Create($Url)
    $req.Timeout = $TimeoutSeconds * 1000
    $req.AllowAutoRedirect = $false
    try {
        $res = $req.GetResponse()
        $code = [int]$res.StatusCode
        $res.Close()
        return $code
    } catch [Net.WebException] {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}

function Measure-SpikeHttp {
    # Seconds for one anonymous GET, and its status code.
    param([Parameter(Mandatory)][string]$Url)
    $status = 0
    $seconds = Measure-SpikeSeconds { $script:__status = Get-SpikeHttpStatus -Url $Url }
    $status = $script:__status
    return [pscustomobject]@{ seconds = $seconds; status = $status }
}

function Get-SpikeArasToken {
    # OAuth password grant against the slot's own OAuth server. Returns the token as a SecureString, or $null.
    # The Aras password is sent as its MD5 hex, as the Aras clients do; it is computed here and never printed.
    param(
        [Parameter(Mandatory)][string]$Alias,
        [Parameter(Mandatory)][string]$DatabaseId,
        [Parameter(Mandatory)][securestring]$ArasPassword,
        [string]$User = 'root'
    )
    Assert-SpikeName -Kind Alias -Name $Alias
    $plain = ConvertTo-SpikePlainText $ArasPassword
    try {
        $md5 = [Security.Cryptography.MD5]::Create()
        $hex = -join ($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($plain)) | ForEach-Object { $_.ToString('x2') })
    } finally { $plain = $null }
    $body = 'grant_type=password&scope=Innovator&client_id=IOMApp&username=' + [uri]::EscapeDataString($User) +
        ('&password={0}&database={1}' -f $hex, [uri]::EscapeDataString($DatabaseId))
    $hex = $null
    $req = [Net.HttpWebRequest]::Create("http://localhost/$Alias/OAuthServer/connect/token")
    $req.Method = 'POST'
    $req.ContentType = 'application/x-www-form-urlencoded'
    $req.Timeout = 120000
    $bytes = [Text.Encoding]::UTF8.GetBytes($body)
    $body = $null
    $stream = $req.GetRequestStream()
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    try {
        $res = $req.GetResponse()
        try {
            $reader = New-Object IO.StreamReader($res.GetResponseStream())
            $json = $reader.ReadToEnd() | ConvertFrom-Json
        } finally { $res.Close() }
    } catch [Net.WebException] {
        # The OAuth server's refusal (error and error_description) is kept for the results: it names the cause, never the password.
        $script:SpikeLastLoginError = $null
        $resp = $_.Exception.Response
        if ($resp) {
            try {
                $body = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() | ConvertFrom-Json
                $script:SpikeLastLoginError = ('{0}: {1}' -f $body.error, $body.error_description)
            } catch { $script:SpikeLastLoginError = 'HTTP ' + [int]$resp.StatusCode }
        } else { $script:SpikeLastLoginError = $_.Exception.Message }
        return $null
    }
    $script:SpikeLastLoginError = $null
    if (-not $json.access_token) { return $null }
    $secure = New-Object Security.SecureString
    foreach ($c in $json.access_token.ToCharArray()) { $secure.AppendChar($c) }
    $secure.MakeReadOnly()
    Register-SpikeSecret $secure
    return $secure
}

function Test-SpikeArasLogin {
    param(
        [Parameter(Mandatory)][string]$Alias,
        [Parameter(Mandatory)][string]$DatabaseId,
        [Parameter(Mandatory)][securestring]$ArasPassword,
        [string]$User = 'root'
    )
    $token = Get-SpikeArasToken -Alias $Alias -DatabaseId $DatabaseId -ArasPassword $ArasPassword -User $User
    return [bool]$token
}

# ---- config files ----
function Get-SpikeDbId {
    # The database id (the 'id' attribute of the single <DB-Connection>) of a slot's InnovatorServerConfig.xml.
    param([Parameter(Mandatory)][string]$ConfigPath)
    $path = Assert-SpikePath -Path $ConfigPath -Mode Read
    [xml]$xml = Get-Content -LiteralPath $path -Raw
    $nodes = @($xml.SelectNodes('//DB-Connection'))
    if ($nodes.Count -ne 1) { throw "CONFIG: expected one DB-Connection in the slot config, found $($nodes.Count)." }
    return $nodes[0].GetAttribute('id')
}

function Find-SpikeFile {
    # First file with this name under a spike folder, or $null.
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Name)
    $dir = Assert-SpikePath -Path $Root -Mode Read -AllowRoot
    $hit = Get-ChildItem -LiteralPath $dir -Recurse -File -Filter $Name -Force -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
    return $null
}

function Get-SpikeTreeStats {
    param([Parameter(Mandatory)][string]$Path)
    $dir = Assert-SpikePath -Path $Path -Mode Read
    $files = 0
    $bytes = 0L
    foreach ($f in (Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue)) { $files++; $bytes += $f.Length }
    return [pscustomobject]@{ files = $files; megabytes = [math]::Round($bytes / 1MB, 1) }
}

function Invoke-SpikeRobocopy {
    # robocopy with fixed safe switches. Source may be under spike or staging; the destination only under spike.
    # Returns [pscustomobject]@{ seconds; exitCode; ok } (robocopy exit codes below 8 are success).
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [switch]$Mirror,
        [int]$Threads = 16,
        [string[]]$ExcludeFiles = @()
    )
    $src = Assert-SpikePath -Path $Source -Mode Read
    $dst = Assert-SpikePath -Path $Destination -Mode Write
    if ($src -ieq $dst) { throw 'ROBOCOPY: source and destination are the same folder.' }
    $mode = if ($Mirror) { '/MIR' } else { '/E' }
    $rcArgs = @($src, $dst, $mode, '/XJ', '/R:2', '/W:1', "/MT:$Threads", '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    if ($ExcludeFiles.Count -gt 0) { $rcArgs += '/XF'; foreach ($f in $ExcludeFiles) { $rcArgs += (Assert-SpikePath -Path $f -Mode Write) } }
    $script:__rc = 0
    $seconds = Measure-SpikeSeconds { & robocopy.exe @rcArgs | Out-Null; $script:__rc = $LASTEXITCODE }
    return [pscustomobject]@{ seconds = $seconds; exitCode = $script:__rc; ok = ($script:__rc -lt 8) }
}

function Remove-SpikeTree {
    # Empties a spike folder fast (robocopy mirror from an empty folder), then removes it.
    param([Parameter(Mandatory)][string]$Path)
    $dir = Assert-SpikePath -Path $Path -Mode Write
    if (-not (Test-Path -LiteralPath $dir)) { return }
    $empty = Join-Path $script:SpikeRoot ('empty-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $empty | Out-Null
    try { & robocopy.exe $empty $dir /MIR /XJ /R:1 /W:1 /MT:16 /NFL /NDL /NJH /NJS /NP | Out-Null }
    finally { Remove-Item -LiteralPath $empty -Force -Recurse -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $dir -Force -Recurse
}

function Get-SpikeNames {
    # The derived spike names for a flavor and suffix.
    param([Parameter(Mandatory)][string]$Flavor, [Parameter(Mandatory)][string]$Suffix)
    return [pscustomobject]@{
        Alias = "ah-spike-$Flavor-$Suffix"
        Database = "arashouse_spike_${Flavor}_$Suffix"
        Service = "ArasHouseAgent_spike_${Flavor}_$Suffix"
        Login = "arashouse_spike_${Flavor}_$Suffix"
    }
}
