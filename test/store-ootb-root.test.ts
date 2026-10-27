import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

const script = join(repoRoot, "scripts/store-ootb-root.ps1");
const text = readFileSync(script, "utf8");

/** As in test/store-licence.test.ts: SPIKE_POWERSHELL, else Windows PowerShell 5.1 from WSL. */
function findPowerShell(): string | undefined {
  const candidates = [process.env.SPIKE_POWERSHELL, "powershell.exe"].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    const probe = spawnSync(c, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" });
    if (probe.status === 0) return c;
  }
  return undefined;
}

const ps = findPowerShell();
const windows = ps?.toLowerCase().endsWith(".exe") ?? false;
const toHostPath = (p: string) => (windows ? execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim() : p);
const cwd = windows && existsSync("/mnt/c") ? "/mnt/c" : undefined;
const describeWithPs = ps ? describe : describe.skip;

function run(file: string, args: string[]) {
  const r = spawnSync(ps as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", toHostPath(file), ...args], {
    encoding: "utf8",
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

// A path that names no real file: neither the dry run nor the refused -Apply opens it.
const FILE = "C:\\aras_installations\\staging\\example\\root.dpapi";

describe("scripts/store-ootb-root.ps1 (static)", () => {
  it("is plain ASCII, so Windows PowerShell 5.1 reads it without a BOM", () => {
    expect(text).toMatch(/^[\x00-\x7f]*$/);
  });

  it("sends the password on the client's stdin only, never in an argument list", () => {
    expect(text).toContain("verb = 'storeOotbRoot'");
    expect(text).toContain("$psi.Arguments = '\"' + $Client + '\"'");
    expect(text).not.toMatch(/Write-(Output|Host)[^\n]*\$(secure|bstr|bytes|request)/i);
  });
});

describeWithPs(`scripts/store-ootb-root.ps1 under ${ps}`, { timeout: 60_000 }, () => {
  it("parses without a syntax error", () => {
    const r = run(join(repoRoot, "test/spike-parse.ps1"), [toHostPath(script)]);
    expect(r.out.trim()).toBe("errors=0");
  });

  it("dry run prints the plan, reads nothing and changes nothing", () => {
    const r = run(script, ["-Flavor", "12sp9", "-PasswordFile", FILE]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`would do: decrypt the password in ${FILE} as the current Windows user`);
    expect(r.out).toContain("for 12sp9 (C:\\aras_installations\\secrets\\ootb-root-12sp9.bin)");
    expect(r.out).toContain("dry run: nothing was read or changed");
  });

  it("refuses a flavor that is not one of the registry's", () => {
    expect(run(script, ["-Flavor", "olm", "-PasswordFile", FILE]).code).not.toBe(0);
  });

  it("refuses -Apply without elevation, before it reads anything (the worker's shell is not elevated)", () => {
    const r = run(script, ["-Flavor", "12sp9", "-PasswordFile", FILE, "-Apply"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("run it elevated");
  });
});
