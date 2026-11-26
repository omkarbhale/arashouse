import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";
import { describeWithPs, ps, runPsFile, toHostPath } from "./powershell.js";

const script = join(repoRoot, "scripts/host-tuning.ps1");

const runFile = runPsFile;

const dir = mkdtempSync(join(tmpdir(), "host-tuning-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// Every run gets a state folder and a .wslconfig path of its own, so no test can reach the real ones.
const sandbox = (name: string) => ["-StateDir", toHostPath(join(dir, `${name}-state`)), "-WslConfigPath", toHostPath(join(dir, `${name}-wslconfig`))];
const run = (name: string, args: string[]) => runFile(script, ["-NoInventory", ...sandbox(name), ...args]);

describe("scripts/host-tuning.ps1 (static)", () => {
  const text = readFileSync(script, "utf8");

  it("is plain ASCII, so Windows PowerShell 5.1 reads it without a BOM", () => {
    expect(text).toMatch(/^[\x00-\x7f]*$/);
  });

  it("applies no host-wide setting: it only reads them and undoes what its ticket 44 version applied (ticket 55)", () => {
    expect(text).not.toMatch(/Add-MpPreference|Set-MpPreference|New-NetFirewallRule|Disable-NetFirewallRule|Set-NetFirewallRule|powercfg(\.exe)? \/(set|change)/i);
    expect(text).not.toMatch(/-WslMemoryGB|-SqlMaxServerMemoryMB|-DefenderExclusion|-FirewallWslOnly|function (Invoke-(Wsl|Sql|Defender|Firewall)|Set-WslConfigValue)\b/);
    // The one setter left puts back the value recorded before that apply, and only Undo-Sql calls it.
    const calls = [...text.matchAll(/Set-SqlMaxMemory \$/g)].map((m) => text.lastIndexOf("function ", m.index));
    expect(calls).toEqual([text.indexOf("function Undo-Sql")]);
  });

  it("is documented in docs/host-tuning.md", () => {
    const doc = readFileSync(join(repoRoot, "docs/host-tuning.md"), "utf8");
    for (const p of ["-Undo", "Wsl", "Sql", "Defender", "Firewall", "state.json"]) expect(doc, p).toContain(p);
  });
});

/** A state folder as the ticket 44 version left it after applying the WSL cap: the record and the file before. */
function recordWslApply(name: string, written: string, before: string | null): void {
  const state = join(dir, `${name}-state`);
  mkdirSync(state, { recursive: true });
  if (before !== null) writeFileSync(join(state, "wslconfig.before"), before);
  const writtenSha256 = createHash("sha256").update(written).digest("hex").toUpperCase();
  writeFileSync(join(state, "state.json"), JSON.stringify({ wsl: { existed: before !== null, writtenSha256 } }));
  writeFileSync(join(dir, `${name}-wslconfig`), written);
}

// Each test starts Windows PowerShell several times (about 2 s each).
describeWithPs(`scripts/host-tuning.ps1 under ${ps}`, { timeout: 60_000 }, () => {
  it("parses without a syntax error", () => {
    const r = runFile(join(repoRoot, "test/spike-parse.ps1"), [toHostPath(script)]);
    expect(r.out.trim()).toBe("errors=0");
  });

  it("with no item, changes nothing and writes nothing", () => {
    const r = run("dry", []);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const lines = r.out.split(/\r?\n/).filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((l) => !/^dry run: /.test(l))).toEqual([]);
    expect(existsSync(join(dir, "dry-state"))).toBe(false);
    expect(existsSync(join(dir, "dry-wslconfig"))).toBe(false);
  });

  it("refuses the ticket 44 apply parameters", () => {
    const r = run("old", ["-WslMemoryGB", "12", "-Apply"]);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(dir, "old-state"))).toBe(false);
    expect(existsSync(join(dir, "old-wslconfig"))).toBe(false);
  });

  it("dry run of an undo with nothing recorded skips every item", () => {
    const r = run("undo-empty", ["-Undo", "Wsl,Sql,Defender,Firewall"]);
    expect(r.code).toBe(0);
    expect(r.out.match(/^skip: /gm)).toHaveLength(4);
  });

  it("refuses an -Undo item it does not know", () => {
    const r = run("refuse", ["-Undo", "Registry"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/-Undo takes/);
    expect(r.out).not.toMatch(/would do:/);
  });

  it("puts back the .wslconfig an earlier apply changed, to the same bytes", () => {
    const before = "[wsl2]\nswap=4GB\nmemory=20GB\n\n[interop]\nenabled=true\n";
    recordWslApply("wsl", "[wsl2]\r\nswap=4GB\r\nmemory=12GB\r\n", before);
    const plan = run("wsl", ["-Undo", "Wsl"]);
    expect(plan.code).toBe(0);
    expect(plan.out).toMatch(/^would do: restore /m);
    expect(readFileSync(join(dir, "wsl-wslconfig"), "utf8")).toContain("memory=12GB");
    const undo = run("wsl", ["-Undo", "Wsl", "-Apply"]);
    expect(undo.err).toBe("");
    expect(undo.code).toBe(0);
    expect(readFileSync(join(dir, "wsl-wslconfig"), "utf8")).toBe(before);
    expect(run("wsl", ["-Undo", "Wsl"]).out).toMatch(/^skip: wsl: nothing recorded/m);
  });

  it("deletes a .wslconfig an earlier apply created, and refuses to undo one changed after it wrote it", () => {
    const config = join(dir, "new-wslconfig");
    recordWslApply("new", "[wsl2]\r\nmemory=12GB\r\n", null);
    writeFileSync(config, "[wsl2]\r\nmemory=14GB\r\n");
    const refused = run("new", ["-Undo", "Wsl", "-Apply"]);
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/changed after this script wrote it/);
    expect(existsSync(config)).toBe(true);
    writeFileSync(config, "[wsl2]\r\nmemory=12GB\r\n");
    expect(run("new", ["-Undo", "Wsl", "-Apply"]).code).toBe(0);
    expect(existsSync(config)).toBe(false);
  });

  it("reads ini text", () => {
    const cases: [string, string][] = [
      ["Read-WslConfigValue|[wsl2]\\nmemory = 12GB|wsl2|memory", "12GB"],
      ["Read-WslConfigValue|[WSL2]\\nMemory=4GB|wsl2|memory", "4GB"],
      ["Read-WslConfigValue|[boot]\\nmemory=12GB|wsl2|memory", ""],
    ];
    const caseFile = join(dir, "cases.txt");
    writeFileSync(caseFile, cases.map(([c]) => c).join("\n") + "\n");
    const r = runFile(join(repoRoot, "test/host-tuning-functions.ps1"), ["-Script", toHostPath(script), "-CaseFile", toHostPath(caseFile)]);
    expect(r.err).toBe("");
    expect(r.out.split(/\r?\n/).slice(0, cases.length)).toEqual(cases.map(([, want]) => want));
  });
});
