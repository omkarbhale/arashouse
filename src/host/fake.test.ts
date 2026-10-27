import { describe, expect, it } from "vitest";
import { GuardError } from "../core/guards.js";
import { goldenDir, slotId, stagingDir } from "../core/names.js";
import { FakeClock } from "./clock.js";
import { HOST_METHODS, type HostMethod } from "./driver.js";
import { HostError, isHostError } from "./errors.js";
import { FakeHost, fakeGoldenHash } from "./fake.js";

/** A secret-store handle wrapping `ref`. */
const handle = (ref: string) => ({ secretRef: ref });

const slot = { flavor: "12sp9", slot: 1 } as const;
const other = { flavor: "23", slot: 2 } as const;

async function kindOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "none";
  } catch (err) {
    return err instanceof HostError ? err.kind : `other: ${String(err)}`;
  }
}

async function provisioned(host = new FakeHost()): Promise<FakeHost> {
  await host.provisionSlot(slot);
  return host;
}

async function reset(host: FakeHost): Promise<void> {
  await host.quiesce(slot);
  await host.resetDatabase(slot, host.backup(slot.flavor));
  await host.resetTree(slot, host.golden(slot.flavor));
  await host.startSlot(slot, { agent: false });
}

describe("FakeHost slots", () => {
  it("provisions a healthy slot with a stamp, and refuses to provision it twice", async () => {
    const host = new FakeHost();
    await host.provisionSlot(slot);
    expect((await host.healthCheck(slot)).ok).toBe(true);
    const stamp = (await host.readStamp(slot)).stamp;
    expect(stamp).toMatchObject({ slotId: "12sp9-01", flavor: "12sp9", goldenHash: fakeGoldenHash("12sp9"), leaseId: null });
    expect(await kindOf(() => host.provisionSlot(slot))).toBe("Refused");
  });

  it("lists slots in flavor then number order", async () => {
    const host = new FakeHost();
    for (const s of [other, { flavor: "12sp9", slot: 3 } as const, slot]) await host.provisionSlot(s);
    expect((await host.listSlots()).slots.map((s) => slotId(s.slot))).toEqual(["12sp9-01", "12sp9-03", "23-02"]);
  });

  it("makes a dirtied slot unhealthy and a full reset heals it", async () => {
    const host = await provisioned();
    await host.deployCode(slot, `${stagingDir("lease1")}\\build`);
    await host.restoreDatabase(slot, `${stagingDir("lease1")}\\x.bak`);
    const dirty = await host.healthCheck(slot);
    expect(dirty.ok).toBe(false);
    expect(dirty.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["database-marker-matches-stamp", "tree-clean"]);
    await reset(host);
    expect((await host.healthCheck(slot)).ok).toBe(true);
  });

  it.each(["tree", "database", "stamp"] as const)("reports a dirty %s", async (part) => {
    const host = await provisioned();
    host.dirty(slot, part);
    expect((await host.healthCheck(slot)).ok).toBe(false);
  });

  it("needs a quiesced slot to reset the tree, and start lifts the quiesce", async () => {
    const host = await provisioned();
    expect(await kindOf(() => host.resetTree(slot, host.golden("12sp9")))).toBe("Refused");
    await host.quiesce(slot);
    expect(host.inspect(slot)).toMatchObject({ online: false, agent: false });
    await host.resetTree(slot, host.golden("12sp9"));
    await host.startSlot(slot, { agent: true });
    expect(host.inspect(slot)).toMatchObject({ online: true, agent: true });
    await host.stopSlot(slot);
    expect(host.inspect(slot)).toMatchObject({ online: false, agent: false });
  });

  it("refuses a golden or backup of another flavor, or a backup outside the golden folder", async () => {
    const host = await provisioned();
    await host.quiesce(slot);
    expect(await kindOf(() => host.resetTree(slot, host.golden("23")))).toBe("Refused");
    expect(await kindOf(() => host.resetDatabase(slot, host.backup("23")))).toBe("Refused");
    const outside = { ...host.backup("12sp9"), file: `${stagingDir("lease1")}\\Core.bak` };
    expect(await kindOf(() => host.resetDatabase(slot, outside))).toBe("Refused");
  });

  it("stamps a reset at the fake clock's time and clears the lease id", async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 2, 3, 4, 5));
    const host = new FakeHost({ clock });
    await host.provisionSlot(slot);
    const stamp = (await host.readStamp(slot)).stamp!;
    await host.writeStamp(slot, { ...stamp, leaseId: "abc" });
    clock.advance(60_000);
    await host.quiesce(slot);
    await host.resetTree(slot, host.golden("12sp9"));
    expect((await host.readStamp(slot)).stamp).toMatchObject({ lastResetAt: "2026-01-02T03:05:05.000Z", leaseId: null });
  });

  it("returns copies, so a caller cannot edit the fake's stamp", async () => {
    const host = await provisioned();
    const read = (await host.readStamp(slot)).stamp as { goldenHash: string | null };
    read.goldenHash = "tampered";
    expect((await host.readStamp(slot)).stamp?.goldenHash).toBe(fakeGoldenHash("12sp9"));
  });

  it("tracks the baseline per flavor", async () => {
    const host = new FakeHost({ baselines: ["23"] });
    expect((await host.baselineVerify("23")).ok).toBe(true);
    expect((await host.baselineVerify("12sp9")).ok).toBe(false);
    const built = await host.baselineBuild("12sp9");
    expect(built.goldenHash).toBe(fakeGoldenHash("12sp9"));
    expect((await host.baselineVerify("12sp9")).ok).toBe(true);
    expect((await host.baselineVerify("12sp9", { level: "full" })).level).toBe("full");
    expect((await host.baselineVerify("12sp9")).level).toBe("golden");
    expect(await kindOf(() => host.baselineVerify("12sp9", { level: "everything" as never }))).toBe("Refused");
  });

  it("reports host info, which a test can change", async () => {
    const host = new FakeHost({ info: { freeDiskGb: 5 } });
    host.setHostInfo({ sqlReachable: false });
    expect((await host.hostInfo()).info).toMatchObject({ freeDiskGb: 5, sqlReachable: false });
  });
});

