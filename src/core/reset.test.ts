import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../host/clock.js";
import type { HealthResult, HostMethod } from "../host/driver.js";
import { HostError, slotBusyError, verbTimeoutError } from "../host/errors.js";
import type { SlotRef } from "./names.js";
import { FakeHost, fakeGoldenHash } from "../host/fake.js";
import { type ArashouseConfig, DEFAULT_CONFIG } from "./config.js";
import { EXIT_CODES } from "./exit-codes.js";
import type { FlavorKey } from "./flavors.js";
import { type LeaseDeps, type LeaseGrant, NoSlotAvailableError, checkClean, exitCodeFor, getLease, returnLease } from "./lease.js";
import { parseSlotId } from "./names.js";
import {
  HEALTH_TIMEOUT_BACKOFF_MS,
  MAX_RESET_ATTEMPTS,
  SLOT_BUSY_POLL_MS,
  SLOT_BUSY_WAIT_MS,
  type ResetDeps,
  type ResetHost,
  type ResetOutcome,
  describeOutcome,
  recoverDeadResets,
  resetHooks,
  resetSlot,
  runResetWorker,
} from "./reset.js";
import { MemorySecretStore } from "./secret-store.js";
import type { Slot } from "./state.js";
import { StateStore } from "./store.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "arashouse-reset-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** The host methods a reset calls, in order. */
const RESET_CALLS: readonly HostMethod[] = ["quiesce", "resetDatabase", "resetTree", "startSlot", "healthCheck", "readStamp"];
const RESET_ONLY = new Set<HostMethod>(["quiesce", "resetDatabase", "resetTree", "startSlot"]);

const MY_PID = 4242;

interface Pool {
  readonly store: StateStore;
  readonly host: FakeHost;
  readonly clock: FakeClock;
  /** Pids of reset workers that still run; any other recorded pid is dead. */
  readonly alive: Set<number>;
  /** Slots `startWorker` was asked for, with the slot's status at that moment. */
  readonly started: { slot: string; status: string | undefined }[];
  readonly reset: ResetDeps;
  readonly deps: LeaseDeps;
  status(id: string): Promise<Slot | undefined>;
}

/**
 * Free, provisioned slots on a fake host whose every call takes `latencyMs` of a fake clock that the
 * store and the lease operations read too; `sleep` moves it. Workers started by `return` are only
 * recorded: a test runs them itself.
 */
async function pool(spec: Partial<Record<FlavorKey, number>>, options: { config?: Partial<ArashouseConfig>; latencyMs?: number } = {}): Promise<Pool> {
  const clock = new FakeClock(Date.UTC(2026, 9, 27, 9, 0, 0));
  const now = () => new Date(clock.now());
  const store = new StateStore({ home, now });
  const host = new FakeHost({ clock, latencyMs: options.latencyMs ?? 0 });
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
  const reset: ResetDeps = {
    store,
    host,
    golden: async (flavor) => ({ tree: host.golden(flavor), backup: host.backup(flavor) }),
    config,
    pid: MY_PID,
    startTime: null,
    isWorkerAlive: (pid) => alive.has(pid),
    now,
    sleep: async (ms) => clock.advance(ms),
  };
  const started: { slot: string; status: string | undefined }[] = [];
  const deps: LeaseDeps = {
    store,
    host,
    secrets: new MemorySecretStore(),
    resolveUrl: async (alias) => `http://172.19.0.1/${alias}`,
    config,
    isWaiterAlive: () => true,
    now,
    pollMs: 1000,
    sleep: async (ms) => clock.advance(ms),
    reset: resetHooks(reset, (slot) => {
      // Synchronous on purpose: what the state says at the moment return asks for a worker.
      started.push({ slot, status: undefined });
      const entry = started[started.length - 1]!;
      void store.read().then((s) => (entry.status = s.slots[slot]?.status));
    }),
  };
  return { store, host, clock, alive, started, reset, deps, status: async (id) => (await store.read()).slots[id] };
}

/** What a holder does to a lease: changes the tree and the database, so an unreset slot is visibly dirty. */
function use(p: Pool, grant: LeaseGrant): void {
  const ref = parseSlotId(grant.slot);
  p.host.dirty(ref, "tree");
  p.host.dirty(ref, "database");
}

/** The fake host's view of a slot: is it at golden, tree and database? */
function atGolden(p: Pool, id: string): boolean {
  const ref = parseSlotId(id);
  const s = p.host.inspect(ref);
  const hash = fakeGoldenHash(ref.flavor);
  return s !== undefined && !s.treeDirty && s.treeHash === hash && s.dbMarker === hash;
}

function hostCallsSince(p: Pool, seq: number): HostMethod[] {
  return p.host.calls.filter((c) => c.seq > seq).map((c) => c.method);
}

