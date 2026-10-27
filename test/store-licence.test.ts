import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

const script = join(repoRoot, "scripts/store-licence.ps1");
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

// A path of the approved shape that names no real install: the dry run never opens it.
const SOURCE = "C:\\Program Files (x86)\\ArasExample\\Innovator\\InnovatorServerConfig.xml";

describe("scripts/store-licence.ps1 (static)", () => {
  it("is plain ASCII, so Windows PowerShell 5.1 reads it without a BOM", () => {
    expect(text).toMatch(/^[\x00-\x7f]*$/);
  });
});

describeWithPs(`scripts/store-licence.ps1 under ${ps}`, { timeout: 60_000 }, () => {
  it("parses without a syntax error", () => {
    const r = run(join(repoRoot, "test/spike-parse.ps1"), [toHostPath(script)]);
    expect(r.out.trim()).toBe("errors=0");
  });

  it("dry run prints the plan, reads nothing and changes nothing", () => {
    const r = run(script, ["-Line", "12", "-SourceConfig", SOURCE]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`would do: read the <License> element (lic_key, act_key, lic_type, company) of ${SOURCE}, read only`);
    expect(r.out).toContain("as the licence of line 12 (C:\\aras_installations\\secrets\\licence-12.bin)");
    expect(r.out).toContain("dry run: nothing was read or changed");
  });

  it.each([
    ["a file that is not an install's server config", "C:\\Program Files (x86)\\ArasExample\\Innovator\\Other.xml"],
    ["a config outside Program Files", "C:\\aras_installations\\slots\\12sp9\\01\\InnovatorServerConfig.xml"],
    ["a path that climbs out of the install", "C:\\Program Files (x86)\\ArasExample\\Innovator\\..\\..\\..\\aras_installations\\Innovator\\InnovatorServerConfig.xml"],
    ["a folder that is not an Aras install", "C:\\Program Files\\Other\\Innovator\\InnovatorServerConfig.xml"],
  ])("refuses %s (exit 2), with or without -Apply", (_name, source) => {
    for (const apply of [[], ["-Apply"]]) {
      const r = run(script, ["-Line", "12", "-SourceConfig", source, ...apply]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("-SourceConfig must be");
    }
  });

  it("refuses a line that is not 12 or 14", () => {
    expect(run(script, ["-Line", "13", "-SourceConfig", SOURCE]).code).not.toBe(0);
  });

  it("refuses -Apply without elevation, before it reads anything (the worker's shell is not elevated)", () => {
    const r = run(script, ["-Line", "12", "-SourceConfig", SOURCE, "-Apply"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("run it elevated");
  });
});
