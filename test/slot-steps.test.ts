import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderBuildStepsScript } from "../src/broker/baseline-steps.js";
import { PS_DENY_LIST_PRINTS } from "../src/broker/ps-common.js";
import { RESERVED_AGENT_PORTS, SECRET_STEPS, SLOT_STEPS, renderSlotStepsScript } from "../src/broker/slot-steps.js";
import { FLAVORS, FLAVOR_KEYS } from "../src/core/flavors.js";
import { APP_POOL_ROLES, agentPort } from "../src/core/names.js";
import { repoRoot } from "./helpers.js";

const steps = renderSlotStepsScript();

describe("slot-steps.ps1 (static)", () => {
  it("is plain ASCII and answers every step the slot system asks for", () => {
    expect(steps).toMatch(/^[\x00-\x7f]*$/);
    for (const step of SLOT_STEPS) expect(steps, step).toContain(`    '${step}' {`);
    expect(steps).toContain(`if (@(${SLOT_STEPS.map((s) => `'${s}'`).join(", ")}) -cnotcontains $Step)`);
    expect(steps).toContain(`if (@(${SECRET_STEPS.map((s) => `'${s}'`).join(", ")}) -ccontains $Step)`);
  });

  it("takes nothing from the request but the flavor, the slot number, the agent switch, the two login passwords, the reset's marker and a secret's name and value", () => {
    const used = [...steps.matchAll(/\$request\.([A-Za-z.]+)/g)].map((m) => m[1]);
    expect([...new Set(used)].sort()).toEqual(["agent", "flavor", "marker.goldenHash", "marker.resetAt", "name", "secrets.dbo", "secrets.reg", "slot", "value"]);
    expect(steps).toContain("if ($request.agent -eq $true) {");
    expect(steps).toContain("if ($goldenHash -cnotmatch '^[0-9a-f]{64}$') { Stop-Step 'the request names no golden hash' }");
    expect(steps).toContain("if ($resetAt -cnotmatch '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(\\.\\d{1,3})?Z$') { Stop-Step 'the request names no reset time' }");
    expect(steps).toContain("if ($FlavorKeys -cnotcontains $Flavor) { Stop-Step 'the request names no registered flavor' }");
    expect(steps).toContain("if (-not (($raw -is [int]) -or ($raw -is [long])) -or $raw -lt 1 -or $raw -gt 99) { Stop-Step 'the request names no slot number from 1 to 99' }");
    expect(steps).toContain("if ($SecretName -cnotmatch '^[a-z0-9][a-z0-9-]{0,63}$') { Stop-Step 'the request names no usable secret' }");
  });

  it("derives every name the way names.ts does", () => {
    expect(steps).toContain('$Alias = "ah-$Flavor-$NN"');
    expect(steps).toContain('$Database = "arashouse_$($Flavor)_$NN"');
    expect(steps).toContain('$Service = "ArasHouseAgent_$($Flavor)_$NN"');
    expect(steps).toContain('$SlotDir = Join-Path $Root "slots\\$Flavor\\$NN"');
    expect(steps).toContain('$VaultDir = Join-Path $Root "vaults\\$Flavor-$NN"');
    expect(steps).toContain('$Golden = Join-Path $Root "golden\\$Flavor"');
    expect(steps).toContain('$SecretFile = Join-Path $Root "secrets\\$SecretName.bin"');
    expect(steps).toContain(`$PoolRoles = @(${APP_POOL_ROLES.map((r) => `'${r}'`).join(", ")})`);
    // The port rule: 8800 + 100 per flavor in registry order + the slot number.
    expect(steps).toContain("$AgentPort = $AgentPortBase + 100 * [array]::IndexOf($FlavorKeys, $Flavor) + $Number");
    expect(agentPort({ flavor: FLAVOR_KEYS[1]!, slot: 2 })).toBe(8902);
    expect(steps).toContain(`$ReservedPorts = @(${RESERVED_AGENT_PORTS.join(", ")})`);
    for (const key of FLAVOR_KEYS) expect(steps).toContain(`'${key}' = @{ data = '${FLAVORS[key].backupFiles.data}'; log = '${FLAVORS[key].backupFiles.log}' }`);
  });

  it("reaches SQL Server only through the name-checked procedures, but for the owner's own restore and user mapping", () => {
    const sql = [...steps.matchAll(/'(EXEC|DECLARE @r int; EXEC @r =) arashouse_admin\.dbo\.(\w+)/g)].map((m) => m[2]);
    expect([...new Set(sql)].sort()).toEqual(["create_slot_database", "create_slot_login", "drop_slot_database", "drop_slot_login", "kill_connections"]);
    expect(steps).not.toMatch(/(CREATE|DROP) (DATABASE|LOGIN)/);
    expect(steps).not.toMatch(/\bKILL \d|SINGLE_USER|BACKUP DATABASE|FILELISTONLY/);
    for (const m of steps.matchAll(/RESTORE DATABASE [^\n]*/g)) expect(m[0]).toMatch(/^RESTORE DATABASE " \+ \(Format-Ident \$Database\) \+ " FROM DISK = " \+ \(Format-Str \$bak\)/);
    expect(steps).toContain("$bak = Join-Path $Golden 'db\\ootb.bak'");
    for (const m of steps.matchAll(/ALTER USER [^\n]*/g)) expect(m[0]).toContain("WITH LOGIN = \" + (Format-Ident $login))");
    expect(steps).toContain("foreach ($pair in @(@($LoginDbo, $dbo), @($LoginReg, $reg)))");
  });

  it("resets the slot database by the owner's restore of ootb.bak, after kill_connections, and once more after it on 3101 only", () => {
    const body = steps.slice(steps.indexOf("    'reset-database' {"), steps.indexOf("    'stop' {"));
    expect(body).toContain("$bak = Join-Path $Golden 'db\\ootb.bak'");
    expect(body).toContain("if (-not (Test-SqlError $_.Exception 3101)) { throw }");
    expect(body.match(/Invoke-Sql \$c \$restore/g)).toHaveLength(2);
    expect(body.match(/Invoke-Sql \$c \$kill/g)).toHaveLength(2);
    expect(body.indexOf("Invoke-Sql $c $kill")).toBeLessThan(body.indexOf("Invoke-Sql $c $restore"));
    expect(body.lastIndexOf("Invoke-Sql $c $kill")).toBeGreaterThan(body.indexOf("Test-SqlError $_.Exception 3101"));
    expect(body).not.toContain("create_slot_database");
    expect(body).not.toContain("create_slot_login");
    expect(body).toContain('if ($access -ne \'MULTI_USER\') { Invoke-Sql $c "ALTER DATABASE $db SET MULTI_USER" | Out-Null }');
    // The marker goes in after the restore and its values only as parameters.
    expect(body.indexOf("sp_addextendedproperty")).toBeGreaterThan(body.lastIndexOf("Invoke-Sql $c $restore"));
    expect(body).toContain("EXEC sys.sp_updateextendedproperty @name = @n, @value = @v ELSE EXEC sys.sp_addextendedproperty @name = @n, @value = @v\") @{ '@n' = $pair[0]; '@v' = $pair[1] }");
    expect(steps).toContain("$MarkerHash = 'arashouse.golden_hash'");
    expect(steps).toContain("$MarkerAt = 'arashouse.reset_at'");
  });

  it("removes only the slot alias's applications, the pools named from the slot and the service of its own name", () => {
    expect(steps).toContain('function Test-SlotApp([string]$Path) { return ($Path -ieq "/$Alias") -or $Path.StartsWith("/$Alias/", [StringComparison]::OrdinalIgnoreCase) }');
    expect(steps).toContain("foreach ($name in $Pools) { $pool = $mgr.ApplicationPools[$name]; if ($pool) { $mgr.ApplicationPools.Remove($pool) } }");
    expect(steps).toContain("& sc.exe delete $Service | Out-Null");
    expect(steps).toContain('$Pools = @($PoolRoles | ForEach-Object { "$Alias-$_" })');
  });

  it("starts, stops and deletes only the slot's own agent service, checked again: never ArasInnovatorAgent_*", () => {
    expect(steps).toContain("if ($Service -cnotmatch '^ArasHouseAgent_[a-z0-9_]+$') { Stop-Step \"the service name $Service is not an arashouse agent name\" }");
    expect(steps).toContain("$DeniedServicePrefixes = @('ArasInnovatorAgent_')");
    expect(steps).toContain('foreach ($p in $DeniedServicePrefixes) { if ($Service.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)) { Stop-Step "the service name $Service is deny-listed" } }');
    expect(steps).toContain('if (-not $bin.StartsWith("$SlotDir\\", [StringComparison]::OrdinalIgnoreCase)) { Stop-Step "the service $Service does not run a binary inside $SlotDir" }');
    // Every service it starts, stops or deletes is $Service, and each step that does so reads it through Get-SlotService first.
    for (const m of steps.matchAll(/(Start-Service|Stop-Service|sc\.exe delete) [^\n]*/g)) expect(m[0]).toMatch(/^(Start-Service -Name \$Service|Stop-Service -Name \$Service -Force|sc\.exe delete \$Service )/);
    for (const step of ["start", "stop", "remove-agent"]) {
      const body = steps.slice(steps.indexOf(`    '${step}' {`));
      const before = body.slice(0, body.search(/Start-Service|Stop-Service|sc\.exe delete/));
      expect(before, step).toContain("$svc = Get-SlotService");
    }
    // The pools it starts or stops are the slot's own, named from its alias: start, stop and remove-iis loop over $Pools only.
    expect(steps.match(/\$mgr\.ApplicationPools\[\$name\]/g)?.length).toBe(steps.match(/foreach \(\$name in \$Pools\)/g)?.length);
  });

  it("writes nothing under Program Files, and makes the pools' grants inheritable on the slot's own folders only", () => {
    expect(steps.split("\n").filter((l) => /Program Files/.test(l))).toEqual([expect.stringMatching(/^\$DeniedRoots = @\('C:\\Program Files \(x86\)\\Aras\\Innovator'/)]);
    const icacls = [...steps.matchAll(/& icacls\.exe [^\n]*/g)].map((m) => m[0]);
    expect(icacls).toEqual([
      "& icacls.exe $SlotDir /grant '*S-1-5-32-568:(OI)(CI)M' '*S-1-5-17:(OI)(CI)RX' /Q | Out-Null",
      "& icacls.exe $VaultDir /grant '*S-1-5-32-568:(OI)(CI)M' /Q | Out-Null",
    ]);
    // One mirror for the provision and the reset, with no /XF: robocopy matches it on the source side (spike 06).
    expect([...steps.matchAll(/& robocopy\.exe [^\n]*/g)].map((m) => m[0])).toEqual(["& robocopy.exe $tree $SlotDir /MIR /XJ /R:2 /W:1 /MT:16 /NFL /NDL /NJH /NJS /NP | Out-Null"]);
  });

  it("resets the tree of a quiesced slot only, and clears without following a junction", () => {
    for (const key of FLAVOR_KEYS) {
      const dirs = FLAVORS[key].runtimeDirs.filter((r) => r.files === undefined).map((r) => `'${r.dir.replace(/\//g, "\\")}'`);
      expect(steps).toContain(`    '${key}' = @(${dirs.join(", ")})`);
    }
    expect(steps).toContain("'Innovator\\Server\\temp', 'Innovator\\Server\\dll', 'Innovator\\Server\\logs'");
    const reset = steps.slice(steps.indexOf("    'reset-tree' {"), steps.indexOf("    'remove-agent' {"));
    expect(reset.indexOf("$serving = @(Get-Serving)")).toBeLessThan(reset.indexOf("$rc = Invoke-Mirror"));
    expect(reset).toContain("Write-Result @{ provisioned = $true; quiesced = $false; serving = $serving }");
    expect(reset).toContain("foreach ($rel in $RuntimeDirs[$Flavor]) { $runtime += Clear-Folder (Join-Path $SlotDir $rel) }");
    expect(reset).toContain("$vault = Clear-Folder $VaultDir");
    // A link or junction is removed itself; only real folders are walked.
    expect(steps).toContain("if ($Item.PSIsContainer) { [IO.Directory]::Delete($Item.FullName, $false) } else { [IO.File]::Delete($Item.FullName) }");
    expect(steps).toContain('if ((Get-Item -LiteralPath $Dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Stop-Step "$Dir is a junction or link" }');
    expect(steps).toContain('if ((Get-Item -LiteralPath $SlotDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Stop-Step "$SlotDir is a junction or link" }');
    expect(steps.match(/Remove-Item -LiteralPath [^\n]*-Recurse/g)).toEqual(["Remove-Item -LiteralPath $d.FullName -Recurse"]);
    expect(steps).toContain('if ($left.Count -gt 0) { Stop-Step "the slot still runs after the wait: $($left -join \', \')" }');
  });

  it("keeps a secret out of everything but the DPAPI blob and the one result line that answers a get", () => {
    expect(steps).toContain("[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)");
    expect(steps).toContain("Write-Result @{ found = $true; value = [Text.Encoding]::UTF8.GetString($plain) }");
    expect(steps).not.toMatch(/Write-(Host|Output|Verbose)|Console\]::Error\.WriteLine\([^"]/);
  });

  it("shares the deny-list fingerprints with the baseline build", () => {
    expect(steps).toContain(PS_DENY_LIST_PRINTS);
    expect(renderBuildStepsScript()).toContain(PS_DENY_LIST_PRINTS);
    expect(steps).toContain("Write-Result @{ prints = (Get-DenyListPrints) }");
  });
});

/** Windows PowerShell 5.1 from WSL, when it is there: the script targets it. */
function findPowerShell(): string | undefined {
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" });
  return probe.status === 0 ? "powershell.exe" : undefined;
}
const ps = findPowerShell();
const describeWithPs = ps ? describe : describe.skip;

describeWithPs("slot-steps.ps1 under Windows PowerShell", () => {
  it("parses without a syntax error", () => {
    const dir = mkdtempSync(join(tmpdir(), "arashouse-slot-steps-"));
    try {
      writeFileSync(join(dir, "slot-steps.ps1"), steps.replace(/\n/g, "\r\n"), "ascii");
      const win = (p: string) => execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim();
      const r = spawnSync(ps as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", win(join(repoRoot, "test/spike-parse.ps1")), win(join(dir, "slot-steps.ps1"))], {
        encoding: "utf8",
        cwd: existsSync("/mnt/c") ? "/mnt/c" : undefined,
      });
      expect(r.stdout.trim()).toBe("errors=0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
