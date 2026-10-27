# SQL restore permission model: can a login that owns only a spike database (no dbcreator, no sysadmin) restore over it WITH REPLACE,
# does the owner survive, and if not, does a stored procedure with EXECUTE AS OWNER in a utility database do it? Also the fix-ups after
# a restore (orphaned users, absolute URLs, root and admin passwords, an extended-property marker) and whether the SQL service account can
# read a backup from staging\ and from a golden-style folder. Dry run by default; -Apply makes changes (elevated; an sa prompt unless
# -SqlAuth Windows). Windows PowerShell 5.1. Only spike databases and spike logins are touched. Results are booleans, counts, error numbers,
# seconds and names; never a password or a password hash (only its shape: length, hex or not, letter case).
param(
    [switch]$Apply,
    [ValidateSet('12sp9', '23', '35')][string]$Flavor = '12sp9',
    [ValidatePattern('^[a-z0-9]{1,8}$')][string]$SlotSuffix = 'b',
    [ValidateSet('Sa', 'Windows')][string]$SqlAuth = 'Sa',
    [string]$BakPath,
    # Overrides, mainly for the guard tests.
    [string]$ScratchDatabase,
    [string]$PoolLogin
)
. "$PSScriptRoot/lib/SpikeCommon.ps1"

try {
    if (-not $ScratchDatabase) { $ScratchDatabase = "arashouse_spike_${Flavor}_o" }
    if (-not $PoolLogin) { $PoolLogin = 'arashouse_spike_pool' }
    $adminDb = 'arashouse_spike_admin'
    $slotDb = (Get-SpikeNames -Flavor $Flavor -Suffix $SlotSuffix).Database
    $slotAlias = (Get-SpikeNames -Flavor $Flavor -Suffix $SlotSuffix).Alias
    Assert-SpikeName -Kind Database -Name $ScratchDatabase
    Assert-SpikeName -Kind Database -Name $adminDb
    Assert-SpikeName -Kind Database -Name $slotDb
    Assert-SpikeName -Kind Login -Name $PoolLogin
    if ($BakPath) { $BakPath = Assert-SpikePath -Path $BakPath -Mode Read }
    $golden = Assert-SpikePath -Path (Join-Path $script:SpikeRoot "golden-build\$Flavor") -Mode Read
    $goldenTest = Assert-SpikePath -Path (Join-Path $script:SpikeRoot 'golden-test') -Mode Write
    $slotTree = Assert-SpikePath -Path (Join-Path $script:SpikeRoot "slot-$Flavor-$SlotSuffix") -Mode Read

    Start-Spike -Name "60-sql-restore-owner-$Flavor" -Apply $Apply.IsPresent -NeedsElevation
    $ctx = @{ sa = $null; sqlPassword = $null; poolPw = $null; bak = $BakPath; dbId = $null }

    function New-AdminConnection([string]$catalog = 'master') {
        if ($SqlAuth -eq 'Sa') { return (New-SpikeSqlConnection -Catalog $catalog -Auth Sa -Password $ctx.sqlPassword) }
        return (New-SpikeSqlConnection -Catalog $catalog -Auth Windows)
    }

    function Get-Owner([string]$db) {
        $r = Invoke-SpikeSql -Connection $ctx.sa -Query 'SELECT SUSER_SNAME(owner_sid) AS owner FROM sys.databases WHERE name = @n' -Parameters @{ '@n' = $db }
        return $r[0].owner
    }

    function Invoke-AsPool([string]$catalog, [string]$sql) {
        # Runs a statement as the pool login; returns seconds and, on failure, the SQL error number and a short message.
        $c = New-SpikeSqlConnection -Catalog $catalog -Auth Login -Password $ctx.poolPw -LoginName $PoolLogin
        try {
            $ok = $true
            $number = 0
            $message = ''
            $sw = [Diagnostics.Stopwatch]::StartNew()
            try { Invoke-SpikeSql -Connection $c -Query $sql | Out-Null }
            catch [Data.SqlClient.SqlException] { $ok = $false; $number = $_.Exception.Number; $message = $_.Exception.Message }
            $sw.Stop()
            if ($message.Length -gt 160) { $message = $message.Substring(0, 160) }
            return [ordered]@{ ok = $ok; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 2); errorNumber = $number; message = $message }
        } finally { $c.Dispose() }
    }

    if ($SqlAuth -eq 'Sa') {
        Invoke-SpikeStep 'prompt (hidden) for the SQL sa password' { $ctx.sqlPassword = Read-SpikeSecret -Prompt 'SQL sa password (hidden)' }
    }

    Invoke-SpikeStep "connect, record the SQL service account, and check it can read a backup from staging\ and from $goldenTest (RESTORE HEADERONLY)" {
        $ctx.sa = New-AdminConnection
        Add-SpikeFact 'sqlServiceAccount' (Get-SpikeSqlServiceAccount)
        $who = Invoke-SpikeSql -Connection $ctx.sa -Query 'SELECT IS_SRVROLEMEMBER(N''sysadmin'') AS sa'
        Add-SpikeFact 'adminConnectionIsSysadmin' ([bool]$who[0].sa)
        $paths = Invoke-SpikeSql -Connection $ctx.sa -Query 'SELECT CAST(SERVERPROPERTY(''InstanceDefaultDataPath'') AS nvarchar(260)) AS data, CAST(SERVERPROPERTY(''InstanceDefaultLogPath'') AS nvarchar(260)) AS log'
        Add-SpikeFact 'sqlDefaultFilePaths' ([ordered]@{ data = $paths[0].data; log = $paths[0].log })
        if (-not $ctx.bak) { $ctx.bak = (Get-ChildItem -LiteralPath $golden -Recurse -Filter 'CoreAndSolutions*.bak' -File | Select-Object -First 1).FullName }
        $files = Invoke-SpikeSql -Connection $ctx.sa -Query ("RESTORE FILELISTONLY FROM DISK = " + (Format-SpikeSqlString $ctx.bak))
        Add-SpikeFact 'backupFiles' @($files | ForEach-Object { [ordered]@{ logicalName = $_.LogicalName; type = $_.Type; sizeMb = [math]::Round([double]$_.Size / 1MB, 1); originalFileName = [IO.Path]::GetFileName($_.PhysicalName) } })
        Add-SpikeFact 'moveTargetFolder' ((Join-Path $script:SpikeRoot "sqldata\$ScratchDatabase") + '\')
        $sqldata = Assert-SpikePath -Path (Join-Path $script:SpikeRoot 'sqldata') -Mode Write
        if (-not (Test-Path -LiteralPath $sqldata)) { New-Item -ItemType Directory -Path $sqldata | Out-Null }
        Grant-SpikeSqlServiceAccess -Path $sqldata -Right Modify
        $staged = Get-ChildItem -LiteralPath (Join-Path $script:SpikeStagingDir $Flavor) -Recurse -Filter 'CoreAndSolutions*.bak' -File -ErrorAction SilentlyContinue | Select-Object -First 1
        New-Item -ItemType Directory -Path $goldenTest | Out-Null
        Copy-Item -LiteralPath $ctx.bak -Destination (Join-Path $goldenTest 'copy.bak')
        $readable = [ordered]@{}
        $targets = @(@('staging', $(if ($staged) { $staged.FullName } else { $null })), @('goldenStyleFolder', (Join-Path $goldenTest 'copy.bak')))
        foreach ($phase in @('beforeGrant', 'afterGrant')) {
            if ($phase -eq 'afterGrant') { foreach ($t in $targets) { if ($t[1]) { Grant-SpikeSqlServiceAccess -Path (Split-Path -Parent $t[1]) -Right Read } } }
            $row = [ordered]@{}
            foreach ($pair in $targets) {
                if (-not $pair[1]) { $row[$pair[0]] = 'no file to test'; continue }
                try { Invoke-SpikeSql -Connection $ctx.sa -Query ("RESTORE HEADERONLY FROM DISK = " + (Format-SpikeSqlString $pair[1])) | Out-Null; $row[$pair[0]] = $true }
                catch [Data.SqlClient.SqlException] { $row[$pair[0]] = $false }
            }
            $readable[$phase] = $row
        }
        Add-SpikeFact 'serviceAccountCanReadBackup' $readable
    }

    Invoke-SpikeStep "(a) restore $ScratchDatabase as sa: new, then WITH REPLACE (seconds)" {
        $sqlaFirst = Restore-SpikeDatabase -Connection $ctx.sa -BackupPath $ctx.bak -Database $ScratchDatabase
        $sqlaReplace = Restore-SpikeDatabase -Connection $ctx.sa -BackupPath $ctx.bak -Database $ScratchDatabase -Replace
        Add-SpikeFact 'saRestore' ([ordered]@{ newSeconds = $sqlaFirst; replaceSeconds = $sqlaReplace; ownerAfter = (Get-Owner $ScratchDatabase) })
    }

    Invoke-SpikeStep "(b) create login $PoolLogin (no server roles), make it the owner of $ScratchDatabase only, restore WITH REPLACE as that login" {
        $ctx.poolPw = New-SpikePassword
        $plain = ConvertTo-SpikePlainText $ctx.poolPw
        try { Invoke-SpikeSql -Connection $ctx.sa -Query ("CREATE LOGIN {0} WITH PASSWORD = {1}, CHECK_POLICY = OFF" -f (Format-SpikeSqlIdent $PoolLogin), (Format-SpikeSqlString $plain)) | Out-Null }
        finally { $plain = $null }
        Invoke-SpikeSql -Connection $ctx.sa -Query ("ALTER AUTHORIZATION ON DATABASE::" + (Format-SpikeSqlIdent $ScratchDatabase) + " TO " + (Format-SpikeSqlIdent $PoolLogin)) | Out-Null
        $roles = Invoke-SpikeSql -Connection $ctx.sa -Query 'SELECT IS_SRVROLEMEMBER(N''sysadmin'', @l) AS sa, IS_SRVROLEMEMBER(N''dbcreator'', @l) AS dbc' -Parameters @{ '@l' = $PoolLogin }
        $map = Get-SpikeBackupFileMap -Connection $ctx.sa -BackupPath $ctx.bak -Database $ScratchDatabase
        $sql = "RESTORE DATABASE " + (Format-SpikeSqlIdent $ScratchDatabase) + " FROM DISK = " + (Format-SpikeSqlString $ctx.bak) + " WITH REPLACE, " + $map.Moves
        $ownerBefore = Get-Owner $ScratchDatabase
        $result = Invoke-AsPool 'master' $sql
        $ownerAfter = Get-Owner $ScratchDatabase
        Add-SpikeFact 'ownerRestore' ([ordered]@{
            poolLoginIsSysadmin = [bool]$roles[0].sa; poolLoginIsDbcreator = [bool]$roles[0].dbc
            succeeded = $result.ok; seconds = $result.seconds; errorNumber = $result.errorNumber; message = $result.message
            ownerIsPoolLoginBefore = ($ownerBefore -eq $PoolLogin); ownerIsPoolLoginAfter = ($ownerAfter -eq $PoolLogin)
        })
    }

    Invoke-SpikeStep "(b2) as $PoolLogin, restore over $ScratchDatabase while another session holds it open: plain WITH REPLACE, then SET SINGLE_USER WITH ROLLBACK IMMEDIATE first" {
        $map = Get-SpikeBackupFileMap -Connection $ctx.sa -BackupPath $ctx.bak -Database $ScratchDatabase
        $restore = "RESTORE DATABASE " + (Format-SpikeSqlIdent $ScratchDatabase) + " FROM DISK = " + (Format-SpikeSqlString $ctx.bak) + " WITH REPLACE, " + $map.Moves
        $holder = New-AdminConnection $ScratchDatabase
        try {
            $plain = Invoke-AsPool 'master' $restore
            $kick = Invoke-AsPool 'master' ("ALTER DATABASE " + (Format-SpikeSqlIdent $ScratchDatabase) + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE; " + $restore)
        } finally { try { $holder.Dispose() } catch { } }
        $access = Invoke-SpikeSql -Connection $ctx.sa -Query 'SELECT user_access_desc AS a FROM sys.databases WHERE name = @n' -Parameters @{ '@n' = $ScratchDatabase }
        Add-SpikeFact 'ownerRestoreWithOpenConnection' ([ordered]@{
            plainSucceeded = $plain.ok; plainErrorNumber = $plain.errorNumber
            singleUserThenRestoreSucceeded = $kick.ok; seconds = $kick.seconds; errorNumber = $kick.errorNumber; message = $kick.message
            userAccessAfter = $access[0].a; ownerIsPoolLoginAfter = ((Get-Owner $ScratchDatabase) -eq $PoolLogin)
        })
    }

    Invoke-SpikeStep "(c) fallback: utility database $adminDb with a stored procedure WITH EXECUTE AS OWNER (TRUSTWORTHY ON for the spike; module signing is the production alternative), name allowlist inside; $PoolLogin gets EXECUTE only" {
        Invoke-SpikeSql -Connection $ctx.sa -Query ("CREATE DATABASE " + (Format-SpikeSqlIdent $adminDb)) | Out-Null
        Invoke-SpikeSql -Connection $ctx.sa -Query ("ALTER DATABASE " + (Format-SpikeSqlIdent $adminDb) + " SET TRUSTWORTHY ON") | Out-Null
        $adm = New-AdminConnection $adminDb
        try {
            $proc = @"
CREATE PROCEDURE dbo.reset_database @name sysname, @bak nvarchar(260), @moves nvarchar(max)
WITH EXECUTE AS OWNER
AS
BEGIN
  IF @name NOT LIKE N'arashouse[_]spike[_]%'
    THROW 50001, N'database name is not allowed', 1;
  IF @bak NOT LIKE N'C:\aras_installations\%.bak' OR @bak LIKE N'%..%'
    THROW 50002, N'backup path is not allowed', 1;
  DECLARE @sql nvarchar(max) = N'RESTORE DATABASE ' + QUOTENAME(@name) + N' FROM DISK = N''' + REPLACE(@bak, N'''', N'''''') + N''' WITH REPLACE, ' + @moves;
  EXEC (@sql);
END
"@
            Invoke-SpikeSql -Connection $adm -Query $proc | Out-Null
            Invoke-SpikeSql -Connection $adm -Query ("CREATE USER " + (Format-SpikeSqlIdent $PoolLogin) + " FOR LOGIN " + (Format-SpikeSqlIdent $PoolLogin)) | Out-Null
            Invoke-SpikeSql -Connection $adm -Query ("GRANT EXECUTE ON dbo.reset_database TO " + (Format-SpikeSqlIdent $PoolLogin)) | Out-Null
        } finally { $adm.Dispose() }
        $map = Get-SpikeBackupFileMap -Connection $ctx.sa -BackupPath $ctx.bak -Database $ScratchDatabase
        $call = "EXEC dbo.reset_database @name = " + (Format-SpikeSqlString $ScratchDatabase) + ", @bak = " + (Format-SpikeSqlString $ctx.bak) + ", @moves = " + (Format-SpikeSqlString $map.Moves)
        $good = Invoke-AsPool $adminDb $call
        $badName = Invoke-AsPool $adminDb ("EXEC dbo.reset_database @name = N'not_a_spike_db', @bak = " + (Format-SpikeSqlString $ctx.bak) + ", @moves = N''")
        Add-SpikeFact 'procedureRestore' ([ordered]@{
            succeeded = $good.ok; seconds = $good.seconds; errorNumber = $good.errorNumber; message = $good.message
            foreignNameRefused = (-not $badName.ok); foreignNameErrorNumber = $badName.errorNumber
            ownerAfter = (Get-Owner $ScratchDatabase)
        })
    }

    Invoke-SpikeStep "fix-ups on $ScratchDatabase after the restore: orphaned users, the vault URL columns, an extended-property marker (written after the restore)" {
        $db = Format-SpikeSqlIdent $ScratchDatabase
        $orphans = Invoke-SpikeSql -Connection $ctx.sa -Query ("SELECT dp.name FROM $db.sys.database_principals dp LEFT JOIN sys.server_principals sp ON dp.sid = sp.sid WHERE dp.type = 'S' AND sp.sid IS NULL AND dp.name NOT IN ('dbo','guest','INFORMATION_SCHEMA','sys')")
        Add-SpikeFact 'orphanedUsersAfterRestore' @($orphans | ForEach-Object { $_.name })
        try {
            # 12.0 names the column vault_url_pattern (ticket 05); vault_url is the older name.
            $col = Invoke-SpikeSql -Connection $ctx.sa -Query ("SELECT TOP 1 c.name FROM $db.sys.columns c JOIN $db.sys.tables t ON t.object_id = c.object_id JOIN $db.sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = N'innovator' AND t.name = N'VAULT' AND c.name IN (N'vault_url_pattern', N'vault_url') ORDER BY c.name DESC")
            $c = Format-SpikeSqlIdent $col[0].name
            $vault = Invoke-SpikeSql -Connection $ctx.sa -Query ("SELECT COUNT(*) AS n, SUM(CASE WHEN $c LIKE 'http%' THEN 1 ELSE 0 END) AS withUrl FROM $db.innovator.VAULT")
            Add-SpikeFact 'vaultItem' ([ordered]@{ column = $col[0].name; rows = [int]$vault[0].n; rowsWithAbsoluteUrl = [int]$vault[0].withUrl })
        } catch { Add-SpikeFact 'vaultItem' "query failed: $($_.Exception.Message)" }
        # Every string column of the innovator schema: rows naming localhost, and rows holding an absolute http(s) URL. Counts only.
        $cols = Invoke-SpikeSql -Connection $ctx.sa -Query ("SELECT t.name AS tbl, c.name AS col FROM $db.sys.columns c JOIN $db.sys.tables t ON t.object_id = c.object_id JOIN $db.sys.schemas s ON s.schema_id = t.schema_id JOIN $db.sys.types ty ON ty.user_type_id = c.user_type_id WHERE s.name = N'innovator' AND ty.name IN (N'nvarchar', N'varchar', N'ntext', N'text') AND (c.max_length = -1 OR c.max_length >= 32 OR ty.name IN (N'ntext', N'text'))")
        $hits = New-Object System.Collections.ArrayList
        $scanned = 0
        foreach ($group in ($cols | Group-Object -Property tbl)) {
            $parts = @()
            $i = 0
            foreach ($r in $group.Group) {
                $q = Format-SpikeSqlIdent $r.col
                $parts += "SUM(CASE WHEN $q LIKE N'%localhost%' THEN 1 ELSE 0 END) AS l$i, SUM(CASE WHEN $q LIKE N'%http://%' OR $q LIKE N'%https://%' THEN 1 ELSE 0 END) AS u$i"
                $i++
            }
            try { $row = (Invoke-SpikeSql -Connection $ctx.sa -Query ("SELECT " + ($parts -join ', ') + " FROM $db.innovator." + (Format-SpikeSqlIdent $group.Name)))[0] }
            catch { [void]$hits.Add([ordered]@{ table = $group.Name; error = $_.Exception.Message }); continue }
            $i = 0
            foreach ($r in $group.Group) {
                $scanned++
                $l = [int]$row.("l$i")
                $u = [int]$row.("u$i")
                if ($l -gt 0 -or $u -gt 0) { [void]$hits.Add([ordered]@{ table = $group.Name; column = $r.col; localhostRows = $l; absoluteUrlRows = $u }) }
                $i++
            }
        }
        Add-SpikeFact 'urlScan' ([ordered]@{ columnsScanned = $scanned; columnsWithHits = @($hits) })
        try {
            Invoke-SpikeSql -Connection $ctx.sa -Query ("USE $db; EXEC sys.sp_addextendedproperty @name = N'arashouse.state', @value = N'clean'; EXEC sys.sp_addextendedproperty @name = N'arashouse.golden_hash', @value = N'spike'") | Out-Null
            $ep = Invoke-SpikeSql -Connection $ctx.sa -Query ("SELECT COUNT(*) AS n FROM $db.sys.extended_properties WHERE class = 0 AND name LIKE N'arashouse.%'")
            Add-SpikeFact 'markerWrittenAfterRestore' ([int]$ep[0].n -eq 2)
        } catch [Data.SqlClient.SqlException] { Add-SpikeFact 'markerWrittenAfterRestore' $false }
    }

    function Get-Md5Hex([securestring]$secure, [switch]$Upper) {
        $plain = ConvertTo-SpikePlainText $secure
        try {
            $md5 = [Security.Cryptography.MD5]::Create()
            $hex = -join ($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($plain)) | ForEach-Object { $_.ToString('x2') })
        } finally { $plain = $null }
        if ($Upper) { return $hex.ToUpperInvariant() }
        return $hex
    }

    function Get-StoredPassword([string]$login) {
        # The stored value stays in memory only, to compare and to describe; it is never written out.
        $r = @(Invoke-SpikeSql -Connection $ctx.sa -Query ("SELECT password AS p, logon_enabled AS e FROM " + (Format-SpikeSqlIdent $slotDb) + ".innovator.[USER] WHERE login_name = @l") -Parameters @{ '@l' = $login })
        if ($r.Count -eq 0) { return $null }
        return $r[0]
    }

    function Get-PasswordShape($stored) {
        if (-not $stored -or -not $stored.p) { return 'absent' }
        $v = [string]$stored.p
        $case = if ($v -cmatch '^[0-9A-F]+$') { 'upper' } elseif ($v -cmatch '^[0-9a-f]+$') { 'lower' } else { 'mixed-or-other' }
        return [ordered]@{ length = $v.Length; hex = ($v -match '^[0-9A-Fa-f]+$'); case = $case; hasSeparator = ($v -match '[$:.]'); logonEnabled = $stored.e }
    }

    function Compare-StoredToMd5($stored, [securestring]$secure) {
        if (-not $stored -or -not $stored.p) { return 'absent' }
        $v = [string]$stored.p
        if ($v -ceq (Get-Md5Hex $secure -Upper)) { return 'md5-upper' }
        if ($v -ceq (Get-Md5Hex $secure)) { return 'md5-lower' }
        return 'other'
    }

    function Invoke-ArasEdit([securestring]$token, [string]$login, [securestring]$newPassword) {
        # AML edit of one User's password through the slot's own server, as the IOM clients do (the password is sent as its MD5 hex).
        $hex = Get-Md5Hex $newPassword
        $aml = '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body><ApplyItem>' +
            ('<Item type="User" action="edit" where="[User].login_name=''{0}''"><password>{1}</password></Item>' -f $login, $hex) +
            '</ApplyItem></SOAP-ENV:Body></SOAP-ENV:Envelope>'
        $hex = $null
        $plainToken = ConvertTo-SpikePlainText $token
        $text = ''
        try {
            $req = [Net.HttpWebRequest]::Create("http://localhost/$slotAlias/Server/InnovatorServer.aspx")
            $req.Method = 'POST'
            $req.ContentType = 'text/xml; charset=utf-8'
            $req.Headers.Add('SOAPAction', 'ApplyItem')
            $req.Headers.Add('Authorization', "Bearer $plainToken")
            $req.Timeout = 120000
            $bytes = [Text.Encoding]::UTF8.GetBytes($aml)
            $aml = $null
            $stream = $req.GetRequestStream()
            try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
            try { $res = $req.GetResponse() }
            catch [Net.WebException] {
                $res = $_.Exception.Response
                if (-not $res) { return [ordered]@{ ok = $false; httpStatus = 0; fault = $_.Exception.Message } }
            }
            $status = [int]$res.StatusCode
            try { $text = (New-Object IO.StreamReader($res.GetResponseStream())).ReadToEnd() } finally { $res.Close() }
        } finally { $plainToken = $null }
        if ($text -match '<faultstring>([^<]{0,160})') { return [ordered]@{ ok = $false; httpStatus = $status; fault = $Matches[1] } }
        return [ordered]@{ ok = ($text -match '<Result'); httpStatus = $status; fault = $null }
    }

    function Test-Login([string]$login, [securestring]$password) {
        $ok = Test-SpikeArasLogin -Alias $slotAlias -DatabaseId $ctx.dbId -ArasPassword $password -User $login
        return [ordered]@{ ok = $ok; refusal = $script:SpikeLastLoginError }
    }

    Invoke-SpikeStep "per-lease passwords on the slot database $slotDb (random values, never shown): the stored format of root and admin; route 1, an AML edit as root through the slot's server; route 2, a direct UPDATE of admin's [USER].password (MD5 hex, upper then lower case); each checked by logging in" {
        $ctx.dbId = Get-SpikeDbId -ConfigPath (Find-SpikeFile -Root $slotTree -Name 'InnovatorServerConfig.xml')
        $shipped = Get-SpikeArasPassword
        $shapes = [ordered]@{}
        foreach ($u in @('root', 'admin')) {
            $stored = Get-StoredPassword $u
            $shapes[$u] = [ordered]@{ shape = (Get-PasswordShape $stored); equalsMd5OfShippedPassword = (Compare-StoredToMd5 $stored $shipped) }
        }
        Add-SpikeFact 'storedPasswordBefore' $shapes

        $api = [ordered]@{}
        $rootToken = Get-SpikeArasToken -Alias $slotAlias -DatabaseId $ctx.dbId -ArasPassword $shipped
        $api.rootLoginWithShippedPassword = [ordered]@{ ok = [bool]$rootToken; refusal = $script:SpikeLastLoginError }
        if ($rootToken) {
            # admin first: the edit of root's own password comes last, with the same token.
            foreach ($u in @('admin', 'root')) {
                $pw = New-SpikePassword
                $edit = Invoke-ArasEdit $rootToken $u $pw
                $stored = Get-StoredPassword $u
                $api[$u] = [ordered]@{ edit = $edit; storedAfter = (Get-PasswordShape $stored); storedEqualsMd5 = (Compare-StoredToMd5 $stored $pw); login = (Test-Login $u $pw) }
            }
        }
        Add-SpikeFact 'passwordRouteApi' $api

        $sqlRoute = [ordered]@{}
        foreach ($variant in @('upper', 'lower')) {
            $pw = New-SpikePassword
            $hex = Get-Md5Hex $pw -Upper:($variant -eq 'upper')
            $r = Invoke-SpikeSql -Connection $ctx.sa -Query ("UPDATE " + (Format-SpikeSqlIdent $slotDb) + ".innovator.[USER] SET password = @p WHERE login_name = N'admin'; SELECT @@ROWCOUNT AS n") -Parameters @{ '@p' = $hex }
            $hex = $null
            $row = [ordered]@{ rowsUpdated = [int]$r[0].n; loginWithoutRecycle = (Test-Login 'admin' $pw) }
            if (-not $row.loginWithoutRecycle.ok) {
                Restart-SpikePools -Alias $slotAlias
                $row.loginAfterRecycle = (Test-Login 'admin' $pw)
            }
            $sqlRoute["md5$variant"] = $row
        }
        Add-SpikeFact 'passwordRouteSql' $sqlRoute
    }

    if ($ctx.sa) { $ctx.sa.Dispose() }
    Complete-Spike
} catch {
    Exit-SpikeFailure $_.Exception.Message
}
