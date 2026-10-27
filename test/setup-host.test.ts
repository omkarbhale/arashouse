import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FLAVOR_KEYS } from "../src/core/flavors.js";
import { ROOT_FOLDERS, brokerWrapperSource, renderSetupHostScript } from "../src/core/setup-host.js";
import { repoRoot } from "./helpers.js";

/** As in test/host-tuning.test.ts: SPIKE_POWERSHELL, else Windows PowerShell 5.1 from WSL; the script targets Windows, so a Linux pwsh is not enough. */
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
const describeWithPs = ps && windows ? describe : describe.skip;

function runPs(args: string[]) {
  const r = spawnSync(ps as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], { encoding: "utf8", cwd, timeout: 120_000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const elevated = (): boolean =>
  runPs(["-Command", "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')"]).out.trim() === "True";

const dir = mkdtempSync(join(tmpdir(), "setup-host-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A root that does not exist, so a dry run has everything to plan and nothing it could touch.
const root = `C:\\arashouse_setup_test_${process.pid}`;
const script = join(dir, "setup-host.ps1");
writeFileSync(
  script,
  renderSetupHostScript({
    root,
    version: "0.0.0",
    worker: { name: "sg\\worker", sid: "S-1-5-21-1111111111-2222222222-3333333333-1001" },
    flavors: [...FLAVOR_KEYS],
    appFiles: [
      { path: "broker\\index.js", sha256: "0".repeat(64) },
      { path: "broker\\client.js", sha256: "0".repeat(64) },
    ],
    packageJsonSha256: "0".repeat(64),
  }).replace(/\n/g, "\r\n"),
);
const run = (args: string[]) => runPs(["-File", toHostPath(script), ...args]);
const rootOnHost = () => existsSync(`/mnt/c/${root.slice(3)}`);

// Each run starts Windows PowerShell (about 3 to 5 s).
describeWithPs(`setup-host.ps1 under ${ps}`, { timeout: 90_000 }, () => {
  it("parses without a syntax error", () => {
    const r = runPs(["-File", toHostPath(join(repoRoot, "test/spike-parse.ps1")), toHostPath(script)]);
    expect(r.out.trim()).toBe("errors=0");
  });

  it("dry run plans every step, ends with the result as JSON, and creates nothing", () => {
    const r = run([]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const [head, json] = r.out.split(/^result:\r?$/m) as [string, string];
    const lines = head.split(/\r?\n/).filter((l) => l.trim());
    expect(lines.filter((l) => !/^(would do: |dry run: |missing: )/.test(l))).toEqual([]);
    expect(lines).toContain(`would do: create ${root}`);
    for (const folder of ROOT_FOLDERS) expect(lines).toContain(`would do: create ${root}\\${folder}`);
    expect(lines.filter((l) => l.startsWith(`would do: set the ACL of ${root}\\`))).toHaveLength(ROOT_FOLDERS.length);
    const result = JSON.parse(json) as { applied: boolean; ok: boolean; folders: unknown[]; planned: string[]; changes: unknown[]; principals: { brokerSid: string }; broker: { installed: boolean } };
    // On a host where setup has already run, the service exists and the dry run rightly does not plan to create it.
    expect(lines.some((l) => l.startsWith("would do: create the service ArasHouseBroker"))).toBe(!result.broker.installed);
    expect(result.applied).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.folders).toHaveLength(ROOT_FOLDERS.length);
    expect(result.changes).toEqual([]);
    expect(result.planned.length).toBe(lines.filter((l) => l.startsWith("would do: ")).length);
    expect(rootOnHost()).toBe(false);
  });

  it.skipIf(!ps || !windows || elevated())("-Apply in a shell that is not elevated exits 4 before any change", () => {
    const r = run(["-Apply"]);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/needs an elevated PowerShell/);
    expect(r.out).toBe("");
    expect(rootOnHost()).toBe(false);
  });

  it.each([
    [["-RemoveRoot"], /-RemoveRoot goes with -Uninstall/],
    [["-Uninstall", "-UpdateBroker"], /-Uninstall takes only/],
    [["-Uninstall", "-SlotIdleTimeoutMinutes", "5"], /-Uninstall takes only/],
  ])("refuses %j", (args, message) => {
    const r = run(args);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(message);
    expect(r.out).not.toMatch(/would do:/);
  });

  it("-Uninstall -RemoveRoot refuses a root that holds a folder that is not arashouse's, and leaves it", () => {
    const foreign = `${root}\\not-arashouse`;
    runPs(["-Command", `New-Item -ItemType Directory -Path '${foreign}' -Force | Out-Null`]);
    try {
      const r = run(["-Uninstall", "-RemoveRoot"]);
      expect(r.err).toMatch(/refused to remove .*not-arashouse, which are not arashouse folders/);
      expect(r.out).not.toContain(`would do: remove ${root}`);
      expect(existsSync(`/mnt/c/${foreign.slice(3).replace(/\\/g, "/")}`)).toBe(true);
    } finally {
      runPs(["-Command", `Remove-Item -LiteralPath '${root}' -Recurse -Force`]);
    }
    expect(rootOnHost()).toBe(false);
  });

  it("sets and reads back the folder ACLs and the root's own ACL on a scratch root, without elevation", () => {
    // The script must name the current user as the worker: a folder's owner may rewrite its DACL, so no elevation is needed.
    const me = /^"([^"]+)","(S-1-5-21-[0-9-]+)"/m.exec(runPs(["-Command", "whoami.exe /user /fo csv /nh"]).out) as RegExpExecArray;
    const aclRoot = `C:\\arashouse_acl_test_${process.pid}`;
    const aclScript = join(dir, "setup-host-acl-root.ps1");
    writeFileSync(
      aclScript,
      renderSetupHostScript({
        root: aclRoot,
        version: "0.0.0",
        worker: { name: me[1] as string, sid: me[2] as string },
        flavors: ["23"],
        appFiles: [
          { path: "broker\\index.js", sha256: "0".repeat(64) },
          { path: "broker\\client.js", sha256: "0".repeat(64) },
        ],
        packageJsonSha256: "0".repeat(64),
      }).replace(/\n/g, "\r\n"),
    );
    const harness = toHostPath(join(repoRoot, "test/setup-host-acl.ps1"));
    try {
      const r = runPs(["-File", harness, "-Script", toHostPath(aclScript)]);
      expect(r.err).toBe("");
      const lines = r.out.split(/\r?\n/).filter(Boolean);
      expect(lines[0]).toMatch(/^root before: [1-9]/);
      expect(lines.slice(1, 3)).toEqual(["root after: ", "other unchanged: True"]);
      for (const folder of ROOT_FOLDERS) expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^${folder}: [1-9]\\d* -> $`)));
      expect(lines).toContainEqual(expect.stringMatching(/^drift: .*Authenticated Users should have no access$/));
      expect(lines.slice(-2)).toEqual(["repaired: 0", "shared sid: "]);
    } finally {
      expect(runPs(["-File", harness, "-Script", toHostPath(aclScript), "-Cleanup"]).out.trim()).toBe("cleanup: True");
    }
  });

  it("compiles the service wrapper with Windows PowerShell's C# compiler", () => {
    const source = join(dir, "wrapper.cs");
    const exe = join(dir, "ArasHouseBroker.exe");
    writeFileSync(source, brokerWrapperSource(root).replace("@@NODE@@", "C:\\nodejs\\node.exe"));
    const r = runPs([
      "-Command",
      `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${toHostPath(source)}')) -Language CSharp -OutputAssembly '${toHostPath(exe)}' -OutputType ConsoleApplication -ReferencedAssemblies 'System.ServiceProcess'`,
    ]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(readFileSync(exe).subarray(0, 2).toString("latin1")).toBe("MZ");
  });
});
