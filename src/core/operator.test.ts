import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../host/clock.js";
import type { HostMethod } from "../host/driver.js";
import { HostError } from "../host/errors.js";
import { FakeHost, fakeGoldenHash } from "../host/fake.js";
import { type ArashouseConfig, DEFAULT_CONFIG } from "./config.js";
import { EXIT_CODES } from "./exit-codes.js";
import type { FlavorKey } from "./flavors.js";
import { DENIED_ALIASES, DENIED_DATABASES, DENIED_INSTALL_ROOTS, DENIED_SERVICE_PREFIXES, DENIED_SUBSTRINGS } from "./guards.js";
import { type LeaseDeps, type LeaseGrant, buildStatus, exitCodeFor, formatStatus, getLease, leaseRef, leaseSecretName, returnLease } from "./lease.js";
import {
  type OperatorDeps,
  type OperatorHost,
  DRY_RUN,
  destroySlot,
  disableSlot,
  doctor,
  enableSlot,
  forceReturn,
  prune,
  provisionPool,
  repairSlot,
} from "./operator.js";
import { parseSlotId } from "./names.js";
import { type ResetDeps, resetHooks, resetSlot } from "./reset.js";
import { Secret } from "./secret.js";
import { MemorySecretStore } from "./secret-store.js";
import type { Slot } from "./state.js";
import { StateStore } from "./store.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "arashouse-operator-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const MY_PID = 4242;

/** Host calls that change something on the host. */
const MUTATING = new Set<HostMethod>([
  "provisionSlot",
  "destroySlot",
  "quiesce",
  "resetTree",
  "resetDatabase",
  "startSlot",
  "stopSlot",
  "writeStamp",
  "setLeaseCredentials",
  "deployCode",
  "restoreDatabase",
  "backupDatabase",
  "baselineBuild",
]);

interface Pool {
  readonly store: StateStore;
  readonly host: FakeHost;
  readonly clock: FakeClock;
  readonly secrets: MemorySecretStore;
  readonly alive: Set<number>;
  /** Slots a reset worker was started for. */
  readonly started: string[];
  readonly deps: OperatorDeps;
  readonly lease: LeaseDeps;
  status(id: string): Promise<Slot | undefined>;
}

async function pool(spec: Partial<Record<FlavorKey, number>>, options: { config?: Partial<ArashouseConfig>; host?: (h: FakeHost) => OperatorHost } = {}): Promise<Pool> {
  const clock = new FakeClock(Date.UTC(2026, 9, 27, 9, 0, 0));
  const now = () => new Date(clock.now());
  const store = new StateStore({ home, now });
  const host = new FakeHost({ clock, baselines: ["12sp9", "23", "35"] });
  for (const [flavor, count] of Object.entries(spec) as [FlavorKey, number][]) {
    for (let n = 1; n <= count; n++) {
      await store.update((tx) => {
        const slot = tx.addSlot({ flavor, slot: n });
        tx.transition(slot.id, { to: "free", golden_hash: fakeGoldenHash(flavor), reset_ms: 1 });
      });
      await host.provisionSlot({ flavor, slot: n });
    }
  }
  const alive = new Set<number>([MY_PID]);
  const config = { ...DEFAULT_CONFIG, ...options.config };
  const secrets = new MemorySecretStore();
  const started: string[] = [];
  const reset: ResetDeps = {
    store,
    host,
    golden: async (flavor) => ({ tree: host.golden(flavor), backup: host.backup(flavor) }),
    config,
    pid: MY_PID,
    startTime: null,
    isWorkerAlive: (pid) => alive.has(pid),
    now,
  };
  const deps: OperatorDeps = {
    store,
    host: options.host ? options.host(host) : host,
    secrets,
    reset,
    startWorker: (slot) => started.push(slot),
    media: async () => true,
    now,
  };
  const lease: LeaseDeps = {
    store,
    host,
    secrets,
    resolveUrl: async (alias) => `http://172.19.0.1/${alias}`,
    config,
    isWaiterAlive: () => true,
    now,
    reset: resetHooks(reset, (slot) => started.push(slot)),
  };
  return { store, host, clock, secrets, alive, started, deps, lease, status: async (id) => (await store.read()).slots[id] };
}

async function take(p: Pool, flavor: FlavorKey, holder = "task-a"): Promise<LeaseGrant> {
  return getLease(p.lease, { flavor, holder });
}

/** Everything a command could change: the state file, the host's slots and the lease passwords. */
async function snapshot(p: Pool): Promise<string> {
  const state = await readFile(p.store.paths.state, "utf8").catch(() => "");
  const listed = (await p.host.listSlots()).slots.map((s) => JSON.stringify(p.host.inspect(s.slot)));
  return JSON.stringify({ state, listed, secrets: p.secrets.size });
}

function mutatingCallsSince(p: Pool, seq: number): HostMethod[] {
  return p.host.calls.filter((c) => c.seq > seq && MUTATING.has(c.method)).map((c) => c.method);
}

/** Runs `fn` and resolves with its exit code, as the CLI would exit. */
async function exitOf(fn: () => Promise<unknown>): Promise<number> {
  try {
    return ((await fn()) as { exitCode?: number }).exitCode ?? EXIT_CODES.ok;
  } catch (err) {
    return exitCodeFor(err);
  }
}

