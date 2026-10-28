# audit-sql.ps1 (ticket 50, docs/audit.md): the SQL half of the host audit. Run by a SQL Server sysadmin's Windows login
# (on this host the captain's login, which the worker's shell carries without elevation); every check runs as the broker's
# login or a slot login through EXECUTE AS LOGIN, on a connection of its own, over shared memory.
#
# It never names, lists or connects to a database outside arashouse's own: what the captain's databases are is asked only
# as counts filtered by owner or access. In place of OLM_Local it makes a throw-away database, arashouse_35_98 (slot 98 of
# the last flavor, which no pool uses), owned by the caller and not by the broker, so it stands for "a database the
# broker does not own"; it refuses to start when that name exists, and drops it at the end whatever happens.
# Prints one "<check>: <result>" line each; a result is the value read or the SQL error number the attempt failed with.
# No secret is read, made or printed. Plain ASCII, Windows PowerShell 5.1.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File audit-sql.ps1
#
# Exit: 0 every check as expected; 1 a check found something else (its line says "UNEXPECTED"); 2 a precondition.
$ErrorActionPreference = 'Stop'
$Broker = 'NT SERVICE\ArasHouseBroker'
$Foreign = 'arashouse_35_98'
$Connection = 'Data Source=lpc:.;Integrated Security=SSPI;Initial Catalog=master;Connect Timeout=15;Pooling=false;Application Name=arashouse-audit-50'
$script:Unexpected = 0

function Invoke-Sql([string]$Sql, [hashtable]$Params = @{}, [string]$As = $null) {
    $cn = New-Object Data.SqlClient.SqlConnection($Connection)
    $cn.Open()
    try {
        if ($As) {
            $ex = $cn.CreateCommand(); $ex.CommandText = 'EXECUTE AS LOGIN = @as;'; [void]$ex.Parameters.AddWithValue('@as', $As); [void]$ex.ExecuteNonQuery()
        }
        $cmd = $cn.CreateCommand(); $cmd.CommandText = $Sql; $cmd.CommandTimeout = 60
        foreach ($k in $Params.Keys) { [void]$cmd.Parameters.AddWithValue("@$k", $Params[$k]) }
        $v = $cmd.ExecuteScalar()
        return @{ ok = $true; value = $v }
    } catch [Data.SqlClient.SqlException] {
        return @{ ok = $false; number = $_.Exception.Number; message = $_.Exception.Message }
    } finally { $cn.Dispose() }
}

function Say([string]$Check, [string]$Result, [bool]$Expected) {
    if (-not $Expected) { $script:Unexpected++; $Result = "UNEXPECTED $Result" }
    [Console]::Out.WriteLine("${Check}: $Result")
}

function Expect-Value([string]$Check, $Expected, [string]$Sql, [hashtable]$Params = @{}, [string]$As = $null) {
    $r = Invoke-Sql $Sql $Params $As
    if ($r.ok) { Say $Check "$($r.value)" ("$($r.value)" -eq "$Expected") } else { Say $Check "error $($r.number)" $false }
}

function Expect-Error([string]$Check, [int[]]$Numbers, [string]$Sql, [hashtable]$Params = @{}, [string]$As = $Broker) {
    $r = Invoke-Sql $Sql $Params $As
    if ($r.ok) { Say $Check "succeeded ($($r.value))" $false } else { Say $Check "refused, error $($r.number)" ($Numbers -contains $r.number) }
}

$who = Invoke-Sql "SELECT IS_SRVROLEMEMBER('sysadmin')"
if (-not $who.ok -or "$($who.value)" -ne '1') { [Console]::Error.WriteLine('error: run it as a SQL Server sysadmin (Windows authentication)'); exit 2 }
if ("$((Invoke-Sql 'SELECT COUNT(*) FROM sys.server_principals WHERE name = @l' @{ l = $Broker }).value)" -ne '1') { [Console]::Error.WriteLine("error: $Broker has no login"); exit 2 }
if ("$((Invoke-Sql 'SELECT COUNT(*) FROM sys.databases WHERE name = @d' @{ d = $Foreign }).value)" -ne '0') { [Console]::Error.WriteLine("error: $Foreign exists; this script makes it and will not touch one it did not make"); exit 2 }

