import { describe, expect, it } from "vitest";
import { DEFAULT_INSTALL_ROOT, extractBackupScratch, slotNames, stagingDir, stampFile, type SlotRef } from "../core/names.js";
import { HostError } from "../host/errors.js";
import type { OwnedContext } from "../host/owned.js";
import { backupDatabaseArgs, backupDatabaseOnHost } from "./backup-database.js";
import { Broker } from "./broker.js";
import { provisionSlotOnHost, registerSlotVerbs } from "./provision.js";
import { renderSlotStepsScript } from "./slot-steps.js";
import { FakeSlotSystem } from "./slot-system.fixture.js";

const ROOT = DEFAULT_INSTALL_ROOT;
const s1: SlotRef = { flavor: "12sp9", slot: 1 };
const LEASE = "0123456789abcdef0123456789abcdef";
const STAGED = `${stagingDir(LEASE, ROOT)}\\extract-db-1.bak`;
const owned: OwnedContext = { root: ROOT };

async function provisioned(leaseId: string | null = LEASE): Promise<FakeSlotSystem> {
  const system = new FakeSlotSystem();
  await provisionSlotOnHost(system, s1, slotNames(s1, ROOT), ROOT);
  const stamp = JSON.parse(system.text(stampFile(s1, ROOT))!);
  system.put(stampFile(s1, ROOT), JSON.stringify({ ...stamp, leaseId }));
  system.calls.length = 0;
  return system;
}

function backup(system: FakeSlotSystem, path: string = STAGED, ctx: OwnedContext = owned) {
  return backupDatabaseOnHost(system, s1, ROOT, ctx, { path });
}

async function failure(promise: Promise<unknown>): Promise<HostError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof HostError)) throw new Error(`expected a HostError, got ${String(err)}`);
  return err;
}

