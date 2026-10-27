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

  it("takes nothing from the request but the flavor, the slot number, the two login passwords and a secret's name and value", () => {
    const used = [...steps.matchAll(/\$request\.([A-Za-z.]+)/g)].map((m) => m[1]);
    expect([...new Set(used)].sort()).toEqual(["flavor", "name", "secrets.dbo", "secrets.reg", "slot", "value"]);
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

  it("removes only the slot alias's applications, the pools named from the slot and the service of its own name", () => {
    expect(steps).toContain('function Test-SlotApp([string]$Path) { return ($Path -ieq "/$Alias") -or $Path.StartsWith("/$Alias/", [StringComparison]::OrdinalIgnoreCase) }');
    expect(steps).toContain("foreach ($name in $Pools) { $pool = $mgr.ApplicationPools[$name]; if ($pool) { $mgr.ApplicationPools.Remove($pool) } }");
    expect(steps).toContain("& sc.exe delete $Service | Out-Null");
    expect(steps).toContain('$Pools = @($PoolRoles | ForEach-Object { "$Alias-$_" })');
  });

  it("writes nothing under Program Files, and makes the pools' grants inheritable on the slot's own folders only", () => {
    expect(steps.split("\n").filter((l) => /Program Files/.test(l))).toEqual([expect.stringMatching(/^\$DeniedRoots = @\('C:\\Program Files \(x86\)\\Aras\\Innovator'/)]);
    const icacls = [...steps.matchAll(/& icacls\.exe [^\n]*/g)].map((m) => m[0]);
    expect(icacls).toEqual([
      "& icacls.exe $SlotDir /grant '*S-1-5-32-568:(OI)(CI)M' '*S-1-5-17:(OI)(CI)RX' /Q | Out-Null",
      "& icacls.exe $VaultDir /grant '*S-1-5-32-568:(OI)(CI)M' /Q | Out-Null",
    ]);
    expect(steps).toContain("& robocopy.exe $tree $SlotDir /MIR /XJ /R:2 /W:1 /MT:16 /XF $StampName /NFL /NDL /NJH /NJS /NP | Out-Null");
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