$made = $false
try {
    $c = Invoke-Sql "CREATE DATABASE [$Foreign];"
    if (-not $c.ok) { [Console]::Error.WriteLine("error: could not make ${Foreign}: $($c.number)"); exit 2 }
    $made = $true
    Expect-Value "$Foreign is owned by the caller, not the broker" 0 'SELECT COUNT(*) FROM sys.databases WHERE name = @d AND owner_sid = SUSER_SID(@b)' @{ d = $Foreign; b = $Broker }

    # ---- the broker's login: roles, rights and reach -------------------------------------------------------------------
    foreach ($role in @('sysadmin', 'securityadmin', 'serveradmin', 'setupadmin', 'processadmin', 'diskadmin', 'dbcreator', 'bulkadmin')) {
        Expect-Value "broker in $role" 0 "SELECT IS_SRVROLEMEMBER(N'$role')" @{} $Broker
    }
    foreach ($perm in @('CONTROL SERVER', 'CREATE ANY DATABASE', 'ALTER ANY DATABASE', 'ALTER ANY LOGIN', 'ALTER ANY LINKED SERVER', 'ALTER ANY CONNECTION', 'ADMINISTER BULK OPERATIONS', 'IMPERSONATE ANY LOGIN', 'CONNECT ANY DATABASE', 'ALTER SETTINGS', 'ALTER ANY CREDENTIAL', 'EXTERNAL ACCESS ASSEMBLY', 'UNSAFE ASSEMBLY', 'VIEW SERVER STATE', 'ALTER SERVER STATE')) {
        Expect-Value "broker holds $perm" 0 'SELECT HAS_PERMS_BY_NAME(NULL, NULL, @p)' @{ p = $perm } $Broker
    }
    Expect-Value 'databases outside arashouse_* the broker can open' 0 "SELECT COUNT(*) FROM sys.databases WHERE database_id > 4 AND name NOT LIKE N'arashouse[_]%' AND HAS_DBACCESS(name) = 1" @{} $Broker
    Expect-Value 'databases outside arashouse_* the broker owns' 0 "SELECT COUNT(*) FROM sys.databases WHERE owner_sid = SUSER_SID() AND name NOT LIKE N'arashouse[_]%'" @{} $Broker
    Expect-Value "the broker can open $Foreign" 0 'SELECT HAS_DBACCESS(@d)' @{ d = $Foreign } $Broker

    # ---- restore over a database it does not own, and over a name that does not exist ---------------------------------
    $none = 'C:\aras_installations\staging\audit-50\none.bak'
    Expect-Error "RESTORE over $Foreign (exists, not the broker's)" @(3110, 262, 3013) "RESTORE DATABASE [$Foreign] FROM DISK = @f WITH REPLACE;" @{ f = $none }
    Expect-Error 'RESTORE of a made-up name outside arashouse_*' @(262, 3013, 1802) 'RESTORE DATABASE [audit_madeup_50] FROM DISK = @f;' @{ f = $none }
    Expect-Error "ALTER DATABASE $Foreign SET OFFLINE" @(5011, 916, 15151, 300) "ALTER DATABASE [$Foreign] SET OFFLINE;"
    Expect-Error "DROP DATABASE $Foreign" @(3701, 916, 15151) "DROP DATABASE [$Foreign];"
    Expect-Error "BACKUP DATABASE $Foreign" @(262, 3013, 916, 3110) "BACKUP DATABASE [$Foreign] TO DISK = @f WITH COPY_ONLY;" @{ f = 'C:\aras_installations\staging\audit-50\out.bak' }

    # ---- the procedures: a foreign-owned slot-shaped name (50002) and deny-shaped made-up names (50001) ---------------
    foreach ($p in @('create_slot_database', 'drop_slot_database', 'kill_connections', 'adopt_slot_database')) {
        Expect-Error "$p on $Foreign" @(50002) "DECLARE @r int; EXEC @r = arashouse_admin.dbo.$p @database = @d; SELECT @r;" @{ d = $Foreign }
    }
    $names = @('OLM_Local_audit_madeup', 'olm', 'arashouse_olm_01', 'InnovatorSolutions_audit_madeup', 'arashouse_12sp9_01; DROP DATABASE x; --', "arashouse_12sp9_0$([char]0xFF11)", "arashouse_12$([char]0x0455)p9_01", 'ARASHOUSE_12SP9_01', 'arashouse_12sp9_01.', '[arashouse_12sp9_01]')
    foreach ($n in $names) {
        foreach ($p in @('create_slot_database', 'drop_slot_database', 'kill_connections', 'adopt_slot_database')) {
            Expect-Error "$p on a deny-shaped name" @(50001) "DECLARE @r int; EXEC @r = arashouse_admin.dbo.$p @database = @d; SELECT @r;" @{ d = $n }
        }
        Expect-Error 'drop_slot_login on a deny-shaped name' @(50001) 'DECLARE @r int; EXEC @r = arashouse_admin.dbo.drop_slot_login @login = @l; SELECT @r;' @{ l = $n }
    }
    $hex = 'a' * 32
    foreach ($f in @('C:\audit_madeup_50\x.bak', "\\localhost\c$\aras_installations\staging\$hex\restore.bak", "\\?\C:\aras_installations\staging\$hex\restore.bak", "C:\aras_installations\staging\$hex\..\..\secrets\restore.bak", "C:\aras_installations\staging\$hex\RESTOR~1.BAK", "c:\aras_installations\staging\$hex\restore.bak")) {
        Expect-Error 'read_staged_backup on a path outside staging\<lease>\restore.bak' @(50001) 'EXEC arashouse_admin.dbo.read_staged_backup @file = @f;' @{ f = $f }
    }

    # ---- xp_cmdshell, linked servers, ad hoc queries -------------------------------------------------------------------
    Expect-Value 'xp_cmdshell enabled on the server' 0 "SELECT CAST(value_in_use AS int) FROM sys.configurations WHERE name = N'xp_cmdshell'"
    Expect-Value 'ad hoc distributed queries enabled on the server' 0 "SELECT CAST(value_in_use AS int) FROM sys.configurations WHERE name = N'Ad Hoc Distributed Queries'"
    Expect-Error 'broker runs xp_cmdshell' @(229, 15281) "EXEC master.sys.xp_cmdshell N'rem';"
    Expect-Error 'broker adds a linked server' @(15247, 229) "EXEC master.dbo.sp_addlinkedserver @server = N'arashouse_audit_link', @srvproduct = N'', @provider = N'SQLNCLI', @datasrc = N'.';"
    Expect-Error 'broker runs OPENROWSET' @(15281, 229, 7415, 15247) "SELECT COUNT(*) FROM OPENROWSET('SQLNCLI', 'Server=.;Trusted_Connection=yes;', 'SELECT 1 AS x') AS a;"
    Expect-Value 'linked servers the broker can use' 0 'SELECT COUNT(*) FROM sys.servers WHERE is_linked = 1' @{} $Broker
    Expect-Value 'public holds more than VIEW ANY DATABASE and endpoint CONNECT' 0 "SELECT COUNT(*) FROM sys.server_permissions WHERE grantee_principal_id = 2 AND NOT (permission_name = N'VIEW ANY DATABASE' AND class = 100) AND class <> 105"

    # ---- every slot login: no role, no server right, no database but its own ------------------------------------------
    $logins = @()
    $cn = New-Object Data.SqlClient.SqlConnection($Connection); $cn.Open()
    try {
        $cmd = $cn.CreateCommand(); $cmd.CommandText = "SELECT name FROM sys.server_principals WHERE type = 'S' AND name COLLATE Latin1_General_BIN2 LIKE N'arashouse[_]%[_][0-9][0-9][_]%' ORDER BY name"
        $rd = $cmd.ExecuteReader(); while ($rd.Read()) { $logins += $rd.GetString(0) }; $rd.Close()
    } finally { $cn.Dispose() }
    [Console]::Out.WriteLine("slot logins found: $($logins.Count)")
    # 12sp9-01 is a long-term lease that this audit leaves alone (firstmate's host notes, 2026-10-28).
    foreach ($l in @($logins | Where-Object { $_ -notlike 'arashouse_12sp9_01_*' })) {
        $own = ($l -replace '_(dbo|reg)$', '')
        Expect-Value "$l server roles" 0 "SELECT IS_SRVROLEMEMBER(N'sysadmin') + IS_SRVROLEMEMBER(N'dbcreator') + IS_SRVROLEMEMBER(N'securityadmin') + IS_SRVROLEMEMBER(N'serveradmin') + IS_SRVROLEMEMBER(N'bulkadmin')" @{} $l
        Expect-Value "$l server rights" 0 "SELECT HAS_PERMS_BY_NAME(NULL, NULL, N'CONTROL SERVER') + HAS_PERMS_BY_NAME(NULL, NULL, N'CONNECT ANY DATABASE') + HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY LINKED SERVER') + HAS_PERMS_BY_NAME(NULL, NULL, N'ADMINISTER BULK OPERATIONS') + HAS_PERMS_BY_NAME(NULL, NULL, N'CREATE ANY DATABASE')" @{} $l
        Expect-Value "$l opens databases other than its slot's" 0 "SELECT COUNT(*) FROM sys.databases WHERE database_id > 4 AND name <> @own AND HAS_DBACCESS(name) = 1" @{ own = $own } $l
    }
} finally {
    if ($made) {
        $d = Invoke-Sql "IF DB_ID(@d) IS NOT NULL DROP DATABASE [$Foreign]; SELECT COUNT(*) FROM sys.databases WHERE name = @d;" @{ d = $Foreign }
        [Console]::Out.WriteLine("$Foreign dropped: $(if ($d.ok -and "$($d.value)" -eq '0') { 'yes' } else { "NO ($($d.number))" })")
    }
}
if ($script:Unexpected -gt 0) { exit 1 }
exit 0
