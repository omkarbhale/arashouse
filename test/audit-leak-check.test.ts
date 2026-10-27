import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

const script = join(repoRoot, "test/host/audit-leak-check.ps1");
const text = readFileSync(script, "utf8");

/** As in test/host-tuning.test.ts: SPIKE_POWERSHELL, else Windows PowerShell 5.1 from WSL. */
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

const INSIDE = "C:\\aras_installations\\staging\\e2e-12sp9\\leak-cycle-1.dpapi";

describe("test/host/audit-leak-check.ps1 (static)", () => {
  it("is plain ASCII, so Windows PowerShell 5.1 reads it without a BOM", () => {
    expect(text).toMatch(/^[\x00-\x7f]*$/);
  });
});

describeWithPs(`test/host/audit-leak-check.ps1 under ${ps}`, { timeout: 60_000 }, () => {
  it("parses without a syntax error", () => {
    const r = run(join(repoRoot, "test/spike-parse.ps1"), [toHostPath(script)]);
    expect(r.out.trim()).toBe("errors=0");
  });

  it.each([
    ["a file outside staging", "C:\\aras_installations\\logs\\leak.dpapi"],
    ["a path that climbs out of staging", "C:\\aras_installations\\staging\\..\\secrets\\leak.dpapi"],
    ["staging itself", "C:\\aras_installations\\staging"],
  ])("refuses %s (exit 2)", (_name, file) => {
    const r = run(script, ["-PasswordsFile", file]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("-PasswordsFile must be under");
  });

  it("refuses without elevation, before it reads anything (the worker's shell is not elevated)", () => {
    const r = run(script, ["-PasswordsFile", INSIDE]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("run it elevated");
  });
});
