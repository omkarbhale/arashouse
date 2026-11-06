import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHost, fakeGoldenHash } from "../host/fake.js";
import { LiveClock } from "../host/clock.js";
import { type ArashouseConfig, DEFAULT_CONFIG } from "./config.js";
import type { FlavorKey } from "./flavors.js";
import { beginReset, checkDiskForBuild, liveWaiters, poolGovernor, runningResets } from "./governor.js";
import { type LeaseDeps, type LeaseGrant, exitCodeFor, getLease, leaseStatus, returnLease } from "./lease.js";
import { MemorySecretStore } from "./secret-store.js";
import type { Slot, Waiter } from "./state.js";
import { StateStore } from "./store.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "arashouse-governor-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

interface Pool {
  readonly store: StateStore;
  readonly host: FakeHost;
  readonly deps: LeaseDeps;
  /** Takes a dirty slot through the reset cap and back to free, as ticket 14's worker will. */
  reset(id: string): Promise<void>;
  status(id: string): Promise<string | undefined>;
}

/** Free, provisioned slots, real timers polling every 5 ms, and the config given. */
async function pool(spec: Partial<Record<FlavorKey, number>>, config: Partial<ArashouseConfig> = {}, overrides: Partial<LeaseDeps> = {}): Promise<Pool> {
  const store = new StateStore({ home });
  const host = new FakeHost({ clock: new LiveClock() });
  for (const [flavor, count] of Object.entries(spec) as [FlavorKey, number][]) {
    for (let n = 1; n <= count; n++) {
      await store.update((tx) => {
        const slot = tx.addSlot({ flavor, slot: n });
        tx.transition(slot.id, { to: "free", golden_hash: fakeGoldenHash(flavor), reset_ms: 1 });
      });
      await host.provisionSlot({ flavor, slot: n });
    }
  }
  const deps: LeaseDeps = {
    store,
    host,
    secrets: new MemorySecretStore(),
    resolveUrl: async (alias) => `http://172.19.0.1/${alias}`,
    config: { ...DEFAULT_CONFIG, ...config },
    pollMs: 5,
    ...overrides,
  };
  return {
    store,
    host,
    deps,
    reset: async (id) => {
      const started = await beginReset(store, id, { pid: process.pid, maxResets: deps.config?.max_resets ?? 2 });
      if (!started.started) throw new Error(started.reason);
      const slot = started.slot;
      const ref = { flavor: slot.flavor, slot: slot.number };
      await host.quiesce(ref);
      await host.resetTree(ref, host.golden(slot.flavor));
      await host.resetDatabase(ref, host.backup(slot.flavor));
      await host.startSlot(ref, { agent: false });
      await store.update((tx) => void tx.transition(id, { to: "free", golden_hash: fakeGoldenHash(slot.flavor), reset_ms: 1 }));
    },
    status: async (id) => (await store.read()).slots[id]?.status,
  };
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ms = (n: number) => new Promise((resolve) => setTimeout(resolve, n));

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to fail");
}

/** Starts a waiting `get` and resolves once its ticket is in the state file, so tickets follow call order. */
async function queued(p: Pool, flavor: FlavorKey, holder: string, waitSeconds = 30, deps: LeaseDeps = p.deps): Promise<{ promise: Promise<LeaseGrant>; settled: () => boolean }> {
  let done = false;
  const promise = getLease(deps, { flavor, holder, waitSeconds });
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await until(async () => (await p.store.read()).queue.some((w) => w.holder === holder) || done);
  return { promise, settled: () => done };
}

const HOST_INFO = { os: "fake", freeRamMb: 16_384, freeDiskGb: 200, brokerVersion: "0", sqlReachable: true };

function slot(id: string, status: Slot["status"]): Slot {
  const [flavor, nn] = id.split("-") as [FlavorKey, string];
  return {
    id,
    flavor,
    number: Number(nn),
    status,
    golden_hash: "g",
    last_reset_at: null,
    last_reset_ms: null,
    ...(status === "resetting" ? { reset: { started_at: "t", pid: 1, attempt: 1 } } : {}),
  };
}

function waiter(ticket: number, flavor: FlavorKey, extra: Partial<Waiter> = {}): Waiter {
  return { ticket, flavor, holder: `w${ticket}`, pid: 1, start_time: null, queued_at: "t", expires_at: null, ...extra };
}

