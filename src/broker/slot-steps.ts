// `slot-steps.ps1`: the broker's Windows operations on one slot (ticket 25) that Node cannot do
// itself: IIS through Microsoft.Web.Administration, the agent service, SQL Server on shared memory
// through the `arashouse_admin` procedures (ticket 22), robocopy, icacls and machine-scope DPAPI for
// the slot's stored secrets. slot-system.ts writes it to `<root>\broker\slot-steps.ps1` and runs one
// step per process:
//
//   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File slot-steps.ps1 -Step <step>
//
// with a JSON request on stdin (`{ "flavor": "12sp9", "slot": 1 }`; the slot's SQL login passwords
// travel only there, only to the `database` step, and a stored secret only to `secret-put`) and one
// `@@arashouse@@ <json>` line on stdout. Like baseline-steps.ps1 it takes no name or path from the
// request: it derives every one from the flavor and the slot number, with the rules of
// src/core/names.ts, and refuses a flavor that is not registered or a number outside 1 to 99.

import { FLAVORS, FLAVOR_KEYS } from "../core/flavors.js";
import { DENIED_INSTALL_ROOTS, DENIED_SERVICE_PREFIXES, assertValidRoot } from "../core/guards.js";
import { SHIPPED_DATABASE_USERS } from "../core/baseline.js";
import {
  AGENT_PORT_BASE,
  APP_POOL_ROLES,
  DEFAULT_INSTALL_ROOT,
  MSI_DEFAULT_AGENT_PORT,
  SLOT_POOL_IDLE_MINUTES,
  STAMP_FILE_NAME,
  agentServiceName,
  databaseFiles,
  databaseName,
  goldenDir,
  slotDir,
  slotLoginSecretName,
  vaultDir,
  webAlias,
} from "../core/names.js";
import { psQuote } from "../core/setup-host.js";
import { RESULT_MARKER } from "./baseline-steps.js";
import { PS_DENY_LIST_PRINTS, PS_IIS, PS_PATHS_AND_PRINTS, psSql } from "./ps-common.js";

/** The steps the script answers. */
export const SLOT_STEPS = [
  "snapshot",
  "present",
  "folders",
  "mirror",
  "iis",
  "agent",
  "database",
  "stop",
  "remove-agent",
  "remove-database",
  "remove-iis",
  "secret-put",
  "secret-get",
  "secret-delete",
] as const;
export type SlotStep = (typeof SLOT_STEPS)[number];

/** The steps that act on a stored secret by name rather than on a slot. */
export const SECRET_STEPS: readonly SlotStep[] = ["secret-put", "secret-get", "secret-delete"];

/** The MSI's agent port and its two neighbours, taken on the host (design 3.2); no slot agent may listen there. */
export const RESERVED_AGENT_PORTS: readonly number[] = [MSI_DEFAULT_AGENT_PORT, MSI_DEFAULT_AGENT_PORT + 1, MSI_DEFAULT_AGENT_PORT + 2];

/** Fails at generation time if a rule the script repeats has drifted from names.ts. */
function checkNameRules(root: string): void {
  const ref = { flavor: FLAVOR_KEYS[0], slot: 7 } as const;
  const checks: [string, string][] = [
    [webAlias(ref), `ah-${ref.flavor}-07`],
    [databaseName(ref), `arashouse_${ref.flavor}_07`],
    [agentServiceName(ref), `ArasHouseAgent_${ref.flavor}_07`],
    [slotDir(ref, root), `${root}\\slots\\${ref.flavor}\\07`],
    [vaultDir(ref, root), `${root}\\vaults\\${ref.flavor}-07`],
    [goldenDir(ref.flavor, root), `${root}\\golden\\${ref.flavor}`],
    [databaseFiles(databaseName(ref), root).data, `${root}\\sqldata\\arashouse_${ref.flavor}_07.mdf`],
    [databaseFiles(databaseName(ref), root).log, `${root}\\sqldata\\arashouse_${ref.flavor}_07_log.ldf`],
    [slotLoginSecretName(ref, "dbo"), `slot-${ref.flavor}-07-dbo`],
  ];
  for (const [derived, scripted] of checks) {
    if (derived !== scripted) throw new Error(`a name rule changed (${derived}); update slot-steps.ts with names.ts`);
  }
}

