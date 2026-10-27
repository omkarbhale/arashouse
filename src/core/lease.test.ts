import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHost, fakeGoldenHash } from "../host/fake.js";
import { HostError, type HostErrorKind } from "../host/errors.js";
import { SECRET_REQUIRED_EXIT_CODE } from "./licence.js";
import { EXIT_CODES } from "./exit-codes.js";
import { FLAVORS, type FlavorKey } from "./flavors.js";
import { DEFAULT_CONFIG } from "./config.js";
import { poolGovernor } from "./governor.js";
import {
  GuardRefusedError,
  HostUnreachableError,
  LeaseMismatchError,
  NoSlotAvailableError,
  ResetFailedError,
  UsageError,
  asLeaseError,
  buildStatus,
  exitCodeFor,
  formatAge,
  formatStatus,
  getLease,
  leaseSecretName,
  leaseStatus,
  renderGetJson,
  returnLease,
  type LeaseDeps,
  type LeaseGrant,
} from "./lease.js";
import { slotId, type SlotRef } from "./names.js";
import { GuardError } from "./guards.js";
import { MemorySecretStore } from "./secret-store.js";
import { Secret } from "./secret.js";
import type { SlotStatus, TransitionRequest } from "./state.js";
import { StateStore } from "./store.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function schema(name: string): Promise<object> {
  return JSON.parse(await readFile(join(repoRoot, "docs", "schemas", name), "utf8")) as object;
}