/** A host that answers the first `after` calls and then never again: the worker process died there. */
function dyingHost(host: FakeHost, after: number): { host: ResetHost; died: Promise<void> } {
  let calls = 0;
  let die: () => void = () => undefined;
  const died = new Promise<void>((resolve) => (die = resolve));
  const wrap =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      if (calls++ < after) return fn(...args);
      die();
      return new Promise<R>(() => undefined);
    };
  return {
    died,
    host: {
      quiesce: wrap(host.quiesce.bind(host)),
      resetDatabase: wrap(host.resetDatabase.bind(host)),
      resetTree: wrap(host.resetTree.bind(host)),
      startSlot: wrap(host.startSlot.bind(host)),
      healthCheck: wrap(host.healthCheck.bind(host)),
      readStamp: wrap(host.readStamp.bind(host)),
    },
  };
}

describe("return", () => {
  it("leaves the slot dirty and exits before any reset call, having asked for a worker", async () => {
    const p = await pool({ "23": 1 });
    const grant = await getLease(p.deps, { flavor: "23", holder: "task-a" });
    const before = p.host.calls.length;
    const result = await returnLease(p.deps, { target: grant.lease_id });
    expect(result.outcome).toBe("returned");
    expect((await p.status("23-01"))?.status).toBe("dirty");
    expect(hostCallsSince(p, before)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The worker was asked for once the slot was already dirty in the state file.
    expect(p.started).toEqual([{ slot: "23-01", status: "dirty" }]);
    // A second return asks for no second worker.
    await returnLease(p.deps, { target: grant.lease_id });
    expect(p.started).toHaveLength(1);
  });
});

describe("the reset worker", () => {
  it("takes a dirty slot to free through the whole sequence, timing it on the host's clock", async () => {
    const p = await pool({ "23": 1 }, { latencyMs: 2000 });
    const grant = await getLease(p.deps, { flavor: "23", holder: "task-a" });
    use(p, grant);
    await returnLease(p.deps, { target: grant.lease_id });
    const before = p.host.calls.length;
    const outcomes = await runResetWorker(p.reset, "23-01");
    expect(outcomes).toEqual([{ kind: "free", slot: "23-01", ms: 12_000 }]);
    expect(describeOutcome(outcomes[0]!)).toBe("23-01 reset in 12.0 s; free");
    expect(hostCallsSince(p, before)).toEqual(RESET_CALLS);
    const slot = await p.status("23-01");
    expect(slot).toMatchObject({ status: "free", golden_hash: fakeGoldenHash("23"), last_reset_ms: 12_000 });
    expect(slot?.reset).toBeUndefined();
    // The event log carries each step's seconds, for the record of a reset on the host (ticket 35).
    const freed = (await p.store.events()).filter((e) => e.slot === "23-01" && e.to === "free").at(-1);
    expect(freed?.reason).toMatch(/^reset: golden [\d.]+ s, quiesce [\d.]+ s, database [\d.]+ s, tree [\d.]+ s, start [\d.]+ s, health [\d.]+ s$/);
    expect(atGolden(p, "23-01")).toBe(true);
    expect(p.host.inspect(parseSlotId("23-01"))?.stamp?.leaseId).toBeNull();
  });

  it("goes on to every other dirty slot, and leaves alone a slot that is not dirty", async () => {
    const p = await pool({ "23": 3 });
    const a = await getLease(p.deps, { flavor: "23", holder: "a" });
    const b = await getLease(p.deps, { flavor: "23", holder: "b" });
    await returnLease(p.deps, { target: a.lease_id });
    await returnLease(p.deps, { target: b.lease_id });
    const outcomes = await runResetWorker(p.reset, "23-02");
    expect(outcomes.map((o) => [o.slot, o.kind])).toEqual([
      ["23-02", "free"],
      ["23-01", "free"],
    ]);
    expect(await runResetWorker(p.reset, "23-03")).toEqual([
      { kind: "not-started", slot: "23-03", reason: "slot 23-03 is free, not dirty" },
    ]);
  });

  it("retries a failed step once and carries on", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    p.host.injectFault({ method: "resetDatabase", kind: "fail" });
    expect(await resetSlot(p.reset, "23-01")).toMatchObject({ kind: "free" });
    expect(p.host.callLog.filter((m) => m === "resetDatabase")).toHaveLength(2);
  });

  it("waits for a verb the broker still runs on the slot (a dead worker's), without using up the retry", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    // The broker answers busy while the dead worker's quiesce runs on; then the step fails once and is retried.
    p.host.injectFault({ method: "quiesce", kind: "fail", times: 5, message: slotBusyError("23-01").message });
    p.host.injectFault({ method: "quiesce", kind: "fail", nth: 6, message: "a pool did not stop" });
    expect(await resetSlot(p.reset, "23-01")).toMatchObject({ kind: "free" });
    expect(p.host.callLog.filter((m) => m === "quiesce")).toHaveLength(7);
  });

  it("counts a slot that stays busy past the bound as a failure", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    p.host.injectFault({ method: "quiesce", kind: "fail", times: Infinity, message: slotBusyError("23-01").message });
    const outcome = await resetSlot(p.reset, "23-01");
    expect(outcome).toMatchObject({ kind: "quarantined", step: "quiesce", reason: expect.stringContaining("failed twice: slot 23-01 is being provisioned") });
    const calls = p.host.callLog.filter((m) => m === "quiesce").length;
    expect(calls).toBeGreaterThanOrEqual(SLOT_BUSY_WAIT_MS / SLOT_BUSY_POLL_MS);
  });

  it("quarantines the slot with the step named after two consecutive failures, and never hands it out", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    p.host.injectFault({ method: "resetTree", kind: "fail", times: 2, message: "robocopy exited 16" });
    const outcome = await resetSlot(p.reset, "23-01");
    expect(outcome).toEqual({
      kind: "quarantined",
      slot: "23-01",
      step: "tree",
      reason: "reset step tree failed twice: robocopy exited 16",
    });
    const slot = await p.status("23-01");
    expect(slot).toMatchObject({ status: "quarantined", quarantine_reason: "reset step tree failed twice: robocopy exited 16" });
    // The steps after the failed one never ran.
    expect(p.host.callLog).not.toContain("startSlot");
    const err = await getLease(p.deps, { flavor: "23", holder: "x", waitSeconds: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoSlotAvailableError);
    expect((err as Error).message).toContain("1 quarantined");
  });

  it("quarantines at once on a guard refusal or a Quarantine error, without a retry", async () => {
    for (const error of ["Refused", "Quarantine"] as const) {
      await rm(home, { recursive: true, force: true });
      const p = await pool({ "23": 1 });
      await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
      p.host.injectFault({ method: "quiesce", kind: "fail", error, message: "not ours" });
      expect(await resetSlot(p.reset, "23-01")).toMatchObject({ kind: "quarantined", step: "quiesce", reason: "reset step quiesce was refused: not ours" });
      expect(p.host.callLog.filter((m) => m === "quiesce")).toHaveLength(1);
    }
  });

  it("counts a health check that fails twice as a failed step", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    p.host.injectFault({ method: "startSlot", kind: "fail", times: 2, error: "Retryable" });
    expect(await resetSlot(p.reset, "23-01")).toMatchObject({ kind: "quarantined", step: "start" });
  });

  it("gives the slot back as dirty when the host does not answer, and a lazy get then exits 6", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    p.host.setReachable(false);
    const outcome = await resetSlot(p.reset, "23-01");
    expect(outcome).toMatchObject({ kind: "dirty", slot: "23-01" });
    expect((outcome as { reason: string }).reason).toContain("reset step quiesce: the host did not answer");
    expect((await p.status("23-01"))?.status).toBe("dirty");
    const err = await getLease(p.deps, { flavor: "23", holder: "x", waitSeconds: 5 }).catch((e: unknown) => e);
    expect(exitCodeFor(err)).toBe(EXIT_CODES.hostUnreachable);
    p.host.setReachable(true);
    expect(await resetSlot(p.reset, "23-01")).toMatchObject({ kind: "free" });
  });

  it("never quarantines a slot for resets the host did not answer, however many", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    p.host.setReachable(false);
    for (let i = 0; i < MAX_RESET_ATTEMPTS + 3; i++) {
      expect(await resetSlot(p.reset, "23-01")).toMatchObject({ kind: "dirty", slot: "23-01" });
      expect((await p.status("23-01"))?.reset).toBeUndefined();
    }
    p.host.setReachable(true);
    expect(await resetSlot(p.reset, "23-01")).toMatchObject({ kind: "free" });
  });

  it("refuses a golden of another flavor or with mismatched hashes", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    const outcome = await resetSlot({ ...p.reset, golden: async () => ({ tree: p.host.golden("12sp9"), backup: p.host.backup("12sp9") }) }, "23-01");
    expect(outcome).toMatchObject({ kind: "quarantined", step: "golden", reason: "reset step golden failed twice: the golden is not the 23 golden" });
    expect(p.host.callLog).not.toContain("quiesce");
  });
});

