import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../host/clock.js";
import type { HostMethod } from "../host/driver.js";
import { HostError } from "../host/errors.js";
import { FakeHost, fakeGoldenHash } from "../host/fake.js";
import { DEFAULT_CONFIG } from "./config.js";
import { EXIT_CODES } from "./exit-codes.js";
import type { FlavorKey } from "./flavors.js";
import { type LeaseDeps, exitCodeFor, getLease, leaseSecretName } from "./lease.js";
import { DRY_RUN, type OperatorDeps } from "./operator.js";
import { type ResetDeps, resetHooks } from "./reset.js";
import { MemorySecretStore } from "./secret-store.js";
import { StateStore } from "./store.js";
import { elevatedPlan, teardownPool, teardownSwitches } from "./teardown.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "arashouse-teardown-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const MY_PID = 4242;

interface Pool {
  readonly store: StateStore;
  readonly host: FakeHost;
  readonly secrets: MemorySecretStore;
  readonly alive: Set<number>;
  readonly deps: OperatorDeps;
  readonly lease: LeaseDeps;
}

async function pool(spec: Partial<Record<FlavorKey, number>>): Promise<Pool> {
  const clock = new FakeClock(Date.UTC(2026, 9, 28, 9, 0, 0));
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
  const secrets = new MemorySecretStore();
  const reset: ResetDeps = {
    store,
    host,
    golden: async (flavor) => ({ tree: host.golden(flavor), backup: host.backup(flavor) }),
    config: DEFAULT_CONFIG,
    pid: MY_PID,
    startTime: null,
    isWorkerAlive: (pid) => alive.has(pid),
    now,
  };
  const deps: OperatorDeps = { store, host, secrets, reset, now };
  const lease: LeaseDeps = {
    store,
    host,
    secrets,
    resolveUrl: async (alias) => `http://172.19.0.1/${alias}`,
    config: DEFAULT_CONFIG,
    isWaiterAlive: () => true,
    now,
    reset: resetHooks(reset, () => undefined),
  };
  return { store, host, secrets, alive, deps, lease };
}

const MUTATING = new Set<HostMethod>(["provisionSlot", "destroySlot", "quiesce", "resetTree", "resetDatabase", "startSlot", "stopSlot", "writeStamp", "setLeaseCredentials"]);

/** Everything a teardown could change: the state file, the host's slots and the lease passwords. */
async function snapshot(p: Pool): Promise<string> {
  const state = await readFile(p.store.paths.state, "utf8").catch(() => "");
  const listed = (await p.host.listSlots()).slots.map((s) => JSON.stringify(p.host.inspect(s.slot)));
  return JSON.stringify({ state, listed, secrets: p.secrets.size, calls: p.host.calls.filter((c) => MUTATING.has(c.method)).length });
}

async function exitOf(fn: () => Promise<unknown>): Promise<number> {
  try {
    return ((await fn()) as { exitCode?: number }).exitCode ?? EXIT_CODES.ok;
  } catch (err) {
    return exitCodeFor(err);
  }
}