async function validator(name: string) {
  return new Ajv2020({ strict: true, allErrors: true }).compile(await schema(name));
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "arashouse-lease-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const ref = (flavor: FlavorKey, slot: number): SlotRef => ({ flavor, slot });
const URL_OF = async (alias: string) => `http://172.19.0.1/${alias}`;

interface Pool {
  readonly store: StateStore;
  readonly host: FakeHost;
  readonly secrets: MemorySecretStore;
  readonly deps: LeaseDeps;
  readonly clock: { t: number };
  /** Applies legal transitions to one slot, in order. */
  drive(id: string, ...steps: TransitionRequest[]): Promise<void>;
  /** Takes a slot from wherever it is back to free the way a reset worker will: dirty, resetting (the host's reset), free. */
  reset(id: string): Promise<void>;
  status(id: string): Promise<SlotStatus | undefined>;
}

/** A pool of free, provisioned slots: `{ "23": 2 }` is 23-01 and 23-02. Time is virtual: `sleep` moves it. */
async function pool(spec: Partial<Record<FlavorKey, number>>, overrides: Partial<LeaseDeps> = {}): Promise<Pool> {
  const clock = { t: Date.UTC(2026, 9, 22, 12, 0, 0) };
  const now = () => new Date(clock.t);
  const store = new StateStore({ home, now });
  const host = new FakeHost();
  for (const [flavor, count] of Object.entries(spec) as [FlavorKey, number][]) {
    for (let n = 1; n <= count; n++) {
      const r = ref(flavor, n);
      await store.update((tx) => {
        const slot = tx.addSlot(r);
        tx.transition(slot.id, { to: "free", golden_hash: fakeGoldenHash(flavor), reset_ms: 1500 });
      });
      await host.provisionSlot(r);
    }
  }
  const secrets = new MemorySecretStore();
  const deps: LeaseDeps = {
    store,
    host,
    secrets,
    resolveUrl: URL_OF,
    now,
    pollMs: 1000,
    sleep: async (ms) => {
      clock.t += ms;
    },
    ...overrides,
  };
  const drive = async (id: string, ...steps: TransitionRequest[]) => {
    for (const step of steps) await store.update((tx) => void tx.transition(id, step));
  };
  return {
    store,
    host,
    secrets,
    deps,
    clock,
    drive,
    reset: async (id) => {
      const slot = (await store.read()).slots[id];
      if (slot?.status === "leased") await drive(id, { to: "dirty" });
      if ((await store.read()).slots[id]?.status === "free") await drive(id, { to: "dirty" });
      const flavor = slot?.flavor ?? "23";
      const r = ref(flavor, slot?.number ?? 1);
      await drive(id, { to: "resetting", pid: 4242 });
      await host.quiesce(r);
      await host.resetTree(r, host.golden(flavor));
      await host.resetDatabase(r, host.backup(flavor));
      await host.startSlot(r, { agent: false });
      await drive(id, { to: "free", golden_hash: fakeGoldenHash(flavor), reset_ms: 900 });
    },
    status: async (id) => (await store.read()).slots[id]?.status,
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to fail");
}

describe("the exit codes", () => {
  it("are the stable table of ticket 13", () => {
    expect(EXIT_CODES).toEqual({ ok: 0, usage: 2, noSlot: 3, leaseMismatch: 4, resetFailed: 5, hostUnreachable: 6, refused: 7 });
    expect(Object.values(EXIT_CODES)).not.toContain(SECRET_REQUIRED_EXIT_CODE);
  });

  it("are carried by the lease errors and found for host failures", () => {
    expect(new UsageError("x").exitCode).toBe(2);
    expect(new NoSlotAvailableError("x").exitCode).toBe(3);
    expect(new LeaseMismatchError("23-01").exitCode).toBe(4);
    expect(new ResetFailedError("x").exitCode).toBe(5);
    expect(new HostUnreachableError("x").exitCode).toBe(6);
    expect(new GuardRefusedError("x").exitCode).toBe(7);
    expect(exitCodeFor(new HostError("Unreachable", "down"))).toBe(6);
    expect(exitCodeFor(new HostError("Retryable", "busy"))).toBe(6);
    expect(exitCodeFor(new HostError("Refused", "no"))).toBe(7);
    expect(exitCodeFor(new Error("boom"))).toBe(1);
  });

  it("do not let a credential in a host message through", () => {
    const secret = Secret.of("hunter2-in-a-host-message", "lease-password");
    const mapped = asLeaseError(new HostError("Unreachable", `login failed password=${secret.reveal()}`));
    expect(String((mapped as Error).message)).not.toContain("hunter2-in-a-host-message");
  });
});

describe("get", () => {
  it("hands out the lowest free slot and returns the contract", async () => {
    const p = await pool({ "23": 2 });
    const grant = await getLease(p.deps, { flavor: "23", holder: "task-a" });
    expect(grant).toMatchObject({
      slot: "23-01",
      flavor: "23",
      aras: "14.0.9.36073",
      engine: "14.0.7",
      url: "http://172.19.0.1/ah-23-01",
      database: "arashouse_23_01",
      user: "root",
      holder: "task-a",
    });
    expect(grant.lease_id).toMatch(/^[0-9a-f]{32}$/);
    const json = renderGetJson(grant);
    expect(json.password).toBe(grant.password.reveal());
    expect(json.password.length).toBeGreaterThanOrEqual(22);
    const validate = await validator("get.schema.json");
    expect(validate(json), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...json, extra: 1 })).toBe(false);
    expect(validate({ ...json, lease_id: "short" })).toBe(false);
  });

  it("marks the slot leased with a holder and a fresh lease id, and logs one transition", async () => {
    const p = await pool({ "12sp9": 1 });
    const grant = await getLease(p.deps, { flavor: "12sp9", holder: "task-a" });
    const state = await p.store.read();
    expect(state.slots["12sp9-01"]).toMatchObject({ status: "leased", lease: { lease_id: grant.lease_id, holder: "task-a" } });
    const events = (await p.store.events()).filter((e) => e.slot === "12sp9-01" && e.to === "leased");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from: "free", holder: "task-a", lease: grant.lease_id.slice(0, 8) });
  });

  it("gives the password to the secret store and the host a handle to it, and stamps the lease on the slot", async () => {
    const p = await pool({ "23": 1 });
    const grant = await getLease(p.deps, { flavor: "23", holder: "task-a" });
    const stored = await p.secrets.get(leaseSecretName(grant.lease_id));
    expect(stored?.reveal()).toBe(grant.password.reveal());
    expect(p.host.inspect(ref("23", 1))?.credentials).toEqual({ secretRef: leaseSecretName(grant.lease_id) });
    expect(p.host.inspect(ref("23", 1))?.stamp?.leaseId).toBe(grant.lease_id);
  });

  it("gives two slots to two calls from one holder", async () => {
    const p = await pool({ "23": 2 });
    const a = await getLease(p.deps, { flavor: "23", holder: "crewmate" });
    const b = await getLease(p.deps, { flavor: "23", holder: "crewmate" });
    expect([a.slot, b.slot]).toEqual(["23-01", "23-02"]);
    expect(a.lease_id).not.toBe(b.lease_id);
    expect(a.password.reveal()).not.toBe(b.password.reveal());
  });

  it("reports a flavor whose build is not yet known as null", async () => {
    expect(FLAVORS["35"].serverBuild).toBeNull();
    const p = await pool({ "35": 1 });
    const json = renderGetJson(await getLease(p.deps, { flavor: "35", holder: "t" }));
    expect(json.aras).toBeNull();
    expect(json.engine).toBe("14.35");
    expect((await validator("get.schema.json"))(json)).toBe(true);
  });

  it("rejects an unknown flavor, a bad holder and a bad wait with exit 2", async () => {
    const p = await pool({ "23": 1 });
    for (const request of [
      { flavor: "99", holder: "t" },
      { flavor: "23", holder: "" },
      { flavor: "23", holder: "line\nbreak" },
      { flavor: "23", holder: "t", waitSeconds: -1 },
      { flavor: "23", holder: "t", waitSeconds: Number.NaN },
    ]) {
      expect(exitCodeFor(await failure(getLease(p.deps, request)))).toBe(2);
    }
    expect((await p.store.read()).slots["23-01"]?.status).toBe("free");
  });
});