/** How a scripted health check answers: as a server that timed out, as a slot that is wrong, as a verb past its bound, or as the fake host does. */
type HealthAnswer = "slow" | "wrong" | "overrun" | "real";

/**
 * The pool's reset with its health check scripted per slot: `script(ref, n)` for the slot's n-th check (from 1). The
 * waits between tries are recorded and move the fake clock.
 */
function scriptedHealth(p: Pool, script: (ref: SlotRef, n: number) => HealthAnswer): { reset: ResetDeps; sleeps: number[]; checks: string[] } {
  const sleeps: number[] = [];
  const checks: string[] = [];
  const counts = new Map<string, number>();
  const host = p.host;
  const healthCheck = async (ref: SlotRef): Promise<HealthResult> => {
    const id = `${ref.flavor}-${String(ref.slot).padStart(2, "0")}`;
    const n = (counts.get(id) ?? 0) + 1;
    counts.set(id, n);
    const answer = script(ref, n);
    checks.push(`${id} ${answer}`);
    if (answer === "real") return host.healthCheck(ref);
    if (answer === "overrun") throw verbTimeoutError("healthCheck", 600_000);
    if (answer === "slow") {
      const detail = "root's login did not answer in time (no answer in 120 s, with the golden backup's password)";
      return { ok: false, ms: 120_000, detail: `${id} failed login (${detail})`, checks: [{ name: "login", ok: false, detail, timedOut: true }], timedOut: true };
    }
    return { ok: false, ms: 10, detail: `${id} failed tree (1 extra)`, checks: [{ name: "tree", ok: false, detail: "1 extra" }] };
  };
  const reset: ResetDeps = {
    ...p.reset,
    host: {
      quiesce: (r) => host.quiesce(r),
      resetDatabase: (r, b) => host.resetDatabase(r, b),
      resetTree: (r, g) => host.resetTree(r, g),
      startSlot: (r, o) => host.startSlot(r, o),
      healthCheck,
      readStamp: (r) => host.readStamp(r),
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      p.clock.advance(ms);
    },
  };
  return { reset, sleeps, checks };
}