describe("dry runs", () => {
  it("change nothing: destroy, prune, force-return, doctor --fix and --rebuild-state without --yes", async () => {
    const p = await pool({ "23": 3 });
    const grant = await take(p, "23");
    await disableSlot(p.deps, "23-02");
    await p.host.provisionSlot({ flavor: "35", slot: 1 }); // an orphan
    const before = await snapshot(p);
    const seq = p.host.calls.length;

    const destroy = await destroySlot(p.deps, { slot: "23-03", yes: false });
    expect(destroy.lines).toContain(DRY_RUN);
    expect(destroy.lines[0]).toMatch(/^would destroy 23-03: its record \(free\); application ah-23-03/);
    const pruned = await prune(p.deps, { yes: false });
    expect(pruned.lines).toEqual(["would destroy 23-02 (disabled)", "would destroy 35-01 (orphaned: on the host with no slot record)", DRY_RUN]);
    const forced = await forceReturn(p.deps, { slot: grant.slot, leaseId: leaseRef(grant.lease_id), yes: false });
    expect(forced.lines).toEqual([expect.stringMatching(/^would force-return 23-01: lease [0-9a-f]{8}, held by task-a/), DRY_RUN]);
    const doc = await doctor(p.deps, { fix: true, rebuildState: true });
    expect(doc.lines.join("\n")).toContain("would destroy 35-01; add --yes");
    expect(doc.lines.join("\n")).toContain("--rebuild-state would replace the state");

    expect(await snapshot(p)).toBe(before);
    expect(mutatingCallsSince(p, seq)).toEqual([]);
    expect(p.started).toEqual([]);
  });
});

describe("--yes", () => {
  it("is needed for every destructive command", async () => {
    const p = await pool({ "23": 3 });
    const grant = await take(p, "23");
    await disableSlot(p.deps, "23-02");
    await p.host.provisionSlot({ flavor: "35", slot: 1 });

    expect((await destroySlot(p.deps, { slot: "23-03", yes: false })).lines).toContain(DRY_RUN);
    expect(await p.status("23-03")).toBeDefined();
    const destroyed = await destroySlot(p.deps, { slot: "23-03", yes: true });
    expect(destroyed.lines[0]).toMatch(/^destroyed 23-03: application ah-23-03, .*database arashouse_23_03 and its logins/);
    expect(await p.status("23-03")).toBeUndefined();
    expect(p.host.inspect({ flavor: "23", slot: 3 })).toBeUndefined();

    const pruned = await prune(p.deps, { yes: true });
    expect(pruned.exitCode).toBe(0);
    expect(await p.status("23-02")).toBeUndefined();
    expect(p.host.inspect({ flavor: "23", slot: 2 })).toBeUndefined();
    expect(p.host.inspect({ flavor: "35", slot: 1 })).toBeUndefined();

    await forceReturn(p.deps, { slot: "23-01", leaseId: grant.lease_id, yes: true });
    expect((await p.status("23-01"))?.status).toBe("dirty");
    expect(await p.secrets.has(leaseSecretName(grant.lease_id))).toBe(false);
    expect(p.started).toEqual(["23-01"]);

    const events = await p.store.events();
    expect(events.filter((e) => e.event === "slot-removed").map((e) => [e.slot, e.from, e.reason])).toEqual([
      ["23-03", "free", "destroyed by the operator"],
      ["23-02", "disabled", "destroyed by the operator"],
    ]);
    expect(events.at(-1)).toMatchObject({ slot: "23-01", from: "leased", to: "dirty", reason: "force-returned by the operator" });
  });
});

describe("destroy", () => {
  it("leaves a leased slot alone without --include-leased, and destroys it with it", async () => {
    const p = await pool({ "23": 1 });
    const grant = await take(p, "23");
    const seq = p.host.calls.length;
    const before = await snapshot(p);
    await expect(destroySlot(p.deps, { slot: "23-01", yes: true })).rejects.toMatchObject({ exitCode: EXIT_CODES.refused });
    await expect(destroySlot(p.deps, { slot: "23-01", yes: false })).rejects.toMatchObject({ exitCode: EXIT_CODES.refused });
    expect(await snapshot(p)).toBe(before);
    expect(mutatingCallsSince(p, seq)).toEqual([]);
    expect((await p.status("23-01"))?.lease?.lease_id).toBe(grant.lease_id);

    await destroySlot(p.deps, { slot: "23-01", yes: true, includeLeased: true });
    expect(await p.status("23-01")).toBeUndefined();
    expect(p.host.inspect({ flavor: "23", slot: 1 })).toBeUndefined();
    expect(await p.secrets.has(leaseSecretName(grant.lease_id))).toBe(false);
  });

  it("refuses a slot whose reset is running, and destroys one whose worker has died", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => {
      tx.transition("23-01", { to: "dirty" });
      tx.transition("23-01", { to: "resetting", pid: MY_PID });
    });
    await expect(destroySlot(p.deps, { slot: "23-01", yes: true })).rejects.toMatchObject({ exitCode: EXIT_CODES.refused });
    p.alive.delete(MY_PID);
    await destroySlot(p.deps, { slot: "23-01", yes: true });
    expect(await p.status("23-01")).toBeUndefined();
  });

  it("drops a record that is not on the host, and says so", async () => {
    const p = await pool({ "23": 1 });
    await p.host.destroySlot({ flavor: "23", slot: 1 });
    const seq = p.host.calls.length;
    expect((await destroySlot(p.deps, { slot: "23-01", yes: true })).lines).toEqual(["removed the record of 23-01; it was not on the host"]);
    expect(mutatingCallsSince(p, seq)).toEqual([]);
  });

  it("is a usage error for a slot that is in neither the pool nor on the host", async () => {
    const p = await pool({});
    expect(await exitOf(() => destroySlot(p.deps, { slot: "23-07", yes: true }))).toBe(EXIT_CODES.usage);
  });

  it("names the orphan it leaves when the host fails", async () => {
    const p = await pool({ "23": 1 });
    p.host.injectFault({ method: "destroySlot", kind: "fail", error: "Unreachable" });
    await expect(destroySlot(p.deps, { slot: "23-01", yes: true })).rejects.toMatchObject({
      exitCode: EXIT_CODES.hostUnreachable,
      message: expect.stringMatching(/removed the record of 23-01, but the host did not destroy it .*orphan/),
    });
    expect(await p.status("23-01")).toBeUndefined();
    const doc = await doctor(p.deps, {});
    expect(doc.lines).toContain("fail  orphan 23-01: on the host with no slot record (`arashouse prune --yes` removes it)");
  });
});