describe("get when no slot can be handed out", () => {
  it("fails at once with exit 3, naming the leased, resetting and quarantined slots", async () => {
    const p = await pool({ "12sp9": 3 });
    await p.drive("12sp9-01", { to: "leased", holder: "a" });
    await p.drive("12sp9-02", { to: "dirty" }, { to: "resetting", pid: 7 });
    await p.drive("12sp9-03", { to: "quarantined", reason: "reset failed at database" });
    const err = await failure(getLease(p.deps, { flavor: "12sp9", holder: "t", waitSeconds: 0 }));
    expect(err).toBeInstanceOf(NoSlotAvailableError);
    expect(exitCodeFor(err)).toBe(3);
    expect((err as Error).message).toBe("no 12sp9 slot is free: 3 slots, 1 leased, 1 resetting, 1 quarantined");
  });

  it("counts dirty slots too, and says so when none is provisioned", async () => {
    const p = await pool({ "23": 1 });
    await p.drive("23-01", { to: "dirty" });
    expect(((await failure(getLease(p.deps, { flavor: "23", holder: "t" }))) as Error).message).toContain("1 dirty");
    expect(((await failure(getLease(p.deps, { flavor: "35", holder: "t" }))) as Error).message).toBe("no 35 slot is provisioned");
  });

  it("never hands out a dirty or resetting slot", async () => {
    const p = await pool({ "23": 2 });
    await p.drive("23-01", { to: "leased", holder: "a" }, { to: "dirty" });
    await p.drive("23-02", { to: "dirty" }, { to: "resetting", pid: 7 });
    expect(exitCodeFor(await failure(getLease(p.deps, { flavor: "23", holder: "t" })))).toBe(3);
    expect(p.host.callLog).not.toContain("setLeaseCredentials");
  });

  it("only looks at slots of the flavor asked for", async () => {
    const p = await pool({ "12sp9": 1, "23": 1 });
    await p.drive("23-01", { to: "leased", holder: "a" });
    expect((await getLease(p.deps, { flavor: "12sp9", holder: "t" })).slot).toBe("12sp9-01");
    expect(exitCodeFor(await failure(getLease(p.deps, { flavor: "23", holder: "t" })))).toBe(3);
  });

  it("with --wait N, polls until N seconds have passed and then fails with exit 3", async () => {
    const p = await pool({ "23": 1 });
    await p.drive("23-01", { to: "leased", holder: "a" });
    const start = p.clock.t;
    const err = await failure(getLease(p.deps, { flavor: "23", holder: "t", waitSeconds: 5 }));
    expect(exitCodeFor(err)).toBe(3);
    expect(p.clock.t - start).toBe(5000);
  });

  it("with --wait N, wakes when a slot becomes free and takes it", async () => {
    let sleeps = 0;
    const p = await pool({ "23": 1 });
    await p.drive("23-01", { to: "leased", holder: "a" }, { to: "dirty" });
    const deps: LeaseDeps = {
      ...p.deps,
      sleep: async (ms) => {
        p.clock.t += ms;
        sleeps++;
        if (sleeps === 2) await p.drive("23-01", { to: "resetting", pid: 7 });
        if (sleeps === 3) await p.drive("23-01", { to: "free", golden_hash: fakeGoldenHash("23"), reset_ms: 800 });
      },
    };
    const start = p.clock.t;
    const grant = await getLease(deps, { flavor: "23", holder: "waiter", waitSeconds: 60 });
    expect(grant.slot).toBe("23-01");
    expect(sleeps).toBe(3);
    expect(p.clock.t - start).toBe(3000);
  });

  it("with real timers, wakes within a poll of the slot being freed", async () => {
    const p = await pool({ "23": 1 });
    await p.drive("23-01", { to: "dirty" });
    const deps: LeaseDeps = { ...p.deps, pollMs: 10, sleep: undefined, now: undefined };
    setTimeout(() => void p.drive("23-01", { to: "resetting", pid: 7 }, { to: "free", golden_hash: fakeGoldenHash("23"), reset_ms: 1 }), 40);
    expect((await getLease(deps, { flavor: "23", holder: "t", waitSeconds: 10 })).slot).toBe("23-01");
  });
});

