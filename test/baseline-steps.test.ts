import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderBaselineBuildScript } from "../src/core/baseline-script.js";
import { PS_STEPS, renderBuildStepsScript } from "../src/broker/baseline-steps.js";
import { msiInstallProperties, baselinePlan } from "../src/core/baseline.js";
import { FLAVOR_KEYS } from "../src/core/flavors.js";
import { buildScratch } from "../src/core/names.js";
import { repoRoot } from "./helpers.js";

const steps = renderBuildStepsScript();

describe("baseline-steps.ps1 (static)", () => {
  it("is plain ASCII and answers every step the build system asks for", () => {
    expect(steps).toMatch(/^[\x00-\x7f]*$/);
    for (const step of PS_STEPS) expect(steps, step).toContain(`    '${step}' {`);
    expect(steps).toContain(`if (@(${PS_STEPS.map((s) => `'${s}'`).join(", ")}) -cnotcontains $Step)`);
  });

  it("takes nothing from the request but the flavor and the restore step's two passwords", () => {
    const used = [...steps.matchAll(/\$request\.([A-Za-z.]+)/g)].map((m) => m[1]);
    expect([...new Set(used)].sort()).toEqual(["flavor", "secrets.dbo", "secrets.reg"]);
    expect(steps).toContain("if ($FlavorKeys -cnotcontains $Flavor) { Stop-Step 'the request names no registered flavor' }");
  });

  it("derives every name the way names.ts does, and acts on SQL objects only by those names", () => {
    expect(steps).toContain('$Alias = "ah-build-$Flavor"');
    expect(steps).toContain('$Database = "arashouse_build_$Flavor"');
    expect(steps).toContain("$BuildDir = Join-Path $Root \"golden-build\\$Flavor\"");
    expect(steps).toContain("$Golden = Join-Path $Root \"golden\\$Flavor\"");
    for (const statement of ["DROP DATABASE", "RESTORE DATABASE", "BACKUP DATABASE", "ALTER DATABASE"]) {
      for (const m of steps.matchAll(new RegExp(`${statement} [^\\n]*`, "g"))) {
        expect(m[0], statement).toMatch(/^[A-Z_ ]+ (\$db\b|" \+ \(Format-Ident \$Database\))/);
      }
    }
    for (const m of steps.matchAll(/(CREATE|DROP) LOGIN [^\n]*/g)) expect(m[0]).toMatch(/Format-Ident \$(pair\[0\]|login\b)/);
    // ootb.bak is taken with the broker as the database's owner, so a slot restored from it is the broker's inside too (ticket 25).
    expect([...steps.matchAll(/ALTER AUTHORIZATION [^\n]*/g)].map((m) => m[0])).toEqual(['ALTER AUTHORIZATION ON DATABASE::" + (Format-Ident $Database) + " TO " + (Format-Ident $BrokerLogin)) | Out-Null']);
    expect(steps).toContain("$BrokerLogin = 'NT SERVICE\\ArasHouseBroker'");
    expect(steps).toContain("foreach ($pair in @(@($LoginDbo, $dbo), @($LoginReg, $reg)))");
    expect(steps).toContain("foreach ($login in @($LoginDbo, $LoginReg))");
  });

  it("writes nothing under Program Files and reads the captain's install roots only for a hash", () => {
    const lines = steps.split("\n").filter((l) => /Program Files/.test(l));
    expect(lines).toEqual([expect.stringMatching(/^\$DeniedRoots = @\('C:\\Program Files \(x86\)\\Aras\\Innovator'/)]);
    expect(steps).toContain("Get-FileHash -LiteralPath $cfg -Algorithm SHA256");
  });

  it("deletes the MSI log and never logs the properties' values", () => {
    expect(steps).toContain("$installer.EnableLog('iwearucmo', $log)");
    expect(steps).toContain("Remove-Item -LiteralPath $log -Force");
    expect(steps).toContain("MsiHiddenProperties=");
    expect(steps).not.toMatch(/\/l\*v|EnableLog\('[^']*[vxp]/);
  });

  it("gives IIS_IUSRS modify on every file of the instance, since the MSI turns inheritance off on OAuthServer\\App_Data", () => {
    expect(steps).toContain("& icacls.exe $dir /grant '*S-1-5-32-568:(OI)(CI)M' /T /C /Q | Out-Null");
    expect(steps).toContain("foreach ($dir in @($BuildDir, $VaultRoot))");
  });

  it("waits for, then ends, the out-of-process applications started from the build folder (14.x), when it stops and removes", () => {
    expect(steps).toContain("function Stop-BuildProcesses {");
    expect(steps).toContain("(Test-Under $_.ExecutablePath $BuildDir)");
    expect(steps).toContain("$_.CommandLine.IndexOf($BuildDir + '\\', [StringComparison]::OrdinalIgnoreCase)");
    expect(steps).toContain("$ended = Stop-BuildProcesses");
    const remove = steps.slice(steps.indexOf("    'remove' {"));
    expect(remove.indexOf("[void](Stop-BuildProcesses)")).toBeGreaterThan(-1);
    expect(remove.indexOf("[void](Stop-BuildProcesses)")).toBeLessThan(remove.indexOf("msiexec.exe"));
  });

  it("installs the agent under the build's own AS_FOLDER and port, with the properties the plan sets", () => {
    for (const key of FLAVOR_KEYS) {
      const a = buildScratch(key).agent;
      expect(steps).toContain(`    '${key}' = @{ service = '${a.service}'; folder = '${a.folder}'; port = ${a.port}; address = '${a.address}' }`);
    }
    const install = steps.slice(steps.indexOf("    'install' {"), steps.indexOf("    'pools' {"));
    // Every property the plan sets is in the step's list; none is the MSI's default agent folder or port.
    for (const name of Object.keys(msiInstallProperties(baselinePlan("12sp9", { msiSha256: "0".repeat(64) })))) expect(install, name).toMatch(new RegExp(`\\b${name} = `));
    expect(install).toContain("INSTALL_AGENT_SERVICE = '1'");
    expect(install).toContain("AS_FOLDER = $AgentFolder; AS_HOST = 'localhost'; AS_PORT = [string]$AgentPort; INNOVATOR_TO_SERVICE_ADDRESS = $AgentAddress");
    expect(install).toContain("$builtIn = @('INSTALLDIR', 'VAULT_ROOT', 'REBOOT', 'MSIRESTARTMANAGERCONTROL', 'INNOVATOR_TO_SERVICE_ADDRESS')");
    expect(steps).not.toMatch(/8734|AS_FOLDER = 'ArasInnovatorAgent'/);
  });

  it("starts, stops and deletes only the build's own agent service, by its recorded name and with its executable in the build folder", () => {
    for (const m of steps.matchAll(/(Start-Service|Stop-Service|sc\.exe delete|New-Service|Set-Service) [^\n]*/g)) {
      expect(m[0]).toMatch(/^(Start-Service -Name \$AgentService$|Stop-Service -Name \$AgentService -Force -ErrorAction SilentlyContinue \}|sc\.exe delete \$AgentService \| Out-Null)/);
    }
    expect(steps).toContain("if (-not (Test-Under (Get-ServiceExe $svc) $BuildDir)) { return $null }");
    expect(steps).toContain(`if (-not (Test-Under (Get-ServiceExe $svc) $BuildDir)) { Stop-Step "the service $AgentService does not run an executable inside $BuildDir" }`);
    const remove = steps.slice(steps.indexOf("    'remove' {"));
    expect(remove.slice(0, remove.indexOf("sc.exe delete"))).toContain("if (Get-BuildAgent) {");
    // The service is stopped through the service manager before the build ends its processes: the MSI sets it to restart on failure.
    expect(remove.indexOf("Stop-BuildAgent")).toBeLessThan(remove.indexOf("[void](Stop-BuildProcesses)"));
    const stop = steps.slice(steps.indexOf("    'stop' {"));
    expect(stop.indexOf("Stop-BuildAgent")).toBeLessThan(stop.indexOf("$ended = Stop-BuildProcesses"));
  });

  it("leaves the build's agent service out of the deny-list fingerprints, and only that one name", () => {
    expect(steps).toContain("$OwnServices = @($AgentService)");
    expect(steps).toContain("if (@($OwnServices) -contains $svc.Name) { continue }");
    // The survey reports it by name, so a leftover is found even though the fingerprints leave it out.
    expect(steps).toContain("if (($svc.Name -ieq $AgentService) -or ($image -and (Test-Under $image $BuildDir))) { $present += \"service $($svc.Name)\" }");
  });

  it("removes only the build alias's applications and pools", () => {
    expect(steps).toContain("$s.Applications | Where-Object { Test-BuildApp $_.Path }");
    expect(steps).toContain("$_.Name.StartsWith($PoolPrefix, [StringComparison]::OrdinalIgnoreCase)");
    expect(steps).toContain('function Test-BuildApp([string]$Path) { return ($Path -ieq "/$Alias") -or $Path.StartsWith("/$Alias/", [StringComparison]::OrdinalIgnoreCase) }');
  });
});

/** Windows PowerShell 5.1 from WSL, when it is there: the scripts target it. */
function findPowerShell(): string | undefined {
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" });
  return probe.status === 0 ? "powershell.exe" : undefined;
}
const ps = findPowerShell();
const describeWithPs = ps ? describe : describe.skip;

describeWithPs("the generated baseline scripts under Windows PowerShell", () => {
  it("parse without a syntax error", () => {
    const dir = mkdtempSync(join(tmpdir(), "arashouse-steps-"));
    try {
      const pinned = ["app\\broker\\baseline-main.js", "package.json", "plan.json", "baseline-steps.ps1"].map((path) => ({ path, sha256: "0".repeat(64) }));
      writeFileSync(join(dir, "baseline-steps.ps1"), steps.replace(/\n/g, "\r\n"), "ascii");
      writeFileSync(join(dir, "baseline-build.ps1"), renderBaselineBuildScript({ flavor: "12sp9", version: "0.0.0", pinned }).replace(/\n/g, "\r\n"), "ascii");
      const win = (p: string) => execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim();
      const r = spawnSync(
        ps as string,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", win(join(repoRoot, "test/spike-parse.ps1")), win(join(dir, "baseline-steps.ps1")), win(join(dir, "baseline-build.ps1"))],
        { encoding: "utf8", cwd: existsSync("/mnt/c") ? "/mnt/c" : undefined },
      );
      expect(r.stdout.trim()).toBe("errors=0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