describe("backupDatabase", () => {
  it("backs the leased slot's database up to sqldata, copies it to the lease's staging folder and removes the scratch copy", async () => {
    const system = await provisioned();
    const result = await backup(system);
    expect(result).toMatchObject({ ok: true, detail: expect.stringMatching(/^backed up the database of 12sp9-01 \(COPY_ONLY, 0\.0 MB, 0\.9 s\) to extract-db-1\.bak in \d+\.\d s$/) });
    expect(system.calls.filter((c) => c !== "readFile")).toEqual(["backupDatabase 12sp9-01", "copyFile", "removeFile"]);
    expect(system.text(STAGED)).toBe("COPY_ONLY backup of arashouse_12sp9_01");
    expect(system.text(extractBackupScratch(s1, ROOT))).toBeUndefined();
  });

  it("refuses a slot that is not leased, or not provisioned, before any backup", async () => {
    for (const leaseId of [null, ""]) {
      const system = await provisioned(leaseId);
      expect(await failure(backup(system))).toMatchObject({ kind: "Refused", message: "slot 12sp9-01 is not leased: only a leased slot's database is backed up" });
      expect(system.calls).not.toContain("backupDatabase 12sp9-01");
    }
    const bare = new FakeSlotSystem();
    expect(await failure(backup(bare))).toMatchObject({ kind: "Refused", message: "slot 12sp9-01 is not provisioned" });
  });

  it("writes only inside the leased lease's staging folder, as a .bak", async () => {
    const system = await provisioned();
    for (const path of [
      `${stagingDir("fedcba9876543210fedcba9876543210", ROOT)}\\x.bak`,
      `${ROOT}\\staging\\x.bak`,
      stagingDir(LEASE, ROOT),
      `${stagingDir(LEASE, ROOT)}\\..\\..\\golden\\12sp9\\db\\x.bak`,
      `${ROOT}\\golden\\12sp9\\db\\ootb.bak`,
      `${ROOT}\\sqldata\\arashouse_12sp9_01.mdf`,
      "C:\\Program Files\\Microsoft SQL Server\\MSSQL15.MSSQLSERVER\\MSSQL\\Backup\\OLM_Local.bak",
      `${stagingDir(LEASE, ROOT)}\\OLM_Local.bak`,
      `${stagingDir(LEASE, ROOT)}\\x.txt`,
      "\\\\server\\share\\x.bak",
    ]) {
      expect((await failure(backup(system, path))).kind, path).toBe("Refused");
    }
    expect(system.calls).not.toContain("backupDatabase 12sp9-01");
  });

  it("refuses a junction in the staging path, before the backup and again before the copy", async () => {
    const system = await provisioned();
    const link = stagingDir(LEASE, ROOT).toLowerCase();
    expect((await failure(backup(system, STAGED, { root: ROOT, isReparsePoint: (p) => p.toLowerCase() === link }))).kind).toBe("Refused");
    expect(system.calls).not.toContain("backupDatabase 12sp9-01");

    // The worker swaps the lease folder for a junction while the backup runs.
    let swapped = false;
    const racing: OwnedContext = { root: ROOT, isReparsePoint: (p) => swapped && p.toLowerCase() === link };
    const original = system.backupDatabase.bind(system);
    system.backupDatabase = async (slot) => {
      swapped = true;
      return original(slot);
    };
    expect((await failure(backup(system, STAGED, racing))).kind).toBe("Refused");
    expect(system.calls).not.toContain("copyFile");
    expect(system.text(STAGED)).toBeUndefined();
    expect(system.text(extractBackupScratch(s1, ROOT))).toBeUndefined();
  });

  it("never replaces a file, and removes the scratch copy when the copy is refused", async () => {
    const system = await provisioned();
    system.put(STAGED, "the leaseholder's own");
    expect(await failure(backup(system))).toMatchObject({ kind: "Refused", message: expect.stringContaining("it exists, and a backup never replaces a file") });
    expect(system.text(STAGED)).toBe("the leaseholder's own");
    expect(system.text(extractBackupScratch(s1, ROOT))).toBeUndefined();
  });

  it("refuses a slot with no database, and removes the scratch copy when the backup fails", async () => {
    const system = await provisioned();
    system.objects.delete("database arashouse_12sp9_01");
    expect(await failure(backup(system))).toMatchObject({ kind: "Refused", message: "slot 12sp9-01 has no database (is it provisioned?)" });
    const failing = await provisioned();
    failing.failNext("backupDatabase", new Error("BACKUP DATABASE failed"));
    await expect(backup(failing)).rejects.toThrow("BACKUP DATABASE failed");
    expect(failing.calls).toContain("removeFile");
  });

  it("takes the staged path and nothing else", () => {
    expect(backupDatabaseArgs({ path: STAGED })).toEqual({ path: STAGED });
    for (const args of [{}, { path: "" }, { path: 1 }, { path: "x".repeat(261) }, { path: STAGED, sql: "BACKUP DATABASE [OLM_Local]" }]) {
      expect(() => backupDatabaseArgs(args), JSON.stringify(args)).toThrow();
    }
  });

  it("is a broker verb for a registered slot only", async () => {
    const system = await provisioned();
    const broker = registerSlotVerbs(new Broker({ root: ROOT }), system);
    expect(await broker.handle({ id: "b1", verb: "backupDatabase", slot: { flavor: "OLM_Local", slot: 1 }, args: { path: STAGED } })).toMatchObject({ ok: false, error: { kind: "Refused" } });
    expect(await broker.handle({ id: "b2", verb: "backupDatabase", slot: s1, args: { path: STAGED } })).toMatchObject({ ok: true, result: { ok: true } });
  });

  it("the host step backs up the slot's own database, COPY_ONLY, to its derived scratch file and takes no path from the request", () => {
    const script = renderSlotStepsScript(ROOT);
    const step = script.slice(script.indexOf("'backup-database' {"), script.indexOf("'read-backup' {"));
    expect(step).toContain('"BACKUP DATABASE " + (Format-Ident $Database) + " TO DISK = " + (Format-Str $ExtractBackup) + " WITH COPY_ONLY, INIT, FORMAT, CHECKSUM"');
    expect(step).not.toMatch(/\$request\./);
    expect(script).toContain(`$ExtractBackup = Join-Path $SqlData "$($Database)-extract.bak"`);
  });
});