describe("FakeHost guards", () => {
  const denied = [
    { flavor: "OLM_Local", slot: 1 },
    { flavor: "olm_local", slot: 1 },
    { flavor: "prod", slot: 1 },
    { flavor: "12sp9", slot: 0 },
    { flavor: "12sp9", slot: 1.5 },
    { flavor: "99", slot: 1 },
    null,
  ];
  const slotCalls: Record<string, (host: FakeHost, s: never) => Promise<unknown>> = {
    provisionSlot: (h, s) => h.provisionSlot(s),
    destroySlot: (h, s) => h.destroySlot(s),
    quiesce: (h, s) => h.quiesce(s),
    resetTree: (h, s) => h.resetTree(s, h.golden("12sp9")),
    resetDatabase: (h, s) => h.resetDatabase(s, h.backup("12sp9")),
    startSlot: (h, s) => h.startSlot(s, { agent: false }),
    stopSlot: (h, s) => h.stopSlot(s),
    deployCode: (h, s) => h.deployCode(s, `${stagingDir("l1")}\\x`),
    restoreDatabase: (h, s) => h.restoreDatabase(s, `${stagingDir("l1")}\\x.bak`),
    backupDatabase: (h, s) => h.backupDatabase(s, `${stagingDir("l1")}\\x.bak`),
    healthCheck: (h, s) => h.healthCheck(s),
    readStamp: (h, s) => h.readStamp(s),
    writeStamp: (h, s) => h.writeStamp(s, { slotId: "x", flavor: "12sp9", goldenHash: null, lastResetAt: null }),
    setLeaseCredentials: (h, s) => h.setLeaseCredentials(s, handle("h1")),
  };

  it("covers every slot-taking method", () => {
    const slotless: HostMethod[] = ["ping", "hostInfo", "listSlots", "baselineBuild", "baselineVerify"];
    expect(Object.keys(slotCalls).sort()).toEqual(HOST_METHODS.filter((m) => !slotless.includes(m)).sort());
  });

  it.each(Object.keys(slotCalls))("%s refuses a slot record that is not a registered (flavor, number)", async (method) => {
    for (const bad of denied) {
      const host = new FakeHost();
      expect(await kindOf(() => slotCalls[method]!(host, bad as never)), `${method} ${JSON.stringify(bad)}`).toBe("Refused");
      expect(host.calls.at(-1)).toMatchObject({ method, outcome: "error", error: "Refused" });
      expect((await host.listSlots()).slots).toEqual([]);
    }
  });

  it("refuses a flavor named by the baseline calls unless it is registered", async () => {
    const host = new FakeHost();
    for (const bad of ["OLM_Local", "olm", "12sp9 ", ""]) {
      expect(await kindOf(() => host.baselineBuild(bad as never))).toBe("Refused");
      expect(await kindOf(() => host.baselineVerify(bad as never))).toBe("Refused");
    }
  });

  it("refuses staged paths that escape the staging folder or hit the deny-list", async () => {
    const host = await provisioned();
    const staging = stagingDir("lease1");
    const bad = [
      "C:\\Program Files (x86)\\Aras\\Innovator\\Server",
      "C:\\Aras\\Innovator",
      `${staging}\\..\\..\\slots\\12sp9\\01`,
      `${staging}\\OLM_Local.bak`,
      `${staging}\\prod.bak`,
      `${goldenDir("12sp9")}\\Core.bak`,
      `${stagingDir("lease1", "C:\\other_root")}\\x`,
      "\\\\host\\share\\x.bak",
      "/mnt/c/aras_installations/staging/x",
      "relative\\x",
      "",
      "C:\\aras_installations\\staging",
      "C:\\aras_installations\\staging\\x.bak",
      staging,
    ];
    for (const path of bad) {
      expect(await kindOf(() => host.deployCode(slot, path)), path).toBe("Refused");
      expect(await kindOf(() => host.restoreDatabase(slot, path)), path).toBe("Refused");
      expect(await kindOf(() => host.backupDatabase(slot, path)), path).toBe("Refused");
    }
    expect(host.inspect(slot)).toMatchObject({ deployed: [], restored: [], backedUp: [] });
  });

  it("refuses a staged path under another lease's folder once the stamp carries a lease id", async () => {
    const host = await provisioned();
    const stamp = (await host.readStamp(slot)).stamp!;
    await host.writeStamp(slot, { ...stamp, leaseId: "lease1" });
    const other = `${stagingDir("lease2")}\\x.bak`;
    expect(await kindOf(() => host.deployCode(slot, other))).toBe("Refused");
    expect(await kindOf(() => host.restoreDatabase(slot, other))).toBe("Refused");
    expect(await kindOf(() => host.backupDatabase(slot, other))).toBe("Refused");
    expect(await kindOf(() => host.restoreDatabase(slot, `${stagingDir("lease1")}\\x.bak`))).toBe("none");
  });

  it("refuses a staged path with a junction in it", async () => {
    const staging = stagingDir("lease1");
    const host = new FakeHost({ isReparsePoint: (p) => p === `${staging}\\link` });
    await host.provisionSlot(slot);
    expect(await kindOf(() => host.deployCode(slot, `${staging}\\link\\x`))).toBe("Refused");
    expect(await kindOf(() => host.deployCode(slot, `${staging}\\fine\\x`))).toBe("none");
  });

  it("refuses an install root on the deny-list when constructed", () => {
    expect(() => new FakeHost({ root: "C:\\Program Files (x86)\\Aras\\Innovator" })).toThrow(GuardError);
    expect(() => new FakeHost({ root: "C:\\Aras28" })).toThrow(GuardError);
    expect(() => new FakeHost({ root: "C:\\Users\\omkarb\\aras" })).toThrow(GuardError);
  });

  it("runs the guards before it reports the host unreachable or applies a fault", async () => {
    const host = new FakeHost();
    host.setReachable(false);
    host.injectFault({ method: "healthCheck", kind: "fail", error: "Quarantine" });
    expect(await kindOf(() => host.healthCheck({ flavor: "olm" as never, slot: 1 }))).toBe("Refused");
  });
});

