# SQL restore permission model: can a login that owns only a spike database (no dbcreator, no sysadmin) restore over it WITH REPLACE,
# does the owner survive, and if not, does a stored procedure with EXECUTE AS OWNER in a utility database do it? Also the fix-ups after
# a restore (orphaned users, absolute URLs, root password, an extended-property marker) and whether the SQL service account can read a
# backup from staging\ and from a golden-style folder. Dry run by default; -Apply makes changes (elevated, sa prompt). Windows PowerShell 5.1.
# Only spike databases and spike logins are touched. Results are booleans, error numbers and seconds.
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
    $ctx = @{ sa = $null; sqlPassword = $null; poolPw = $null; bak = $BakPath }

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
        $ctx.sa = if ($SqlAuth -eq 'Sa') { New-SpikeSqlConnection -Auth Sa -Password $ctx.sqlPassword } else { New-SpikeSqlConnection -Auth Windows }
        Add-SpikeFact 'sqlServiceAccount' (Get-SpikeSqlServiceAccount)
        if (-not $ctx.bak) { $ctx.bak = (Get-ChildItem -LiteralPath $golden -Recurse -Filter 'CoreAndSolutions*.bak' -File | Select-Object -First 1).FullName }
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

    Invoke-SpikeStep "(c) fallback: utility database $adminDb with a stored procedure WITH EXECUTE AS OWNER (TRUSTWORTHY ON for the spike; module signing is the production alternative), name allowlist inside; $PoolLogin gets EXECUTE only" {
        Invoke-SpikeSql -Connection $ctx.sa -Query ("CREATE DATABASE " + (Format-SpikeSqlIdent $adminDb)) | Out-Null
        Invoke-SpikeSql -Connection $ctx.sa -Query ("ALTER DATABASE " + (Format-SpikeSqlIdent $adminDb) + " SET TRUSTWORTHY ON") | Out-Null
        $adm = New-SpikeSqlConnection -Catalog $adminDb -Auth Sa -Password $ctx.sqlPassword
        if ($SqlAuth -eq 'Windows') { $adm.Dispose(); $adm = New-SpikeSqlConnection -Catalog $adminDb -Auth Windows }
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
            $vault = Invoke-SpikeSql -Connection $ctx.sa -Query ("SELECT COUNT(*) AS n, SUM(CASE WHEN vault_url LIKE 'http%' THEN 1 ELSE 0 END) AS withUrl FROM $db.innovator.VAULT")
            Add-SpikeFact 'vaultItem' ([ordered]@{ rows = [int]$vault[0].n; rowsWithAbsoluteUrl = [int]$vault[0].withUrl })
        } catch [Data.SqlClient.SqlException] { Add-SpikeFact 'vaultItem' "query failed: error $($_.Exception.Number); the table or column name differs in this flavor" }
        try {
            Invoke-SpikeSql -Connection $ctx.sa -Query ("USE $db; EXEC sys.sp_addextendedproperty @name = N'arashouse.state', @value = N'clean'; EXEC sys.sp_addextendedproperty @name = N'arashouse.golden_hash', @value = N'spike'") | Out-Null
            $ep = Invoke-SpikeSql -Connection $ctx.sa -Query ("SELECT COUNT(*) AS n FROM $db.sys.extended_properties WHERE class = 0 AND name LIKE N'arashouse.%'")
            Add-SpikeFact 'markerWrittenAfterRestore' ([int]$ep[0].n -eq 2)
        } catch [Data.SqlClient.SqlException] { Add-SpikeFact 'markerWrittenAfterRestore' $false }
    }

    Invoke-SpikeStep "set a new Aras password for root on the slot database $slotDb (a random value, never shown), recycle the slot, and log in with it (does the per-lease password route work?)" {
        $db = Format-SpikeSqlIdent $slotDb
        $newPw = New-SpikePassword
        $plain = ConvertTo-SpikePlainText $newPw
        try {
            $md5 = [Security.Cryptography.MD5]::Create()
            $hex = -join ($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($plain)) | ForEach-Object { $_.ToString('x2') })
        } finally { $plain = $null }
        $updated = 0
        try {
            $r = Invoke-SpikeSql -Connection $ctx.sa -Query ("UPDATE $db.innovator.[USER] SET password = @p WHERE login_name = N'root'; SELECT @@ROWCOUNT AS n") -Parameters @{ '@p' = $hex }
            $updated = [int]$r[0].n
        } catch [Data.SqlClient.SqlException] { Add-SpikeFact 'rootPasswordRoute' "update failed: error $($_.Exception.Number); table or column names differ" }
        $hex = $null
        if ($updated -eq 1) {
            Restart-SpikePools -Alias $slotAlias
            $cfg = Find-SpikeFile -Root $slotTree -Name 'InnovatorServerConfig.xml'
            $id = Get-SpikeDbId -ConfigPath $cfg
            Add-SpikeFact 'rootPasswordRoute' ([ordered]@{ rowsUpdated = $updated; loginWithNewPassword = (Test-SpikeArasLogin -Alias $slotAlias -DatabaseId $id -ArasPassword $newPw) })
        }
    }

    if ($ctx.sa) { $ctx.sa.Dispose() }
    Complete-Spike
} catch {
    Exit-SpikeFailure $_.Exception.Message
}
