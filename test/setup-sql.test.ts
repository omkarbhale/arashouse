import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderSetupSqlScript } from "../src/core/setup-sql.js";
import { repoRoot } from "./helpers.js";
import { describeOnWindowsHost, onWindowsHost, ps, psCwd, runPs as runHostPs, toHostPath, toLocalPath } from "./powershell.js";

const runPs = (args: string[], timeout = 120_000) => runHostPs(args, { timeout });

const dir = mkdtempSync(join(tmpdir(), "setup-sql-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describeOnWindowsHost(`setup-sql.ps1 under ${ps}`, { timeout: 60_000 }, () => {
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
const localDb = onWindowsHost && process.env.ARASHOUSE_TEST_LOCALDB === "1" && spawnSync("sqllocaldb.exe", ["info"], { cwd: psCwd }).status === 0;
const describeWithLocalDb = localDb ? describe : describe.skip;

describeWithLocalDb("setup-sql.ps1 on a throw-away LocalDB instance", { timeout: 600_000 }, () => {
  const instance = `ahsqltest${process.pid}`;
  const root = `C:\\aras_installations\\staging\\arashouse-sqltest-${process.pid}`;
  const localRoot = toLocalPath(root);
  const script = join(dir, "setup-sql-localdb.ps1");
  afterAll(() => {
    spawnSync("sqllocaldb.exe", ["stop", instance, "-k"], { cwd: psCwd });
    spawnSync("sqllocaldb.exe", ["delete", instance], { cwd: psCwd });
    rmSync(localRoot, { recursive: true, force: true });
  });

  const result = (out: string) => JSON.parse(out.slice(out.indexOf("result:") + "result:".length)) as Record<string, any>;

  it("creates everything, passes its checks and the self-test, and then has nothing to change", () => {
    mkdirSync(join(localRoot, "sqldata"), { recursive: true });
    expect(spawnSync("sqllocaldb.exe", ["create", instance, "-s"], { cwd: psCwd, encoding: "utf8" }).status).toBe(0);
    writeFileSync(script, renderSetupSqlScript({ version: "0.0.0", root, dataSource: `(localdb)\\${instance}` }).replace(/\n/g, "\r\n"), "ascii");

    const first = runPs(["-File", toHostPath(script), "-Apply", "-SelfTest"], 300_000);
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    const r1 = result(first.out);
    expect(r1.ok).toBe(true);
    expect(r1.changes).toHaveLength(4);
    expect(r1.checks.poolLogin).toMatchObject({ sysadmin: false, dbcreator: false, controlServer: false, ownServerRights: 0, executes: 7, ok: true });
    expect(r1.checks.refusals).toMatchObject({ ok: true, notRefused: [], directCreateError: 262, madeUpDatabaseAfter: false });
    expect(r1.checks.selfTest).toMatchObject({ ok: true, error: null });

    const second = runPs(["-File", toHostPath(script), "-Apply"], 300_000);
    expect(second.code).toBe(0);
    const r2 = result(second.out);
    expect(r2.ok).toBe(true);
    expect(r2.changes).toEqual([]);
    for (const name of ["arashouse_admin_signer", "arashouse_admin_adopter"]) {
      expect(r2.state.signers[name]).toMatchObject({ privateKeyRemoved: true, sameThumbprint: true, login: true });
    }
    expect(r2.state.signers.arashouse_admin_adopter.permissions).toEqual(["CONTROL SERVER"]);
  });

  it("reads a staged backup and hands a restored foreign backup to the broker (ticket 39)", () => {
    // A backup of a database another login owns, staged where a lease's would be; then, as the broker: read it through
    // read_staged_backup, restore it over a slot database it made, find it cannot open it, adopt it, open and drop it.
    const lease = "0123456789abcdef0123456789abcdef";
    mkdirSync(join(localRoot, "staging", lease), { recursive: true });
    const staged = `${root}\\staging\\${lease}\\restore.bak`;
    const flow = join(dir, "restore-flow.ps1");
    const conn = `Data Source=(localdb)\\${instance};Initial Catalog=master;Integrated Security=SSPI;Pooling=False`;
    writeFileSync(
      flow,
      [
        `$ErrorActionPreference = 'Stop'`,
        `$c = New-Object Data.SqlClient.SqlConnection '${conn}'; $c.Open()`,
        `function Q([string]$Text) { $q = $c.CreateCommand(); $q.CommandText = $Text; $q.CommandTimeout = 120; $t = New-Object Data.DataTable; $t.Load($q.ExecuteReader()); return ,$t }`,
        `function Probe([string]$Text) { try { [void](Q $Text); return 'ok' } catch { return 'refused' } }`,
        `$out = [ordered]@{}`,
        `[void](Q "CREATE LOGIN zz_other WITH PASSWORD = N'$([guid]::NewGuid())x-A1', CHECK_POLICY = OFF")`,
        `[void](Q "CREATE DATABASE zz_foreign ON (NAME = zz_foreign, FILENAME = N'${root}\\sqldata\\zz_foreign.mdf') LOG ON (NAME = zz_foreign_log, FILENAME = N'${root}\\sqldata\\zz_foreign_log.ldf'); ALTER AUTHORIZATION ON DATABASE::zz_foreign TO zz_other")`,
        `[void](Q "USE zz_foreign; CREATE TABLE dbo.t (x int); INSERT dbo.t VALUES (7)")`,
        `[void](Q "BACKUP DATABASE zz_foreign TO DISK = N'${staged}' WITH INIT")`,
        `[void](Q "USE master; DROP DATABASE zz_foreign; DROP LOGIN zz_other")`,
        `$as = "EXECUTE AS LOGIN = N'NT SERVICE\\ArasHouseBroker'; "`,
        `try {`,
        `[void](Q ($as + "EXEC arashouse_admin.dbo.create_slot_database @database = N'arashouse_12sp9_96'; REVERT;"))`,
        `$out.readAsBrokerWithoutProcedure = Probe ($as + "RESTORE HEADERONLY FROM DISK = N'${staged}'; REVERT;")`,
        `$q = $c.CreateCommand(); $q.CommandText = $as + "EXEC arashouse_admin.dbo.read_staged_backup @file = N'${staged}'; REVERT;"; $r = $q.ExecuteReader()`,
        `$sets = @(); $files = @(); do { while ($r.Read()) { if (@($r.GetSchemaTable().Rows | Where-Object { $_.ColumnName -eq 'LogicalName' }).Count -gt 0) { $files += [string]$r['LogicalName'] } else { $sets += [string]$r['DatabaseName'] } } } while ($r.NextResult()); $r.Close()`,
        `$out.sets = $sets; $out.files = $files`,
        `$move = "MOVE N'zz_foreign' TO N'${root}\\sqldata\\arashouse_12sp9_96.mdf', MOVE N'zz_foreign_log' TO N'${root}\\sqldata\\arashouse_12sp9_96_log.ldf'"`,
        `[void](Q ($as + "RESTORE DATABASE [arashouse_12sp9_96] FROM DISK = N'${staged}' WITH REPLACE, $move; REVERT;"))`,
        `$out.openBeforeAdopt = Probe ($as + "SELECT x FROM arashouse_12sp9_96.dbo.t; REVERT;")`,
        `$out.adopted = (Q ($as + "DECLARE @r int; EXEC @r = arashouse_admin.dbo.adopt_slot_database @database = N'arashouse_12sp9_96'; REVERT; SELECT @r AS r")).Rows[0].r`,
        `$out.openAfterAdopt = Probe ($as + "SELECT x FROM arashouse_12sp9_96.dbo.t; REVERT;")`,
        `$out.dbo = (Q "SELECT SUSER_SNAME(sid) AS n FROM arashouse_12sp9_96.sys.database_principals WHERE name = N'dbo'").Rows[0].n`,
        `$out.adoptForeign = Probe ($as + "EXEC arashouse_admin.dbo.adopt_slot_database @database = N'master'; REVERT;")`,
        `[void](Q ($as + "EXEC arashouse_admin.dbo.drop_slot_database @database = N'arashouse_12sp9_96'; REVERT;"))`,
        `$out.left = (Q "SELECT COUNT(*) AS n FROM sys.databases WHERE name IN (N'arashouse_12sp9_96', N'zz_foreign')").Rows[0].n`,
        `} finally { [void](Q "USE master; IF DB_ID(N'arashouse_12sp9_96') IS NOT NULL DROP DATABASE [arashouse_12sp9_96]"); $c.Dispose() }`,
        `Write-Host ('result:' + ($out | ConvertTo-Json -Compress))`,
      ].join("\r\n"),
      "ascii",
    );
    const run = runPs(["-File", toHostPath(flow)], 300_000);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(result(run.out)).toMatchObject({
      sets: ["zz_foreign"],
      files: ["zz_foreign", "zz_foreign_log"],
      readAsBrokerWithoutProcedure: "refused",
      openBeforeAdopt: "refused",
      adopted: 1,
      openAfterAdopt: "ok",
      dbo: "NT SERVICE\\ArasHouseBroker",
      adoptForeign: "refused",
      left: 0,
    });
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
    expect(refusedApply.state).toMatchObject({ adminDatabase: true, poolLogin: true });
    expect(refusedApply.state.signerLogins).toHaveLength(2);
    expect(refusedApply.state.masterCertificates).toHaveLength(2);

    expect(runPs(["-File", toHostPath(slot), "drop_slot_database"]).code).toBe(0);
    const plan = result(runPs(["-File", toHostPath(script), "-Uninstall"]).out);
    expect(plan).toMatchObject({ ok: true, applied: false, changes: [] });
    expect(plan.planned).toHaveLength(6);

    const apply = runPs(["-File", toHostPath(script), "-Uninstall", "-Apply"], 300_000);
    expect(apply.err).toBe("");
    expect(apply.code).toBe(0);
    const removed = result(apply.out);
    expect(removed.changes).toHaveLength(6);
    expect(removed.state).toMatchObject({ slotDatabases: [], slotLogins: [], adminDatabase: false, poolLogin: false, signerLogins: [], masterCertificates: [] });
    expect(existsSync(join(localRoot, "sqldata", "arashouse_admin.mdf"))).toBe(false);

    const again = runPs(["-File", toHostPath(script), "-Uninstall", "-Apply"]);
    expect(again.code).toBe(0);
    expect(result(again.out)).toMatchObject({ ok: true, changes: [], planned: [] });
  });
});
