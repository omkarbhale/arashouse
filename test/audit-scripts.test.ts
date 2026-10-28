// Ticket 50's host scripts (docs/audit.md): plain ASCII, so Windows PowerShell 5.1 reads them without a BOM, and free of
// syntax errors when a PowerShell is at hand (as in test/audit-leak-check.test.ts). The secret search refuses to run
// unelevated before it reads anything.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

const SCRIPTS = ["test/host/audit-probe.ps1", "test/host/audit-sql.ps1", "test/host/audit-secrets.ps1", "test/host/login-check.ps1"];

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

describe("ticket 50's host scripts (static)", () => {
  it.each(SCRIPTS)("%s is plain ASCII", (script) => {
    expect(readFileSync(join(repoRoot, script), "utf8")).toMatch(/^[\x00-\x7f]*$/);
  });

  it("the SQL script never names a database of the captain's, and drops the throw-away one it makes", () => {
    const text = readFileSync(join(repoRoot, "test/host/audit-sql.ps1"), "utf8");
    expect(text).not.toMatch(/'OLM_Local'|\[OLM_Local\]|InnovatorSolutions'|RabbitDemo/);
    expect(text).toMatch(/DROP DATABASE \[\$Foreign\]/);
  });
});

describeWithPs(`ticket 50's host scripts under ${ps}`, { timeout: 60_000 }, () => {
  it.each(SCRIPTS)("%s parses without a syntax error", (script) => {
    const r = run(join(repoRoot, "test/spike-parse.ps1"), [toHostPath(join(repoRoot, script))]);
    expect(r.out.trim()).toBe("errors=0");
  });

  it("the secret search refuses without elevation, before it reads anything (the worker's shell is not elevated)", () => {
    const r = run(join(repoRoot, "test/host/audit-secrets.ps1"), []);
    expect(r.code).toBe(4);
    expect(r.err).toContain("run it elevated");
  });
});
