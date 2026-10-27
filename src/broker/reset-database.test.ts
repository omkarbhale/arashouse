import { describe, expect, it } from "vitest";
import { DATABASE_MARKER, DEFAULT_INSTALL_ROOT, goldenLayout, slotNames, type SlotRef } from "../core/names.js";
import { HostError } from "../host/errors.js";
import { Broker } from "./broker.js";
import { ootbUnusable, provisionSlotOnHost, registerSlotVerbs } from "./provision.js";
import { resetDatabaseArgs, resetDatabaseOnHost, versionProblem, type ResetDatabaseArgs } from "./reset-database.js";
import { FAKE_GOLDEN_HASH, FakeSlotSystem } from "./slot-system.fixture.js";

const ROOT = DEFAULT_INSTALL_ROOT;
const s1: SlotRef = { flavor: "12sp9", slot: 1 };
const OOTB = goldenLayout("12sp9", ROOT).ootbBackup;
const backup: ResetDatabaseArgs = { file: OOTB, hash: FAKE_GOLDEN_HASH };

async function provisioned(slot: SlotRef = s1): Promise<FakeSlotSystem> {
  const system = new FakeSlotSystem();
  await provisionSlotOnHost(system, slot, slotNames(slot, ROOT), ROOT);
  system.calls.length = 0;
  return system;
}

function reset(system: FakeSlotSystem, args: ResetDatabaseArgs = backup, slot: SlotRef = s1) {
  return resetDatabaseOnHost(system, slot, ROOT, args, (flavor) => ootbUnusable(system, flavor, ROOT));
}

async function failure(promise: Promise<unknown>): Promise<HostError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof HostError)) throw new Error(`expected a HostError, got ${String(err)}`);
  return err;
}