describe("teardown", () => {
  it("is a dry run without yes: it names every slot (orphans too) and what the elevated half removes, and changes nothing", async () => {
    const p = await pool({ "12sp9": 2, "23": 1 });
    await p.host.provisionSlot({ flavor: "35", slot: 4 });
    const before = await snapshot(p);
    let wrote = 0;
    const r = await teardownPool(p.deps, { yes: false, goldens: true }, async () => void wrote++);
    expect(r.exitCode).toBe(EXIT_CODES.ok);
    expect(r.slotsGone).toBe(true);
    expect(r.lines.filter((l) => l.startsWith("would destroy")).map((l) => l.split(":")[0])).toEqual([
      "would destroy 12sp9-01",
      "would destroy 12sp9-02",
      "would destroy 23-01",
      "would destroy 35-04",
    ]);
    expect(r.lines).toContain("  remove the goldens: C:\\aras_installations\\golden\\12sp9, C:\\aras_installations\\golden\\23, C:\\aras_installations\\golden\\35");
    expect(r.lines.at(-1)).toBe(DRY_RUN);
    expect(r.scriptSwitches).toEqual(["-Goldens"]);
    expect(wrote).toBe(0);
    expect(await snapshot(p)).toBe(before);
  });

  it("with yes, writes the bundle first and then destroys every slot and orphan, leaving no record and nothing on the host", async () => {
    const p = await pool({ "12sp9": 2, "23": 1 });
    await p.host.provisionSlot({ flavor: "35", slot: 4 });
    const order: string[] = [];
    const destroy = p.host.destroySlot.bind(p.host);
    p.host.destroySlot = async (ref) => {
      order.push(`destroy ${ref.flavor}-${ref.slot}`);
      return destroy(ref);
    };
    const r = await teardownPool(p.deps, { yes: true }, async () => void order.push("bundle"));
    expect(r.exitCode).toBe(EXIT_CODES.ok);
    expect(r.slotsGone).toBe(true);
    expect(order).toEqual(["bundle", "destroy 12sp9-1", "destroy 12sp9-2", "destroy 23-1", "destroy 35-4"]);
    expect(Object.keys((await p.store.read()).slots)).toEqual([]);
    expect((await p.host.listSlots()).slots).toEqual([]);
    expect(r.lines).not.toContain(DRY_RUN);
    expect(r.lines.some((l) => l.startsWith("destroyed 35-04: "))).toBe(true);
  });

  it("changes nothing when the bundle cannot be written", async () => {
    const p = await pool({ "23": 2 });
    const before = await snapshot(p);
    await expect(
      teardownPool(p.deps, { yes: true }, async () => {
        throw new Error("no Windows temp folder");
      }),
    ).rejects.toThrow("no Windows temp folder");
    expect(await snapshot(p)).toBe(before);
  });

  it("refuses while a slot is leased, unless every leased slot is named exactly, and then loses their leases", async () => {
    const p = await pool({ "23": 2, "12sp9": 1 });
    const a = await getLease(p.lease, { flavor: "23", holder: "task-a" });
    const b = await getLease(p.lease, { flavor: "12sp9", holder: "task-b" });
    const before = await snapshot(p);
    for (const yes of [false, true]) {
      await expect(teardownPool(p.deps, { yes })).rejects.toMatchObject({ exitCode: EXIT_CODES.refused, message: expect.stringContaining(`${b.slot} (to task-b), ${a.slot} (to task-a)`) });
      // Naming only one of them is not enough.
      await expect(teardownPool(p.deps, { yes, includeLeased: [a.slot] })).rejects.toMatchObject({ exitCode: EXIT_CODES.refused, message: expect.stringContaining(`${b.slot} (to task-b)`) });
      // Naming a slot that is not leased is a usage error, not a wider licence.
      expect(await exitOf(() => teardownPool(p.deps, { yes, includeLeased: [a.slot, b.slot, "23-02"] }))).toBe(EXIT_CODES.usage);
      expect(await exitOf(() => teardownPool(p.deps, { yes, includeLeased: [a.slot, b.slot, "35-09"] }))).toBe(EXIT_CODES.usage);
      expect(await exitOf(() => teardownPool(p.deps, { yes, includeLeased: ["OLM_Local"] }))).toBe(EXIT_CODES.refused);
      expect(await exitOf(() => teardownPool(p.deps, { yes, includeLeased: ["23"] }))).toBe(EXIT_CODES.usage);
    }
    expect(await snapshot(p)).toBe(before);

    const r = await teardownPool(p.deps, { yes: true, includeLeased: [b.slot, a.slot] });
    expect(r.exitCode).toBe(EXIT_CODES.ok);
    expect(Object.keys((await p.store.read()).slots)).toEqual([]);
    expect(await p.secrets.has(leaseSecretName(a.lease_id))).toBe(false);
    expect(await p.secrets.has(leaseSecretName(b.lease_id))).toBe(false);
  });

  it("counts an orphan whose stamp names a lease as leased", async () => {
    const p = await pool({});
    await p.host.provisionSlot({ flavor: "23", slot: 3 });
    const stamp = (await p.host.readStamp({ flavor: "23", slot: 3 })).stamp!;
    await p.host.writeStamp({ flavor: "23", slot: 3 }, { ...stamp, leaseId: "a".repeat(32) });
    await expect(teardownPool(p.deps, { yes: true })).rejects.toMatchObject({ exitCode: EXIT_CODES.refused, message: expect.stringContaining("23-03 (to") });
    expect((await teardownPool(p.deps, { yes: true, includeLeased: ["23-03"] })).exitCode).toBe(EXIT_CODES.ok);
    expect((await p.host.listSlots()).slots).toEqual([]);
  });

  it("refuses while a reset is running, before destroying anything", async () => {
    const p = await pool({ "23": 2 });
    await p.store.update((tx) => {
      tx.transition("23-02", { to: "dirty" });
      tx.transition("23-02", { to: "resetting", pid: MY_PID });
    });
    const before = await snapshot(p);
    await expect(teardownPool(p.deps, { yes: true })).rejects.toMatchObject({ exitCode: EXIT_CODES.refused, message: expect.stringContaining("23-02 (pid 4242)") });
    expect(await snapshot(p)).toBe(before);
    p.alive.delete(MY_PID);
    expect((await teardownPool(p.deps, { yes: true })).exitCode).toBe(EXIT_CODES.ok);
  });

  it("goes on past a slot the host fails to destroy, and says slots are left", async () => {
    const p = await pool({ "23": 3 });
    p.host.injectFault({ method: "destroySlot", kind: "fail", error: "Unreachable", slot: { flavor: "23", slot: 2 } });
    const r = await teardownPool(p.deps, { yes: true });
    expect(r.exitCode).toBe(EXIT_CODES.hostUnreachable);
    expect(r.slotsGone).toBe(false);
    expect(r.lines.find((l) => l.startsWith("23-02 not destroyed: "))).toBeDefined();
    expect((await p.host.listSlots()).slots.map((s) => s.slot.slot)).toEqual([2]);
    // A second run finds the orphan the failure left, and finishes it.
    const again = await teardownPool(p.deps, { yes: true });
    expect(again).toMatchObject({ exitCode: EXIT_CODES.ok, slotsGone: true });
    expect((await p.host.listSlots()).slots).toEqual([]);
  });

  it("with an empty pool, says so and still plans the elevated half", async () => {
    const p = await pool({});
    const r = await teardownPool(p.deps, { yes: true, keepSql: true });
    expect(r.lines[0]).toBe("no slot in the pool or on the host");
    expect(r.lines).toContain("  keep arashouse_admin and the broker's SQL login (--keep-sql)");
    expect(r.scriptSwitches).toEqual(["-KeepSql"]);
  });
});