describe("a loaded host: a health check that times out (ticket 56)", () => {
  it("tries a timed-out health check again after backing off, without using up an attempt, and the slot ends free", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    const h = scriptedHealth(p, (_ref, n) => (n <= 2 ? "slow" : "real"));
    expect(await resetSlot(h.reset, "23-01")).toMatchObject({ kind: "free" });
    expect(h.checks).toEqual(["23-01 slow", "23-01 slow", "23-01 real"]);
    expect(h.sleeps).toEqual([...HEALTH_TIMEOUT_BACKOFF_MS]);
  });

  it("leaves the slot dirty, never quarantined, when its health check keeps timing out; a later reset makes it free", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    const h = scriptedHealth(p, () => "slow");
    for (let i = 0; i < MAX_RESET_ATTEMPTS + 2; i++) {
      const outcome = await resetSlot(h.reset, "23-01");
      expect(outcome).toMatchObject({ kind: "dirty", slot: "23-01", timedOut: true });
      expect((outcome as { reason: string }).reason).toMatch(/^reset step health: the slot's server did not answer in time, 3 tries: 23-01 failed login/);
      const slot = await p.status("23-01");
      expect(slot?.status).toBe("dirty");
      expect(slot?.reset).toBeUndefined();
    }
    expect(h.checks).toHaveLength((MAX_RESET_ATTEMPTS + 2) * (HEALTH_TIMEOUT_BACKOFF_MS.length + 1));
    expect(await resetSlot(p.reset, "23-01")).toMatchObject({ kind: "free" });
  });

  it("treats a health check the broker cut off at its verb bound as timed out too", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    const h = scriptedHealth(p, () => "overrun");
    expect(await resetSlot(h.reset, "23-01")).toMatchObject({ kind: "dirty", timedOut: true, reason: expect.stringContaining("healthCheck did not finish within 600000 ms") });
    expect((await p.status("23-01"))?.status).toBe("dirty");
  });

  it("still quarantines a health check that answers wrongly twice, timeouts or not", async () => {
    const p = await pool({ "23": 2 });
    await p.store.update((tx) => {
      tx.transition("23-01", { to: "dirty" });
      tx.transition("23-02", { to: "dirty" });
    });
    const h = scriptedHealth(p, (ref, n) => (ref.slot === 1 ? "wrong" : (["slow", "wrong", "slow", "wrong"] as const)[n - 1]!));
    expect(await resetSlot(h.reset, "23-01")).toMatchObject({ kind: "quarantined", step: "health", reason: "reset step health failed twice: 23-01 failed tree (1 extra)" });
    expect(await resetSlot(h.reset, "23-02")).toMatchObject({ kind: "quarantined", step: "health", reason: "reset step health failed twice: 23-02 failed tree (1 extra)" });
    expect(h.checks.filter((c) => c.startsWith("23-01"))).toEqual(["23-01 wrong", "23-01 wrong"]);
    expect(h.checks.filter((c) => c.startsWith("23-02"))).toEqual(["23-02 slow", "23-02 wrong", "23-02 slow", "23-02 wrong"]);
  });

  it("the worker leaves a timed-out slot dirty and goes on to the next", async () => {
    const p = await pool({ "23": 2 });
    await p.store.update((tx) => {
      tx.transition("23-01", { to: "dirty" });
      tx.transition("23-02", { to: "dirty" });
    });
    const h = scriptedHealth(p, (ref) => (ref.slot === 1 ? "slow" : "real"));
    const outcomes = await runResetWorker(h.reset, "23-01");
    expect(outcomes.map((o) => [o.slot, o.kind])).toEqual([
      ["23-01", "dirty"],
      ["23-02", "free"],
    ]);
  });

  it("a lazy reset that times out does not fail the get with exit 6: it waits for a slot, and exits 3 when none comes", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    const h = scriptedHealth(p, () => "slow");
    const deps: LeaseDeps = { ...p.deps, reset: resetHooks(h.reset, () => undefined) };
    const err = await getLease(deps, { flavor: "23", holder: "b", waitSeconds: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoSlotAvailableError);
    expect(exitCodeFor(err)).toBe(EXIT_CODES.noSlot);
    expect((await p.status("23-01"))?.status).toBe("dirty");
  });
});

