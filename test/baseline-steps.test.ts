import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderBaselineBuildScript } from "../src/core/baseline-script.js";
import { PS_STEPS, renderBuildStepsScript } from "../src/broker/baseline-steps.js";
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