describe("prune", () => {
  it("never prunes by age, and leaves an orphan whose stamp names a lease", async () => {
    const p = await pool({ "23": 1 });
    await take(p, "23");
    p.clock.advance(90 * 24 * 3600 * 1000);
    await p.host.provisionSlot({ flavor: "35", slot: 2 });
    const stamp = (await p.host.readStamp({ flavor: "35", slot: 2 })).stamp!;
    await p.host.writeStamp({ flavor: "35", slot: 2 }, { ...stamp, leaseId: "a".repeat(32) });
    const r = await prune(p.deps, { yes: true });
    expect(r.lines[0]).toBe("nothing to prune: no disabled or orphaned slot");
    expect(r.lines[1]).toMatch(/^left orphan 35-02: its stamp names a lease/);
    expect((await p.status("23-01"))?.status).toBe("leased");
    expect(p.host.inspect({ flavor: "35", slot: 2 })).toBeDefined();
  });

  it("skips a disabled slot that was enabled since it was listed", async () => {
    const p = await pool({ "23": 1 });
    await disableSlot(p.deps, "23-01");
    const host = p.host;
    let enabled = false;
    const racing: OperatorHost = Object.assign(Object.create(host) as FakeHost, {
      listSlots: async () => {
        const listed = await host.listSlots();
        if (!enabled) {
          enabled = true;
          await enableSlot(p.deps, "23-01");
        }
        return listed;
      },
    });
    const r = await prune({ ...p.deps, host: racing }, { yes: true });
    expect(r.lines).toEqual(["skipped 23-01 is no longer disabled"]);
    expect((await p.status("23-01"))?.status).toBe("dirty");
    expect(p.host.inspect({ flavor: "23", slot: 1 })).toBeDefined();
  });
});

describe("force-return", () => {
  it("with a wrong lease id changes nothing (exit 4), and cannot hit a later lease", async () => {
    const p = await pool({ "23": 1 });
    const first = await take(p, "23", "task-a");
    await returnLease(p.lease, { target: first.lease_id });
    expect((await resetSlot(p.deps.reset, "23-01")).kind).toBe("free");
    const second = await take(p, "23", "task-b");
    const before = await snapshot(p);
    const seq = p.host.calls.length;
    for (const leaseId of [leaseRef(first.lease_id), first.lease_id, "0123abcd"]) {
      for (const yes of [false, true]) {
        expect(await exitOf(() => forceReturn(p.deps, { slot: "23-01", leaseId, yes }))).toBe(EXIT_CODES.leaseMismatch);
      }
    }
    expect(await snapshot(p)).toBe(before);
    expect(mutatingCallsSince(p, seq)).toEqual([]);
    expect((await p.status("23-01"))?.lease?.lease_id).toBe(second.lease_id);
  });

  it("needs a lease id in the shape status shows, and is a no-op on a slot that is not leased", async () => {
    const p = await pool({ "23": 1 });
    expect(await exitOf(() => forceReturn(p.deps, { slot: "23-01", leaseId: undefined, yes: true }))).toBe(EXIT_CODES.usage);
    expect(await exitOf(() => forceReturn(p.deps, { slot: "23-01", leaseId: "0123abc", yes: true }))).toBe(EXIT_CODES.usage);
    expect(await exitOf(() => forceReturn(p.deps, { slot: "23-01", leaseId: "0123ABCD", yes: true }))).toBe(EXIT_CODES.usage);
    expect((await forceReturn(p.deps, { slot: "23-01", leaseId: "0123abcd", yes: true })).lines).toEqual(["23-01 is free, not leased: nothing to return"]);
  });

  it("takes the lease reference from status and dirties the slot like return", async () => {
    const p = await pool({ "23": 1 });
    const grant = await take(p, "23");
    const shown = (await buildStatus(await p.store.read(), { now: new Date(p.clock.now()) })).slots[0]!.lease!;
    const r = await forceReturn(p.deps, { slot: "23-01", leaseId: shown, yes: true });
    expect(r.lines[0]).toBe(`force-returned 23-01 (lease ${shown}, held by task-a); it is reset before it is handed out again`);
    expect((await p.status("23-01"))?.status).toBe("dirty");
    expect(await p.secrets.has(leaseSecretName(grant.lease_id))).toBe(false);
    expect(p.started).toEqual(["23-01"]);
  });
});

