import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderTeardownScript } from "../src/broker/teardown-script.js";
import { FLAVOR_KEYS } from "../src/core/flavors.js";
import { renderSetupHostScript } from "../src/core/setup-host.js";
import { renderSetupSqlScript } from "../src/core/setup-sql.js";
import { writeTeardownBundle } from "../src/cli/teardown.js";
import { repoRoot } from "./helpers.js";

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const WORKER = { name: "sg\\worker", sid: "S-1-5-21-1111111111-2222222222-3333333333-1001" };

const dir = mkdtempSync(join(tmpdir(), "teardown-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the teardown bundle", () => {
  const dist = join(dir, "dist");
  mkdirSync(join(dist, "broker"), { recursive: true });
  writeFileSync(join(dist, "broker", "index.js"), "// broker\n");
  writeFileSync(join(dist, "broker", "client.js"), "// client\n");
  const packageJson = join(dir, "package.json");
  writeFileSync(packageJson, '{"name":"arashouse","version":"0.0.0","type":"module"}\n');
  const options = (outDir: string) => ({ outDir, distDir: dist, packageJson, version: "0.0.0", worker: WORKER, flavors: [...FLAVOR_KEYS] });

  it("holds teardown.ps1, the setup bundle and setup-sql.ps1, each child pinned by its SHA-256", async () => {
    const out = join(dir, "bundle");
    const script = await writeTeardownBundle(options(out));
    expect(script).toBe(join(out, "teardown.ps1"));
    const text = readFileSync(script, "ascii");
    expect(text).toContain("\r\n");
    expect(text).toContain(`$HostScriptSha256 = '${sha256(readFileSync(join(out, "host", "setup-host.ps1")))}'`);
    expect(text).toContain(`$SqlScriptSha256 = '${sha256(readFileSync(join(out, "sql", "setup-sql.ps1")))}'`);
    expect(existsSync(join(out, "host", "app", "broker", "index.js"))).toBe(true);
    // Written again over itself (and over a result an earlier run left), it is the same.
    writeFileSync(join(out, "teardown-result.json"), "{}");
    await writeTeardownBundle(options(out));
    expect(readFileSync(script, "ascii")).toBe(text);
    expect(existsSync(join(out, "teardown-result.json"))).toBe(false);
  });

  it("refuses a folder that holds anything else", async () => {
    const out = join(dir, "foreign");
    mkdirSync(out);
    writeFileSync(join(out, "notes.txt"), "mine");
    await expect(writeTeardownBundle(options(out))).rejects.toThrow("holds notes.txt, which a teardown bundle does not");
    expect(existsSync(join(out, "teardown.ps1"))).toBe(false);
  });
});

/** As in test/setup-host.test.ts: SPIKE_POWERSHELL, else Windows PowerShell 5.1 from WSL. */
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

function runPs(args: string[], timeout = 180_000) {
  const r = spawnSync(ps as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], { encoding: "utf8", cwd, timeout });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const result = (out: string) => JSON.parse(out.slice(out.indexOf("result:") + "result:".length)) as Record<string, any>;

/** Writes a bundle by hand (so a test can name its root and data source) and returns teardown.ps1's path. */
function bundle(at: string, root: string, dataSource?: string): string {
  mkdirSync(join(at, "host"), { recursive: true });
  mkdirSync(join(at, "sql"), { recursive: true });
  const crlf = (t: string) => t.replace(/\r?\n/g, "\r\n");
  const host = crlf(
    renderSetupHostScript({
      root,
      version: "0.0.0",
      worker: WORKER,
      flavors: [...FLAVOR_KEYS],
      appFiles: [
        { path: "broker\\index.js", sha256: "0".repeat(64) },
        { path: "broker\\client.js", sha256: "0".repeat(64) },
      ],
      packageJsonSha256: "0".repeat(64),
    }),
  );
  const sql = crlf(renderSetupSqlScript({ root, version: "0.0.0", ...(dataSource ? { dataSource } : {}) }));
  writeFileSync(join(at, "host", "setup-host.ps1"), host, "ascii");
  writeFileSync(join(at, "sql", "setup-sql.ps1"), sql, "ascii");
  const script = join(at, "teardown.ps1");
  writeFileSync(script, crlf(renderTeardownScript({ root, version: "0.0.0", setupHostSha256: sha256(host), setupSqlSha256: sha256(sql), ...(dataSource ? { dataSource } : {}) })), "ascii");
  return script;
}

const elevated = (): boolean =>
  runPs(["-Command", "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')"]).out.trim() === "True";

// Each case stops before it reads the host: the arguments and the children's hashes are checked first.
describeWithPs(`teardown.ps1 under ${ps}`, { timeout: 90_000 }, () => {
  const script = bundle(join(dir, "ps"), `C:\\arashouse_teardown_test_${process.pid}`);
  const run = (args: string[]) => runPs(["-File", toHostPath(script), ...args]);

  it("parses without a syntax error", () => {
    expect(runPs(["-File", toHostPath(join(repoRoot, "test/spike-parse.ps1")), toHostPath(script)]).out.trim()).toBe("errors=0");
  });

  it("refuses -RemoveRoot without -Goldens, or with -KeepSql (exit 2)", () => {
    const a = run(["-RemoveRoot"]);
    expect(a.code).toBe(2);
    expect(a.err).toContain("-RemoveRoot removes golden\\ too: give -Goldens with it");
    const b = run(["-Goldens", "-RemoveRoot", "-KeepSql"]);
    expect(b.code).toBe(2);
    expect(b.err).toContain("it cannot go with -KeepSql");
  });

  it.runIf(!elevated())("refuses -Apply when not elevated (exit 4)", () => {
    const r = run(["-Apply"]);
    expect(r.code).toBe(4);
    expect(r.out).not.toContain("do: ");
  });

  it("refuses to run a child script that changed after it was generated (exit 3)", () => {
    const changed = bundle(join(dir, "changed"), `C:\\arashouse_teardown_test_${process.pid}`);
    writeFileSync(join(dir, "changed", "sql", "setup-sql.ps1"), "Write-Host 'not the reviewed script'\r\n", "ascii");
    const r = runPs(["-File", toHostPath(changed)]);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/setup-sql\.ps1 is missing or not the script this one was generated with/);
    expect(r.out).toBe("");
  });
});