describe("the pool governor (pure)", () => {
  const governor = poolGovernor(DEFAULT_CONFIG);
  const check = (slots: Slot[], flavor: FlavorKey, queue: Waiter[] = [], ticket: number | null = null, host = HOST_INFO) =>
    governor.check({ slots, flavor, holder: "me", queue, ticket, host });

  it("counts leased slots only toward max_active, not resetting ones", () => {
    const slots = [slot("23-01", "leased"), slot("23-02", "leased"), slot("23-03", "resetting"), slot("23-04", "resetting"), slot("23-05", "free")];
    expect(check(slots, "23")).toEqual({ ok: true });
    expect(check([...slots, slot("12sp9-01", "leased")], "23")).toEqual({ ok: false, reason: "max_active 3 reached (3 leased)" });
  });

  it("refuses below min_free_ram_mb, whatever else is free", () => {
    expect(check([slot("23-01", "free")], "23", [], null, { ...HOST_INFO, freeRamMb: 2047 })).toEqual({
      ok: false,
      reason: "the host has 2047 MB of free RAM, under min_free_ram_mb 2048",
    });
    expect(check([slot("23-01", "free")], "23", [], null, { ...HOST_INFO, freeRamMb: 2048 })).toEqual({ ok: true });
  });

  it("serves earlier waiters first, a slot and a place each", () => {
    const slots = [slot("23-01", "free"), slot("23-02", "free")];
    expect(check(slots, "23", [waiter(1, "23")], null)).toEqual({ ok: true });
    expect(check(slots, "23", [waiter(1, "23"), waiter(2, "23")], null)).toEqual({ ok: false, reason: "2 earlier waiters ahead in the queue" });
    // The caller's own ticket and anyone behind it do not count.
    expect(check(slots, "23", [waiter(1, "23"), waiter(2, "23"), waiter(3, "23")], 2)).toEqual({ ok: true });
  });

  it("does not let a waiter for a flavor with nothing free hold up one that can go", () => {
    expect(check([slot("23-01", "free")], "23", [waiter(1, "35")], null)).toEqual({ ok: true });
  });

  it("lets earlier waiters take the last max_active place even for another flavor", () => {
    const slots = [slot("23-01", "leased"), slot("23-02", "leased"), slot("23-03", "free"), slot("35-01", "free")];
    expect(check(slots, "23", [waiter(1, "35")], null)).toEqual({ ok: false, reason: "1 earlier waiter ahead in the queue" });
  });

  it("drops waiters whose process is gone or whose wait ran out", () => {
    const now = new Date("2026-10-27T12:00:00Z");
    const queue = [waiter(1, "23", { pid: 111 }), waiter(2, "23", { expires_at: "2026-10-27T11:59:59Z" }), waiter(3, "23", { expires_at: "2026-10-27T12:00:01Z" })];
    expect(liveWaiters(queue, now, (w) => w.pid !== 111).map((w) => w.ticket)).toEqual([3]);
  });
});

describe("get and max_active", () => {
  it("refuses the fourth get with exit 3, and queues it with --wait", async () => {
    const p = await pool({ "12sp9": 3, "23": 2 });
    const grants: LeaseGrant[] = [];
    for (const flavor of ["12sp9", "12sp9", "23"] as const) grants.push(await getLease(p.deps, { flavor, holder: "t" }));
    const err = await failure(getLease(p.deps, { flavor: "23", holder: "fourth" }));
    expect(exitCodeFor(err)).toBe(3);
    expect((err as Error).message).toBe("max_active 3 reached (3 leased): no 23 slot can be leased now");

    const fourth = await queued(p, "23", "fourth");
    const state = await p.store.read();
    expect(state.queue).toMatchObject([{ ticket: 1, flavor: "23", holder: "fourth", pid: process.pid }]);
    expect((await leaseStatus(p.deps)).queue).toMatchObject([{ ticket: 1, flavor: "23", holder: "fourth" }]);
    await ms(30);
    expect(fourth.settled()).toBe(false);
    expect(await p.status("23-02")).toBe("free");

    await returnLease(p.deps, { target: grants[0]!.lease_id });
    expect((await fourth.promise).slot).toBe("23-02");
    expect((await p.store.read()).queue).toEqual([]);
    const events = (await p.store.events()).filter((e) => e.event.startsWith("queue-"));
    expect(events.map((e) => [e.event, e.ticket, e.reason])).toEqual([
      ["queue-join", 1, undefined],
      ["queue-leave", 1, "leased"],
    ]);
  });

  it("does not let a caller who does not wait jump the queue", async () => {
    const p = await pool({ "23": 2 }, { max_active: 1 });
    const first = await getLease(p.deps, { flavor: "23", holder: "t" });
    const waiting = await queued(p, "23", "waiter");
    await returnLease(p.deps, { target: first.lease_id });
    // The waiter may already have the slot; either way the late caller is refused.
    const err = await failure(getLease(p.deps, { flavor: "23", holder: "late" }));
    expect(exitCodeFor(err)).toBe(3);
    expect((await waiting.promise).holder).toBe("waiter");
  });
});