describe("disable and enable", () => {
  it("takes a slot out of rotation and stops it, and puts it back through a reset", async () => {
    const p = await pool({ "23": 1 });
    const r = await disableSlot(p.deps, "23-01");
    expect(r.lines).toEqual(["disabled 23-01 (it was free); it is not handed out until `arashouse enable 23-01`", "stopped 23-01: its applications are offline"]);
    expect(p.host.inspect({ flavor: "23", slot: 1 })?.online).toBe(false);
    expect(await exitOf(() => getLease(p.lease, { flavor: "23", holder: "x" }))).toBe(EXIT_CODES.noSlot);
    expect((await disableSlot(p.deps, "23-01")).lines).toEqual(["23-01 is already disabled"]);

    expect((await enableSlot(p.deps, "23-01")).lines).toEqual(["enabled 23-01: it is reset before it is handed out"]);
    expect((await p.status("23-01"))?.status).toBe("dirty");
    expect(p.started).toEqual(["23-01"]);
    expect((await enableSlot(p.deps, "23-01")).lines).toEqual(["23-01 is dirty, not disabled: nothing to do"]);
  });

  it("refuses a leased slot, and stays disabled when the host cannot stop it", async () => {
    const p = await pool({ "23": 2 });
    await take(p, "23");
    expect(await exitOf(() => disableSlot(p.deps, "23-01"))).toBe(EXIT_CODES.refused);
    expect((await p.status("23-01"))?.status).toBe("leased");
    p.host.setReachable(false);
    const r = await disableSlot(p.deps, "23-02");
    expect(r.lines[1]).toMatch(/^23-02 could not be stopped \(the host did not answer\); it is out of rotation all the same$/);
    expect((await p.status("23-02"))?.status).toBe("disabled");
  });
});

describe("repair", () => {
  async function quarantine(p: Pool, id: string): Promise<void> {
    await p.store.update((tx) => {
      tx.transition(id, { to: "dirty" });
      tx.transition(id, { to: "resetting", pid: 99 });
      tx.transition(id, { to: "quarantined", reason: "reset step tree failed twice: boom" });
    });
    p.host.dirty(parseSlotId(id), "tree");
  }

  it("resets a quarantined slot from golden and frees it", async () => {
    const p = await pool({ "23": 1 });
    await quarantine(p, "23-01");
    const seq = p.host.calls.length;
    const r = await repairSlot(p.deps, { slot: "23-01" });
    expect(r.exitCode).toBe(0);
    expect(r.lines.at(-1)).toBe("repaired 23-01");
    expect(mutatingCallsSince(p, seq)).toEqual(["quiesce", "resetDatabase", "resetTree", "startSlot"]);
    const slot = await p.status("23-01");
    expect(slot).toMatchObject({ status: "free", golden_hash: fakeGoldenHash("23") });
    expect(slot?.reset).toBeUndefined();
  });

  it("with --rebuild destroys and provisions the slot first, behind the disk gate", async () => {
    const p = await pool({ "23": 1 });
    await quarantine(p, "23-01");
    p.host.setHostInfo({ freeDiskGb: 1 });
    expect(await exitOf(() => repairSlot(p.deps, { slot: "23-01", rebuild: true }))).toBe(EXIT_CODES.refused);
    expect((await p.status("23-01"))?.status).toBe("quarantined");
    p.host.setHostInfo({ freeDiskGb: 200 });
    const seq = p.host.calls.length;
    const r = await repairSlot(p.deps, { slot: "23-01", rebuild: true });
    expect(r.exitCode).toBe(0);
    expect(mutatingCallsSince(p, seq)).toEqual(["destroySlot", "provisionSlot", "quiesce", "resetDatabase", "resetTree", "startSlot"]);
    expect((await p.status("23-01"))?.status).toBe("free");
    const moves = (await p.store.events()).filter((e) => e.slot === "23-01" && e.event === "transition").map((e) => e.to);
    expect(moves.slice(-5)).toEqual(["quarantined", "provisioning", "dirty", "resetting", "free"]);
  });

  it("quarantines again with exit 5 when the reset fails twice, and quarantines a failed rebuild", async () => {
    const p = await pool({ "23": 1 });
    await quarantine(p, "23-01");
    p.host.injectFault({ method: "resetTree", kind: "fail", times: 2 });
    const r = await repairSlot(p.deps, { slot: "23-01" });
    expect(r.exitCode).toBe(EXIT_CODES.resetFailed);
    expect((await p.status("23-01"))?.quarantine_reason).toMatch(/reset step tree failed twice/);

    p.host.injectFault({ method: "provisionSlot", kind: "fail", error: "Unreachable" });
    expect(await exitOf(() => repairSlot(p.deps, { slot: "23-01", rebuild: true }))).toBe(EXIT_CODES.hostUnreachable);
    expect((await p.status("23-01"))?.quarantine_reason).toMatch(/^repair --rebuild failed: /);
  });

  it("refuses a slot that is not quarantined", async () => {
    const p = await pool({ "23": 1 });
    expect(await exitOf(() => repairSlot(p.deps, { slot: "23-01" }))).toBe(EXIT_CODES.refused);
    expect(await exitOf(() => repairSlot(p.deps, { slot: "23-02" }))).toBe(EXIT_CODES.usage);
  });
});

