import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

const script = join(repoRoot, "scripts/host-tuning.ps1");

/** As in test/spike.test.ts: SPIKE_POWERSHELL, else Windows PowerShell 5.1 from WSL; the script targets Windows, so a Linux pwsh is not enough. */
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

function runFile(file: string, args: string[]) {
  const r = spawnSync(ps as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", toHostPath(file), ...args], {
    encoding: "utf8",
    cwd,
    timeout: 120_000,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const dir = mkdtempSync(join(tmpdir(), "host-tuning-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// Every run gets a state folder and a .wslconfig path of its own, so no test can reach the real ones.
const sandbox = (name: string) => ["-StateDir", toHostPath(join(dir, `${name}-state`)), "-WslConfigPath", toHostPath(join(dir, `${name}-wslconfig`))];
const run = (name: string, args: string[]) => runFile(script, ["-NoInventory", ...sandbox(name), ...args]);

describe("scripts/host-tuning.ps1 (static)", () => {
  it("is plain ASCII, so Windows PowerShell 5.1 reads it without a BOM", () => {
    expect(readFileSync(script, "utf8")).toMatch(/^[\x00-\x7f]*$/);
  });

  it("is documented in docs/host-tuning.md", () => {
    const doc = readFileSync(join(repoRoot, "docs/host-tuning.md"), "utf8");
    for (const p of ["-WslMemoryGB", "-SqlMaxServerMemoryMB", "-DefenderExclusion", "-FirewallWslOnly", "-Undo"]) expect(doc, p).toContain(p);
  });

  it("never shuts WSL down and touches only its fixed Defender path and firewall rules", () => {
    const text = readFileSync(script, "utf8");
    expect(text).not.toMatch(/&\s*wsl(\.exe)?\b/i);
    expect(text).toContain("$ExcludedPath = 'C:\\aras_installations'");
    expect(text).toContain("$IisRule = 'IIS-WebServerRole-HTTP-In-TCP'");
    expect(text).toContain("$OwnRule = 'arashouse-http-in-wsl'");
    expect(text).toContain("Initial Catalog=master;");
  });
});

// Each test starts Windows PowerShell several times (about 2 s each).
describeWithPs(`scripts/host-tuning.ps1 under ${ps}`, { timeout: 60_000 }, () => {
  it("parses without a syntax error", () => {
    const r = runFile(join(repoRoot, "test/spike-parse.ps1"), [toHostPath(script)]);
    expect(r.out.trim()).toBe("errors=0");
  });

  it("dry run of every item prints only the plan and writes nothing", () => {
    const r = run("dry", ["-WslMemoryGB", "12", "-WslAutoMemoryReclaim", "gradual", "-SqlMaxServerMemoryMB", "4096", "-DefenderExclusion", "-FirewallWslOnly"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const lines = r.out.split(/\r?\n/).filter((l) => l.trim());
    expect(lines.filter((l) => !/^(would do: |dry run: )/.test(l))).toEqual([]);
    expect(lines.filter((l) => l.startsWith("would do: "))).toHaveLength(4);
    expect(r.out).toContain("memory=12GB and autoMemoryReclaim=gradual");
    expect(r.out).toContain("4096 MB");
    expect(existsSync(join(dir, "dry-state"))).toBe(false);
    expect(existsSync(join(dir, "dry-wslconfig"))).toBe(false);
  });

  it("dry run of an undo with nothing recorded skips every item", () => {
    const r = run("undo-empty", ["-Undo", "Wsl,Sql,Defender,Firewall"]);
    expect(r.code).toBe(0);
    expect(r.out.match(/^skip: /gm)).toHaveLength(4);
  });

  it.each([
    [["-Undo", "Registry"], /-Undo takes/],
    [["-Undo", "Sql", "-SqlMaxServerMemoryMB", "4096"], /both applied and undone/],
    [["-WslAutoMemoryReclaim", "gradual"], /goes with -WslMemoryGB/],
    [["-FirewallWslRange", "10.0.0.0/8"], /goes with -FirewallWslOnly/],
  ])("refuses %j", (args, message) => {
    const r = run("refuse", args);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(message);
    expect(r.out).not.toMatch(/would do:/);
  });

  it("writes the WSL cap into an existing .wslconfig, keeps its other lines, and undoes to the same bytes", () => {
    const config = join(dir, "wsl-wslconfig");
    const before = "[wsl2]\nswap=4GB\nmemory=20GB\n\n[interop]\nenabled=true\n";
    writeFileSync(config, before);
    const apply = run("wsl", ["-WslMemoryGB", "12", "-WslAutoMemoryReclaim", "gradual", "-Apply"]);
    expect(apply.err).toBe("");
    expect(apply.code).toBe(0);
    expect(readFileSync(config, "utf8")).toBe(
      "[wsl2]\r\nswap=4GB\r\nmemory=12GB\r\n\r\n[interop]\r\nenabled=true\r\n\r\n[experimental]\r\nautoMemoryReclaim=gradual\r\n",
    );
    // A second apply changes the value but keeps the original for the undo.
    expect(run("wsl", ["-WslMemoryGB", "10", "-Apply"]).code).toBe(0);
    expect(readFileSync(config, "utf8")).toContain("memory=10GB\r\n");
    const undo = run("wsl", ["-Undo", "Wsl", "-Apply"]);
    expect(undo.code).toBe(0);
    expect(readFileSync(config, "utf8")).toBe(before);
  });

  it("deletes a .wslconfig it created, and refuses to undo one changed after it wrote it", () => {
    const config = join(dir, "new-wslconfig");
    expect(run("new", ["-WslMemoryGB", "12", "-Apply"]).code).toBe(0);
    expect(readFileSync(config, "utf8")).toBe("[wsl2]\r\nmemory=12GB\r\n");
    writeFileSync(config, "[wsl2]\r\nmemory=14GB\r\n");
    const refused = run("new", ["-Undo", "Wsl", "-Apply"]);
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/changed after this script wrote it/);
    expect(existsSync(config)).toBe(true);
    expect(run("new", ["-WslMemoryGB", "12", "-Apply"]).code).toBe(0);
    expect(run("new", ["-Undo", "Wsl", "-Apply"]).code).toBe(0);
    expect(existsSync(config)).toBe(false);
  });

  it("edits ini text and checks address ranges", () => {
    const cases: [string, string][] = [
      ["Set-WslConfigValue||wsl2|memory|12GB", "[wsl2]\\nmemory=12GB\\n"],
      ["Set-WslConfigValue|[WSL2]\\nMemory = 4GB\\n|wsl2|memory|12GB", "[WSL2]\\nmemory=12GB\\n"],
      ["Set-WslConfigValue|[wsl2]\\nswap=0\\n\\n[boot]\\nsystemd=true|wsl2|memory|12GB", "[wsl2]\\nswap=0\\nmemory=12GB\\n\\n[boot]\\nsystemd=true\\n"],
      ["Set-WslConfigValue|[boot]\\nsystemd=true|wsl2|memory|8GB", "[boot]\\nsystemd=true\\n\\n[wsl2]\\nmemory=8GB\\n"],
      ["Set-WslConfigValue|[boot]\\n# memory=1GB\\n|boot|memory|8GB", "[boot]\\n# memory=1GB\\nmemory=8GB\\n"],
      ["Read-WslConfigValue|[wsl2]\\nmemory = 12GB|wsl2|memory", "12GB"],
      ["Read-WslConfigValue|[boot]\\nmemory=12GB|wsl2|memory", ""],
      ["Test-InRange|172.19.0.1|172.16.0.0/12", "True"],
      ["Test-InRange|172.31.255.254|172.16.0.0/12", "True"],
      ["Test-InRange|172.32.0.1|172.16.0.0/12", "False"],
      ["Test-InRange|192.168.1.10|172.16.0.0/12", "False"],
      ["Test-InRange|10.1.2.3|0.0.0.0/0", "True"],
    ];
    const caseFile = join(dir, "cases.txt");
    writeFileSync(caseFile, cases.map(([c]) => c).join("\n") + "\n");
    const r = runFile(join(repoRoot, "test/host-tuning-functions.ps1"), ["-Script", toHostPath(script), "-CaseFile", toHostPath(caseFile)]);
    expect(r.err).toBe("");
    expect(r.out.split(/\r?\n/).slice(0, cases.length)).toEqual(cases.map(([, want]) => want));
  });
});
