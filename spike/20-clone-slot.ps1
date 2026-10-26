# Clone the baseline (script 10) into a second instance that runs side by side: copy the tree, create the second alias and pools,
# restore a second database from the shipped .bak, create per-slot SQL logins, a vault folder and an agent service, apply a
# hand edit list, and check that both instances answer. Dry run by default; -Apply makes changes (elevated). Windows PowerShell 5.1.
# The per-slot SQL passwords are generated here, written only into the clone's own config, and never printed or saved elsewhere.
param(
    [switch]$Apply,
    [ValidateSet('12sp9', '23', '35')][string]$Flavor = '12sp9',
    [ValidatePattern('^[a-z0-9]{1,8}$')][string]$SourceSuffix = 'a',
    [ValidatePattern('^[a-z0-9]{1,8}$')][string]$NewSuffix = 'b',
    [ValidateSet('Sa', 'Windows')][string]$SqlAuth = 'Sa',
    # Default: the shipped CoreAndSolutions*.bak found inside the baseline's tree (its DB\ folder).
    [string]$BakPath,
    # Added edits as JSON: [{ "file": "relative\\path.xml", "replace": [["from","to"]] }]. Applied after the built-in edits.
    [string]$EditList,
    [int]$AgentPort = 0,
    # Overrides, mainly for the guard tests. Defaults are derived from -Flavor and -NewSuffix.
    [string]$NewAlias,
    [string]$NewDatabase,
    [string]$NewTree
)
. "$PSScriptRoot/lib/SpikeCommon.ps1"