describe("provision", () => {
  const provisioned = (p: Pool, seq: number) => p.host.calls.filter((c) => c.seq > seq && c.method === "provisionSlot").map((c) => c.target);

  it("provisions the missing slots in order and frees each once its health check passes", async () => {
    const p = await pool({});
    const r = await provisionPool(p.deps, { flavor: "23", count: 2 });
    expect(r.exitCode).toBe(0);
    expect(provisioned(p, 0)).toEqual(["23-01", "23-02"]);
    expect(r.lines).toEqual(["provisioned 23-01 (provisioned 23-01); free", "provisioned 23-02 (provisioned 23-02); free"]);
    for (const id of ["23-01", "23-02"]) expect(await p.status(id)).toMatchObject({ status: "free", golden_hash: fakeGoldenHash("23") });
    const moves = (await p.store.events()).filter((e) => e.slot === "23-02").map((e) => e.to);
    expect(moves).toEqual(["provisioning", "free"]);
  });

  it("defaults to slots_per_flavor, and leaves a slot already in the pool alone", async () => {
    const p = await pool({ "23": 1 }, { config: { slots_per_flavor: { "12sp9": 3, "23": 2, "35": 2 } } });
    await p.store.update((tx) => tx.transition("23-01", { to: "disabled" }));
    const seq = p.host.calls.length;
    const r = await provisionPool(p.deps, { flavor: "23" });
    expect(r.lines).toEqual(["23-01 is in the pool already (disabled)", "provisioned 23-02 (provisioned 23-02); free"]);
    expect(provisioned(p, seq)).toEqual(["23-02"]);
  });

  it("finishes a slot an earlier run left provisioning, and does not provision one the host already has", async () => {
    const p = await pool({});
    await p.store.update((tx) => {
      tx.addSlot({ flavor: "35", slot: 1 });
      tx.addSlot({ flavor: "35", slot: 2 });
    });
    await p.host.provisionSlot({ flavor: "35", slot: 1 });
    const seq = p.host.calls.length;
    const r = await provisionPool(p.deps, { flavor: "35", count: 2 });
    expect(r.lines[0]).toBe("provisioned 35-01 (it was on the host already); free");
    expect(provisioned(p, seq)).toEqual(["35-02"]);
    expect((await p.status("35-02"))?.status).toBe("free");
  });

  it("removes the record of a slot whose provision failed (the host rolled it back), and stops there", async () => {
    const p = await pool({});
    p.host.injectFault({ method: "provisionSlot", kind: "fail", nth: 2, error: "Retryable" });
    let message = "";
    const code = await exitOf(() =>
      provisionPool(p.deps, { flavor: "12sp9", count: 3 }).catch((err: Error) => {
        message = err.message;
        throw err;
      }),
    );
    expect(code).toBe(EXIT_CODES.hostUnreachable);
    expect(message.split("\n")[0]).toBe("provisioned 12sp9-01 (provisioned 12sp9-01); free");
    expect(message).toMatch(/12sp9-02 was rolled back and its record removed$/);
    expect(await p.status("12sp9-02")).toBeUndefined();
    expect(await p.status("12sp9-03")).toBeUndefined();
    expect(provisioned(p, 0)).toEqual(["12sp9-01", "12sp9-02"]);
  });

  it("quarantines a failed slot that the host still lists, and leaves one provisioning when the host did not answer", async () => {
    const p = await pool({});
    const host: OperatorHost = Object.assign(Object.create(p.host) as FakeHost, {
      provisionSlot: async (slot: { flavor: FlavorKey; slot: number }) => {
        await p.host.provisionSlot(slot);
        throw new HostError("Quarantine", "the rollback left IIS application /ah-23-01");
      },
    });
    expect(await exitOf(() => provisionPool({ ...p.deps, host }, { flavor: "23", count: 1 }))).toBe(EXIT_CODES.hostUnreachable);
    expect(await p.status("23-01")).toMatchObject({ status: "quarantined", quarantine_reason: expect.stringMatching(/^provision failed: the rollback left/) });

    p.host.injectFault({ method: "provisionSlot", kind: "fail", error: "Unreachable" });
    expect(await exitOf(() => provisionPool(p.deps, { flavor: "35", count: 1 }))).toBe(EXIT_CODES.hostUnreachable);
    expect((await p.status("35-01"))?.status).toBe("provisioning");
    expect((await provisionPool(p.deps, { flavor: "35", count: 1 })).lines).toEqual(["provisioned 35-01 (provisioned 35-01); free"]);
  });

  it("quarantines a slot whose health check fails, and leaves one dirty (with a reset worker) when the check cannot run", async () => {
    const p = await pool({});
    const failing: OperatorHost = Object.assign(Object.create(p.host) as FakeHost, {
      healthCheck: async () => ({ ok: false, ms: 1, detail: "unhealthy", checks: [{ name: "tree", ok: false, detail: "3 files differ" }] }),
    });
    await provisionPool({ ...p.deps, host: failing }, { flavor: "23", count: 1 });
    expect(await p.status("23-01")).toMatchObject({ status: "quarantined", quarantine_reason: "the health check after its provision failed: tree: 3 files differ" });

    p.host.injectFault({ method: "healthCheck", kind: "fail", error: "Unreachable" });
    const r = await provisionPool(p.deps, { flavor: "35", count: 1 });
    expect(r.lines[0]).toMatch(/^provisioned 35-01 \(provisioned 35-01\); dirty: the health check could not run \(.*\); a reset makes it free$/);
    expect((await p.status("35-01"))?.status).toBe("dirty");
    expect(p.started).toEqual(["35-01"]);
  });

  it("refuses a deny-listed flavor, an unknown flavor or count, and a host short of disk, before anything changes", async () => {
    const p = await pool({});
    expect(await exitOf(() => provisionPool(p.deps, { flavor: "OLM_Local" }))).toBe(EXIT_CODES.refused);
    expect(await exitOf(() => provisionPool(p.deps, { flavor: "14sp18" }))).toBe(EXIT_CODES.usage);
    expect(await exitOf(() => provisionPool(p.deps, { flavor: "23", count: 0 }))).toBe(EXIT_CODES.usage);
    expect(await exitOf(() => provisionPool(p.deps, { flavor: "23", count: 100 }))).toBe(EXIT_CODES.usage);
    p.host.setHostInfo({ freeDiskGb: 1 });
    expect(await exitOf(() => provisionPool(p.deps, { flavor: "23", count: 1 }))).toBe(EXIT_CODES.refused);
    expect((await p.store.read()).slots).toEqual({});
    expect(mutatingCallsSince(p, 0)).toEqual([]);
  });

  it("holds the provision lock for the whole run, and releases it on a failure", async () => {
    const p = await pool({});
    const held: string[] = [];
    const provisionLock = async () => {
      held.push("acquire");
      return { release: async () => void held.push("release") };
    };
    await provisionPool({ ...p.deps, provisionLock }, { flavor: "23", count: 1 });
    p.host.injectFault({ method: "provisionSlot", kind: "fail" });
    await exitOf(() => provisionPool({ ...p.deps, provisionLock }, { flavor: "23", count: 2 }));
    expect(held).toEqual(["acquire", "release", "acquire", "release"]);
  });
});

