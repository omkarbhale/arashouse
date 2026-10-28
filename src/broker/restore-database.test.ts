import { describe, expect, it } from "vitest";
import { DATABASE_MARKER, DEFAULT_INSTALL_ROOT, slotNames, stampFile, type SlotRef } from "../core/names.js";
import { stagedBackup } from "../core/restore.js";
import { HostError } from "../host/errors.js";
import { Broker } from "./broker.js";
import { provisionSlotOnHost, registerSlotVerbs } from "./provision.js";
import { restoreDatabaseArgs, restoreDatabaseOnHost, type RestoreDatabaseArgs } from "./restore-database.js";
import { FakeSlotSystem } from "./slot-system.fixture.js";

const ROOT = DEFAULT_INSTALL_ROOT;
const s1: SlotRef = { flavor: "12sp9", slot: 1 };
const LEASE = "0123456789abcdef0123456789abcdef";
const STAGED = stagedBackup(LEASE, ROOT);

/** A provisioned slot leased to `LEASE`, with a backup staged for it. */
async function leased(lease: string | null = LEASE): Promise<FakeSlotSystem> {
  const system = new FakeSlotSystem();
  await provisionSlotOnHost(system, s1, slotNames(s1, ROOT), ROOT);
  const stamp = JSON.parse(system.text(stampFile(s1, ROOT))!) as Record<string, unknown>;
  system.put(stampFile(s1, ROOT), JSON.stringify({ ...stamp, leaseId: lease }));
  system.put(STAGED, "backup bytes");
  system.calls.length = 0;
  return system;
}

function restore(system: FakeSlotSystem, args: Partial<RestoreDatabaseArgs> = {}) {
  return restoreDatabaseOnHost(system, s1, slotNames(s1, ROOT), ROOT, { file: STAGED, ...args });
}

async function failure(promise: Promise<unknown>): Promise<HostError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof HostError)) throw new Error(`expected a HostError, got ${String(err)}`);
  return err;
}

const slotCalls = (system: FakeSlotSystem) => system.calls.filter((c) => / 12sp9-01$/.test(c) || c === "removeFile");

