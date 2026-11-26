// Ticket 50's host scripts (docs/audit.md): plain ASCII, so Windows PowerShell 5.1 reads them without a BOM, and free of
// syntax errors when a PowerShell is at hand (as in test/audit-leak-check.test.ts). The secret search refuses to run
// unelevated before it reads anything.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";
import { describeWithPs, elevated, ps, runPsFile, toHostPath } from "./powershell.js";

const SCRIPTS = ["test/host/audit-probe.ps1", "test/host/audit-sql.ps1", "test/host/audit-secrets.ps1", "test/host/login-check.ps1"];

const run = (file: string, args: string[]) => runPsFile(file, args, { timeout: 60_000 });

describe("ticket 50's host scripts (static)", () => {
  it.each(SCRIPTS)("%s is plain ASCII", (script) => {
    expect(readFileSync(join(repoRoot, script), "utf8")).toMatch(/^[\x00-\x7f]*$/);
  });
});

describeWithPs(`ticket 50's host scripts under ${ps}`, { timeout: 60_000 }, () => {
  it.each(SCRIPTS)("%s parses without a syntax error", (script) => {
    const r = run(join(repoRoot, "test/spike-parse.ps1"), [toHostPath(join(repoRoot, script))]);
    expect(r.out.trim()).toBe("errors=0");
  });

  // An elevated shell (a Windows CI runner) passes the check this case is about, and the script would go on to the host.
  it.skipIf(elevated())("the secret search refuses without elevation, before it reads anything (the worker's shell is not elevated)", () => {
    const r = run(join(repoRoot, "test/host/audit-secrets.ps1"), []);
    expect(r.code).toBe(4);
    expect(r.err).toContain("run it elevated");
  });
});
