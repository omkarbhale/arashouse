import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";
import { describeWithPs, elevated, ps, runPsFile, toHostPath } from "./powershell.js";

const script = join(repoRoot, "test/host/pool-measure.ps1");
const text = readFileSync(script, "utf8");

const run = (file: string, args: string[]) => runPsFile(file, args, { timeout: 60_000 });

describe("test/host/pool-measure.ps1 (static)", () => {
  it("is plain ASCII, so Windows PowerShell 5.1 reads it without a BOM", () => {
    expect(text).toMatch(/^[\x00-\x7f]*$/);
  });
});

describeWithPs(`test/host/pool-measure.ps1 under ${ps}`, { timeout: 60_000 }, () => {
  it("parses without a syntax error", () => {
    const r = run(join(repoRoot, "test/spike-parse.ps1"), [toHostPath(script)]);
    expect(r.out.trim()).toBe("errors=0");
  });

  // An elevated shell (a Windows CI runner) passes the check this case is about, and the script would go on to the host.
  it.skipIf(elevated())("refuses without elevation, before it reads anything (the worker's shell is not elevated)", () => {
    const r = run(script, []);
    expect(r.code).toBe(2);
    expect(r.err).toContain("run it elevated");
  });
});