export function renderSlotStepsScript(root: string = DEFAULT_INSTALL_ROOT): string {
  const r = assertValidRoot(root);
  checkNameRules(r);
  const list = (items: readonly (string | number)[]) => `@(${items.map((i) => (typeof i === "number" ? String(i) : psQuote(i))).join(", ")})`;
  const backupFiles = FLAVOR_KEYS.map(
    (key) => `    ${psQuote(key)} = @{ data = ${psQuote(FLAVORS[key].backupFiles.data)}; log = ${psQuote(FLAVORS[key].backupFiles.log)} }`,
  ).join("\n");

  return `# slot-steps.ps1: the broker's Windows operations on a slot (ticket 25, docs/provision.md). Generated; do not edit.
# Started by the broker (Node, NT SERVICE\\ArasHouseBroker) once per step: -Step <name>, a JSON request on stdin, one result line on stdout.
# It derives every name and path from the flavor and the slot number; nothing in the request names a path. Windows PowerShell 5.1.
param([Parameter(Mandatory = $true)][string]$Step)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = ${psQuote(r)}
$FlavorKeys = ${list(FLAVOR_KEYS)}
$PoolRoles = ${list(APP_POOL_ROLES)}
$IdleMinutes = ${SLOT_POOL_IDLE_MINUTES}
$AgentPortBase = ${AGENT_PORT_BASE}
$ReservedPorts = ${list(RESERVED_AGENT_PORTS)}
$StampName = ${psQuote(STAMP_FILE_NAME)}
$BackupFiles = @{
${backupFiles}
}
$ShippedUsers = [ordered]@{ dbo = ${psQuote(SHIPPED_DATABASE_USERS.dbo)}; reg = ${psQuote(SHIPPED_DATABASE_USERS.reg)} }
$PoolIdentities = @('ApplicationPoolIdentity', 'NetworkService', 'LocalService')
$DeniedRoots = ${list(DENIED_INSTALL_ROOTS)}
$DeniedServicePrefixes = ${list(DENIED_SERVICE_PREFIXES)}

function Stop-Step([string]$Message) { [Console]::Error.WriteLine("error: $Message"); exit 1 }
function Write-Result($Value) { [Console]::Out.WriteLine(${psQuote(RESULT_MARKER)} + (ConvertTo-Json -InputObject $Value -Depth 8 -Compress)) }

$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if (${list(SLOT_STEPS)} -cnotcontains $Step) { Stop-Step "no step '$Step'" }

if (${list(SECRET_STEPS)} -ccontains $Step) {
    $SecretName = [string]$request.name
    if ($SecretName -cnotmatch '^[a-z0-9][a-z0-9-]{0,63}$') { Stop-Step 'the request names no usable secret' }
    $SecretFile = Join-Path $Root "secrets\\$SecretName.bin"
} elseif ($Step -ne 'snapshot') {
    # The names, as src/core/names.ts derives them.
    $Flavor = [string]$request.flavor
    if ($FlavorKeys -cnotcontains $Flavor) { Stop-Step 'the request names no registered flavor' }
    $raw = $request.slot
    if (-not (($raw -is [int]) -or ($raw -is [long])) -or $raw -lt 1 -or $raw -gt 99) { Stop-Step 'the request names no slot number from 1 to 99' }
    $Number = [int]$raw
    $NN = '{0:D2}' -f $Number
    $Alias = "ah-$Flavor-$NN"
    $Database = "arashouse_$($Flavor)_$NN"
    $LoginDbo = "$($Database)_dbo"
    $LoginReg = "$($Database)_reg"
    $Service = "ArasHouseAgent_$($Flavor)_$NN"
    $AgentPort = $AgentPortBase + 100 * [array]::IndexOf($FlavorKeys, $Flavor) + $Number
    $Pools = @($PoolRoles | ForEach-Object { "$Alias-$_" })
    $SlotDir = Join-Path $Root "slots\\$Flavor\\$NN"
    $VaultDir = Join-Path $Root "vaults\\$Flavor-$NN"
    $Golden = Join-Path $Root "golden\\$Flavor"
    $SqlData = Join-Path $Root 'sqldata'
    $DataFile = Join-Path $SqlData "$Database.mdf"
    $LogFile = Join-Path $SqlData "$($Database)_log.ldf"
    $SlotSecrets = @("slot-$Flavor-$NN-dbo", "slot-$Flavor-$NN-reg")
}

${PS_PATHS_AND_PRINTS}
${psSql("arashouse-broker")}

# ---- IIS ----
${PS_IIS}
${PS_DENY_LIST_PRINTS}
function Test-SlotApp([string]$Path) { return ($Path -ieq "/$Alias") -or $Path.StartsWith("/$Alias/", [StringComparison]::OrdinalIgnoreCase) }
function Test-Relative([string]$Path) {
    if ($Path -eq '') { return $true }
    if ([IO.Path]::IsPathRooted($Path) -or $Path.Contains(':') -or $Path.StartsWith('\\')) { return $false }
    return -not (@($Path.Split('\\') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0)
}
function Read-Golden([string]$Name) {
    $file = Join-Path $Golden $Name
    if (-not (Test-Path -LiteralPath $file)) { Stop-Step "$file does not exist (is the $Flavor baseline built?)" }
    $record = [IO.File]::ReadAllText($file) | ConvertFrom-Json
    if ($record.schema -ne 1) { Stop-Step "$file is not a schema 1 record" }
    return $record
}

# ---- what of the slot exists (names only) ----
function Get-Present {
    $present = @()
    foreach ($d in @($SlotDir, $VaultDir)) { if (Test-Path -LiteralPath $d) { $present += $d } }
    $mgr = Get-Iis
    try {
        foreach ($s in $mgr.Sites) { foreach ($app in $s.Applications) { if (Test-SlotApp $app.Path) { $present += "IIS application $($s.Name)$($app.Path)" } } }
        foreach ($p in $Pools) { if ($mgr.ApplicationPools[$p]) { $present += "IIS pool $p" } }
    } finally { $mgr.Dispose() }
    if (Get-Service -Name $Service -ErrorAction SilentlyContinue) { $present += "service $Service" }
    $c = New-Sql
    try { if (@(Invoke-Sql $c 'SELECT name FROM sys.databases WHERE name = @n' @{ '@n' = $Database }).Count -gt 0) { $present += "database $Database" } } finally { $c.Dispose() }
    foreach ($name in $SlotSecrets) { $f = Join-Path $Root "secrets\\$name.bin"; if (Test-Path -LiteralPath $f) { $present += $f } }
    return @($present)
}

switch ($Step) {
    'snapshot' {
        # The deny-list fingerprints (names and hashes only), before a provision or destroy changes anything and again after it.
        Write-Result @{ prints = (Get-DenyListPrints) }
    }
    'present' {
        # The broker's login cannot see other logins, so the slot's two SQL logins are not in this list: remove-database reports them.
        Write-Result @{ present = @(Get-Present) }
    }
    'folders' {
        # The slot and vault folders. slots\\ and vaults\\ have a protected ACL that names no IIS account, and robocopy copies no ACL, so
        # IIS_IUSRS (every pool identity is a member) gets modify and anonymous requests (IUSR) read here, inherited by everything the
        # mirror then creates: OAuthServer\\App_Data's SQLite file included (docs/baselines.md, run 3).
        foreach ($d in @($SlotDir, $VaultDir)) {
            if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
            if ((Get-Item -LiteralPath $d -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Stop-Step "$d is a junction or link" }
        }
        & icacls.exe $SlotDir /grant '*S-1-5-32-568:(OI)(CI)M' '*S-1-5-17:(OI)(CI)RX' /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { Stop-Step "icacls could not grant on $SlotDir ($LASTEXITCODE)" }
        & icacls.exe $VaultDir /grant '*S-1-5-32-568:(OI)(CI)M' /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { Stop-Step "icacls could not grant on $VaultDir ($LASTEXITCODE)" }
        Write-Result @{ slotDir = $SlotDir; vaultDir = $VaultDir }
    }
    'mirror' {
        # The same mirror the reset uses (ticket 30): times kept, no junction followed, the slot stamp left alone.
        $tree = Join-Path $Golden 'tree'
        if (-not (Test-Path -LiteralPath $tree)) { Stop-Step "$tree does not exist (is the $Flavor baseline built?)" }
        & robocopy.exe $tree $SlotDir /MIR /XJ /R:2 /W:1 /MT:16 /XF $StampName /NFL /NDL /NJH /NJS /NP | Out-Null
        $rc = $LASTEXITCODE
        if ($rc -ge 8) { Stop-Step "robocopy failed ($rc)" }
        Write-Result @{ robocopy = $rc }
    }
    'iis' {
        # The applications and pools of the golden's iis.json (ticket 24), each application on a pool of the slot's own,
        # ah-<key>-<NN>-<role>, with the captured settings and a short idle timeout. Existing ones are brought to the template.
        $record = Read-Golden 'iis.json'
        # The idle timeout setup-host.ps1 -SlotIdleTimeoutMinutes recorded, if any (docs/setup.md); else the default.
        $idle = $IdleMinutes
        $setupRecord = Join-Path $Root 'broker\setup-host.json'
        if (Test-Path -LiteralPath $setupRecord) {
            $recorded = $null
            try { $recorded = ([IO.File]::ReadAllText($setupRecord) | ConvertFrom-Json).options.slotIdleTimeoutMinutes } catch { }
            if (($recorded -is [int] -or $recorded -is [long]) -and $recorded -ge 1 -and $recorded -le 1440) { $idle = [int]$recorded }
        }
        $apps = @($record.applications | Sort-Object { ([string]$_.subPath).Length })
        if ($apps.Count -eq 0 -or ([string]$apps[0].subPath) -ne '') { Stop-Step 'iis.json has no application for the alias itself' }
        foreach ($a in $apps) {
            if ($PoolRoles -cnotcontains [string]$a.role) { Stop-Step "iis.json names the role '$($a.role)', which is not one of the slot pool roles" }
            if ([string]$a.subPath -cnotmatch '^(/[A-Za-z0-9]+)?$') { Stop-Step "iis.json names the sub-path '$($a.subPath)'" }
            if (-not (Test-Relative ([string]$a.physicalPath))) { Stop-Step "iis.json names the physical path '$($a.physicalPath)'" }
            if ($PoolIdentities -notcontains [string]$a.pool.identityType) { Stop-Step "iis.json names the pool identity '$($a.pool.identityType)'" }
        }
        $mgr = Get-Iis
        try {
            $site = $mgr.Sites[[string]$record.site]
            if (-not $site) { Stop-Step "IIS has no site '$($record.site)'" }
            foreach ($a in $apps) {
                $poolName = "$Alias-$($a.role)"
                $pool = $mgr.ApplicationPools[$poolName]
                if (-not $pool) { $pool = $mgr.ApplicationPools.Add($poolName) }
                $pool.ManagedRuntimeVersion = [string]$a.pool.managedRuntimeVersion
                $pool.ManagedPipelineMode = [Microsoft.Web.Administration.ManagedPipelineMode]([string]$a.pool.pipelineMode)
                $pool.Enable32BitAppOnWin64 = [bool]$a.pool.enable32Bit
                $pool.ProcessModel.IdentityType = [Microsoft.Web.Administration.ProcessModelIdentityType]([string]$a.pool.identityType)
                $pool.ProcessModel.IdleTimeout = [TimeSpan]::FromMinutes($idle)
                $pool.StartMode = [Microsoft.Web.Administration.StartMode]([string]$a.pool.startMode)
                $path = "/$Alias" + [string]$a.subPath
                $physical = if ([string]$a.physicalPath) { Join-Path $SlotDir ([string]$a.physicalPath) } else { $SlotDir }
                $app = $site.Applications[$path]
                if (-not $app) { $app = $site.Applications.Add($path, $physical) } else { $app.VirtualDirectories['/'].PhysicalPath = $physical }
                $app.ApplicationPoolName = $poolName
            }
            $mgr.CommitChanges()
        } finally { $mgr.Dispose() }
        Write-Result @{ applications = $apps.Count; idleMinutes = $idle }
    }
    'agent' {
        # The agent service of the golden's service.json, if it has one, on the slot's reserved port, startup Manual, left stopped.
        $record = Read-Golden 'service.json'
        if (-not $record.installed) {
            Write-Result @{ installed = $false }
        } else {
            $rel = [string]$record.binaryPath
            if (-not $rel -or -not (Test-Relative $rel)) { Stop-Step "service.json names the binary '$rel', not a path inside the tree" }
            $bin = Join-Path $SlotDir $rel
            if (-not (Test-Path -LiteralPath $bin)) { Stop-Step "$bin does not exist" }
            if ($ReservedPorts -contains $AgentPort) { Stop-Step "the agent port $AgentPort is reserved" }
            $existing = Get-Service -Name $Service -ErrorAction SilentlyContinue
            if (-not $existing -and @(Get-NetTCPConnection -State Listen -LocalPort $AgentPort -ErrorAction SilentlyContinue).Count -gt 0) { Stop-Step "something already listens on the agent port $AgentPort" }
            if (-not $existing) { New-Service -Name $Service -BinaryPathName ('"' + $bin + '"') -StartupType Manual -DisplayName "ArasHouse agent $Flavor-$NN" | Out-Null }
            Write-Result @{ installed = $true; port = $AgentPort }
        }
    }
    'database' {
        # The slot database through the name-checked procedures (ticket 22): created empty and owned by the broker, then the golden's
        # ootb.bak restored over it by its owner, with its files moved to sqldata\\. The two logins get the passwords of the request only,
        # and the restored users innovator and innovator_regular are mapped to them (the CD's SQL scripts are not run).
        $bak = Join-Path $Golden 'db\\ootb.bak'
        if (-not (Test-Path -LiteralPath $bak)) { Stop-Step "$bak does not exist" }
        $dbo = [string]$request.secrets.dbo
        $reg = [string]$request.secrets.reg
        if ($dbo.Length -lt 16 -or $reg.Length -lt 16 -or $dbo.Contains(';') -or $reg.Contains(';')) { Stop-Step 'the request carries no usable login passwords' }
        $c = New-Sql
        try {
            Invoke-Sql $c 'EXEC arashouse_admin.dbo.create_slot_database @database = @d' @{ '@d' = $Database } | Out-Null
            Invoke-Sql $c 'EXEC arashouse_admin.dbo.kill_connections @database = @d' @{ '@d' = $Database } | Out-Null
            $files = $BackupFiles[$Flavor]
            $move = "MOVE " + (Format-Str $files.data) + " TO " + (Format-Str $DataFile) + ", MOVE " + (Format-Str $files.log) + " TO " + (Format-Str $LogFile)
            Invoke-Sql $c ("RESTORE DATABASE " + (Format-Ident $Database) + " FROM DISK = " + (Format-Str $bak) + " WITH REPLACE, " + $move + ", RECOVERY") | Out-Null
            foreach ($pair in @(@($LoginDbo, $dbo), @($LoginReg, $reg))) {
                Invoke-Sql $c 'EXEC arashouse_admin.dbo.create_slot_login @login = @l, @password = @p' @{ '@l' = $pair[0]; '@p' = $pair[1] } | Out-Null
            }
            $dbo = $null; $reg = $null; $request = $null
            $db = Format-Ident $Database
            $users = @(Invoke-Sql $c ("SELECT name FROM $db.sys.database_principals WHERE type = 'S'") | ForEach-Object { $_.name })
            foreach ($role in @('dbo', 'reg')) {
                $user = $ShippedUsers[$role]
                if ($users -notcontains $user) { Stop-Step "the restored database has no user $user" }
                $login = if ($role -eq 'dbo') { $LoginDbo } else { $LoginReg }
                Invoke-Sql $c ("USE $db; ALTER USER " + (Format-Ident $user) + " WITH LOGIN = " + (Format-Ident $login)) | Out-Null
            }
        } finally { $c.Dispose() }
        Write-Result @{ database = $Database }
    }
    'stop' {
        # The slot's pools and agent stopped, and its worker processes gone, so nothing holds a file or a session.
        $mgr = Get-Iis
        try {
            foreach ($name in $Pools) {
                $pool = $mgr.ApplicationPools[$name]
                if (-not $pool) { continue }
                if ($pool.State -eq [Microsoft.Web.Administration.ObjectState]::Started) { [void]$pool.Stop() }
                for ($i = 0; $i -lt 120 -and $pool.State -ne [Microsoft.Web.Administration.ObjectState]::Stopped; $i++) { Start-Sleep -Milliseconds 500 }
            }
        } finally { $mgr.Dispose() }
        for ($i = 0; $i -lt 120; $i++) {
            $left = @(Get-CimInstance Win32_Process -Filter "Name='w3wp.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains('"' + "$Alias-".ToLowerInvariant()) })
            if ($left.Count -eq 0) { break }
            Start-Sleep -Milliseconds 500
        }
        $svc = Get-Service -Name $Service -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -ne 'Stopped') { Stop-Service -Name $Service -Force }
        Write-Result @{ stopped = $true }
    }
    'remove-agent' {
        $svc = Get-Service -Name $Service -ErrorAction SilentlyContinue
        if ($svc) {
            if ($svc.Status -ne 'Stopped') { Stop-Service -Name $Service -Force }
            & sc.exe delete $Service | Out-Null
            if ($LASTEXITCODE -ne 0) { Stop-Step "sc.exe could not delete $Service ($LASTEXITCODE)" }
        }
        Write-Result @{ removed = [bool]$svc }
    }
    'remove-database' {
        # Through the procedures: each ends the sessions it must and answers 1 (dropped) or 0 (absent).
        $c = New-Sql
        $dropped = [ordered]@{}
        try {
            $r = Invoke-Sql $c 'DECLARE @r int; EXEC @r = arashouse_admin.dbo.drop_slot_database @database = @d; SELECT @r AS r' @{ '@d' = $Database }
            $dropped[$Database] = [int]$r[-1].r
            foreach ($login in @($LoginDbo, $LoginReg)) {
                $r = Invoke-Sql $c 'DECLARE @r int; EXEC @r = arashouse_admin.dbo.drop_slot_login @login = @l; SELECT @r AS r' @{ '@l' = $login }
                $dropped[$login] = [int]$r[-1].r
            }
        } finally { $c.Dispose() }
        Write-Result @{ dropped = $dropped }
    }
    'remove-iis' {
        # Only the slot alias's applications and the pools named from the slot; then ASP.NET's temporary files of the alias.
        $mgr = Get-Iis
        try {
            foreach ($s in $mgr.Sites) { foreach ($app in @($s.Applications | Where-Object { Test-SlotApp $_.Path } | Sort-Object { $_.Path.Length } -Descending)) { $s.Applications.Remove($app) } }
            foreach ($name in $Pools) { $pool = $mgr.ApplicationPools[$name]; if ($pool) { $mgr.ApplicationPools.Remove($pool) } }
            $mgr.CommitChanges()
        } finally { $mgr.Dispose() }
        foreach ($fw in @('Framework', 'Framework64')) {
            $base = Join-Path $env:windir "Microsoft.NET\\$fw\\v4.0.30319\\Temporary ASP.NET Files"
            if (-not (Test-Path -LiteralPath $base)) { continue }
            foreach ($d in @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq $Alias -or $_.Name -like "$($Alias)_*" })) { Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue }
        }
        Write-Result @{ removed = $true }
    }
    'secret-put' {
        # Machine-scope DPAPI; the file is readable only through the secrets folder's ACL (SYSTEM and the broker, ticket 21).
        Add-Type -AssemblyName System.Security
        $value = [string]$request.value
        $request = $null
        $blob = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
        $value = $null
        $temp = "$SecretFile.tmp"
        [IO.File]::WriteAllBytes($temp, $blob)
        Move-Item -LiteralPath $temp -Destination $SecretFile -Force
        Write-Result @{ stored = $true }
    }
    'secret-get' {
        if (-not (Test-Path -LiteralPath $SecretFile)) {
            Write-Result @{ found = $false }
        } else {
            Add-Type -AssemblyName System.Security
            $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($SecretFile), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
            Write-Result @{ found = $true; value = [Text.Encoding]::UTF8.GetString($plain) }
        }
    }
    'secret-delete' {
        $found = Test-Path -LiteralPath $SecretFile
        if ($found) { Remove-Item -LiteralPath $SecretFile -Force }
        Write-Result @{ deleted = $found }
    }
}
`;
}