describe("restoreDatabase", () => {
  it("reads the header, stops the slot, restores, starts it again and deletes the staged copy", async () => {
    const system = await leased();
    system.databaseMarkers.set("arashouse_12sp9_01", { goldenHash: "9".repeat(64), resetAt: "2026-10-28T00:00:00.000Z" });
    const result = await restore(system);
    expect(result.ok).toBe(true);
    expect(slotCalls(system)).toEqual(["readStagedBackup 12sp9-01", "quiesce 12sp9-01", "restoreStaged 12sp9-01", "start 12sp9-01", "removeFile"]);
    // The step moves the backup's files by the logical names the header named, and checks the header still names them.
    expect(system.stagedRestores).toEqual([{ databaseName: "scratch_12sp9", data: "scratch_12sp9", log: "scratch_12sp9_log" }]);
    expect(system.text(STAGED)).toBeUndefined();
    // The database no longer claims a reset from the golden.
    expect(system.databaseMarkers.has("arashouse_12sp9_01")).toBe(false);
    expect(result.detail).toMatch(
      /^restored a backup into 12sp9-01 in \d+\.\d s \("scratch_12sp9" from SQL Server 15\.0\.2000; restore 0\.9 s; no session in the way; version 12 build 24090; 2 passwords carried; read [\d.]+, stop [\d.]+, restore [\d.]+, start [\d.]+\)$/,
    );
  });

  it("refuses a backup on its header before the slot is touched, and still deletes the staged copy", async () => {
    const cases: [string, (s: FakeSlotSystem) => void, RegExp][] = [
      ["a deny-list name", (s) => (s.stagedHeader = { ...s.stagedHeader, sets: [{ ...s.stagedHeader.sets[0]!, databaseName: "OLM_Local" }] }), /taken of the database "OLM_Local".*--allow-foreign-origin/],
      ["a newer SQL Server", (s) => (s.stagedHeader = { ...s.stagedHeader, sets: [{ ...s.stagedHeader.sets[0]!, softwareVersion: "16.0.1000" }] }), /newer than this host's 15\.0\.2190\.7/],
      ["no room", (s) => (s.restoreTarget = { ...s.restoreTarget, freeBytes: 1024 }), /needs 0\.1 GB and the drive of sqldata\\ has 0\.0 GB free/],
    ];
    for (const [name, change, message] of cases) {
      const system = await leased();
      change(system);
      const err = await failure(restore(system));
      expect(err.kind, name).toBe("Refused");
      expect(err.message, name).toMatch(/^the backup is not restored into 12sp9-01: /);
      expect(err.message, name).toMatch(message);
      expect(slotCalls(system), name).toEqual(["readStagedBackup 12sp9-01", "removeFile"]);
      expect(system.text(STAGED), name).toBeUndefined();
    }
  });

  it("restores a backup recorded under a deny-list name when the caller allows a foreign origin", async () => {
    const system = await leased();
    system.stagedHeader = { ...system.stagedHeader, sets: [{ ...system.stagedHeader.sets[0]!, databaseName: "prod_copy" }] };
    expect(await failure(restore(system))).toMatchObject({ kind: "Refused" });
    system.put(STAGED, "backup bytes");
    const result = await restore(system, { allowForeignOrigin: true });
    expect(result.detail).toContain('"prod_copy" from SQL Server');
    expect(result.detail).toContain("--allow-foreign-origin");
  });

  it("fails a database of another flavor with the flavor it belongs to, unless the version check is skipped", async () => {
    const system = await leased();
    system.stagedVersion = { VersionMajor: "14", VersionMinor: "0", VersionServicePack: "SP9", VersionBuild: "36073" };
    const err = await failure(restore(system));
    expect(err.kind).toBe("Refused");
    expect(err.message).toBe(
      "12sp9-01: the restored database is version 14.0 SP9 build 36073, not the 12sp9 server build 12.0.0.24090; " +
        "it is a 23 database: restore it into a 23 lease (arashouse get 23 --restore ...), or pass --skip-version-check to keep it",
    );
    // Restored, not started: the lease is given back and the slot reset.
    expect(slotCalls(system)).toEqual(["readStagedBackup 12sp9-01", "quiesce 12sp9-01", "restoreStaged 12sp9-01", "removeFile"]);
    system.put(STAGED, "backup bytes");
    const kept = await restore(system, { skipVersionCheck: true });
    expect(kept.detail).toContain("version 14 build 36073 (not the flavor's: --skip-version-check)");
  });

  it("refuses a staged backup it cannot read (a corrupt file) without touching the slot", async () => {
    const system = await leased();
    system.failNext("readStagedBackup", new Error("read-backup failed (exit 1): SQL error 3241: The media family on device is incorrectly formed"));
    const err = await failure(restore(system));
    expect(err).toMatchObject({ kind: "Refused", message: expect.stringContaining("the staged backup cannot be read: read-backup failed") });
    expect(slotCalls(system)).toEqual(["readStagedBackup 12sp9-01", "removeFile"]);
  });

  it("refuses a restore that fails part way, and one the slot does not start after", async () => {
    const system = await leased();
    system.failNext("restoreStaged", new Error("restore-staged failed (exit 1): error: the restored database has no user innovator (is it an Aras database?)"));
    expect(await failure(restore(system))).toMatchObject({ kind: "Refused", message: expect.stringContaining("no user innovator") });
    expect(system.text(STAGED)).toBeUndefined();

    const cold = await leased();
    cold.warmAnswer = () => ({ status: 500, ms: 10 });
    expect(await failure(restore(cold))).toMatchObject({ kind: "Retryable", message: expect.stringContaining("did not start after the restore") });
  });

  it("restores only into a leased slot, and only that lease's staged backup", async () => {
    expect(await failure(restore(await leased(null)))).toMatchObject({ kind: "Refused", message: "slot 12sp9-01 is not leased: a backup is restored only into a lease" });
    const system = await leased();
    for (const file of [
      stagedBackup("f".repeat(32), ROOT),
      `${ROOT}\\staging\\${LEASE}\\other.bak`,
      `${ROOT}\\golden\\12sp9\\db\\ootb.bak`,
      `${ROOT}\\staging\\${LEASE}\\..\\${"f".repeat(32)}\\restore.bak`,
      "C:\\Program Files (x86)\\Aras\\Innovator\\olm.bak",
    ]) {
      expect((await failure(restore(system, { file }))).kind, file).toBe("Refused");
    }
    expect(system.calls.filter((c) => c.startsWith("readStagedBackup") || c.startsWith("restoreStaged"))).toEqual([]);
    const fresh = new FakeSlotSystem();
    expect(await failure(restore(fresh))).toMatchObject({ kind: "Refused", message: "slot 12sp9-01 is not provisioned" });
  });

  it("removes no marker it did not find, and fails a database that still carries one", async () => {
    const system = await leased();
    const realRestore = system.restoreStaged.bind(system);
    system.restoreStaged = async (...args) => {
      const r = await realRestore(...args);
      return r.state === "restored" ? { ...r, marker: { [DATABASE_MARKER.goldenHash]: "9".repeat(64) } } : r;
    };
    expect(await failure(restore(system))).toMatchObject({ kind: "Refused", message: "the restored database of 12sp9-01 still carries a reset marker" });
  });
});

describe("restoreDatabase's arguments", () => {
  it("are the file and two switches, nothing else", () => {
    expect(restoreDatabaseArgs({ file: STAGED })).toEqual({ file: STAGED, allowForeignOrigin: false, skipVersionCheck: false });
    expect(restoreDatabaseArgs({ file: STAGED, allowForeignOrigin: true, skipVersionCheck: true })).toEqual({ file: STAGED, allowForeignOrigin: true, skipVersionCheck: true });
    expect(() => restoreDatabaseArgs({})).toThrow("needs the staged backup's file");
    expect(() => restoreDatabaseArgs({ file: STAGED, sql: "DROP" })).toThrow('takes no "sql" argument');
    expect(() => restoreDatabaseArgs({ file: STAGED, allowForeignOrigin: "yes" })).toThrow("allowForeignOrigin is true or false");
  });

  it("is a broker verb on a slot, which refuses another argument or a slot not on the allowlist", async () => {
    const system = await leased();
    const b = registerSlotVerbs(new Broker({ root: ROOT }), system);
    expect(b.registered()).toContain("restoreDatabase");
    expect(await b.handle({ id: "r", verb: "restoreDatabase", slot: s1, args: { file: STAGED } })).toMatchObject({ ok: true, result: { ok: true } });
    expect(await b.handle({ id: "x", verb: "restoreDatabase", slot: s1, args: { file: STAGED, path: "C:\\x" } })).toMatchObject({ ok: false, error: { kind: "Refused" } });
    for (const slot of [{ flavor: "OLM_Local", slot: 1 }, { flavor: "12sp9", slot: 0 }]) {
      expect(await b.handle({ id: "x", verb: "restoreDatabase", slot, args: { file: STAGED } })).toMatchObject({ ok: false, error: { kind: "Refused" } });
    }
  });
});