describe("doctor", () => {
  it("finds an orphan the fake hosts and an unrecorded dirty slot, and --fix deals with both", async () => {
    const p = await pool({ "23": 2 });
    await p.host.provisionSlot({ flavor: "35", slot: 1 });
    p.host.dirty({ flavor: "23", slot: 2 }, "tree");

    const found = await doctor(p.deps, {});
    expect(found.exitCode).toBe(1);
    expect(found.lines).toContain("ok    slot 23-01: free and clean");
    expect(found.lines).toContain("fail  slot 23-02: free in the state but not clean on the host: health check failed: failed: tree-clean");
    expect(found.lines).toContain("fail  orphan 35-01: on the host with no slot record (`arashouse prune --yes` removes it)");
    expect(found.lines.at(-1)).toBe("doctor: 2 problems, 0 warnings");
    expect((await p.status("23-02"))?.status).toBe("free");

    const fixedNoYes = await doctor(p.deps, { fix: true });
    expect(fixedNoYes.exitCode).toBe(1);
    expect(fixedNoYes.lines).toContain("      fixed: marked dirty; a reset worker resets it");
    expect(fixedNoYes.lines).toContain("      not fixed: would destroy 35-01; add --yes");
    expect((await p.status("23-02"))?.status).toBe("dirty");
    expect(p.started).toEqual(["23-02"]);
    expect(p.host.inspect({ flavor: "35", slot: 1 })).toBeDefined();

    const fixed = await doctor(p.deps, { fix: true, yes: true });
    expect(fixed.lines).toContainEqual(expect.stringMatching(/^ {6}fixed: destroyed 35-01: application ah-35-01, /));
    expect(p.host.inspect({ flavor: "35", slot: 1 })).toBeUndefined();
    expect(fixed.exitCode).toBe(0);
  });

  it("reports the broker, SQL, disk, RAM, media and baselines", async () => {
    const p = await pool({ "23": 1 }, { config: { min_free_disk_gb: 10, min_free_ram_mb: 2048 } });
    const ok = await doctor(p.deps, {});
    expect(ok.exitCode).toBe(0);
    expect(ok.lines).toEqual(
      expect.arrayContaining(["ok    broker: answers (pong)", "ok    sql: the broker's SQL login connects", "ok    sql login: NT SERVICE\\ArasHouseBroker is neither sysadmin nor dbcreator, and executes the 5 arashouse_admin procedures", "ok    disk: 200 GB free at the install root", "ok    ram: 16384 MB free", "ok    media 23: present"]),
    );
    expect(ok.lines.at(-1)).toBe("doctor: every check passed");

    const licences = new MemorySecretStore();
    await licences.put("licence-14", Secret.of("not-a-real-key", "licence"));
    const withKeys = await doctor({ ...p.deps, licences }, {});
    expect(withKeys.lines).toEqual(expect.arrayContaining(["ok    licence line 14: present", "ok    licence line 12: absent (asked for when a step needs it)"]));
    expect(withKeys.lines.join("\n")).not.toContain("not-a-real-key");

    // Without a store of its own, doctor reports what the host's hostInfo says (ticket 34b).
    p.host.setHostInfo({ licences: [{ line: "12", present: true }, { line: "14", present: false }] });
    const fromHost = await doctor(p.deps, {});
    expect(fromHost.lines).toEqual(expect.arrayContaining(["ok    licence line 12: present", "ok    licence line 14: absent (asked for when a step needs it)"]));
    p.host.setHostInfo({ licences: undefined });

    p.host.setHostInfo({ sqlReachable: false, freeDiskGb: 3, freeRamMb: 100 });
    const bad = await doctor({ ...p.deps, media: async (f) => (f === "35" ? null : false) }, {});
    expect(bad.exitCode).toBe(1);
    expect(bad.lines).toEqual(
      expect.arrayContaining([
        "fail  sql: the broker cannot connect to SQL Server with its login; run `arashouse setup-sql` and the script it writes (docs/setup-sql.md)",
        "warn  disk: 3 GB free at the install root, under min_free_disk_gb 10: no provision or baseline build starts",
        "warn  ram: 100 MB free, under min_free_ram_mb 2048: get hands out no slot",
        "warn  media 23: missing or incomplete (`arashouse media check`)",
        "warn  media 35: the media folder cannot be found",
      ]),
    );

    p.host.setReachable(false);
    const down = await doctor(p.deps, {});
    expect(down.exitCode).toBe(1);
    expect(down.lines[1]).toBe("fail  broker: did not answer: the host did not answer; the host checks were skipped");
  });

  it("fails a broker SQL login in sysadmin or dbcreator, or one that cannot execute the procedures (ticket 22)", async () => {
    const p = await pool({ "23": 1 });
    const login = { login: "NT SERVICE\\ArasHouseBroker", sysadmin: false, dbcreator: false, procedures: 5 };
    const lineOf = async () => (await doctor(p.deps, {})).lines.find((l) => l.includes("sql login:"));

    p.host.setHostInfo({ sqlLogin: { ...login, sysadmin: true, dbcreator: true } });
    expect((await doctor(p.deps, {})).exitCode).toBe(1);
    expect(await lineOf()).toBe("fail  sql login: NT SERVICE\\ArasHouseBroker is in sysadmin and dbcreator, so it could restore over any database on the server; take it out (docs/setup-sql.md)");
    p.host.setHostInfo({ sqlLogin: { ...login, dbcreator: true } });
    expect(await lineOf()).toMatch(/^fail {2}sql login: .* is in dbcreator, so it could restore over any database/);
    p.host.setHostInfo({ sqlLogin: { ...login, procedures: 0 } });
    expect(await lineOf()).toBe("fail  sql login: NT SERVICE\\ArasHouseBroker is neither sysadmin nor dbcreator, but executes 0 of the 5 arashouse_admin procedures; run `arashouse setup-sql` and the script it writes (docs/setup-sql.md)");

    p.host.setHostInfo({ sqlLogin: undefined });
    const old = await doctor(p.deps, {});
    expect(old.exitCode).toBe(0);
    expect(old.lines).toContain("warn  sql login: the broker does not report its SQL login's roles (it predates ticket 22); install this build with setup-host.ps1 -UpdateBroker (docs/setup.md)");

    p.host.setHostInfo({ sqlReachable: true, sqlLogin: null });
    expect((await doctor(p.deps, {})).lines).toContain("fail  sql: the broker cannot connect to SQL Server with its login; run `arashouse setup-sql` and the script it writes (docs/setup-sql.md)");
  });

  it("reports the host setup before the broker, from what the worker sees", async () => {
    const p = await pool({ "23": 1 });
    const none = await doctor({ ...p.deps, setup: async () => ({ record: null, rootExists: false, access: {} }) }, {});
    expect(none.exitCode).toBe(1);
    expect(none.lines[1]).toBe("fail  setup: the install root is missing; run `arashouse setup` and the script it writes, elevated (docs/setup.md)");
    expect(none.lines[2]).toBe("ok    broker: answers (pong)");
    expect(none.findings).toContainEqual({ level: "fail", check: "setup", message: expect.stringMatching(/^the install root is missing/) });
    expect((await doctor(p.deps, {})).lines.some((l) => l.includes("setup"))).toBe(false);
  });

  it("fails a flavor in the pool whose baseline does not verify", async () => {
    const p = await pool({ "23": 1 });
    const unbuilt = new FakeHost({ clock: p.clock });
    await unbuilt.provisionSlot({ flavor: "23", slot: 1 });
    const r = await doctor({ ...p.deps, host: unbuilt }, {});
    expect(r.lines).toContain("fail  baseline 23: the 23 baseline is not built: its slots cannot be reset");
    expect(r.lines).toContain("warn  baseline 35: the 35 baseline is not built");
  });

  it("verifies the baselines at the full level with --deep", async () => {
    const p = await pool({ "23": 1 });
    expect((await doctor(p.deps, {})).lines).toContain("ok    baseline 23: the 23 baseline verifies (fast)");
    expect((await doctor(p.deps, { deep: true })).lines).toContain("ok    baseline 23: the 23 baseline verifies (full)");
  });

  it("finds a reset with no live worker, a dirty slot nobody resets and an old lease", async () => {
    const p = await pool({ "23": 3 });
    const grant = await take(p, "23");
    await p.store.update((tx) => {
      tx.transition("23-02", { to: "dirty" });
      tx.transition("23-03", { to: "dirty" });
      tx.transition("23-03", { to: "resetting", pid: 77 });
    });
    p.clock.advance(25 * 3600 * 1000);
    const r = await doctor(p.deps, { fix: true });
    expect(r.lines).toContain(
      `warn  slot 23-01: leased to task-a for 25h00m (old): nothing reclaims it; if its holder is gone, \`arashouse force-return 23-01 --lease-id ${leaseRef(grant.lease_id)} --yes\``,
    );
    expect(r.lines).toContain("warn  slot 23-02: dirty, and no reset is running (the next `get` resets it lazily)");
    expect(r.lines).toContain("fail  slot 23-03: resetting, but its reset worker (pid 77) has ended");
    expect(r.lines).toContain("      fixed: sent back to dirty; a reset worker resets it");
    expect((await p.status("23-03"))?.status).toBe("dirty");
    expect(p.started.sort()).toEqual(["23-02", "23-03"]);
    expect((await p.status("23-01"))?.status).toBe("leased");
  });

  it("rebuilds the state from the stamps only with --yes", async () => {
    const p = await pool({ "23": 2 });
    const grant = await take(p, "23");
    await writeFile(p.store.paths.state, "{ not json");
    const found = await doctor(p.deps, {});
    expect(found.exitCode).toBe(1);
    expect(found.lines[0]).toMatch(/^fail  state: the state file .* is unusable/);
    expect(found.lines).toContain("fail  slots: skipped: the state file is unusable; `arashouse doctor --rebuild-state --yes` rebuilds it from the slot stamps");

    const dry = await doctor(p.deps, { rebuildState: true });
    expect(dry.lines).toContain("warn  state: --rebuild-state would replace the state with 2 slots from the stamps: 23-01 leased, 23-02 dirty");
    expect(await readFile(p.store.paths.state, "utf8")).toBe("{ not json");

    const rebuilt = await doctor(p.deps, { rebuildState: true, yes: true });
    expect(rebuilt.lines).toContain("ok    state: rebuilt from 2 slot stamps: 23-01 leased, 23-02 dirty");
    const state = await p.store.read();
    expect(state.slots["23-01"]?.lease).toMatchObject({ lease_id: grant.lease_id, holder: "unknown (recovered)" });
    expect(state.slots["23-02"]?.status).toBe("dirty");
  });
});