describe("crash safety", () => {
  it("recovers a worker killed mid-reset as dirty, and the next reset starts over", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    const dying = dyingHost(p.host, 2);
    p.alive.add(777);
    void resetSlot({ ...p.reset, host: dying.host, pid: 777 }, "23-01");
    await dying.died;
    expect(await p.status("23-01")).toMatchObject({ status: "resetting", reset: { pid: 777, attempt: 1 } });
    // While the worker lives, its slot is left alone.
    expect(await recoverDeadResets(p.store, (pid) => p.alive.has(pid))).toEqual([]);
    p.alive.delete(777);
    expect(await recoverDeadResets(p.store, (pid) => p.alive.has(pid))).toEqual(["23-01"]);
    expect(await p.status("23-01")).toMatchObject({ status: "dirty", reset: { pid: 777, attempt: 1 } });
    expect(await resetSlot(p.reset, "23-01")).toMatchObject({ kind: "free" });
    expect(atGolden(p, "23-01")).toBe(true);
  });

  it("lets a get find the dead worker's slot, reset it and hand it out", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    const dying = dyingHost(p.host, 3);
    p.alive.add(778);
    void resetSlot({ ...p.reset, host: dying.host, pid: 778 }, "23-01");
    await dying.died;
    p.alive.delete(778);
    const grant = await getLease(p.deps, { flavor: "23", holder: "next-day", waitSeconds: 60 });
    expect(grant.slot).toBe("23-01");
    expect(atGolden(p, "23-01")).toBe(true);
  });

  it("quarantines a slot whose reset was started too often without finishing", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    for (let i = 0; i < MAX_RESET_ATTEMPTS; i++) {
      const pid = 900 + i;
      const dying = dyingHost(p.host, 0);
      p.alive.add(pid);
      void resetSlot({ ...p.reset, host: dying.host, pid }, "23-01");
      await dying.died;
      p.alive.delete(pid);
    }
    expect(await resetSlot(p.reset, "23-01")).toMatchObject({
      kind: "quarantined",
      step: null,
      reason: `reset started ${MAX_RESET_ATTEMPTS + 1} times without finishing`,
    });
  });

  it("a worker judged dead that wakes up again finds the slot is no longer its own and touches nothing", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    let resume: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    let pausedAt: () => void = () => undefined;
    const atPause = new Promise<void>((resolve) => (pausedAt = resolve));
    // The worker stalls (suspended, say) just before its database step.
    const stalling: ResetHost = {
      quiesce: p.host.quiesce.bind(p.host),
      resetDatabase: async (ref, backup) => {
        pausedAt();
        await paused;
        return p.host.resetDatabase(ref, backup);
      },
      resetTree: p.host.resetTree.bind(p.host),
      startSlot: p.host.startSlot.bind(p.host),
      healthCheck: p.host.healthCheck.bind(p.host),
      readStamp: p.host.readStamp.bind(p.host),
    };
    p.alive.add(779);
    const zombie = resetSlot({ ...p.reset, host: stalling, pid: 779 }, "23-01");
    await atPause;
    p.alive.delete(779);
    expect(await resetSlot(p.reset, "23-01")).toMatchObject({ kind: "free" });
    const before = p.host.calls.length;
    resume();
    const outcome: ResetOutcome = await zombie;
    expect(outcome.kind).toBe("lost");
    // Its in-flight call finished; it made no further one and did not move the slot.
    expect(hostCallsSince(p, before)).toEqual(["resetDatabase"]);
    expect((await p.status("23-01"))?.status).toBe("free");
  });
});