describe("the queue", () => {
  it("is served first come, first served", async () => {
    const p = await pool({ "23": 4 }, { max_active: 1 });
    const held = await getLease(p.deps, { flavor: "23", holder: "first" });
    const order: string[] = [];
    const waiters = [];
    for (const name of ["a", "b", "c"]) {
      const w = await queued(p, "23", name);
      void w.promise.then((g) => order.push(g.holder));
      waiters.push(w);
    }
    expect((await p.store.read()).queue.map((w) => [w.ticket, w.holder])).toEqual([
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]);
    let current = held;
    for (const expected of ["a", "b", "c"]) {
      await returnLease(p.deps, { target: current.lease_id });
      await until(() => order.length === ["a", "b", "c"].indexOf(expected) + 1);
      expect(order.at(-1)).toBe(expected);
      current = await waiters[order.length - 1]!.promise;
    }
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("wakes the first waiter when a returned slot's reset completes, not before", async () => {
    const p = await pool({ "23": 1 });
    const held = await getLease(p.deps, { flavor: "23", holder: "holder" });
    const a = await queued(p, "23", "a");
    const b = await queued(p, "23", "b");
    await returnLease(p.deps, { target: held.lease_id });
    await ms(30);
    expect(await p.status("23-01")).toBe("dirty");
    expect(a.settled() || b.settled()).toBe(false);

    await p.reset("23-01");
    const grant = await a.promise;
    expect(grant).toMatchObject({ slot: "23-01", holder: "a" });
    await ms(30);
    expect(b.settled()).toBe(false);

    await returnLease(p.deps, { target: grant.lease_id });
    await p.reset("23-01");
    expect((await b.promise).holder).toBe("b");
  });

  it("forgets a waiter whose process died, and one that stopped waiting", async () => {
    const dead = new Set<number>();
    const p = await pool({ "23": 2 }, { max_active: 1 }, { isWaiterAlive: (w) => !dead.has(w.pid) });
    const held = await getLease(p.deps, { flavor: "23", holder: "holder" });
    // A waiter that gives up leaves the queue.
    expect(exitCodeFor(await failure(getLease(p.deps, { flavor: "23", holder: "impatient", waitSeconds: 0.05 })))).toBe(3);
    expect((await p.store.read()).queue).toEqual([]);

    // A crashed waiter's ticket stays in the file, ahead of everyone, until someone sees its pid is gone.
    await p.store.update((tx) => tx.joinQueue({ flavor: "23", holder: "crashed", pid: 999_999, start_time: null, expires_at: null }));
    dead.add(999_999);
    const live = await queued(p, "23", "live");
    await returnLease(p.deps, { target: held.lease_id });
    expect((await live.promise).holder).toBe("live");
    expect((await p.store.read()).queue).toEqual([]);
    expect((await p.store.events()).find((e) => e.event === "queue-leave" && e.holder === "crashed")?.reason).toBe("gone");
  });
});

describe("get and the host's free RAM", () => {
  it("refuses a get while the host is under min_free_ram_mb, without probing a slot", async () => {
    const p = await pool({ "23": 1 });
    p.host.setHostInfo({ freeRamMb: 1500 });
    const err = await failure(getLease(p.deps, { flavor: "23", holder: "t" }));
    expect(exitCodeFor(err)).toBe(3);
    expect((err as Error).message).toBe("the host has 1500 MB of free RAM, under min_free_ram_mb 2048: no 23 slot can be leased now");
    expect(p.host.callLog).toContain("hostInfo");
    expect(p.host.callLog).not.toContain("brokerToken");
    expect(p.host.callLog).not.toContain("healthCheck");
    expect(await p.status("23-01")).toBe("free");
  });

  it("hands out a slot and checks the disk without asking for the broker's token, which starts a PowerShell process", async () => {
    const p = await pool({ "23": 1 });
    expect((await getLease(p.deps, { flavor: "23", holder: "t" })).slot).toBe("23-01");
    await checkDiskForBuild(p.host, DEFAULT_CONFIG);
    expect(p.host.callLog).toContain("hostInfo");
    expect(p.host.callLog).not.toContain("brokerToken");
  });

  it("makes a get --wait wait until RAM is free again", async () => {
    const p = await pool({ "23": 1 }, { min_free_ram_mb: 4096 });
    p.host.setHostInfo({ freeRamMb: 3000 });
    const w = await queued(p, "23", "t");
    await ms(30);
    expect(w.settled()).toBe(false);
    p.host.setHostInfo({ freeRamMb: 5000 });
    expect((await w.promise).slot).toBe("23-01");
  });

  it("keeps waiting through a busy host and fails on an unreachable one", async () => {
    const p = await pool({ "23": 1 });
    p.host.injectFault({ method: "hostInfo", kind: "fail", error: "Retryable", nth: 1 });
    expect((await getLease(p.deps, { flavor: "23", holder: "t", waitSeconds: 5 })).slot).toBe("23-01");
    const q = await pool({ "35": 1 });
    q.host.setReachable(false);
    expect(exitCodeFor(await failure(getLease(q.deps, { flavor: "35", holder: "t" })))).toBe(6);
  });
});

describe("the reset cap", () => {
  it("holds under 10 simultaneous returns", async () => {
    const p = await pool({ "12sp9": 10 }, { max_active: 10 });
    const grants: LeaseGrant[] = [];
    for (let i = 0; i < 10; i++) grants.push(await getLease(p.deps, { flavor: "12sp9", holder: `t${i}` }));
    // Ten processes' worth of stores, each returning a lease and then trying to start its reset.
    const stores = grants.map(() => new StateStore({ home }));
    await Promise.all(grants.map((g, i) => returnLease({ ...p.deps, store: stores[i]! }, { target: g.lease_id })));
    const starts = await Promise.all(
      grants.map((g, i) => beginReset(stores[i]!, g.slot, { pid: 5000 + i, maxResets: 2, isAlive: () => true })),
    );
    expect(starts.filter((s) => s.started)).toHaveLength(2);
    for (const s of starts.filter((s) => !s.started)) expect(s).toEqual({ started: false, reason: "max_resets 2 reached (2 resetting)" });
    const state = await p.store.read();
    expect(Object.values(state.slots).filter((s) => s.status === "resetting")).toHaveLength(2);
    expect(Object.values(state.slots).filter((s) => s.status === "dirty")).toHaveLength(8);
    expect((await leaseStatus(p.deps)).max_resets).toEqual({ limit: 2, in_use: 2 });

    // Draining: each finished reset lets one more start, never more than two at once.
    let peak = 0;
    for (;;) {
      const now = Object.values((await p.store.read()).slots);
      peak = Math.max(peak, now.filter((s) => s.status === "resetting").length);
      const running = now.filter((s) => s.status === "resetting");
      if (running.length === 0 && now.every((s) => s.status === "free")) break;
      for (const s of running) await p.store.update((tx) => void tx.transition(s.id, { to: "free", golden_hash: fakeGoldenHash("12sp9"), reset_ms: 1 }));
      await Promise.all(
        now.filter((s) => s.status === "dirty").map((s, i) => beginReset(new StateStore({ home }), s.id, { pid: 6000 + i, maxResets: 2, isAlive: () => true })),
      );
    }
    expect(peak).toBe(2);
  });

  it("does not count a reset whose worker died, and starts only from dirty", async () => {
    const p = await pool({ "23": 3 });
    await p.store.update((tx) => {
      for (const id of ["23-01", "23-02", "23-03"]) tx.transition(id, { to: "dirty" });
      tx.transition("23-01", { to: "resetting", pid: 111 });
      tx.transition("23-02", { to: "resetting", pid: 222 });
    });
    const alive = (pid: number) => pid !== 111;
    expect(runningResets(Object.values((await p.store.read()).slots), alive).map((s) => s.id)).toEqual(["23-02"]);
    expect(await beginReset(p.store, "23-03", { pid: 333, maxResets: 2, isAlive: alive })).toMatchObject({ started: true, slot: { status: "resetting" } });
    expect(await beginReset(p.store, "23-03", { pid: 444, maxResets: 2, isAlive: alive })).toEqual({ started: false, reason: "slot 23-03 is resetting, not dirty" });
    expect(await beginReset(p.store, "23-09", { pid: 444, maxResets: 2 })).toEqual({ started: false, reason: 'no slot "23-09" in the pool' });
  });
});

describe("the disk gate for a provision or a baseline build", () => {
  it("refuses under min_free_disk_gb and allows at or above it", async () => {
    const host = new FakeHost({ info: { freeDiskGb: 9 } });
    expect(await checkDiskForBuild(host, DEFAULT_CONFIG)).toEqual({
      ok: false,
      reason: "the host has 9 GB free at the install root, under min_free_disk_gb 10",
    });
    host.setHostInfo({ freeDiskGb: 10 });
    expect(await checkDiskForBuild(host, DEFAULT_CONFIG)).toEqual({ ok: true });
  });

  it("is not asked by get: a lease needs no disk", async () => {
    const p = await pool({ "23": 1 });
    p.host.setHostInfo({ freeDiskGb: 0 });
    expect((await getLease(p.deps, { flavor: "23", holder: "t" })).slot).toBe("23-01");
  });
});
