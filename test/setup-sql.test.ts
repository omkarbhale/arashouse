import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderSetupSqlScript } from "../src/core/setup-sql.js";
import { repoRoot } from "./helpers.js";

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

function runPs(args: string[], timeout = 120_000) {
  const r = spawnSync(ps as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], { encoding: "utf8", cwd, timeout });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const dir = mkdtempSync(join(tmpdir(), "setup-sql-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describeWithPs(`setup-sql.ps1 under ${ps}`, { timeout: 60_000 }, () => {
  it("parses without a syntax error", () => {
    const script = join(dir, "setup-sql.ps1");
    writeFileSync(script, renderSetupSqlScript({ version: "0.0.0" }).replace(/\n/g, "\r\n"), "ascii");
    const r = runPs(["-File", toHostPath(join(repoRoot, "test/spike-parse.ps1")), toHostPath(script)]);
    expect(r.out.trim()).toBe("errors=0");
  });
});

// The whole script against a throw-away LocalDB instance of the test's own (never the host's SQL Server):
// -Apply -SelfTest from nothing, then again with nothing to change. Opt-in. Its scratch root is a folder of
// its own under the install root's staging\ (which the worker may change), never the drive root.
const localDb = windows && process.env.ARASHOUSE_TEST_LOCALDB === "1" && spawnSync("sqllocaldb.exe", ["info"], { cwd }).status === 0;
const describeWithLocalDb = localDb ? describe : describe.skip;

describeWithLocalDb("setup-sql.ps1 on a throw-away LocalDB instance", { timeout: 600_000 }, () => {
  const instance = `ahsqltest${process.pid}`;
  const root = `C:\\aras_installations\\staging\\arashouse-sqltest-${process.pid}`;
  const rootOnWsl = `/mnt/c/aras_installations/staging/arashouse-sqltest-${process.pid}`;
  const script = join(dir, "setup-sql-localdb.ps1");
  afterAll(() => {
    spawnSync("sqllocaldb.exe", ["stop", instance, "-k"], { cwd });
    spawnSync("sqllocaldb.exe", ["delete", instance], { cwd });
    rmSync(rootOnWsl, { recursive: true, force: true });
  });

  const result = (out: string) => JSON.parse(out.slice(out.indexOf("result:") + "result:".length)) as Record<string, any>;

  it("creates everything, passes its checks and the self-test, and then has nothing to change", () => {
    mkdirSync(join(rootOnWsl, "sqldata"), { recursive: true });
    expect(spawnSync("sqllocaldb.exe", ["create", instance, "-s"], { cwd, encoding: "utf8" }).status).toBe(0);
    writeFileSync(script, renderSetupSqlScript({ version: "0.0.0", root, dataSource: `(localdb)\\${instance}` }).replace(/\n/g, "\r\n"), "ascii");

    const first = runPs(["-File", toHostPath(script), "-Apply", "-SelfTest"], 300_000);
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    const r1 = result(first.out);
    expect(r1.ok).toBe(true);
    expect(r1.changes).toHaveLength(4);
    expect(r1.checks.poolLogin).toMatchObject({ sysadmin: false, dbcreator: false, ownServerRights: 0, executes: 5, ok: true });
    expect(r1.checks.refusals).toMatchObject({ ok: true, notRefused: [], directCreateError: 262, madeUpDatabaseAfter: false });
    expect(r1.checks.selfTest).toMatchObject({ ok: true, error: null });

    const second = runPs(["-File", toHostPath(script), "-Apply"], 300_000);
    expect(second.code).toBe(0);
    const r2 = result(second.out);
    expect(r2.ok).toBe(true);
    expect(r2.changes).toEqual([]);
    expect(r2.state.signer).toMatchObject({ privateKeyRemoved: true, sameThumbprint: true, login: true });
  });

  it("-Uninstall refuses while a slot database is left, then drops every object it made, and then has nothing to drop", () => {
    // A slot database the broker owns, made through the procedure as the broker would (the instance's sysadmin impersonates it).
    const slot = join(dir, "slot-db.ps1");
    const conn = `Data Source=(localdb)\\${instance};Initial Catalog=master;Integrated Security=SSPI;Pooling=False`;
    const sql = (text: string) =>
      `$c = New-Object Data.SqlClient.SqlConnection '${conn}'; $c.Open(); $q = $c.CreateCommand(); $q.CommandText = "${text}"; [void]$q.ExecuteNonQuery(); $c.Dispose()`;
    const asBroker = (proc: string) => sql(`EXECUTE AS LOGIN = N'NT SERVICE\\ArasHouseBroker'; EXEC arashouse_admin.dbo.${proc} @database = N'arashouse_12sp9_97'; REVERT;`);
    writeFileSync(slot, `param([string]$Proc)\r\n${asBroker("create_slot_database").replace("create_slot_database", "$Proc")}\r\n`, "ascii");
    expect(runPs(["-File", toHostPath(slot), "create_slot_database"]).code).toBe(0);

    const dry = runPs(["-File", toHostPath(script), "-Uninstall"]);
    expect(dry.code).toBe(1);
    const refused = result(dry.out);
    expect(refused).toMatchObject({ mode: "uninstall", ok: false, planned: [], changes: [] });
    expect(refused.state.slotDatabases).toEqual(["arashouse_12sp9_97"]);
    expect(refused.errors.join(" ")).toContain("refused: slot databases are left: arashouse_12sp9_97");
    const refusedApply = result(runPs(["-File", toHostPath(script), "-Uninstall", "-Apply"]).out);
    expect(refusedApply).toMatchObject({ ok: false, changes: [] });
    expect(refusedApply.state).toMatchObject({ adminDatabase: true, poolLogin: true, signerLogin: true, masterCertificate: true });

    expect(runPs(["-File", toHostPath(slot), "drop_slot_database"]).code).toBe(0);
    const plan = result(runPs(["-File", toHostPath(script), "-Uninstall"]).out);
    expect(plan).toMatchObject({ ok: true, applied: false, changes: [] });
    expect(plan.planned).toHaveLength(4);

    const apply = runPs(["-File", toHostPath(script), "-Uninstall", "-Apply"], 300_000);
    expect(apply.err).toBe("");
    expect(apply.code).toBe(0);
    const removed = result(apply.out);
    expect(removed.changes).toHaveLength(4);
    expect(removed.state).toMatchObject({ slotDatabases: [], slotLogins: [], adminDatabase: false, poolLogin: false, signerLogin: false, masterCertificate: false });
    expect(existsSync(join(rootOnWsl, "sqldata", "arashouse_admin.mdf"))).toBe(false);

    const again = runPs(["-File", toHostPath(script), "-Uninstall", "-Apply"]);
    expect(again.code).toBe(0);
    expect(result(again.out)).toMatchObject({ ok: true, changes: [], planned: [] });
  });
});
