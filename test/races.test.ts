// Ticket 38's races, offline: several `arashouse` processes at once on the v1 pool (`12sp9` x3, `23` x2, `35` x2)
// against the fake host (`ARASHOUSE_HOST=fake`), sharing only the state file and its lock, as workers on the laptop
// share it. Each process rebuilds its fake host from the state; a slow fault takes real time there (`LiveClock`), so
// the resets of several reset workers overlap. The same scenarios run on the host in test/host/capacity.ts; the
// results of both are in docs/capacity.md, which also says how these were run ten times in a row.

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { EXIT_CODES } from "../src/core/exit-codes.js";
import type { FlavorKey } from "../src/core/flavors.js";
import { StateStore, type StoreEvent } from "../src/core/store.js";
import { fakeGoldenHash } from "../src/host/fake.js";
import { repoRoot } from "./helpers.js";

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Grant {
  readonly slot: string;
  readonly lease_id: string;
}

/** The built CLI, in a folder of its own: test/cli.test.ts builds `dist/` at the same time. */
let build: string;
let BIN: string;
let home: string;

beforeAll(async () => {
  build = await mkdtemp(join(tmpdir(), "arashouse-races-build-"));
  const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  await promisify(execFile)(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", join(build, "dist")], { cwd: repoRoot });
  // The CLI reads its version from ../../package.json, which also makes its .js files ES modules.
  await copyFile(join(repoRoot, "package.json"), join(build, "package.json"));
  BIN = join(build, "dist", "cli", "index.js");
}, 180_000);

afterAll(async () => {
  await rm(build, { recursive: true, force: true });
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "arashouse-races-"));
  await seed(DEFAULT_CONFIG.slots_per_flavor);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** The pool, every slot free and reset from its flavor's golden. */
async function seed(spec: Readonly<Partial<Record<FlavorKey, number>>>): Promise<void> {
  const store = new StateStore({ home });
  await store.update((tx) => {
    for (const [flavor, count] of Object.entries(spec) as [FlavorKey, number][]) {
      for (let n = 1; n <= count; n++) {
        const slot = tx.addSlot({ flavor, slot: n });
        tx.transition(slot.id, { to: "free", golden_hash: fakeGoldenHash(flavor), reset_ms: 1500 });
      }
    }
  });
}

/** One process of the CLI; reset workers on unless `env` turns them off. `pid` is known at once, `done` at its end. */
function start(args: readonly string[], env: NodeJS.ProcessEnv = {}): { pid: number; done: Promise<Result> } {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { PATH: process.env.PATH, HOME: home, ARASHOUSE_HOME: home, ARASHOUSE_HOST: "fake", ARASHOUSE_MEDIA: join(home, "media"), ARASHOUSE_WINDOWS_NODE: join(home, "no-node.exe"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  const done = new Promise<Result>((resolve) =>
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    }),
  );
  return { pid: child.pid ?? 0, done };
}

const cli = (args: readonly string[], env: NodeJS.ProcessEnv = {}) => start(args, env).done;

const NO_WORKER = { ARASHOUSE_RESET_WORKER: "off" };

const grantOf = (r: Result): Grant => JSON.parse(r.stdout) as Grant;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const state = () => new StateStore({ home }).read();

const events = () => new StateStore({ home }).events();

/** Polls the state until `done` holds, or fails after `ms`. */
async function until(what: string, done: (s: Awaited<ReturnType<typeof state>>) => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (done(await state())) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}: ${JSON.stringify(Object.values((await state()).slots).map((s) => `${s.id} ${s.status}`))}`);
    await sleep(100);
  }
}

const statuses = (s: Awaited<ReturnType<typeof state>>) => Object.values(s.slots).map((slot) => slot.status);

/** Replays the transitions in commit order: the most resets running at once, and whether a slot waited dirty meanwhile. */
function resetConcurrency(log: readonly StoreEvent[]): { peak: number; dirtyAtPeak: boolean } {
  const now = new Map<string, string>();
  let peak = 0;
  let dirtyAtPeak = false;
  for (const e of log) {
    if (e.event !== "transition" || !e.slot || !e.to) continue;
    now.set(e.slot, e.to);
    const running = [...now.values()].filter((s) => s === "resetting").length;
    const dirty = [...now.values()].some((s) => s === "dirty");
    if (running > peak) [peak, dirtyAtPeak] = [running, dirty];
    else if (running === peak && dirty) dirtyAtPeak = true;
  }
  return { peak, dirtyAtPeak };
}

/**
 * The slot's transitions since its lease by `returned` ended: the return, a reset that ended `free`, then the lease to
 * `holder`, last. (A process's fake host is built from the state when it starts, so a `get` that started while the slot
 * was leased finds its stamp unclean and resets it once more; on the host the stamp is one, and that does not happen.)
 */
function resetBeforeLease(log: readonly StoreEvent[], slot: string, returned: string, holder: string): string[] {
  const mine = log.filter((e) => e.event === "transition" && e.slot === slot);
  const ended = mine.findIndex((e) => e.from === "leased" && e.lease === returned.slice(0, 8));
  return mine.slice(ended).map((e) => `${e.from}->${e.to}${e.to === "leased" ? ` ${e.holder}` : ""}`);
}

/** Each step of a reset takes this long in real time, so three resets started together overlap. */
const SLOW = JSON.stringify((["resetDatabase", "resetTree"] as const).map((method) => ({ method, kind: "slow", ms: 1500, times: 1000 })));

describe("races between processes on the v1 pool (ticket 38, the fake host)", () => {
  it.each([
    ["three flavors", ["12sp9", "23", "35", "12sp9"], `max_active ${DEFAULT_CONFIG.max_active} reached (3 leased)`],
    ["one flavor", ["12sp9", "12sp9", "12sp9", "12sp9"], "no 12sp9 slot is free: 3 slots, 3 leased"],
  ] as const)("four gets at once (%s): three distinct slots, and the fourth exits 3", { timeout: 120_000 }, async (_name, flavors, reason) => {
    const runs = await Promise.all(flavors.map((flavor, i) => cli(["get", flavor, "--holder", `proc-${i}`, "--json"], NO_WORKER)));
    const granted = runs.filter((r) => r.code === 0).map(grantOf);
    const refused = runs.filter((r) => r.code !== 0);
    expect(granted).toHaveLength(3);
    expect(new Set(granted.map((g) => g.slot)).size).toBe(3);
    expect(new Set(granted.map((g) => g.lease_id)).size).toBe(3);
    expect(refused.map((r) => r.code)).toEqual([EXIT_CODES.noSlot]);
    expect(refused[0]!.stderr).toContain(reason);
    const leased = Object.values((await state()).slots).filter((s) => s.status === "leased");
    expect(leased.map((s) => s.lease?.lease_id).sort()).toEqual(granted.map((g) => g.lease_id).sort());
  });

  it("a fourth get --wait queues behind three leases and takes the returned slot once its reset ends", { timeout: 120_000 }, async () => {
    const grants = (await Promise.all([0, 1, 2].map((i) => cli(["get", "12sp9", "--holder", `proc-${i}`, "--json"], NO_WORKER)))).map(grantOf);
    const waiter = start(["get", "12sp9", "--holder", "waiter", "--wait", "60", "--json"], { ...NO_WORKER, ARASHOUSE_FAKE_FAULTS: SLOW });
    await until("the fourth get is in the queue", (s) => s.queue.some((w) => w.holder === "waiter"));
    const returned = grants[1]!;
    expect((await cli(["return", returned.lease_id, "--quiet"], { ARASHOUSE_FAKE_FAULTS: SLOW })).code).toBe(0);
    const r = await waiter.done;
    expect(r.code, r.stderr).toBe(0);
    expect(grantOf(r).slot).toBe(returned.slot);
    // In commit order: the return, then the end of the slot's reset, then the waiter's lease.
    const steps = resetBeforeLease(await events(), returned.slot, returned.lease_id, "waiter");
    expect(steps[0]).toBe("leased->dirty");
    expect(steps.slice(-2)).toEqual(["resetting->free", "free->leased waiter"]);
    expect((await state()).queue).toEqual([]);
  });

  it("returning three at once runs at most max_resets resets; the third waits dirty, a get during the burst gets a clean slot, and every slot ends free", { timeout: 120_000 }, async () => {
    const grants = (await Promise.all([0, 1, 2].map((i) => cli(["get", "12sp9", "--holder", `proc-${i}`, "--json"], NO_WORKER)))).map(grantOf);
    const env = { ARASHOUSE_FAKE_FAULTS: SLOW };
    const [returns, during] = await Promise.all([
      Promise.all(grants.map((g) => cli(["return", g.lease_id, "--quiet"], env))),
      sleep(300).then(() => cli(["get", "12sp9", "--holder", "during", "--wait", "60", "--json"], env)),
    ]);
    expect(returns.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(during.code, during.stderr).toBe(0);
    const got = grantOf(during);
    await until("the burst is over", (s) => statuses(s).every((x) => x === "free" || x === "leased"));

    const log = await events();
    const { peak, dirtyAtPeak } = resetConcurrency(log);
    expect(peak).toBe(DEFAULT_CONFIG.max_resets);
    expect(dirtyAtPeak).toBe(true);
    // The slot the burst's get took was reset after its last lease ended, before it was leased again.
    const before = grants.find((g) => g.slot === got.slot)!;
    const steps = resetBeforeLease(log, got.slot, before.lease_id, "during");
    expect(steps[0]).toBe("leased->dirty");
    expect(steps.slice(-2)).toEqual(["resetting->free", "free->leased during"]);

    expect((await cli(["return", got.lease_id, "--quiet", "--wait=60"], env)).code).toBe(0);
    const after = await state();
    expect(statuses(after).every((s) => s === "free")).toBe(true);
    const doctor = await cli(["doctor"], NO_WORKER);
    expect(doctor.code, doctor.stdout).toBe(0);
    for (const id of Object.keys(after.slots)) expect(doctor.stdout).toContain(`ok    slot ${id}: free and clean`);
  });

  it("a reset whose worker died, and a host that went away while a lease was held: doctor --fix makes the pool consistent and keeps the lease", { timeout: 120_000 }, async () => {
    const [kept, cut] = (await Promise.all(["kept", "cut"].map((holder) => cli(["get", "12sp9", "--holder", holder, "--json"], NO_WORKER)))).map(grantOf);
    // The reset never hears back from the host (the broker died under it), and its worker is killed in the middle.
    const hang = JSON.stringify([{ method: "resetDatabase", kind: "hang" }]);
    expect((await cli(["return", cut!.lease_id, "--quiet"], { ARASHOUSE_FAKE_FAULTS: hang })).code).toBe(0);
    await until("the reset worker is in the reset", (s) => s.slots[cut!.slot]?.status === "resetting");
    const pid = (await state()).slots[cut!.slot]!.reset!.pid;
    // A hung call holds no timer, so the worker's process may already have ended by itself: dead either way.
    try {
      process.kill(pid, "SIGKILL");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }

    // The host is gone: doctor says so, fixes nothing it cannot reach, and the lease is untouched.
    const down = await cli(["doctor", "--fix"], { ...NO_WORKER, ARASHOUSE_HOST: "" });
    expect(down.code).toBe(1);
    expect(down.stdout).toContain("fail  broker: did not answer");
    expect((await cli(["get", "12sp9", "--holder", "x"], { ...NO_WORKER, ARASHOUSE_HOST: "" })).code).toBe(EXIT_CODES.hostUnreachable);
    const held = (await state()).slots[kept!.slot];
    expect([held?.status, held?.lease?.lease_id, held?.lease?.holder]).toEqual(["leased", kept!.lease_id, "kept"]);

    // The host is back: doctor --fix restarts the dead reset, and the lease is still the same one.
    const fixed = await cli(["doctor", "--fix", "--yes"]);
    expect(fixed.stdout).toContain(cut!.slot);
    await until("the cut slot is free again", (s) => s.slots[cut!.slot]?.status === "free");
    const after = (await state()).slots[kept!.slot];
    expect([after?.status, after?.lease?.lease_id, after?.lease?.holder]).toEqual(["leased", kept!.lease_id, "kept"]);
    const ran = await cli(["run", "--lease", kept!.lease_id, "--", process.execPath, "-e", "process.exit(process.env.ARASHOUSE_SLOT ? 0 : 1)"], NO_WORKER);
    expect(ran.code, ran.stderr).toBe(0);
    const clean = await cli(["doctor"], NO_WORKER);
    expect(clean.code, clean.stdout).toBe(0);
    expect(clean.stdout).toContain(`ok    slot ${cut!.slot}: free and clean`);
    expect((await cli(["return", kept!.lease_id, "--quiet", "--wait=60"])).code).toBe(0);
  });
});
