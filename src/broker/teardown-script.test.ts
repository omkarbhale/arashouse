import { describe, expect, it } from "vitest";
import { FLAVOR_KEYS } from "../core/flavors.js";
import { DENIED_ALIASES, DENIED_DATABASES, DENIED_SERVICE_PREFIXES } from "../core/guards.js";
import {
  APP_POOL_ROLES,
  BUILD_SCRATCH_SUFFIXES,
  MAX_SLOT,
  UTILITY_DATABASE,
  agentServiceName,
  appPoolName,
  buildNames,
  buildScratch,
  databaseName,
  loginName,
  webAlias,
} from "../core/names.js";
import { HOST_TUNING_FIREWALL_RULE, HOST_TUNING_STATE, TEARDOWN_CHILDREN, renderTeardownScript, teardownPatterns } from "./teardown-script.js";

const HOST = "a".repeat(64);
const SQL = "b".repeat(64);
const script = renderTeardownScript({ version: "0.0.0", setupHostSha256: HOST, setupSqlSha256: SQL });
const lines = script.split("\n");

/** The body of `function <name>`, up to its closing brace at the start of a line. */
function body(name: string): string {
  const at = script.indexOf(`function ${name}`);
  if (at === -1) throw new Error(`no function ${name}`);
  return script.slice(at, script.indexOf("\n}\n", at) + 2);
}

/** The PowerShell regexes the script carries, compiled as PowerShell's -match does (case-insensitive). */
const patterns = Object.fromEntries(Object.entries(teardownPatterns()).map(([k, v]) => [k, new RegExp(v, "i")])) as Record<keyof ReturnType<typeof teardownPatterns>, RegExp>;