describe("the deny-list", () => {
  const DENIED = [
    ...DENIED_DATABASES,
    ...DENIED_ALIASES,
    ...DENIED_INSTALL_ROOTS,
    ...DENIED_SERVICE_PREFIXES.map((prefix) => `${prefix}12`),
    ...DENIED_SUBSTRINGS,
    "OLM_Local",
    "olm-01",
    "prod-01",
    "C:\\Aras",
    "C:\\Aras28\\Innovator",
    "C:\\Program Files (x86)\\Aras\\Innovator",
  ];

  it.each(DENIED)("refuses %s in every command that names a slot, touching nothing", async (name) => {
    const p = await pool({ "23": 1 });
    await take(p, "23");
    const before = await snapshot(p);
    const seq = p.host.calls.length;
    const commands = [
      () => repairSlot(p.deps, { slot: name }),
      () => repairSlot(p.deps, { slot: name, rebuild: true }),
      () => destroySlot(p.deps, { slot: name, yes: true, includeLeased: true }),
      () => destroySlot(p.deps, { slot: name, yes: false }),
      () => forceReturn(p.deps, { slot: name, leaseId: "0123abcd", yes: true }),
      () => disableSlot(p.deps, name),
      () => enableSlot(p.deps, name),
    ];
    for (const command of commands) expect(await exitOf(command)).toBe(EXIT_CODES.refused);
    expect(p.host.calls.length).toBe(seq);
    expect(await snapshot(p)).toBe(before);
  });

  it("ignores whatever the host lists that is not an arashouse slot, in doctor and prune", async () => {
    const p = await pool({ "23": 1 });
    const host = p.host;
    const listing: OperatorHost = Object.assign(Object.create(host) as FakeHost, {
      listSlots: async () => {
        const real = await host.listSlots();
        const odd = ["OLM_Local", "InnovatorServer", "prod"].map((flavor) => ({ slot: { flavor, slot: 1 } as never, stamp: null }));
        return { ...real, slots: [...real.slots, ...odd, { slot: { flavor: "23" as const, slot: 0 }, stamp: null }] };
      },
    });
    const seq = p.host.calls.length;
    const doc = await doctor({ ...p.deps, host: listing }, { fix: true, yes: true });
    expect(doc.lines).toContain("warn  host: ignored 4 entries the host listed that are not arashouse slots");
    const pr = await prune({ ...p.deps, host: listing }, { yes: true });
    expect(pr.lines).toEqual(["nothing to prune: no disabled or orphaned slot", "ignored 4 entries the host listed that are not arashouse slots"]);
    const targets = p.host.calls.filter((c) => c.seq > seq).map((c) => c.target);
    expect(targets.every((t) => t === null || t === "23-01" || ["12sp9", "23", "35"].includes(t))).toBe(true);
  });
});

describe("status", () => {
  it("marks a lease older than 24 h as old in the human output", async () => {
    const p = await pool({ "23": 2 });
    const grant = await take(p, "23", "task-old");
    p.clock.advance(23 * 3600 * 1000);
    await take(p, "23", "task-new");
    p.clock.advance(1 * 3600 * 1000 + 1000);
    const text = formatStatus(buildStatus(await p.store.read(), { now: new Date(p.clock.now()), isWaiterAlive: () => true }));
    expect(text).toContainEqual(expect.stringMatching(/^23-01 +23 +leased +task-old +[0-9a-f]{8} +24h00m old/));
    expect(text).toContainEqual(expect.stringMatching(/^23-02 +23 +leased +task-new +[0-9a-f]{8} +1h00m +/));
    expect(text).toContain(`old lease 23-01: held by task-old for 24h00m; nothing reclaims it. If its holder is gone: arashouse force-return 23-01 --lease-id ${leaseRef(grant.lease_id)} --yes`);
    expect(text.filter((l) => l.startsWith("old lease"))).toHaveLength(1);
  });
});