// The dry run end to end, against a throw-away LocalDB instance of the test's own (its SQL reads and its SQL child go there,
// never to the host's SQL Server) and a scratch root under staging\. Opt-in, as in test/setup-sql.test.ts. Not elevated, so
// IIS and the deny-list are reported unread; the host child plans the uninstall of the host's real broker but changes nothing.
const localDb = windows && process.env.ARASHOUSE_TEST_LOCALDB === "1" && spawnSync("sqllocaldb.exe", ["info"], { cwd }).status === 0;
const describeWithLocalDb = localDb ? describe : describe.skip;

describeWithLocalDb("teardown.ps1 dry run on a scratch root and a throw-away LocalDB instance", { timeout: 600_000 }, () => {
  const instance = `ahtdtest${process.pid}`;
  const root = `C:\\aras_installations\\staging\\arashouse-tdtest-${process.pid}`;
  const rootOnWsl = `/mnt/c/aras_installations/staging/arashouse-tdtest-${process.pid}`;
  const dataSource = `(localdb)\\${instance}`;
  afterAll(() => {
    spawnSync("sqllocaldb.exe", ["stop", instance, "-k"], { cwd });
    spawnSync("sqllocaldb.exe", ["delete", instance], { cwd });
    rmSync(rootOnWsl, { recursive: true, force: true });
  });

  it("refuses while a slot's folder is left, then plans the SQL drop and the broker's uninstall and changes nothing", () => {
    mkdirSync(join(rootOnWsl, "sqldata"), { recursive: true });
    mkdirSync(join(rootOnWsl, "slots", "12sp9", "05"), { recursive: true });
    mkdirSync(join(rootOnWsl, "golden", "23"), { recursive: true });
    expect(spawnSync("sqllocaldb.exe", ["create", instance, "-s"], { cwd, encoding: "utf8" }).status).toBe(0);
    const at = join(dir, "localdb");
    const script = bundle(at, root, dataSource);
    expect(runPs(["-File", toHostPath(join(at, "sql", "setup-sql.ps1")), "-Apply"], 300_000).code).toBe(0);

    const refused = runPs(["-File", toHostPath(script), "-Goldens"]);
    expect(refused.code).toBe(1);
    const r1 = result(refused.out);
    expect(r1.errors).toEqual([expect.stringContaining("refused: slots of the pool are left (slots\\12sp9\\05)")]);
    expect(r1).toMatchObject({ applied: false, ok: false, planned: [], changes: [], steps: { goldens: "skipped", sql: "skipped", host: "not run" } });
    expect(r1.before.setupSql).toEqual(["arashouse_admin", "arashouse_admin_signer", "NT SERVICE\\ArasHouseBroker"]);
    expect(r1.notes.join(" ")).toContain("the deny-list cannot be fingerprinted here");

    rmSync(join(rootOnWsl, "slots", "12sp9", "05"), { recursive: true });
    const plan = runPs(["-File", toHostPath(script), "-Goldens"]);
    expect(plan.err).toBe("");
    expect(plan.code).toBe(0);
    const r2 = result(plan.out);
    expect(r2).toMatchObject({ applied: false, ok: true, changes: [], steps: { goldens: "ok", sql: "ok", host: "ok" } });
    expect(r2.planned).toContain(`remove the 23 golden, ${root}\\golden\\23`);
    expect(r2.planned.filter((p: string) => p.startsWith("sql: drop "))).toHaveLength(4);
    expect(plan.out).toMatch(/^run: setup-sql\.ps1 -Uninstall\r?$/m);
    expect(plan.out).toMatch(/^ {2}sql: would do: drop the login \[NT SERVICE\\ArasHouseBroker\]\r?$/m);
    expect(plan.out).toMatch(/^run: setup-host\.ps1 -Uninstall\r?$/m);
    // Nothing changed: the golden is there, and so is every SQL object.
    expect(existsSync(join(rootOnWsl, "golden", "23"))).toBe(true);
    expect(r2.after.setupSql).toEqual(r2.before.setupSql);
    expect(r2.left).toEqual(expect.arrayContaining(["golden\\23", "arashouse_admin"]));
  });
});