describe("lazy reset in get", () => {
  it("resets a dirty slot itself when no slot is free, waits on it and hands it out", async () => {
    const p = await pool({ "23": 1 }, { latencyMs: 1000 });
    const first = await getLease(p.deps, { flavor: "23", holder: "a" });
    use(p, first);
    await returnLease(p.deps, { target: first.lease_id });
    const before = p.host.calls.length;
    const grant = await getLease(p.deps, { flavor: "23", holder: "b", waitSeconds: 60 });
    expect(grant.slot).toBe("23-01");
    expect(hostCallsSince(p, before).filter((m) => RESET_ONLY.has(m))).toEqual(["quiesce", "resetDatabase", "resetTree", "startSlot"]);
    expect(p.host.inspect(parseSlotId("23-01"))).toMatchObject({ treeDirty: false, dbMarker: fakeGoldenHash("23") });
  });

  it("without --wait starts a worker for the dirty slot and fails at once with exit 3", async () => {
    const p = await pool({ "23": 1 });
    const first = await getLease(p.deps, { flavor: "23", holder: "a" });
    await returnLease(p.deps, { target: first.lease_id });
    const before = p.host.calls.length;
    const err = await getLease(p.deps, { flavor: "23", holder: "b" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoSlotAvailableError);
    expect((err as Error).message).toBe("no 23 slot is free: 1 slot, 0 leased, 0 resetting, 0 quarantined, 1 dirty; 23-01 is being reset");
    expect(hostCallsSince(p, before).filter((m) => RESET_ONLY.has(m))).toEqual([]);
    expect(p.started.map((s) => s.slot)).toEqual(["23-01", "23-01"]);
  });

  it("waits for a slot another worker is resetting rather than starting a second reset", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    p.host.injectFault({ method: "resetTree", kind: "hang" });
    p.alive.add(780);
    const worker = resetSlot({ ...p.reset, pid: 780 }, "23-01");
    while (p.host.hangingCalls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const sleeps: number[] = [];
    const getting = getLease(
      {
        ...p.deps,
        sleep: async (ms) => {
          sleeps.push(ms);
          p.clock.advance(ms);
          if (sleeps.length === 3) p.host.releaseHangs();
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      },
      { flavor: "23", holder: "b", waitSeconds: 60 },
    );
    expect(await worker).toMatchObject({ kind: "free" });
    expect((await getting).slot).toBe("23-01");
    expect(p.host.callLog.filter((m) => m === "quiesce")).toHaveLength(1);
  });

  it("does not retry a slot whose lazy reset failed in the same call", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => void tx.transition("23-01", { to: "dirty" }));
    p.host.injectFault({ method: "quiesce", kind: "fail", times: 2 });
    const err = await getLease(p.deps, { flavor: "23", holder: "b", waitSeconds: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoSlotAvailableError);
    expect((await p.status("23-01"))?.status).toBe("quarantined");
    expect(p.host.callLog.filter((m) => m === "quiesce")).toHaveLength(2);
  });
});

describe("dirty detection before handing out", () => {
  it("resets a free slot whose stamp no longer carries the golden hash, then hands it out", async () => {
    const p = await pool({ "23": 1 });
    p.host.dirty(parseSlotId("23-01"), "stamp");
    const grant = await getLease(p.deps, { flavor: "23", holder: "b", waitSeconds: 60 });
    expect(grant.slot).toBe("23-01");
    expect(p.host.callLog).toContain("resetTree");
    expect(p.host.inspect(parseSlotId("23-01"))?.stamp?.goldenHash).toBe(fakeGoldenHash("23"));
  });

  it("resets a free slot whose database marker is gone", async () => {
    const p = await pool({ "23": 1 });
    p.host.dirty(parseSlotId("23-01"), "database");
    await getLease(p.deps, { flavor: "23", holder: "b", waitSeconds: 60 });
    expect(p.host.callLog).toContain("resetDatabase");
    expect(atGolden(p, "23-01")).toBe(true);
  });
});

describe("dirty detection before handing out (ticket 32)", () => {
  it("resets a free slot whose state record alone names another golden, then hands it out", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => {
      tx.transition("23-01", { to: "dirty" });
      tx.transition("23-01", { to: "resetting", pid: 7 });
      tx.transition("23-01", { to: "free", golden_hash: "f".repeat(64), reset_ms: 1 });
    });
    const grant = await getLease(p.deps, { flavor: "23", holder: "b", waitSeconds: 60 });
    expect(grant.slot).toBe("23-01");
    expect(p.host.callLog).toContain("resetTree");
    expect((await p.status("23-01"))?.golden_hash).toBe(fakeGoldenHash("23"));
  });

  it("resets a free slot that was not reset after its last lease, then hands it out", async () => {
    const p = await pool({ "23": 1 });
    const first = await getLease(p.deps, { flavor: "23", holder: "a" });
    use(p, first);
    p.clock.advance(60_000);
    await returnLease(p.deps, { target: first.lease_id });
    // Made free by hand, its stamp's lease taken off and its database marked again, but nothing reset after the lease.
    const ref = parseSlotId("23-01");
    await p.host.writeStamp(ref, { ...p.host.inspect(ref)!.stamp!, leaseId: null });
    await p.host.resetDatabase(ref, p.host.backup("23"));
    await p.store.update((tx) => {
      tx.transition("23-01", { to: "resetting", pid: 7 });
      tx.transition("23-01", { to: "free", golden_hash: fakeGoldenHash("23"), reset_ms: 1 });
    });
    const before = p.host.calls.length;
    const second = await getLease(p.deps, { flavor: "23", holder: "b", waitSeconds: 60 });
    expect(second.slot).toBe("23-01");
    expect(hostCallsSince(p, before)).toContain("resetTree");
    expect(atGolden(p, "23-01")).toBe(true);
    const events = (await p.store.events()).filter((e) => e.slot === "23-01" && e.to === "dirty").map((e) => e.reason);
    expect(events).toContain("the stamp's reset is older than the end of the last lease");
  });
});