describe("get and concurrency", () => {
  it("never gives one slot to two concurrent calls", async () => {
    const p = await pool({ "12sp9": 3 });
    const stores = [1, 2, 3, 4, 5, 6].map(() => new StateStore({ home }));
    const results = await Promise.allSettled(
      stores.map((store, i) => getLease({ ...p.deps, store, config: { ...DEFAULT_CONFIG, max_active: 99 } }, { flavor: "12sp9", holder: `t${i}` })),
    );
    const granted = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.slot] : []));
    expect(granted.sort()).toEqual(["12sp9-01", "12sp9-02", "12sp9-03"]);
    const refused = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    expect(refused).toHaveLength(3);
    for (const err of refused) expect(exitCodeFor(err)).toBe(3);
    const state = await p.store.read();
    expect(new Set(Object.values(state.slots).map((s) => s.lease?.lease_id)).size).toBe(3);
  });

  it("never gives one slot to two concurrent processes", { timeout: 120_000 }, async () => {
    const p = await pool({ "12sp9": 3 });
    const outputs = await Promise.all(
      [0, 1, 2, 3, 4].map(
        (i) =>
          new Promise<{ code: number | null; stdout: string }>((resolve) => {
            const child = spawn(
              process.execPath,
              [join(repoRoot, "node_modules/vite-node/vite-node.mjs"), join(repoRoot, "test/fixtures/lease-worker.ts")],
              { cwd: repoRoot, env: { ...process.env, LW_HOME: home, LW_FLAVOR: "12sp9", LW_HOLDER: `proc-${i}` }, stdio: ["ignore", "pipe", "inherit"] },
            );
            let stdout = "";
            child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
            child.on("exit", (code) => resolve({ code, stdout }));
          }),
      ),
    );
    const granted = outputs.filter((o) => o.code === 0).map((o) => (JSON.parse(o.stdout) as { slot: string }).slot);
    expect(granted.sort()).toEqual(["12sp9-01", "12sp9-02", "12sp9-03"]);
    expect(outputs.filter((o) => o.code === 3)).toHaveLength(2);
    expect(Object.values((await p.store.read()).slots).every((s) => s.status === "leased")).toBe(true);
  });
});

describe("get and the governor", () => {
  it("refuses with exit 3 and the reason once max_active slots are leased, across flavors", async () => {
    const p = await pool({ "12sp9": 2, "23": 2 });
    for (const flavor of ["12sp9", "12sp9", "23"] as const) await getLease(p.deps, { flavor, holder: "t" });
    const err = await failure(getLease(p.deps, { flavor: "23", holder: "t" }));
    expect(exitCodeFor(err)).toBe(3);
    expect((err as Error).message).toBe(`max_active ${DEFAULT_CONFIG.max_active} reached (3 leased): no 23 slot can be leased now`);
    expect((await p.store.read()).slots["23-02"]?.status).toBe("free");
  });

  it("lets a fourth call through when a lease has been returned", async () => {
    const p = await pool({ "12sp9": 3, "23": 1 });
    const grants: LeaseGrant[] = [];
    for (const flavor of ["12sp9", "12sp9", "12sp9"] as const) grants.push(await getLease(p.deps, { flavor, holder: "t" }));
    expect(exitCodeFor(await failure(getLease(p.deps, { flavor: "23", holder: "t" })))).toBe(3);
    await returnLease(p.deps, { target: grants[0]!.lease_id });
    expect((await getLease(p.deps, { flavor: "23", holder: "t" })).slot).toBe("23-01");
  });

  it("asks the governor under the lock, with every slot and the request", async () => {
    const seen: unknown[] = [];
    const p = await pool(
      { "23": 2 },
      { governor: { check: (c) => (seen.push([c.slots.length, c.flavor, c.holder]), { ok: false, reason: "RAM is low" }) } },
    );
    const err = await failure(getLease(p.deps, { flavor: "23", holder: "who" }));
    expect((err as Error).message).toBe("RAM is low: no 23 slot can be leased now");
    expect(seen).toEqual([[2, "23", "who"]]);
    const host = (await p.host.hostInfo()).info;
    expect(poolGovernor({ ...DEFAULT_CONFIG, max_active: 1 }).check({ slots: [], flavor: "23", holder: "t", queue: [], ticket: null, host })).toEqual({
      ok: false,
      reason: "0 earlier waiters ahead in the queue",
    });
  });
});