try {
    $src = Get-SpikeNames -Flavor $Flavor -Suffix $SourceSuffix
    $dst = Get-SpikeNames -Flavor $Flavor -Suffix $NewSuffix
    if (-not $NewAlias) { $NewAlias = $dst.Alias }
    if (-not $NewDatabase) { $NewDatabase = $dst.Database }
    if (-not $NewTree) { $NewTree = Join-Path $script:SpikeRoot "slot-$Flavor-$NewSuffix" }
    $loginDbo = "$($dst.Login)_dbo"
    $loginReg = "$($dst.Login)_reg"
    $serviceName = $dst.Service
    Assert-SpikeName -Kind Alias -Name $NewAlias
    Assert-SpikeName -Kind Database -Name $NewDatabase
    Assert-SpikeName -Kind Login -Name $loginDbo
    Assert-SpikeName -Kind Login -Name $loginReg
    Assert-SpikeName -Kind Service -Name $serviceName
    $NewTree = Assert-SpikePath -Path $NewTree -Mode Write
    $srcTree = Assert-SpikePath -Path (Join-Path $script:SpikeRoot ("golden-build\" + $(if ($SourceSuffix -eq 'a') { $Flavor } else { "$Flavor-$SourceSuffix" }))) -Mode Read
    $vault = Assert-SpikePath -Path (Join-Path $script:SpikeRoot "vaults\$Flavor-$NewSuffix") -Mode Write
    if ($BakPath) { $BakPath = Assert-SpikePath -Path $BakPath -Mode Read }
    if ($EditList) { $EditList = Assert-SpikePath -Path $EditList -Mode Read }
    $baselineJson = Join-Path $script:SpikeOutDir "10-baseline-install-$Flavor-$SourceSuffix.json"

    Start-Spike -Name "20-clone-slot-$Flavor-$NewSuffix" -Apply $Apply.IsPresent -NeedsElevation
    Add-SpikeFact 'newAlias' $NewAlias
    Add-SpikeFact 'newDatabase' $NewDatabase

    $ctx = @{ baseline = $null; sqlPassword = $null; conn = $null; dboPw = $null; regPw = $null; port = $AgentPort; config = $null; edited = @() }

    Invoke-SpikeStep "read the baseline's recorded layout from $baselineJson (IIS apps and pools, config files)" {
        if (-not (Test-Path -LiteralPath $baselineJson)) { throw "PRECONDITION: $baselineJson is missing; run 10-baseline-install.ps1 -Apply first." }
        $ctx.baseline = Get-Content -LiteralPath $baselineJson -Raw | ConvertFrom-Json
        if (-not $ctx.baseline.iisLayout) { throw 'PRECONDITION: the baseline recorded no IIS layout.' }
        if (-not $BakPath) {
            $bak = Get-ChildItem -LiteralPath $srcTree -Recurse -Filter 'CoreAndSolutions*.bak' -File | Select-Object -First 1
            if (-not $bak) { throw "MEDIA: no CoreAndSolutions*.bak under $srcTree; pass -BakPath." }
            $script:BakPath = $bak.FullName
        }
        Add-SpikeFact 'bakFileName' (Split-Path -Leaf $script:BakPath)
        if (Test-Path -LiteralPath $NewTree) { throw "PRECONDITION: $NewTree already exists." }
    }

    Invoke-SpikeStep "copy the tree $srcTree to $NewTree (robocopy /E /XJ, 16 threads) and compare file counts" {
        $r = Invoke-SpikeRobocopy -Source $srcTree -Destination $NewTree -Threads 16
        Add-SpikeFact 'copySeconds' $r.seconds
        if (-not $r.ok) { throw "ROBOCOPY: copy failed with exit code $($r.exitCode)." }
        $a = Get-SpikeTreeStats -Path $srcTree
        $b = Get-SpikeTreeStats -Path $NewTree
        Add-SpikeFact 'copyFileCounts' ([ordered]@{ source = $a.files; copy = $b.files; megabytes = $b.megabytes })
    }

    if ($SqlAuth -eq 'Sa') {
        Invoke-SpikeStep 'prompt (hidden) for the SQL sa password' { $ctx.sqlPassword = Read-SpikeSecret -Prompt 'SQL sa password (hidden)' }
    }

    Invoke-SpikeStep "restore database $NewDatabase from the shipped backup, files under spike\sqldata (the SQL service account gets modify on that folder and read on the backup)" {
        $ctx.conn = if ($SqlAuth -eq 'Sa') { New-SpikeSqlConnection -Auth Sa -Password $ctx.sqlPassword } else { New-SpikeSqlConnection -Auth Windows }
        $sqldata = Assert-SpikePath -Path (Join-Path $script:SpikeRoot 'sqldata') -Mode Write
        if (-not (Test-Path -LiteralPath $sqldata)) { New-Item -ItemType Directory -Path $sqldata | Out-Null }
        Grant-SpikeSqlServiceAccess -Path $sqldata -Right Modify
        Grant-SpikeSqlServiceAccess -Path (Split-Path -Parent $script:BakPath) -Right Read
        Add-SpikeFact 'sqlServiceAccount' (Get-SpikeSqlServiceAccount)
        Add-SpikeFact 'restoreSeconds' (Restore-SpikeDatabase -Connection $ctx.conn -BackupPath $script:BakPath -Database $NewDatabase)
    }

    Invoke-SpikeStep "create per-slot logins $loginDbo and $loginReg (random passwords, kept only in the clone's config) and map the database users to them" {
        $ctx.dboPw = New-SpikePassword
        $ctx.regPw = New-SpikePassword
        $db = Format-SpikeSqlIdent $NewDatabase
        foreach ($pair in @(@($loginDbo, $ctx.dboPw), @($loginReg, $ctx.regPw))) {
            $plain = ConvertTo-SpikePlainText $pair[1]
            try {
                Invoke-SpikeSql -Connection $ctx.conn -Query ("CREATE LOGIN {0} WITH PASSWORD = {1}, CHECK_POLICY = OFF, DEFAULT_DATABASE = {2}" -f (Format-SpikeSqlIdent $pair[0]), (Format-SpikeSqlString $plain), $db) | Out-Null
            } finally { $plain = $null }
        }
        $users = Invoke-SpikeSql -Connection $ctx.conn -Query ("SELECT name FROM $db.sys.database_principals WHERE type = 'S' AND name NOT IN ('dbo','guest','INFORMATION_SCHEMA','sys')")
        $names = @($users | ForEach-Object { $_.name })
        Add-SpikeFact 'restoredDatabaseUsers' $names
        $map = [ordered]@{ innovator = $loginDbo; innovator_regular = $loginReg }
        $mapped = @()
        foreach ($u in $map.Keys) {
            if ($names -contains $u) {
                Invoke-SpikeSql -Connection $ctx.conn -Query ("USE $db; ALTER USER " + (Format-SpikeSqlIdent $u) + " WITH LOGIN = " + (Format-SpikeSqlIdent $map[$u])) | Out-Null
                $mapped += $u
            }
        }
        Add-SpikeFact 'usersRemapped' $mapped
        if ($mapped.Count -ne 2) { Write-Host 'warning: the expected users innovator and innovator_regular were not both found; map the users from restoredDatabaseUsers by hand' }
    }

    Invoke-SpikeStep "create vault folder $vault" {
        New-Item -ItemType Directory -Path $vault | Out-Null
        & icacls.exe $vault /grant 'IIS_IUSRS:(OI)(CI)M' | Out-Null
    }

    Invoke-SpikeStep "create IIS alias /$NewAlias with the baseline's applications and one pool per application (names ah-spike-*)" {
        $layout = @($ctx.baseline.iisLayout)
        $r = New-SpikeIisApps -NewAlias $NewAlias -NewTree $NewTree -Layout $layout
        Add-SpikeFact 'iisCreated' $r.created
        Add-SpikeFact 'poolIdentityFellBackFromSpecificUser' $r.specificUserFallback
    }

    Invoke-SpikeStep "edit the clone's config files: alias, database, tree path, vault path and agent port renamed; DB-Connection logins set (counts and file names only are recorded)" {
        $oldTree = $ctx.baseline.installDir
        $pairs = [ordered]@{
            alias = @($src.Alias, $NewAlias)
            database = @($ctx.baseline.database, $NewDatabase)
            treeBackslash = @($oldTree, $NewTree)
            treeSlash = @($oldTree.Replace('\', '/'), $NewTree.Replace('\', '/'))
        }
        $port = $ctx.port
        if ($port -eq 0) {
            $listening = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port }
            $port = 8800
            while ($listening -contains $port) { $port++ }
        }
        $ctx.port = $port
        Add-SpikeFact 'agentPort' $port
        $files = Get-ChildItem -LiteralPath $NewTree -Recurse -File -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch '\\(Server\\temp|Server\\dll|node_modules|logs)\\' -and ($_.Name -like '*Config.xml' -or $_.Name -in @('web.config', 'OAuth.config', 'vault.config', 'appsettings.json') -or $_.Name -like 'appsettings.*.json') -and $_.Length -lt 2MB }
        $report = @()
        foreach ($f in $files) {
            $text = [IO.File]::ReadAllText($f.FullName)
            $orig = $text
            $counts = [ordered]@{}
            foreach ($k in $pairs.Keys) {
                $from = $pairs[$k][0]
                if (-not $from) { continue }
                $n = ([regex]::Matches($text, [regex]::Escape($from), 'IgnoreCase')).Count
                if ($n -gt 0) { $text = [regex]::Replace($text, [regex]::Escape($from), $pairs[$k][1].Replace('$', '$$'), 'IgnoreCase'); $counts[$k] = $n }
            }
            if ($f.Name -eq 'InnovatorServerConfig.xml') {
                $xml = New-Object Xml.XmlDocument
                $xml.PreserveWhitespace = $true
                $xml.LoadXml($text)
                $conn = @($xml.SelectNodes('//DB-Connection'))
                $attrNames = @()
                if ($conn.Count -eq 1) {
                    $node = $conn[0]
                    $attrNames = @($node.Attributes | ForEach-Object { $_.Name })
                    $set = [ordered]@{ uid = @($loginDbo, $ctx.dboPw); regular_uid = @($loginReg, $ctx.regPw) }
                    foreach ($uidName in $set.Keys) {
                        if ($node.HasAttribute($uidName)) {
                            $node.SetAttribute($uidName, $set[$uidName][0])
                            $pwdName = $uidName -replace 'uid$', 'pwd'
                            if ($node.HasAttribute($pwdName)) {
                                $plain = ConvertTo-SpikePlainText $set[$uidName][1]
                                $node.SetAttribute($pwdName, $plain)
                                $plain = $null
                                $counts[$pwdName] = 1
                            }
                            $counts[$uidName] = 1
                        }
                    }
                    foreach ($agent in @($xml.SelectNodes('//AgentService'))) {
                        if ($agent.HasAttribute('InnovatorToServiceAddress')) {
                            $agent.SetAttribute('InnovatorToServiceAddress', ([regex]::Replace($agent.GetAttribute('InnovatorToServiceAddress'), ':\d{2,5}', (':' + $port), 1)))
                            $counts['agentPort'] = 1
                        }
                    }
                }
                $text = $xml.OuterXml
                Add-SpikeFact 'dbConnectionElementsFound' $conn.Count
                Add-SpikeFact 'dbConnectionAttributeNames' $attrNames
                $ctx.config = $f.FullName
            }
            if ($text -ne $orig) {
                [IO.File]::WriteAllText($f.FullName, $text, (New-Object Text.UTF8Encoding($false)))
                $report += [ordered]@{ file = $f.FullName.Substring($NewTree.Length).TrimStart('\'); replacements = $counts }
            }
        }
        if ($EditList) {
            foreach ($e in (Get-Content -LiteralPath $EditList -Raw | ConvertFrom-Json)) {
                $target = Assert-SpikePath -Path (Join-Path $NewTree $e.file) -Mode Write
                $t = [IO.File]::ReadAllText($target)
                foreach ($r in $e.replace) { $t = $t.Replace($r[0], $r[1]) }
                [IO.File]::WriteAllText($target, $t, (New-Object Text.UTF8Encoding($false)))
                $report += [ordered]@{ file = $e.file; replacements = 'edit list' }
            }
        }
        Add-SpikeFact 'editedFiles' $report
        $ctx.edited = @($report | ForEach-Object { Join-Path $NewTree $_.file })
    }

    Invoke-SpikeStep "create agent service $serviceName (manual start, left stopped) from the agent executable in the clone's AgentService folder" {
        $agentDir = Get-ChildItem -LiteralPath $NewTree -Recurse -Directory -Filter 'AgentService' | Select-Object -First 1
        $exes = if ($agentDir) { @(Get-ChildItem -LiteralPath $agentDir.FullName -Filter '*.exe' -File) } else { @() }
        $pick = @($exes | Where-Object { $_.Name -match 'Agent' } | Select-Object -First 1)
        Add-SpikeFact 'agentExecutables' @($exes | ForEach-Object { $_.Name })
        if ($pick.Count -eq 1) {
            New-Service -Name $serviceName -BinaryPathName ('"' + $pick[0].FullName + '"') -DisplayName $serviceName -StartupType Manual | Out-Null
            Add-SpikeFact 'agentServiceCreated' $true
        } else {
            Add-SpikeFact 'agentServiceCreated' $false
            Write-Host 'warning: no single agent executable found; create the service by hand and record its definition'
        }
    }

    Invoke-SpikeStep "start both pools, then check that /$($src.Alias) and /$NewAlias answer and that the clone logs in while the baseline stays up (booleans)" {
        Restart-SpikePools -Alias $NewAlias
        Restart-SpikePools -Alias $src.Alias
        $cold = Measure-SpikeHttp "http://localhost/$NewAlias/Client/"
        Add-SpikeFact 'cloneColdClient' $cold
        Add-SpikeFact 'baselineClientStatus' (Get-SpikeHttpStatus "http://localhost/$($src.Alias)/Client/")
        $pw = Get-SpikeArasPassword
        $id = Get-SpikeDbId -ConfigPath $ctx.config
        Add-SpikeFact 'cloneLoginOk' (Test-SpikeArasLogin -Alias $NewAlias -DatabaseId $id -ArasPassword $pw)
        $baseConfig = Find-SpikeFile -Root $srcTree -Name 'InnovatorServerConfig.xml'
        Add-SpikeFact 'baselineLoginOkWhileCloneUp' (Test-SpikeArasLogin -Alias $src.Alias -DatabaseId (Get-SpikeDbId -ConfigPath $baseConfig) -ArasPassword $pw)
    }

    if ($ctx.conn) { $ctx.conn.Dispose() }
    Complete-Spike
} catch {
    Exit-SpikeFailure $_.Exception.Message
}