describe("a replaced golden", () => {
  it("does not hand out a free slot reset from an older golden", async () => {
    const p = await pool({ "23": 1 });
    const slot = (await p.status("23-01"))!;
    expect((await checkClean(p.host, slot, fakeGoldenHash("23"))).clean).toBe(true);
    expect(await checkClean(p.host, slot, "new-golden")).toEqual({ clean: false, reason: "the slot was reset from an older golden" });
    const newer = async (flavor: FlavorKey) => ({ tree: { flavor, hash: "new-golden" }, backup: { ...p.host.backup(flavor), hash: "new-golden" } });
    await expect(getLease({ ...p.deps, reset: undefined, golden: newer }, { flavor: "23", holder: "b" })).rejects.toBeInstanceOf(NoSlotAvailableError);
    expect((await p.status("23-01"))?.status).toBe("dirty");
  });

  it("hands out a free slot, checked as before, when the current golden cannot be named", async () => {
    const p = await pool({ "23": 1 });
    const unnamed = async (): Promise<never> => Promise.reject(new HostError("Unreachable", "the broker cannot name a flavor's golden"));
    const grant = await getLease({ ...p.deps, golden: unnamed }, { flavor: "23", holder: "b" });
    expect(grant.slot).toBe("23-01");
  });

  it("does not read a golden that is being promoted, and leaves a slot dirty when a promote overlaps its reset", async () => {
    const p = await pool({ "23": 2 });
    for (const holder of ["a", "b"]) {
      const grant = await getLease(p.deps, { flavor: "23", holder });
      use(p, grant);
      await returnLease(p.deps, { target: grant.lease_id });
    }
    p.host.setPromoting("23", true);
    const before = p.host.calls.length;
    const refused = await resetSlot(p.reset, "23-01");
    expect(refused).toMatchObject({ kind: "dirty", slot: "23-01" });
    expect(hostCallsSince(p, before)).toEqual([]);
    p.host.setPromoting("23", false);

    const host = p.host;
    const overlapping: ResetHost = {
      quiesce: (r) => host.quiesce(r),
      resetDatabase: (r, b) => host.resetDatabase(r, b),
      resetTree: async (r, g) => {
        host.setPromoting("23", true);
        return host.resetTree(r, g);
      },
      startSlot: (r, o) => host.startSlot(r, o),
      healthCheck: (r) => host.healthCheck(r),
      readStamp: (r) => host.readStamp(r),
    };
    const outcome = await resetSlot({ ...p.reset, host: overlapping }, "23-02");
    expect(outcome).toEqual({ kind: "dirty", slot: "23-02", reason: "the golden changed during the reset" });
    expect((await p.status("23-02"))?.status).toBe("dirty");
  });

  it("leaves a slot dirty when the golden changes while it is reset", async () => {
    const p = await pool({ "23": 1 });
    const grant = await getLease(p.deps, { flavor: "23", holder: "a" });
    use(p, grant);
    await returnLease(p.deps, { target: grant.lease_id });
    let reads = 0;
    const golden = async (flavor: FlavorKey) => {
      reads++;
      const hash = reads === 1 ? fakeGoldenHash(flavor) : "new-golden";
      return { tree: { flavor, hash }, backup: { ...p.host.backup(flavor), hash } };
    };
    const outcome = await resetSlot({ ...p.reset, golden }, "23-01");
    expect(outcome).toEqual({ kind: "dirty", slot: "23-01", reason: "the golden changed during the reset" });
    expect((await p.status("23-01"))?.status).toBe("dirty");
  });
});