describe("get and the dirty check", () => {
  it("marks a free slot whose tree is dirty as dirty and hands out the next one", async () => {
    const p = await pool({ "23": 2 });
    p.host.dirty(ref("23", 1), "tree");
    expect((await getLease(p.deps, { flavor: "23", holder: "t" })).slot).toBe("23-02");
    expect(await p.status("23-01")).toBe("dirty");
    const note = (await p.store.events()).find((e) => e.slot === "23-01" && e.to === "dirty");
    expect(note?.reason).toContain("health check failed");
  });

  it.each([["database"], ["stamp"]] as const)("does not hand out a slot whose %s no longer matches the golden", async (part) => {
    const p = await pool({ "23": 1 });
    p.host.dirty(ref("23", 1), part);
    const err = await failure(getLease(p.deps, { flavor: "23", holder: "t" }));
    expect(exitCodeFor(err)).toBe(3);
    expect(await p.status("23-01")).toBe("dirty");
    expect(p.host.callLog).not.toContain("setLeaseCredentials");
  });

  it("treats a stamp that still names a lease, or whose golden differs from the state's, as dirty", async () => {
    const p = await pool({ "23": 2 });
    const stamp = p.host.inspect(ref("23", 1))?.stamp;
    await p.host.writeStamp(ref("23", 1), { ...stamp!, leaseId: "ab".repeat(16) });
    await p.drive("23-02", { to: "dirty" }, { to: "resetting", pid: 7 }, { to: "free", golden_hash: "some-other-golden", reset_ms: 1 });
    expect(exitCodeFor(await failure(getLease(p.deps, { flavor: "23", holder: "t" })))).toBe(3);
    expect(await p.status("23-01")).toBe("dirty");
    expect(await p.status("23-02")).toBe("dirty");
  });

  it("skips a slot whose check fails with a retryable host error, and tries it again after waiting", async () => {
    const p = await pool({ "23": 2 });
    p.host.injectFault({ method: "healthCheck", kind: "fail", error: "Retryable", nth: 1 });
    expect((await getLease(p.deps, { flavor: "23", holder: "t" })).slot).toBe("23-02");
    expect(await p.status("23-01")).toBe("free");
  });

  it("quarantines a slot whose check fails with a quarantine error, and hands out the next", async () => {
    const p = await pool({ "23": 2 });
    p.host.injectFault({ method: "healthCheck", kind: "fail", error: "Quarantine", message: "database is gone", nth: 1 });
    expect((await getLease(p.deps, { flavor: "23", holder: "t" })).slot).toBe("23-02");
    expect((await p.store.read()).slots["23-01"]).toMatchObject({ status: "quarantined", quarantine_reason: "database is gone" });
  });

  it.each([
    ["Unreachable", 6],
    ["Refused", 7],
  ] as [HostErrorKind, number][])("exits %s -> %i when the host cannot be asked, and leases nothing", async (error, code) => {
    const p = await pool({ "23": 1 });
    p.host.injectFault({ method: "readStamp", kind: "fail", error });
    expect(exitCodeFor(await failure(getLease(p.deps, { flavor: "23", holder: "t" })))).toBe(code);
    expect(await p.status("23-01")).toBe("free");
  });

  it("exits 6 when the host is unreachable", async () => {
    const p = await pool({ "23": 1 });
    p.host.setReachable(false);
    expect(exitCodeFor(await failure(getLease(p.deps, { flavor: "23", holder: "t" })))).toBe(6);
    expect(await p.status("23-01")).toBe("free");
  });

  it("gives a slot up for reset, and its password back, when the lease cannot be completed", async () => {
    const p = await pool({ "23": 1 });
    p.host.injectFault({ method: "setLeaseCredentials", kind: "fail", error: "Unreachable" });
    const err = await failure(getLease(p.deps, { flavor: "23", holder: "t" }));
    expect(exitCodeFor(err)).toBe(6);
    expect((await p.store.read()).slots["23-01"]).toMatchObject({ status: "dirty" });
    expect((await p.store.read()).slots["23-01"]?.lease).toBeUndefined();
    const leaseId = (await p.store.events()).find((e) => e.to === "leased")?.lease;
    expect(leaseId).toBeDefined();
    expect(p.secrets.size).toBe(0);
  });

  it("gives a slot up, and fails with exit 6, when no URL can be found", async () => {
    const p = await pool({ "23": 1 }, { resolveUrl: async () => Promise.reject(new HostError("Unreachable", "no host address answered")) });
    expect(exitCodeFor(await failure(getLease(p.deps, { flavor: "23", holder: "t" })))).toBe(6);
    expect(await p.status("23-01")).toBe("dirty");
  });

  it("quarantines a slot, and moves to the next, when completing the lease reports a quarantine error", async () => {
    const p = await pool({ "23": 2 });
    p.host.injectFault({ method: "setLeaseCredentials", kind: "fail", error: "Quarantine", message: "login cannot be set", nth: 1 });
    expect((await getLease(p.deps, { flavor: "23", holder: "t" })).slot).toBe("23-02");
    expect((await p.store.read()).slots["23-01"]).toMatchObject({ status: "quarantined", quarantine_reason: "login cannot be set" });
  });
});