describe("FakeHost faults", () => {
  it("fails a step on its Nth call and leaves the slot unchanged", async () => {
    const host = await provisioned();
    host.injectFault({ method: "quiesce", nth: 2, kind: "fail", error: "Quarantine", message: "locked" });
    await host.quiesce(slot);
    expect(await kindOf(() => host.quiesce(slot))).toBe("Quarantine");
    await host.startSlot(slot, { agent: true });
    expect(await kindOf(() => host.quiesce(slot))).toBe("none");
  });

  it("fails the first call by default and as Retryable", async () => {
    const host = await provisioned();
    host.injectFault({ method: "resetTree", kind: "fail" });
    await host.quiesce(slot);
    const err = await host.resetTree(slot, host.golden("12sp9")).catch((e: unknown) => e);
    expect(isHostError(err, "Retryable")).toBe(true);
    expect((await host.resetTree(slot, host.golden("12sp9"))).ok).toBe(true);
  });

  it("fails consecutive calls with `times`, and every call with Infinity", async () => {
    const host = new FakeHost();
    host.injectFault({ method: "ping", times: 2, kind: "fail" });
    expect([await kindOf(() => host.ping()), await kindOf(() => host.ping()), await kindOf(() => host.ping())]).toEqual([
      "Retryable",
      "Retryable",
      "none",
    ]);
    host.clearFaults();
    host.injectFault({ method: "ping", times: Infinity, kind: "fail", error: "Unreachable" });
    for (let i = 0; i < 5; i++) expect(await kindOf(() => host.ping())).toBe("Unreachable");
  });

  it("counts only the matching slot when a fault names one", async () => {
    const host = new FakeHost();
    await host.provisionSlot(slot);
    await host.provisionSlot(other);
    host.injectFault({ method: "healthCheck", slot: other, kind: "fail", error: "Quarantine" });
    expect(await kindOf(() => host.healthCheck(slot))).toBe("none");
    expect(await kindOf(() => host.healthCheck(slot))).toBe("none");
    expect(await kindOf(() => host.healthCheck(other))).toBe("Quarantine");
    expect(await kindOf(() => host.healthCheck(other))).toBe("none");
  });

  it("makes a step slow on the fake clock and reports it in `ms`", async () => {
    const clock = new FakeClock();
    const host = new FakeHost({ clock, latencyMs: 5 });
    host.injectFault({ method: "ping", kind: "slow", ms: 40_000 });
    const t0 = clock.now();
    expect((await host.ping()).ms).toBe(40_005);
    expect(clock.now() - t0).toBe(40_005);
    expect((await host.ping()).ms).toBe(5);
    expect(host.calls.map((c) => c.ms)).toEqual([40_005, 5]);
  });

  it("hangs a call until released, then lets it succeed", async () => {
    const host = new FakeHost();
    host.injectFault({ method: "ping", kind: "hang" });
    let settled = false;
    const pending = host.ping().then((r) => {
      settled = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(host.hangingCalls).toBe(1);
    expect(host.calls[0]?.outcome).toBe("hung");
    host.releaseHangs();
    expect((await pending).ok).toBe(true);
    expect(host.hangingCalls).toBe(0);
    expect(host.calls[0]?.outcome).toBe("ok");
  });

  it("throws Unreachable for every call while the host is unreachable", async () => {
    const host = await provisioned();
    host.setReachable(false);
    expect(await kindOf(() => host.ping())).toBe("Unreachable");
    expect(await kindOf(() => host.healthCheck(slot))).toBe("Unreachable");
    host.setReachable(true);
    expect((await host.ping()).ok).toBe(true);
  });

  it("rejects a malformed fault", () => {
    const host = new FakeHost();
    expect(() => host.injectFault({ method: "nope" as never, kind: "fail" })).toThrow();
    expect(() => host.injectFault({ method: "ping", kind: "fail", nth: 0 })).toThrow();
  });
});

describe("FakeHost call record", () => {
  it("records every call in order, refused ones too", async () => {
    const host = new FakeHost();
    await host.ping();
    await host.provisionSlot(slot);
    await host.quiesce({ flavor: "olm" as never, slot: 1 }).catch(() => {});
    await host.baselineVerify("23");
    await host.listSlots();
    expect(host.callLog).toEqual(["ping", "provisionSlot", "quiesce", "baselineVerify", "listSlots"]);
    expect(host.calls.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(host.calls.map((c) => c.target)).toEqual([null, "12sp9-01", "olm/1", "23", null]);
    expect(host.calls.map((c) => c.outcome)).toEqual(["ok", "ok", "error", "not-ok", "ok"]);
  });

  it("records the time each call started", async () => {
    const clock = new FakeClock(1000);
    const host = new FakeHost({ clock, latencyMs: 10 });
    await host.ping();
    clock.advance(90);
    await host.ping();
    expect(host.calls.map((c) => c.at)).toEqual([1000, 1100]);
  });

  it("never records a credential handle", async () => {
    const host = await provisioned();
    await host.setLeaseCredentials(slot, handle("handle-for-lease-xyz"));
    expect(JSON.stringify(host.calls)).not.toContain("handle-for-lease-xyz");
    expect(host.calls.at(-1)?.args).toEqual(handle("[handle]"));
    expect(host.inspect(slot)?.credentials).toEqual(handle("handle-for-lease-xyz"));
  });

  it("forgets the credentials when the database is reset", async () => {
    const host = await provisioned();
    await host.setLeaseCredentials(slot, handle("lease-abc"));
    await host.resetDatabase(slot, host.backup(slot.flavor));
    expect(host.inspect(slot)?.credentials).toBeNull();
  });

  it("refuses an empty secret handle", async () => {
    const host = await provisioned();
    expect(await kindOf(() => host.setLeaseCredentials(slot, handle("")))).toBe("Refused");
  });
});