describe("resetDatabase", () => {
  it("checks the golden, then restores and marks the database with the golden's hash and the time", async () => {
    const system = await provisioned();
    const result = await reset(system);
    expect(result.ok).toBe(true);
    expect(system.calls.filter((c) => c !== "readFile")).toEqual(["golden", "resetDatabase 12sp9-01"]);
    const marker = system.databaseMarkers.get("arashouse_12sp9_01")!;
    expect(marker.goldenHash).toBe(FAKE_GOLDEN_HASH);
    expect(marker.resetAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(result.detail).toMatch(
      /^database of 12sp9-01 restored from golden 999999999999 in \d+\.\d s \(restore 1\.4 s; no session in the way; version 12\.0 SP9 build 24090; golden check \d+\.\d s\)$/,
    );
  });

  it("says when sessions were ended and the database was not MULTI_USER", async () => {
    const system = await provisioned();
    system.resetAnswer = { killed: 2, access: "SINGLE_USER" };
    expect((await reset(system)).detail).toContain("2 foreign sessions ended first; set back to MULTI_USER from SINGLE_USER;");
  });

  it("refuses a slot with no database", async () => {
    const system = new FakeSlotSystem();
    expect(await failure(reset(system))).toMatchObject({ kind: "Refused", message: "slot 12sp9-01 has no database (is it provisioned?)" });
  });

  it("restores the golden's ootb.bak only", async () => {
    const system = await provisioned();
    for (const file of [`${ROOT}\\golden\\12sp9\\db\\Core120.bak`, `${ROOT}\\golden\\12sp9\\tree\\ootb.bak`]) {
      expect(await failure(reset(system, { ...backup, file }))).toMatchObject({ kind: "Refused", message: expect.stringMatching(/^a reset restores .*ootb\.bak only/) });
    }
    for (const file of [`${ROOT}\\golden\\23\\db\\ootb.bak`, `${ROOT}\\staging\\lease-1\\db.bak`, "C:\\Program Files\\Aras\\olm.bak", `${ROOT}\\golden\\12sp9\\db\\..\\..\\23\\db\\ootb.bak`]) {
      expect((await failure(reset(system, { ...backup, file }))).kind, file).toBe("Refused");
    }
    // Case does not matter on Windows.
    expect((await reset(system, { ...backup, file: OOTB.toUpperCase() })).ok).toBe(true);
    expect(system.calls.filter((c) => c.startsWith("resetDatabase"))).toHaveLength(1);
  });

  it("waits for a golden being promoted, refuses one that is unusable, and notices one that changed", async () => {
    const system = await provisioned();
    system.goldenState = { state: "promoting" };
    expect((await failure(reset(system))).kind).toBe("Retryable");
    system.goldenState = { state: "unusable", detail: "it is not built" };
    expect(await failure(reset(system))).toMatchObject({ kind: "Refused", message: "the 12sp9 golden cannot be restored from: it is not built" });
    system.goldenState = { state: "ok", hash: "8".repeat(64) };
    expect(await failure(reset(system))).toMatchObject({ kind: "Retryable", message: "the 12sp9 golden is 888888888888 now, not the 999999999999 the reset began with" });
    expect(system.calls.filter((c) => c.startsWith("resetDatabase"))).toEqual([]);
  });

  it("refuses a golden whose ootb.bak the broker does not own inside", async () => {
    const system = await provisioned();
    system.put(goldenLayout("12sp9", ROOT).flavor, JSON.stringify({ schema: 1, flavor: "12sp9" }));
    expect(await failure(reset(system))).toMatchObject({ kind: "Refused", message: expect.stringContaining("rebuild it with `arashouse baseline build 12sp9 --replace`") });
    expect(system.calls.filter((c) => c.startsWith("resetDatabase"))).toEqual([]);
  });

  it("quarantines a database whose marker or version does not read back as expected", async () => {
    const system = await provisioned();
    system.resetAnswer = { marker: { [DATABASE_MARKER.goldenHash]: "1".repeat(64), [DATABASE_MARKER.resetAt]: "2026-01-01T00:00:00.000Z" } };
    expect(await failure(reset(system))).toMatchObject({ kind: "Quarantine", message: "the marker of 12sp9-01's database does not read back as written" });
    system.resetAnswer = {};
    system.databaseVersion = { VersionMajor: "14", VersionMinor: "0", VersionServicePack: "SP9", VersionBuild: "36073" };
    expect(await failure(reset(system))).toMatchObject({
      kind: "Quarantine",
      message: "12sp9-01: the restored database is version 14.0 SP9 build 36073, not the 12sp9 server build 12.0.0.24090",
    });
  });
});

describe("versionProblem", () => {
  it("compares the major version and the build with the flavor's server build", () => {
    expect(versionProblem("12sp9", { VersionMajor: "12", VersionMinor: "0", VersionServicePack: "SP9", VersionBuild: "24090" })).toBeUndefined();
    expect(versionProblem("23", { VersionMajor: "14", VersionMinor: "0", VersionBuild: "36073" })).toBeUndefined();
    expect(versionProblem("35", { VersionMajor: "14", VersionMinor: "35", VersionBuild: "43890" })).toBeUndefined();
    expect(versionProblem("23", { VersionMajor: "14", VersionBuild: "43890" })).toMatch(/version 14\.\? build 43890, not the 23 server build 14\.0\.9\.36073/);
    expect(versionProblem("12sp9", {})).toMatch(/version \?\.\? build \?/);
  });
});

describe("resetDatabase arguments", () => {
  it("are the backup's file and its 64-hex golden hash, nothing else", () => {
    expect(resetDatabaseArgs({ file: OOTB, hash: FAKE_GOLDEN_HASH })).toEqual(backup);
    for (const args of [{}, { file: OOTB }, { file: OOTB, hash: "" }, { file: OOTB, hash: "A".repeat(64) }, { file: "", hash: FAKE_GOLDEN_HASH }, { file: 1, hash: FAKE_GOLDEN_HASH }, { ...backup, sql: "x" }]) {
      expect(() => resetDatabaseArgs(args), JSON.stringify(args)).toThrow(/resetDatabase/);
    }
  });
});

describe("the resetDatabase verb", () => {
  it("is refused as a request without its arguments, and shares the slot's lock with provision and destroy", async () => {
    const system = await provisioned();
    const b = registerSlotVerbs(new Broker({ root: ROOT }), system);
    expect(await b.handle({ id: "r0", verb: "resetDatabase", slot: s1 })).toMatchObject({ ok: false, error: { kind: "Refused" } });
    expect(await b.handle({ id: "r1", verb: "resetDatabase", slot: { flavor: "OLM_Local", slot: 1 }, args: { ...backup } })).toMatchObject({ ok: false, error: { kind: "Refused" } });

    let release!: () => void;
    const restore = system.resetDatabase.bind(system);
    system.resetDatabase = (slot, marker) => new Promise((resolve) => (release = () => void restore(slot, marker).then(resolve)));
    const first = b.handle({ id: "r2", verb: "resetDatabase", slot: s1, args: { ...backup } });
    await new Promise((r) => setTimeout(r, 10));
    expect(await b.handle({ id: "d1", verb: "destroySlot", slot: s1 })).toMatchObject({
      ok: false,
      error: { kind: "Retryable", message: "slot 12sp9-01 is being provisioned, destroyed, started, stopped or reset already" },
    });
    release();
    expect(await first).toMatchObject({ ok: true, result: { detail: expect.stringMatching(/^database of 12sp9-01 restored/) } });
  });
});