describe("return", () => {
  it("marks the slot dirty and exits without calling the host or waiting for a reset", async () => {
    const p = await pool({ "23": 1 });
    const grant = await getLease(p.deps, { flavor: "23", holder: "t" });
    const callsBefore = p.host.calls.length;
    const result = await returnLease(p.deps, { target: "23-01", ifLeaseId: grant.lease_id });
    expect(result).toMatchObject({ outcome: "returned", slot: "23-01" });
    expect(p.host.calls.length).toBe(callsBefore);
    expect(await p.status("23-01")).toBe("dirty");
    expect((await p.store.read()).slots["23-01"]?.lease).toBeUndefined();
  });

  it("works by lease id alone, and forgets the lease password", async () => {
    const p = await pool({ "23": 1 });
    const grant = await getLease(p.deps, { flavor: "23", holder: "t" });
    expect(await p.secrets.has(leaseSecretName(grant.lease_id))).toBe(true);
    await returnLease(p.deps, { target: grant.lease_id });
    expect(await p.status("23-01")).toBe("dirty");
    expect(await p.secrets.has(leaseSecretName(grant.lease_id))).toBe(false);
  });

  it("refuses to return by slot name without --if-lease-id (exit 2), changing nothing", async () => {
    const p = await pool({ "23": 1 });
    await getLease(p.deps, { flavor: "23", holder: "t" });
    const err = await failure(returnLease(p.deps, { target: "23-01" }));
    expect(err).toBeInstanceOf(UsageError);
    expect(await p.status("23-01")).toBe("leased");
  });

  it("rejects things that are neither a slot nor a lease, and an unknown slot, with exit 2", async () => {
    const p = await pool({ "23": 1 });
    const id = "cd".repeat(16);
    for (const request of [
      { target: "nonsense", ifLeaseId: id },
      { target: "23-01", ifLeaseId: "not-hex" },
      { target: "23-09", ifLeaseId: id },
      { target: id, ifLeaseId: "ef".repeat(16) },
    ]) {
      expect(exitCodeFor(await failure(returnLease(p.deps, request)))).toBe(2);
    }
  });

  it("protects against ABA: a stale caller cannot return a later lease of the same slot", async () => {
    const p = await pool({ "23": 1 });
    const first = await getLease(p.deps, { flavor: "23", holder: "old" });
    await returnLease(p.deps, { target: "23-01", ifLeaseId: first.lease_id });
    await p.reset("23-01");
    const second = await getLease(p.deps, { flavor: "23", holder: "new" });
    expect(second.slot).toBe("23-01");
    expect(second.lease_id).not.toBe(first.lease_id);

    const before = await readFile(p.store.paths.state, "utf8");
    const eventsBefore = await readFile(p.store.paths.events, "utf8");
    const err = await failure(returnLease(p.deps, { target: "23-01", ifLeaseId: first.lease_id }));
    expect(err).toBeInstanceOf(LeaseMismatchError);
    expect(exitCodeFor(err)).toBe(4);
    expect(await readFile(p.store.paths.state, "utf8")).toBe(before);
    expect(await readFile(p.store.paths.events, "utf8")).toBe(eventsBefore);
    expect((await p.store.read()).slots["23-01"]?.lease?.lease_id).toBe(second.lease_id);
    expect(await p.secrets.has(leaseSecretName(second.lease_id))).toBe(true);

    expect((await returnLease(p.deps, { target: "23-01", ifLeaseId: second.lease_id })).outcome).toBe("returned");
  });

  it("is a no-op, exit 0, saying 'already returned' the second time", async () => {
    const p = await pool({ "23": 1 });
    const grant = await getLease(p.deps, { flavor: "23", holder: "t" });
    await returnLease(p.deps, { target: "23-01", ifLeaseId: grant.lease_id });
    const before = await readFile(p.store.paths.state, "utf8");
    for (const request of [{ target: "23-01", ifLeaseId: grant.lease_id }, { target: grant.lease_id }]) {
      const again = await returnLease(p.deps, request);
      expect(again).toMatchObject({ outcome: "already-returned", message: "already returned" });
    }
    expect(await readFile(p.store.paths.state, "utf8")).toBe(before);
    await p.reset("23-01");
    expect((await returnLease(p.deps, { target: "23-01", ifLeaseId: grant.lease_id })).outcome).toBe("already-returned");
    expect((await returnLease(p.deps, { target: "ab".repeat(16) })).slot).toBeNull();
  });

  it("leaves the other leases alone", async () => {
    const p = await pool({ "23": 2 });
    const a = await getLease(p.deps, { flavor: "23", holder: "a" });
    const b = await getLease(p.deps, { flavor: "23", holder: "b" });
    await returnLease(p.deps, { target: a.lease_id });
    expect((await p.store.read()).slots[b.slot]).toMatchObject({ status: "leased", lease: { lease_id: b.lease_id } });
    expect(await p.secrets.has(leaseSecretName(b.lease_id))).toBe(true);
  });

  describe("--wait", () => {
    it("blocks until the slot is free again", async () => {
      const p = await pool({ "23": 1 });
      const grant = await getLease(p.deps, { flavor: "23", holder: "t" });
      let sleeps = 0;
      const deps: LeaseDeps = {
        ...p.deps,
        sleep: async (ms) => {
          p.clock.t += ms;
          sleeps++;
          if (sleeps === 1) await p.drive("23-01", { to: "resetting", pid: 7 });
          if (sleeps === 2) await p.drive("23-01", { to: "free", golden_hash: fakeGoldenHash("23"), reset_ms: 5 });
        },
      };
      const result = await returnLease(deps, { target: grant.lease_id, waitSeconds: Infinity });
      expect(result.outcome).toBe("returned");
      expect(sleeps).toBe(2);
      expect(await p.status("23-01")).toBe("free");
    });

    it("exits 5 when the slot is quarantined", async () => {
      const p = await pool({ "23": 1 });
      const grant = await getLease(p.deps, { flavor: "23", holder: "t" });
      const deps: LeaseDeps = {
        ...p.deps,
        sleep: async () => {
          await p.drive("23-01", { to: "quarantined", reason: "reset failed at tree" });
        },
      };
      const err = await failure(returnLease(deps, { target: grant.lease_id, waitSeconds: 60 }));
      expect(err).toBeInstanceOf(ResetFailedError);
      expect(exitCodeFor(err)).toBe(5);
      expect((err as Error).message).toContain("reset failed at tree");
      expect(await p.status("23-01")).toBe("quarantined");
    });

    it("exits 5 when the reset does not finish in time, and 0 if the slot was freed and leased again meanwhile", async () => {
      const p = await pool({ "23": 1 });
      const grant = await getLease(p.deps, { flavor: "23", holder: "t" });
      const err = await failure(returnLease(p.deps, { target: grant.lease_id, waitSeconds: 3 }));
      expect(exitCodeFor(err)).toBe(5);
      expect((err as Error).message).toContain("not free again within 3 s");

      const q = await pool({ "35": 1 });
      const first = await getLease(q.deps, { flavor: "35", holder: "t" });
      const deps: LeaseDeps = {
        ...q.deps,
        sleep: async () => {
          await q.reset("35-01");
          await getLease(q.deps, { flavor: "35", holder: "next" });
        },
      };
      expect((await returnLease(deps, { target: first.lease_id, waitSeconds: 60 })).outcome).toBe("returned");
    });

    it("does not wait when the target is a lease that is not in the state", async () => {
      const p = await pool({ "23": 1 });
      const result = await returnLease(p.deps, { target: "ab".repeat(16), waitSeconds: 60 });
      expect(result).toMatchObject({ outcome: "already-returned", slot: null });
    });
  });
});

