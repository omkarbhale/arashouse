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
  DATABASE_MARKER,
  DEFAULT_INSTALL_ROOT,
  MSI_DEFAULT_AGENT_PORT,
  SLOT_POOL_IDLE_MINUTES,
  STAMP_FILE_NAME,
  agentServiceName,
  buildScratch,
  databaseFiles,
  databaseName,
  extractBackupScratch,
  goldenDir,
  slotDir,
  slotLoginSecretName,
  slotRootSecretName,
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
  "start",
  "reset-database",
  "read-database",
  "backup-database",
  "stop",
  "quiesce",
  "reset-tree",
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
    [extractBackupScratch(ref, root), `${root}\\sqldata\\arashouse_${ref.flavor}_07-extract.bak`],
    [slotLoginSecretName(ref, "dbo"), `slot-${ref.flavor}-07-dbo`],
    [slotRootSecretName(ref), `slot-${ref.flavor}-07-root`],
  ];
  for (const [derived, scripted] of checks) {
    if (derived !== scripted) throw new Error(`a name rule changed (${derived}); update slot-steps.ts with names.ts`);
  }
}

export function renderSlotStepsScript(root: string = DEFAULT_INSTALL_ROOT): string {
  const r = assertValidRoot(root);
  checkNameRules(r);
  const list = (items: readonly (string | number)[]) => `@(${items.map((i) => (typeof i === "number" ? String(i) : psQuote(i))).join(", ")})`;
  // The whole-folder runtime rules: the reset empties them after the mirror (the file rules are restored by the mirror).
  const runtimeDirs = FLAVOR_KEYS.map(
    (key) => `    ${psQuote(key)} = ${list(FLAVORS[key].runtimeDirs.filter((rule) => rule.files === undefined).map((rule) => rule.dir.replace(/\//g, "\\")))}`,
  ).join("\n");
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
$RuntimeDirs = @{
${runtimeDirs}
}
$ShippedUsers = [ordered]@{ dbo = ${psQuote(SHIPPED_DATABASE_USERS.dbo)}; reg = ${psQuote(SHIPPED_DATABASE_USERS.reg)} }
$MarkerHash = ${psQuote(DATABASE_MARKER.goldenHash)}
$MarkerAt = ${psQuote(DATABASE_MARKER.resetAt)}
$PoolIdentities = @('ApplicationPoolIdentity', 'NetworkService', 'LocalService')
$DeniedRoots = ${list(DENIED_INSTALL_ROOTS)}
$DeniedServicePrefixes = ${list(DENIED_SERVICE_PREFIXES)}
# The baseline builds' own agent services (ArasInnovatorAgent_ah-build-<key>, ticket 33b) come and go while a build runs, which a
# provision or destroy may overlap; they are arashouse's, so the fingerprints leave out those exact names and nothing else.
$OwnServices = ${list(FLAVOR_KEYS.map((key) => buildScratch(key, r).agent.service))}

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
    $ExtractBackup = Join-Path $SqlData "$($Database)-extract.bak"
    $SlotSecrets = @("slot-$Flavor-$NN-dbo", "slot-$Flavor-$NN-reg", "slot-$Flavor-$NN-root")
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

# ---- serving: the slot's pools, its agent and its processes ----
function Get-SlotProcesses {
    # The slot's w3wp.exe (by its pools' names) and anything started from the slot folder.
    $marker = ('"' + "$Alias-").ToLowerInvariant()
    return @(Get-CimInstance Win32_Process | Where-Object {
        (($_.Name -eq 'w3wp.exe') -and $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($marker)) -or
        ($_.ExecutablePath -and (Test-Under $_.ExecutablePath $SlotDir)) -or
        ($_.CommandLine -and $_.CommandLine.IndexOf($SlotDir + '\\', [StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
}
function Get-Serving {
    # What of the slot still runs: pools not stopped, its agent, its processes. Names only.
    $serving = @()
    $mgr = Get-Iis
    try {
        foreach ($name in $Pools) {
            $pool = $mgr.ApplicationPools[$name]
            if ($pool -and $pool.State -ne [Microsoft.Web.Administration.ObjectState]::Stopped) { $serving += "IIS pool $name ($($pool.State))" }
        }
    } finally { $mgr.Dispose() }
    $svc = Get-SlotService
    if ($svc -and $svc.Status -ne 'Stopped') { $serving += "service $Service ($($svc.Status))" }
    foreach ($p in @(Get-SlotProcesses)) { $serving += "process $($p.Name) $($p.ProcessId)" }
    return @($serving)
}
# Stops the slot's agent (first: it talks to the server) and pools, and waits, bounded, for its processes to end. The pool stop releases
# every locked file and closes the server's SQL sessions (spike 06). From 14.0 the Innovator, Client, OAuth and Vault applications run
# out of process (Aras.Server.exe and the like next to w3wp.exe; spike 07) and a pool stop does not wait for them: those still running
# after 30 s are ended, each being this slot's own. Answers what still runs, the pools stopped and the agent's state.
function Stop-Slot {
    $svc = Get-SlotService
    $agent = 'none'
    if ($svc) {
        if ($svc.Status -ne 'Stopped') { Stop-Service -Name $Service -Force }
        $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
        $agent = 'stopped'
    }
    $stopped = 0
    $mgr = Get-Iis
    try {
        foreach ($name in $Pools) {
            $pool = $mgr.ApplicationPools[$name]
            if (-not $pool) { continue }
            if ($pool.State -eq [Microsoft.Web.Administration.ObjectState]::Started) { [void]$pool.Stop() }
            for ($i = 0; $i -lt 120 -and $pool.State -ne [Microsoft.Web.Administration.ObjectState]::Stopped; $i++) { Start-Sleep -Milliseconds 500 }
            $stopped++
        }
    } finally { $mgr.Dispose() }
    for ($i = 0; $i -lt 120; $i++) {
        $left = @(Get-SlotProcesses)
        if ($left.Count -eq 0) { break }
        if ($i -eq 60) { foreach ($p in @($left | Where-Object { $_.Name -ne 'w3wp.exe' })) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } }
        Start-Sleep -Milliseconds 500
    }
    return @{ serving = @(Get-Serving); pools = $stopped; agent = $agent }
}

# ---- the tree ----
function Invoke-Mirror {
    # The golden tree over the slot folder (the provision's copy and the reset's mirror): times kept, no junction followed, everything
    # else removed, the stamp included (a reset writes a new one last). No /XF: robocopy matches it on the source side (spike 06).
    $tree = Join-Path $Golden 'tree'
    if (-not (Test-Path -LiteralPath $tree)) { Stop-Step "$tree does not exist (is the $Flavor baseline built?)" }
    if (-not (Test-Path -LiteralPath $SlotDir)) { Stop-Step "$SlotDir does not exist" }
    if ((Get-Item -LiteralPath $SlotDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Stop-Step "$SlotDir is a junction or link" }
    & robocopy.exe $tree $SlotDir /MIR /XJ /R:2 /W:1 /MT:16 /NFL /NDL /NJH /NJS /NP | Out-Null
    $rc = $LASTEXITCODE
    if ($rc -ge 8) { Stop-Step "robocopy failed ($rc)" }
    return $rc
}
function Remove-Entry($Item) {
    # A link or junction is removed itself, never followed. Answers how many entries went.
    if ($Item.Attributes -band [IO.FileAttributes]::ReadOnly) { $Item.Attributes = $Item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly) }
    if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        if ($Item.PSIsContainer) { [IO.Directory]::Delete($Item.FullName, $false) } else { [IO.File]::Delete($Item.FullName) }
        return 1
    }
    $n = 1
    if ($Item.PSIsContainer) {
        foreach ($e in @(Get-ChildItem -LiteralPath $Item.FullName -Force)) { $n += Remove-Entry $e }
        [IO.Directory]::Delete($Item.FullName, $false)
    } else {
        [IO.File]::Delete($Item.FullName)
    }
    return $n
}
function Clear-Folder([string]$Dir) {
    # Everything inside $Dir, which stays; $Dir must not be a junction or link. Answers how many entries went.
    if (-not (Test-Path -LiteralPath $Dir)) { return 0 }
    if ((Get-Item -LiteralPath $Dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Stop-Step "$Dir is a junction or link" }
    $n = 0
    foreach ($e in @(Get-ChildItem -LiteralPath $Dir -Force)) { $n += Remove-Entry $e }
    return $n
}
function Clear-AspNetTemp {
    # ASP.NET's temporary files of the alias (compiled pages, shadow copies of its bin), by folder name. Answers how many folders went.
    $n = 0
    foreach ($fw in @('Framework', 'Framework64')) {
        $base = Join-Path $env:windir "Microsoft.NET\\$fw\\v4.0.30319\\Temporary ASP.NET Files"
        if (-not (Test-Path -LiteralPath $base)) { continue }
        foreach ($d in @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq $Alias -or $_.Name -like "$($Alias)_*" })) {
            Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
            $n++
        }
    }
    return $n
}

function Test-SqlError($Exception, [int]$Number) {
    for ($e = $Exception; $e; $e = $e.InnerException) {
        if ($e -is [System.Data.SqlClient.SqlException]) { foreach ($x in $e.Errors) { if ($x.Number -eq $Number) { return $true } } }
    }
    return $false
}
# The marker (src/core/names.ts DATABASE_MARKER) from the request, each value checked against its pattern; written after a restore,
# which brings the golden's own properties. Read back with the version rows.
function Get-RequestMarker {
    $hash = [string]$request.marker.goldenHash
    $at = [string]$request.marker.resetAt
    if ($hash -cnotmatch '^[0-9a-f]{64}$') { Stop-Step 'the request names no golden hash' }
    if ($at -cnotmatch '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(\\.\\d{1,3})?Z$') { Stop-Step 'the request names no reset time' }
    return @($hash, $at)
}
function Write-Marker($c, [string]$db, [string[]]$Marker) {
    foreach ($pair in @(@($MarkerHash, $Marker[0]), @($MarkerAt, $Marker[1]))) {
        Invoke-Sql $c ("USE $db; IF EXISTS (SELECT 1 FROM sys.extended_properties WHERE class = 0 AND name = @n) EXEC sys.sp_updateextendedproperty @name = @n, @value = @v ELSE EXEC sys.sp_addextendedproperty @name = @n, @value = @v") @{ '@n' = $pair[0]; '@v' = $pair[1] } | Out-Null
    }
}
function Read-Marker($c, [string]$db) {
    $marker = [ordered]@{}
    foreach ($row in @(Invoke-Sql $c ("SELECT name, CAST(value AS nvarchar(200)) AS value FROM $db.sys.extended_properties WHERE class = 0 AND name IN (@h, @a)") @{ '@h' = $MarkerHash; '@a' = $MarkerAt })) { $marker[[string]$row.name] = [string]$row.value }
    return $marker
}
function Read-Version($c, [string]$db) {
    $version = [ordered]@{}
    foreach ($row in @(Invoke-Sql $c ("SELECT name, value FROM $db.innovator.[VARIABLE] WHERE name IN ('VersionMajor', 'VersionMinor', 'VersionServicePack', 'VersionBuild')"))) { $version[[string]$row.name] = [string]$row.value }
    return $version
}
function Read-Golden([string]$Name) {
    $file = Join-Path $Golden $Name
    if (-not (Test-Path -LiteralPath $file)) { Stop-Step "$file does not exist (is the $Flavor baseline built?)" }
    $record = [IO.File]::ReadAllText($file) | ConvertFrom-Json
    if ($record.schema -ne 1) { Stop-Step "$file is not a schema 1 record" }
    return $record
}

# The slot's agent service, guarded again before any service is started, stopped or deleted: the name derived above, matching the
# allowlist and no deny-listed prefix (never ArasInnovatorAgent_*), and a service of that name must run a binary inside the slot folder.
function Get-SlotService {
    if ($Service -cnotmatch '^ArasHouseAgent_[a-z0-9_]+$') { Stop-Step "the service name $Service is not an arashouse agent name" }
    foreach ($p in $DeniedServicePrefixes) { if ($Service.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)) { Stop-Step "the service name $Service is deny-listed" } }
    $svc = Get-CimInstance Win32_Service -Filter "Name='$Service'"
    if (-not $svc) { return $null }
    $bin = ([string]$svc.PathName).Trim().Trim('"')
    if (-not $bin.StartsWith("$SlotDir\\", [StringComparison]::OrdinalIgnoreCase)) { Stop-Step "the service $Service does not run a binary inside $SlotDir" }
    return Get-Service -Name $Service
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
        # The same mirror the reset uses (ticket 30).
        Write-Result @{ robocopy = (Invoke-Mirror) }
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
            # The build's arguments, if the MSI gave the service any, with the tree ({{tree}}) the slot's; no other path may appear.
            $arguments = ([string]$record.arguments).Replace('{{tree}}', $SlotDir)
            foreach ($m in [regex]::Matches($arguments, '[A-Za-z]:\\\\[^"\\s]*')) { if (-not (Test-Under $m.Value $SlotDir)) { Stop-Step "service.json's arguments name a path outside the slot" } }
            if ($ReservedPorts -contains $AgentPort) { Stop-Step "the agent port $AgentPort is reserved" }
            $existing = Get-Service -Name $Service -ErrorAction SilentlyContinue
            if (-not $existing -and @(Get-NetTCPConnection -State Listen -LocalPort $AgentPort -ErrorAction SilentlyContinue).Count -gt 0) { Stop-Step "something already listens on the agent port $AgentPort" }
            $command = '"' + $bin + '"' + $(if ($arguments) { ' ' + $arguments } else { '' })
            if (-not $existing) { New-Service -Name $Service -BinaryPathName $command -StartupType Manual -DisplayName "ArasHouse agent $Flavor-$NN" | Out-Null }
            Write-Result @{ installed = $true; port = $AgentPort }
        }
    }
    'database' {
        # The slot database through the name-checked procedures (ticket 22): created empty and owned by the broker, then the golden's
        # ootb.bak restored over it by its owner, with its files moved to sqldata\\. The two logins get the passwords of the request only,
        # and the restored users innovator and innovator_regular are mapped to them (the CD's SQL scripts are not run).
        $bak = Join-Path $Golden 'db\\ootb.bak'
        if (-not (Test-Path -LiteralPath $bak)) { Stop-Step "$bak does not exist" }
        $marker = Get-RequestMarker
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
            Write-Marker $c $db $marker
        } finally { $c.Dispose() }
        Write-Result @{ database = $Database }
    }
    'start' {
        # The slot online again (ticket 33): its pools started (the stop and the reset's quiesce leave them stopped, and a stopped pool
        # does not start on a request), and the agent only when the request asks for it. The warm-up is the broker's (Node), after this.
        if (-not (Test-Path -LiteralPath (Join-Path $SlotDir $StampName))) { Stop-Step "slot $Flavor-$NN is not provisioned" }
        $started = @()
        $mgr = Get-Iis
        try {
            foreach ($name in $Pools) {
                $pool = $mgr.ApplicationPools[$name]
                if (-not $pool) { continue }
                if ($pool.State -ne [Microsoft.Web.Administration.ObjectState]::Started) {
                    for ($i = 0; $i -lt 120 -and $pool.State -eq [Microsoft.Web.Administration.ObjectState]::Stopping; $i++) { Start-Sleep -Milliseconds 500 }
                    [void]$pool.Start()
                }
                for ($i = 0; $i -lt 120 -and $pool.State -ne [Microsoft.Web.Administration.ObjectState]::Started; $i++) { Start-Sleep -Milliseconds 500 }
                if ($pool.State -ne [Microsoft.Web.Administration.ObjectState]::Started) { Stop-Step "the pool $name did not start ($($pool.State))" }
                $started += $name
            }
        } finally { $mgr.Dispose() }
        if ($started.Count -eq 0) { Stop-Step "slot $Flavor-$NN has no IIS pools" }
        $agent = 'not asked'
        if ($request.agent -eq $true) {
            $svc = Get-SlotService
            if (-not $svc) {
                $agent = 'none'
            } else {
                if ($svc.Status -ne 'Running') { Start-Service -Name $Service }
                $svc.WaitForStatus('Running', [TimeSpan]::FromSeconds(60))
                $listening = $false
                for ($i = 0; $i -lt 60; $i++) {
                    if (@(Get-NetTCPConnection -State Listen -LocalPort $AgentPort -ErrorAction SilentlyContinue).Count -gt 0) { $listening = $true; break }
                    Start-Sleep -Milliseconds 500
                }
                if (-not $listening) { Stop-Step "the agent $Service runs but nothing listens on its port $AgentPort" }
                $agent = 'running'
            }
        }
        Write-Result @{ pools = $started.Count; agent = $agent; port = $AgentPort }
    }
    'reset-database' {
        # The reset's owner restore (spike 06, ticket 31): the golden's ootb.bak over the slot database by its owner, the broker,
        # files moved to sqldata\\, after kill_connections has ended any other session in it. One that comes back in between blocks
        # it with 3101: kill_connections again and it runs once more. Then MULTI_USER, the two users mapped to the slot's logins again, and the marker written (after the restore, which
        # brings the golden's own properties). The owner survives the restore and the vault URL is alias-relative, so neither is fixed.
        $bak = Join-Path $Golden 'db\\ootb.bak'
        if (-not (Test-Path -LiteralPath $bak)) { Stop-Step "$bak does not exist" }
        $requested = Get-RequestMarker
        $c = New-Sql
        try {
            if (@(Invoke-Sql $c 'SELECT name FROM sys.databases WHERE name = @n' @{ '@n' = $Database }).Count -eq 0) { Write-Result @{ missing = $true }; return }
            $db = Format-Ident $Database
            $files = $BackupFiles[$Flavor]
            $move = "MOVE " + (Format-Str $files.data) + " TO " + (Format-Str $DataFile) + ", MOVE " + (Format-Str $files.log) + " TO " + (Format-Str $LogFile)
            $restore = "RESTORE DATABASE " + (Format-Ident $Database) + " FROM DISK = " + (Format-Str $bak) + " WITH REPLACE, " + $move + ", RECOVERY"
            $kill = 'DECLARE @r int; EXEC @r = arashouse_admin.dbo.kill_connections @database = @d; SELECT @r AS r'
            $watch = [Diagnostics.Stopwatch]::StartNew()
            # Ended first as well: an idle session in the database holds the restore for about 20 s before the 3101 (measured).
            $killed = [int](Invoke-Sql $c $kill @{ '@d' = $Database })[-1].r
            try {
                Invoke-Sql $c $restore | Out-Null
            } catch {
                if (-not (Test-SqlError $_.Exception 3101)) { throw }
                $killed += [int](Invoke-Sql $c $kill @{ '@d' = $Database })[-1].r
                Invoke-Sql $c $restore | Out-Null
            }
            $watch.Stop()
            $access = [string](Invoke-Sql $c 'SELECT user_access_desc AS a FROM sys.databases WHERE name = @n' @{ '@n' = $Database })[0].a
            if ($access -ne 'MULTI_USER') { Invoke-Sql $c "ALTER DATABASE $db SET MULTI_USER" | Out-Null }
            $users = @(Invoke-Sql $c ("SELECT name FROM $db.sys.database_principals WHERE type = 'S'") | ForEach-Object { $_.name })
            foreach ($role in @('dbo', 'reg')) {
                $user = $ShippedUsers[$role]
                if ($users -notcontains $user) { Stop-Step "the restored database has no user $user" }
                $login = if ($role -eq 'dbo') { $LoginDbo } else { $LoginReg }
                Invoke-Sql $c ("USE $db; ALTER USER " + (Format-Ident $user) + " WITH LOGIN = " + (Format-Ident $login)) | Out-Null
            }
            Write-Marker $c $db $requested
            $marker = Read-Marker $c $db
            $version = Read-Version $c $db
        } finally { $c.Dispose() }
        Write-Result @{ restoreMs = [int]$watch.ElapsedMilliseconds; killed = $killed; access = $access; marker = $marker; version = $version }
    }
    'read-database' {
        # The health check (ticket 32): the marker and the version rows, read only, from the database the broker owns.
        $c = New-Sql
        try {
            if (@(Invoke-Sql $c 'SELECT name FROM sys.databases WHERE name = @n' @{ '@n' = $Database }).Count -eq 0) { Write-Result @{ missing = $true }; return }
            $db = Format-Ident $Database
            $marker = Read-Marker $c $db
            $version = Read-Version $c $db
        } finally { $c.Dispose() }
        Write-Result @{ marker = $marker; version = $version }
    }
    'backup-database' {
        # A leaseholder's extraction (ticket 43, docs/extract.md): a COPY_ONLY backup of the slot database by its owner, the broker,
        # to sqldata\\<database>-extract.bak, replacing an older one (the SQL Server account may write sqldata\\ only). The broker copies
        # it into the lease's staging folder and removes this one. COPY_ONLY leaves the database's backup sequence as it was.
        $c = New-Sql
        try {
            if (@(Invoke-Sql $c 'SELECT name FROM sys.databases WHERE name = @n' @{ '@n' = $Database }).Count -eq 0) { Write-Result @{ missing = $true }; return }
            $watch = [Diagnostics.Stopwatch]::StartNew()
            Invoke-Sql $c ("BACKUP DATABASE " + (Format-Ident $Database) + " TO DISK = " + (Format-Str $ExtractBackup) + " WITH COPY_ONLY, INIT, FORMAT, CHECKSUM") | Out-Null
            $watch.Stop()
        } finally { $c.Dispose() }
        Write-Result @{ backupMs = [int]$watch.ElapsedMilliseconds; bytes = [long](Get-Item -LiteralPath $ExtractBackup).Length }
    }
    'stop' {
        # The slot's agent and pools stopped, and its worker processes gone, so nothing holds a file or a session (ticket 33; before a
        # destroy).
        $r = Stop-Slot
        $left = @($r.serving)
        if ($left.Count -gt 0) { Stop-Step "the slot still runs after the wait: $($left -join ', ')" }
        Write-Result @{ stopped = $true; pools = $r.pools; agent = $r.agent }
    }
    'quiesce' {
        # The reset's first step (ticket 30): the same stop, and a failure when anything of the slot still runs after the wait.
        if (-not (Test-Path -LiteralPath $SlotDir)) {
            Write-Result @{ provisioned = $false }
        } else {
            $left = @((Stop-Slot).serving)
            if ($left.Count -gt 0) { Stop-Step "the slot still runs after the wait: $($left -join ', ')" }
            Write-Result @{ provisioned = $true }
        }
    }
    'reset-tree' {
        # The tree half of a reset (ticket 30, docs/reset.md), on a quiesced slot only: the mirror from golden, then the runtime state it
        # leaves: the whole runtime folders emptied, the vault folder's files, ASP.NET's temporary files of the alias. The broker then
        # renders the configs, verifies the tree and writes the stamp.
        if (-not (Test-Path -LiteralPath $SlotDir)) {
            Write-Result @{ provisioned = $false }
        } else {
            $serving = @(Get-Serving)
            if ($serving.Count -gt 0) {
                Write-Result @{ provisioned = $true; quiesced = $false; serving = $serving }
            } else {
                if (-not (Test-Path -LiteralPath $VaultDir)) { Stop-Step "$VaultDir does not exist" }
                $watch = [Diagnostics.Stopwatch]::StartNew()
                $rc = Invoke-Mirror
                $mirrorMs = $watch.ElapsedMilliseconds
                $watch.Restart()
                $runtime = 0
                foreach ($rel in $RuntimeDirs[$Flavor]) { $runtime += Clear-Folder (Join-Path $SlotDir $rel) }
                $vault = Clear-Folder $VaultDir
                $aspnet = Clear-AspNetTemp
                Write-Result @{ provisioned = $true; quiesced = $true; robocopy = $rc; mirrorMs = $mirrorMs; clearMs = $watch.ElapsedMilliseconds; runtimeEntries = $runtime; vaultEntries = $vault; aspnetFolders = $aspnet }
            }
        }
    }
    'remove-agent' {
        $svc = Get-SlotService
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
        [void](Clear-AspNetTemp)
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