describe("max_resets", () => {
  it("runs at most max_resets resets at once; the rest stay dirty and the running workers drain them", async () => {
    const p = await pool({ "23": 2, "12sp9": 3 }, { config: { max_resets: 2 } });
    await p.store.update((tx) => {
      for (const id of ["12sp9-01", "12sp9-02", "12sp9-03", "23-01", "23-02"]) tx.transition(id, { to: "dirty" });
    });
    p.host.injectFault({ method: "quiesce", kind: "hang", times: 2 });
    p.alive.add(801).add(802).add(803);
    const hanging = async (n: number) => {
      while (p.host.hangingCalls < n) await new Promise((resolve) => setTimeout(resolve, 1));
    };
    const workers = [runResetWorker({ ...p.reset, pid: 801 }, "23-01")];
    await hanging(1);
    workers.push(runResetWorker({ ...p.reset, pid: 802 }, "23-02"));
    await hanging(2);
    const third = await runResetWorker({ ...p.reset, pid: 803 }, "12sp9-01");
    expect(third).toEqual([{ kind: "not-started", slot: "12sp9-01", reason: "max_resets 2 reached (2 resetting)" }]);
    const resetting = Object.values((await p.store.read()).slots).filter((s) => s.status === "resetting");
    expect(resetting.map((s) => s.id).sort()).toEqual(["23-01", "23-02"]);
    p.host.releaseHangs();
    const done = (await Promise.all(workers)).flat();
    expect(done.filter((o) => o.kind === "free").map((o) => o.slot).sort()).toEqual(["12sp9-01", "12sp9-02", "12sp9-03", "23-01", "23-02"]);
    const slots = Object.values((await p.store.read()).slots);
    expect(slots.every((s) => s.status === "free")).toBe(true);
  });
});

// ---- the property: a returned slot is never handed out before its reset ends ---------------------

/** A small seeded generator, so a failing sequence can be replayed from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the invariant, over random interleavings of get, return, crash and reset", () => {
  it("never hands out a slot that is not at golden, and every returned slot can be leased again", async () => {
    const SEQUENCES = 15;
    const STEPS = 30;
    for (let seed = 1; seed <= SEQUENCES; seed++) {
      await rm(home, { recursive: true, force: true });
      const p = await pool({ "23": 3 }, { config: { max_resets: 2 } });
      const rand = rng(seed);
      const pick = <T>(items: readonly T[]): T | undefined => (items.length === 0 ? undefined : items[Math.floor(rand() * items.length)]);
      const held: LeaseGrant[] = [];
      let nextPid = 10_000;
      const trace: string[] = [];
      const fail = (what: string) => {
        throw new Error(`seed ${seed}: ${what}\n${trace.join("\n")}`);
      };
      for (let step = 0; step < STEPS; step++) {
        const r = rand();
        if (r < 0.3) {
          trace.push("get");
          const grant = await getLease(p.deps, { flavor: "23", holder: `h${step}`, waitSeconds: rand() < 0.5 ? 0 : 3 }).catch((err: unknown) => {
            if (err instanceof NoSlotAvailableError) return null;
            throw err;
          });
          if (grant) {
            if (!atGolden(p, grant.slot)) fail(`${grant.slot} was handed out without being at golden`);
            if (held.some((h) => h.slot === grant.slot)) fail(`${grant.slot} was handed out twice`);
            held.push(grant);
            use(p, grant);
          }
        } else if (r < 0.55) {
          const grant = pick(held);
          if (!grant) continue;
          trace.push(`return ${grant.slot}`);
          held.splice(held.indexOf(grant), 1);
          await returnLease(p.deps, { target: grant.lease_id });
        } else if (r < 0.7) {
          // A worker dies part-way through, after 0 to 5 host calls.
          const dirty = Object.values((await p.store.read()).slots).filter((s) => s.status === "dirty");
          const victim = pick(dirty);
          if (!victim) continue;
          const pid = nextPid++;
          const after = Math.floor(rand() * 6);
          trace.push(`crash ${victim.id} after ${after}`);
          const dying = dyingHost(p.host, after);
          p.alive.add(pid);
          const run = resetSlot({ ...p.reset, host: dying.host, pid }, victim.id);
          await Promise.race([run, dying.died]);
          p.alive.delete(pid);
        } else if (r < 0.85) {
          trace.push("worker");
          await runResetWorker(p.reset);
        } else if (r < 0.92) {
          // Drift on a free slot: its stamp no longer matches.
          const free = pick(Object.values((await p.store.read()).slots).filter((s) => s.status === "free"));
          if (!free) continue;
          trace.push(`drift ${free.id}`);
          p.host.dirty(parseSlotId(free.id), "stamp");
        } else {
          // A step fails once; the retry recovers.
          const method = pick(["quiesce", "resetDatabase", "resetTree", "startSlot"] as const)!;
          trace.push(`fault ${method}`);
          p.host.injectFault({ method, kind: "fail" });
        }
      }
      // Return everything; with waiting, every slot not quarantined (crashed too often) comes back.
      p.host.clearFaults();
      for (const grant of held) await returnLease(p.deps, { target: grant.lease_id });
      const usable = Object.values((await p.store.read()).slots).filter((s) => s.status !== "quarantined").length;
      const again: LeaseGrant[] = [];
      for (let i = 0; i < usable; i++) again.push(await getLease(p.deps, { flavor: "23", holder: `final${i}`, waitSeconds: 60 }));
      for (const grant of again) if (!atGolden(p, grant.slot)) fail(`${grant.slot} was handed out at the end without being at golden`);
      expect(new Set(again.map((g) => g.slot)).size).toBe(usable);
    }
  }, 120_000);
});