describe("teardown.ps1 (generated)", () => {
  it("is plain ASCII, takes -Apply, -Goldens, -KeepSql and -RemoveRoot, and needs elevation to apply", () => {
    expect(script).toMatch(/^[\x00-\x7f]*$/);
    expect(script).toMatch(/param\(\s*\[switch\]\$Apply,\s*\[switch\]\$Goldens,\s*\[switch\]\$KeepSql,\s*\[switch\]\$RemoveRoot\s*\)/);
    expect(script).toContain("if ($Apply -and -not (Test-Elevated)) { Fail 4 ");
    expect(script).toContain("if ($RemoveRoot -and -not $Goldens) { Fail 2 ");
    expect(script).toContain("if ($RemoveRoot -and $KeepSql) { Fail 2 ");
  });

  it("runs its two child scripts only when they are the bytes it was generated with", () => {
    expect(script).toContain(`$HostScript = Join-Path $PSScriptRoot '${TEARDOWN_CHILDREN.host}'`);
    expect(script).toContain(`$HostScriptSha256 = '${HOST}'`);
    expect(script).toContain(`$SqlScript = Join-Path $PSScriptRoot '${TEARDOWN_CHILDREN.sql}'`);
    expect(script).toContain(`$SqlScriptSha256 = '${SQL}'`);
    const check = script.indexOf("if ((Get-Sha256 $child[0]) -ne $child[1]) { Fail 3 ");
    expect(check).toBeGreaterThan(-1);
    // The check comes before any read or change.
    expect(check).toBeLessThan(script.indexOf("$denyBefore = Get-DenyList"));
    // The children run with -Uninstall only (and -RemoveRoot, -Apply as given), never their install.
    const calls = lines.filter((l) => /Invoke-Child '/.test(l));
    expect(calls).toEqual([
      "        $sql = Invoke-Child 'sql' $SqlScript @('-Uninstall')",
      "    $hostRun = Invoke-Child 'host' $HostScript $hostArgs",
    ]);
    expect(script).toContain("$hostArgs = @('-Uninstall') + @($(if ($RemoveRoot) { '-RemoveRoot' }))");
    expect(body("Invoke-Child")).toContain("if ($Apply) { $all += '-Apply' }");
    expect(() => renderTeardownScript({ version: "0.0.0", setupHostSha256: "x", setupSqlSha256: SQL })).toThrow("SHA-256");
  });

  it("changes nothing of its own outside Invoke-Change: the goldens, by their derived paths, with no junction in them", () => {
    const invoke = body("Invoke-Change");
    expect(invoke.indexOf("return")).toBeLessThan(invoke.indexOf("& $Action"));
    // Remove-Item only in Remove-Golden, and Remove-Golden only inside an Invoke-Change block.
    const removes = lines.filter((l) => /Remove-Item\b/.test(l));
    expect(removes).toEqual(["    Remove-Item -LiteralPath $Path -Recurse -Force"]);
    expect(body("Remove-Golden")).toContain("Remove-Item -LiteralPath $Path -Recurse -Force");
    const uses = lines.filter((l) => /Remove-Golden\b/.test(l) && !l.startsWith("function"));
    expect(uses).toEqual(["            if (Test-Path -LiteralPath $path) { Invoke-Change \"remove the $key golden, $path\" { Remove-Golden $path } }"]);
    expect(body("Remove-Golden")).toContain("if (-not (Test-Under $Path ($Root + '\\golden'))) { throw");
    expect(body("Remove-Golden")).toContain("-Attributes ReparsePoint");
    for (const key of FLAVOR_KEYS) expect(script).toContain(`    '${key}' = 'C:\\aras_installations\\golden\\${key}'`);
    // Nothing else of its own that could change the host.
    expect(script).not.toMatch(/\b(New-Item|Copy-Item|Move-Item|Set-Acl|SetAccessControl|New-Service|Stop-Service|Remove-MpPreference|Remove-NetFirewallRule|Set-ItemProperty|robocopy|icacls|sc\.exe|net\.exe)\b/);
    expect(script).not.toMatch(/\b(DROP|ALTER|CREATE|RESTORE|BACKUP|KILL|EXEC)\b/);
    // The one write is the result, with -Apply, next to the script.
    expect(lines.filter((l) => /WriteAllText/.test(l))).toEqual(["if ($Apply) { [IO.File]::WriteAllText($ResultFile, $json, (New-Object Text.ASCIIEncoding)) }"]);
  });

  it("refuses before any change while a slot is left, or (with -Goldens) a baseline build's leftovers", () => {
    const main = script.slice(script.indexOf("# ---- main ----"));
    const firstChange = main.indexOf("Invoke-Change");
    expect(main.indexOf("if ($slotsLeft.Count -gt 0) { throw ")).toBeLessThan(firstChange);
    expect(main.indexOf("if (($Goldens -or $RemoveRoot) -and $buildsLeft.Count -gt 0) { throw ")).toBeLessThan(firstChange);
    expect(main.indexOf("if ($Apply -and $before.unread.Count -gt 0) { throw ")).toBeLessThan(firstChange);
    expect(main.indexOf("if ($Apply -and -not $denyBefore) { Fail 1 ")).toBeLessThan(firstChange);
    // A failed SQL uninstall leaves the broker installed rather than half-removing the pool.
    expect(main.indexOf("if (-not $sql.ok) { throw ")).toBeLessThan(main.indexOf("$hostRun = Invoke-Child"));
  });

  it("counts a tool folder it cannot list (the worker's view of golden\\, vaults\\, golden-build\\) as unread, not empty", () => {
    const left = body("Get-Leftovers");
    expect(left).toContain("$hidden = @($SlotsDir, $VaultsDir, ($Root + '\\golden'), $GoldenBuildDir | Where-Object { (Test-Path -LiteralPath $_) -and -not (Test-Listable $_) })");
    expect(left).toContain('foreach ($h in $hidden) { $left.unread += "folders: $h cannot be listed here" }');
    expect(left.indexOf("$hidden =")).toBeLessThan(left.indexOf("Get-ChildNames"));
    const reads = left.split("\n").filter((l) => l.includes("Get-ChildNames "));
    expect(reads).toHaveLength(2);
    expect(left).toMatch(/^\s*try \{ \$left\.goldens = .*\} catch \{ \$left\.goldens = @\(\) \}$/m);
    for (const l of reads) expect(l).toMatch(/^\s*try \{ .*Get-ChildNames .*\} catch \{/);
  });

  it("lists SQL Server only by the arashouse_ filter and the broker's exact login", () => {
    const sql = body("Get-SqlNames");
    const selects = sql.split("\n").filter((l) => /SELECT/.test(l));
    expect(selects).toEqual([
      `        $dbs = & $read "SELECT name FROM sys.databases WHERE name LIKE N'arashouse[_]%'"`,
      `        $logins = & $read "SELECT name FROM sys.server_principals WHERE name LIKE N'arashouse[_]%' OR name = @pool"`,
    ]);
    expect(script).toContain("Data Source=lpc:.;Initial Catalog=master;Integrated Security=SSPI;Connect Timeout=10;Pooling=False;Application Name=arashouse-teardown");
    expect(() => renderTeardownScript({ version: "0.0.0", setupHostSha256: HOST, setupSqlSha256: SQL, dataSource: "tcp:prod" })).toThrow("data source");
  });

  it("fingerprints the deny-list before and after and prints the objects' names, never their prints", () => {
    expect(script).toContain("function Get-DenyListPrints {");
    expect(script).toContain('foreach ($name in $denyBefore.Keys) { Write-Host "  $name" }');
    expect(script).toContain("$now = $(if (-not $denyAfter.Contains($name)) { 'gone' } elseif ($denyAfter[$name] -eq $denyBefore[$name]) { 'unchanged' } else { 'changed' })");
    expect(script).toContain("if ($moved.Count -gt 0) { [void]$Errors.Add(('the deny-list changed: {0}'");
    // The record carries the names only.
    expect(script).toContain("denyList = [ordered]@{ before = $(if ($denyBefore) { @($denyBefore.Keys) } else { $null }); after = @($deny) }");
    expect(lines.filter((l) => /Write-Host/.test(l) && /denyBefore\[|denyAfter\[/.test(l))).toEqual([]);
  });

  it("must leave no slot, broker, firewall rule or Defender exclusion; the goldens, SQL objects and root as asked", () => {
    expect(script).toContain("$mustGo = @('slotFolders', 'slotIis', 'slotServices', 'slotSql', 'broker', 'firewall', 'defender')");
    expect(script).toContain("if ($Goldens) { $mustGo += @('goldens', 'buildFolders', 'buildIis', 'buildSql') }");
    expect(script).toContain("if (-not $KeepSql) { $mustGo += 'setupSql' }");
    expect(script).toContain("if ($RemoveRoot) { $mustGo += 'root' }");
    expect(script).toContain(`$FirewallRule = '${HOST_TUNING_FIREWALL_RULE}'`);
  });

  it("names the undo of host settings an earlier arashouse recorded, and changes none itself (ticket 55)", () => {
    expect(script).toContain(`$TuningStateFile = Join-Path $env:LOCALAPPDATA '${HOST_TUNING_STATE}'`);
    expect(script).toContain("undo them with host-tuning.ps1 -Undo {0} -Apply");
    expect(script).not.toMatch(/Add-MpPreference|Set-MpPreference|New-NetFirewallRule|Disable-NetFirewallRule|sp_configure|powercfg/i);
  });

  it("holds no credential, no sa, and no path outside the install root or under Program Files", () => {
    expect(script).not.toMatch(/\bsa\b|password|licen[cs]e key|SecureString/i);
    for (const m of script.matchAll(/'([A-Za-z]:\\[^']*)'/g)) {
      const path = m[1] as string;
      if (path.startsWith("C:\\Program Files (x86)\\Aras")) continue; // the deny-list's own roots, only fingerprinted
      expect(path, path).toMatch(/^C:\\aras_installations(\\|$)/);
    }
    expect(() => renderTeardownScript({ version: "0.0.0", setupHostSha256: HOST, setupSqlSha256: SQL, root: "C:\\Program Files\\x" })).toThrow();
  });
});

describe("the names teardown.ps1 reports as the tool's", () => {
  it("are every name the tool derives, for every flavor and slot", () => {
    for (const flavor of FLAVOR_KEYS) {
      for (let slot = 1; slot <= MAX_SLOT; slot++) {
        const ref = { flavor, slot };
        expect(patterns.slotAlias.test(webAlias(ref))).toBe(true);
        for (const role of APP_POOL_ROLES) expect(patterns.slotPool.test(appPoolName(ref, role))).toBe(true);
        expect(patterns.slotService.test(agentServiceName(ref))).toBe(true);
        expect(patterns.slotDatabase.test(databaseName(ref))).toBe(true);
        expect(patterns.slotLogin.test(loginName(ref, "dbo")) && patterns.slotLogin.test(loginName(ref, "reg"))).toBe(true);
      }
      const build = buildNames(flavor);
      expect(patterns.buildAlias.test(build.alias)).toBe(true);
      for (const role of APP_POOL_ROLES) expect(patterns.buildPool.test(`${buildScratch(flavor).poolPrefix}${role}`)).toBe(true);
      expect(patterns.buildDatabase.test(build.database)).toBe(true);
      expect(patterns.buildLogin.test(buildScratch(flavor).logins.dbo) && patterns.buildLogin.test(buildScratch(flavor).logins.reg)).toBe(true);
      expect(patterns.buildFolder.test(flavor)).toBe(true);
      for (const suffix of BUILD_SCRATCH_SUFFIXES) expect(patterns.buildFolder.test(`${flavor}.${suffix}`)).toBe(true);
    }
  });

  it("are not the host's other objects: the ah-pp-* and arashouse_pp_* ones, the deny-list, the tool's own utility names", () => {
    const all = Object.values(patterns);
    const foreign = [
      "ah-pp-01",
      "ah-pp-01-root",
      "arashouse_pp_01",
      "arashouse_pp_01_dbo",
      "ah-12sp9-1",
      "ah-12sp9-001",
      "ah-12sp9-01x",
      "xah-12sp9-01",
      "ah-36-01",
      "arashouse_12sp9_01_dbx",
      "ArasHouseAgent_pp_01",
      "ah-build-pp",
      "arashouse_build_12sp9x",
      UTILITY_DATABASE,
      "arashouse_negative_madeup",
      ...DENIED_DATABASES,
      ...DENIED_ALIASES,
      ...DENIED_SERVICE_PREFIXES.map((p) => `${p}12sp9_01`),
    ];
    for (const name of foreign) for (const re of all) if (re !== patterns.buildFolder) expect(re.test(name), `${re} ${name}`).toBe(false);
    // The folder pattern is applied only to what is in golden-build\ (whose own names are the flavor keys).
    for (const name of ["12sp9.tmp", "12sp9.msi.old", "pp", "pp.msi", "12sp9x", "golden"]) expect(patterns.buildFolder.test(name), name).toBe(false);
  });
});