describe("teardown options", () => {
  it("map to the script's switches, and refuse combinations that do not go together", () => {
    expect(teardownSwitches({})).toEqual([]);
    expect(teardownSwitches({ goldens: true, removeRoot: true })).toEqual(["-Goldens", "-RemoveRoot"]);
    expect(teardownSwitches({ keepSql: true, goldens: true })).toEqual(["-Goldens", "-KeepSql"]);
    expect(() => teardownSwitches({ removeRoot: true })).toThrow("--remove-root removes golden\\ too");
    expect(() => teardownSwitches({ removeRoot: true, goldens: true, keepSql: true })).toThrow("it cannot go with --keep-sql");
  });

  it("plan the SQL drop unless kept, and the root only when asked", () => {
    const plain = elevatedPlan({}).join("\n");
    expect(plain).toContain("drop arashouse_admin");
    expect(plain).toContain("keep the goldens");
    expect(plain).not.toContain("install root");
    expect(elevatedPlan({ goldens: true, removeRoot: true }).join("\n")).toContain("remove the install root, if it holds only arashouse folders");
  });
});

it("is refused from a fake host error kind the same way destroy is (Refused is exit 7)", async () => {
  const p = await pool({ "23": 1 });
  p.host.destroySlot = async () => {
    throw new HostError("Refused", "refused path");
  };
  const r = await teardownPool(p.deps, { yes: true });
  expect(r.exitCode).toBe(EXIT_CODES.refused);
});
