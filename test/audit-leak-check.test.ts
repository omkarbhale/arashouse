import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";
import { describeWithPs, elevated, ps, runPsFile, toHostPath } from "./powershell.js";

const script = join(repoRoot, "test/host/audit-leak-check.ps1");
const text = readFileSync(script, "utf8");

const run = (file: string, args: string[]) => runPsFile(file, args, { timeout: 60_000 });

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

  // An elevated shell (a Windows CI runner) passes the check this case is about, and the script would go on to the host.
  it.skipIf(elevated())("refuses without elevation, before it reads anything (the worker's shell is not elevated)", () => {
    const r = run(script, ["-PasswordsFile", INSIDE]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("run it elevated");
  });
});