describe("status", () => {
  it("has one row per slot, totals per flavor and max_active in use, and validates against the schema", async () => {
    const p = await pool({ "12sp9": 3, "23": 2 });
    const grant = await getLease(p.deps, { flavor: "12sp9", holder: "task-a" });
    await p.drive("12sp9-02", { to: "dirty" });
    await p.drive("12sp9-03", { to: "dirty" }, { to: "resetting", pid: 5 });
    await p.drive("23-01", { to: "quarantined", reason: "reset failed at database: restore timed out" });
    p.clock.t += (2 * 3600 + 13 * 60 + 5) * 1000;

    const report = await leaseStatus(p.deps);
    const validate = await validator("status.schema.json");
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report.slots.map((s) => s.slot)).toEqual(["12sp9-01", "12sp9-02", "12sp9-03", "23-01", "23-02"]);
    expect(report.slots[0]).toMatchObject({
      status: "leased",
      holder: "task-a",
      lease: grant.lease_id.slice(0, 8),
      lease_age_seconds: 2 * 3600 + 13 * 60 + 5,
      last_reset_ms: 1500,
      quarantine_reason: null,
    });
    expect(report.slots[3]).toMatchObject({ status: "quarantined", quarantine_reason: "reset failed at database: restore timed out", holder: null, lease: null });
    expect(report.max_active).toEqual({ limit: 3, in_use: 1 });
    expect(report.max_resets).toEqual({ limit: 2, in_use: 1 });
    expect(report.queue).toEqual([]);
    expect(report.flavors["12sp9"]).toEqual({ total: 3, provisioning: 0, free: 0, leased: 1, dirty: 1, resetting: 1, quarantined: 0, disabled: 0 });
    expect(report.flavors["23"]).toMatchObject({ total: 2, free: 1, quarantined: 1 });
    expect(report.flavors["35"].total).toBe(0);

    expect(validate({ ...report, extra: true })).toBe(false);
    expect(validate({ ...report, slots: [{ ...report.slots[0], lease: grant.lease_id }] })).toBe(false);
  });

  it("is valid for an empty pool", async () => {
    const p = await pool({});
    const report = await leaseStatus(p.deps);
    expect(report.slots).toEqual([]);
    expect((await validator("status.schema.json"))(report)).toBe(true);
  });

  it("does not need the lock, so it answers while a get holds it", async () => {
    const p = await pool({ "23": 1 });
    const report = await leaseStatus({ ...p.deps, config: { ...DEFAULT_CONFIG, max_active: 5 } });
    expect(report.max_active.limit).toBe(5);
  });

  it("is readable as text: the table, the quarantine reasons, the totals", async () => {
    const p = await pool({ "23": 2 });
    await getLease(p.deps, { flavor: "23", holder: "task-a" });
    await p.drive("23-02", { to: "quarantined", reason: "reset failed at tree" });
    p.clock.t += 125_000;
    const text = formatStatus(await leaseStatus(p.deps)).join("\n");
    expect(text).toMatch(/^SLOT\s+FLAVOR\s+STATUS\s+HOLDER\s+LEASE\s+AGE\s+LAST RESET$/m);
    expect(text).toMatch(/^23-01\s+23\s+leased\s+task-a\s+[0-9a-f]{8}\s+2m05s\s+1\.5s$/m);
    expect(text).toContain("quarantined 23-02: reset failed at tree");
    expect(text).toContain("23: 0 free of 2 (1 leased, 0 dirty, 0 resetting, 1 quarantined)");
    expect(text).toContain("max_active: 1 of 3 in use");
    expect(text).toContain("max_resets: 0 of 2 running");
    expect(text).not.toContain("queue:");
  });

  it("shows the live get --wait queue, first served first", async () => {
    const p = await pool({ "23": 1 });
    await p.store.update((tx) => {
      tx.joinQueue({ flavor: "23", holder: "task-b", pid: process.pid, start_time: null, expires_at: null });
      tx.joinQueue({ flavor: "35", holder: "task-c", pid: process.pid, start_time: null, expires_at: null });
      tx.joinQueue({ flavor: "23", holder: "gone", pid: 4_000_000, start_time: null, expires_at: null });
    });
    const report = await leaseStatus({ ...p.deps, isWaiterAlive: (w) => w.pid === process.pid });
    const validate = await validator("status.schema.json");
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report.queue).toEqual([
      { ticket: 1, flavor: "23", holder: "task-b", queued_at: new Date(p.clock.t).toISOString() },
      { ticket: 2, flavor: "35", holder: "task-c", queued_at: new Date(p.clock.t).toISOString() },
    ]);
    expect(formatStatus(report)).toContain("queue: #1 23 task-b, #2 35 task-c");
    expect(validate({ ...report, queue: [{ ...report.queue[0], pid: 1 }] })).toBe(false);
  });

  it("formats ages", () => {
    expect([0, 59, 60, 125, 3599, 3600, 7985].map(formatAge)).toEqual(["0s", "59s", "1m00s", "2m05s", "59m59s", "1h00m", "2h13m"]);
  });

  it("builds from a state alone", async () => {
    const p = await pool({ "23": 1 });
    const report = buildStatus(await p.store.read(), { now: new Date(p.clock.t) });
    expect(report.max_active).toEqual({ limit: 3, in_use: 0 });
  });
});

describe("no password anywhere but the get output", () => {
  it("stays out of the state file, the events log, status and the host's call record", async () => {
    const password = ["Zx9", "fixed-test", "Qw3"].join("-");
    const p = await pool({ "23": 2 }, { newPassword: () => Secret.of(password, "lease-password") });
    const grant = await getLease(p.deps, { flavor: "23", holder: "task-a" });
    expect(renderGetJson(grant).password).toBe(password);

    const second = await getLease(p.deps, { flavor: "23", holder: "task-b" });
    await returnLease(p.deps, { target: second.lease_id });
    await failure(returnLease(p.deps, { target: "23-01", ifLeaseId: "ab".repeat(16) }));
    const failed = await failure(getLease(p.deps, { flavor: "23", holder: "task-c" }));

    const report = await leaseStatus(p.deps);
    const everything = [
      await readFile(p.store.paths.state, "utf8"),
      await readFile(p.store.paths.events, "utf8"),
      JSON.stringify(report),
      formatStatus(report).join("\n"),
      JSON.stringify(p.host.calls),
      JSON.stringify(p.host.inspect(ref("23", 1))),
      String((failed as Error).message),
      String(grant.password),
      JSON.stringify(grant),
    ].join("\n");
    expect(everything).not.toContain(password);
    expect(everything).not.toContain(encodeURIComponent(password));
    // The lease id is the capability to return or run against the lease: status shows only its first 8 characters.
    expect(JSON.stringify(report) + formatStatus(report).join("\n")).not.toContain(grant.lease_id.slice(8));
  });

  it("generates 128 bits, URL-safe, fresh for every lease", async () => {
    const p = await pool({ "12sp9": 3 });
    const passwords = new Set<string>();
    for (let i = 0; i < 3; i++) passwords.add((await getLease(p.deps, { flavor: "12sp9", holder: "t" })).password.reveal());
    expect(passwords.size).toBe(3);
    for (const pw of passwords) expect(pw).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("the guards still apply", () => {
  it("surface as exit 7", () => {
    const refused = asLeaseError(new HostError("Refused", new GuardError("denied", "database", "OLM_Local", "on the deny-list").message));
    expect(exitCodeFor(refused)).toBe(7);
    expect(slotId(ref("23", 1))).toBe("23-01");
  });
});

describe("states the slot machine allows from a lease", () => {
  it("never reaches free from leased without a reset", async () => {
    const p = await pool({ "23": 1 });
    const grant = await getLease(p.deps, { flavor: "23", holder: "t" });
    await returnLease(p.deps, { target: grant.lease_id });
    const events = (await p.store.events()).filter((e) => e.slot === "23-01").map((e) => `${e.from}>${e.to}`);
    expect(events).toEqual(["null>provisioning", "provisioning>free", "free>leased", "leased>dirty"]);
  });
});
