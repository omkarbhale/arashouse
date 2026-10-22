import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockTimeoutError, acquireLock } from "./lock.js";
import { IllegalTransitionError, StateCorruptError, emptyState, newSlot, serialiseState } from "./state.js";
import { HOME_ENV, StateStore, resolveStorePaths, writeFileAtomic } from "./store.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "arashouse-store-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const slot = { flavor: "23", slot: 1 } as const;

/** Runs test/fixtures/state-worker.ts to completion (or its death) in a child process. */
function worker(env: Record<string, string>): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  const child: ChildProcess = spawn(
    process.execPath,
    [join(repoRoot, "node_modules/vite-node/vite-node.mjs"), join(repoRoot, "test/fixtures/state-worker.ts")],
    { cwd: repoRoot, env: { ...process.env, ST_HOME: home, ...env }, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, stderr })));
}

describe("where the state lives", () => {
  it("defaults to ~/.arashouse and honours ARASHOUSE_HOME", () => {
    expect(resolveStorePaths({}).home.endsWith(".arashouse")).toBe(true);
    const paths = resolveStorePaths({ [HOME_ENV]: "/x/y" });
    expect(paths).toEqual({ home: "/x/y", state: "/x/y/state.json", lock: "/x/y/state.lock", events: "/x/y/events.log" });
  });

  it("refuses a relative home", () => {
    expect(() => resolveStorePaths({ [HOME_ENV]: "state" })).toThrow(/absolute/);
  });
});

describe("StateStore", () => {
  it("reads an empty pool when there is no file, and does not create one", async () => {
    const store = new StateStore({ home });
    expect((await store.read()).slots).toEqual({});
    expect(existsSync(store.paths.state)).toBe(false);
  });

  it("commits an update atomically, with a revision and an event per transition", async () => {
    const store = new StateStore({ home, newLeaseId: () => "ab".repeat(16) });
    await store.update((tx) => {
      tx.addSlot(slot);
      tx.transition("23-01", { to: "free", golden_hash: "g", reset_ms: 10 });
      tx.transition("23-01", { to: "leased", holder: "task-9" });
    });
    const state = await store.read();
    expect(state.revision).toBe(1);
    expect(state.slots["23-01"]).toMatchObject({ status: "leased", lease: { lease_id: "ab".repeat(16), holder: "task-9" } });
    const events = await store.events();
    expect(events.map((e) => [e.event, e.slot, e.from, e.to])).toEqual([
      ["transition", "23-01", null, "provisioning"],
      ["transition", "23-01", "provisioning", "free"],
      ["transition", "23-01", "free", "leased"],
    ]);
    // The lease id is a bearer token for `return --if-lease-id`: the log keeps only its prefix.
    expect(events[2]).toMatchObject({ lease: "abababab", holder: "task-9" });
    expect(await readFile(store.paths.events, "utf8")).not.toContain("ab".repeat(16));
  });

  it("writes nothing when the callback throws, and nothing when it changes nothing", async () => {
    const store = new StateStore({ home });
    await store.update((tx) => void tx.addSlot(slot));
    await expect(
      store.update((tx) => {
        tx.transition("23-01", { to: "free", golden_hash: "g", reset_ms: 1 });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await store.update(() => undefined);
    const state = await store.read();
    expect(state.revision).toBe(1);
    expect(state.slots["23-01"]?.status).toBe("provisioning");
    expect(await store.events()).toHaveLength(1);
  });

  it("throws an illegal transition without writing", async () => {
    const store = new StateStore({ home });
    await store.update((tx) => {
      tx.addSlot(slot);
      tx.transition("23-01", { to: "free", golden_hash: "g", reset_ms: 1 });
    });
    await expect(store.update((tx) => tx.transition("23-01", { to: "resetting", pid: 5 }))).rejects.toThrow(IllegalTransitionError);
    expect((await store.read()).slots["23-01"]?.status).toBe("free");
  });

  it("refuses an unknown slot and a duplicate add", async () => {
    const store = new StateStore({ home });
    await expect(store.update((tx) => tx.transition("23-01", { to: "dirty" }))).rejects.toThrow(/no slot/);
    await store.update((tx) => void tx.addSlot(slot));
    await expect(store.update((tx) => void tx.addSlot(slot))).rejects.toThrow(/already exists/);
  });

  it("keeps the state file private to its owner", async () => {
    const store = new StateStore({ home });
    await store.update((tx) => void tx.addSlot(slot));
    expect((await stat(store.paths.state)).mode & 0o077).toBe(0);
    expect((await stat(store.paths.events)).mode & 0o077).toBe(0);
  });

  it("reports a corrupt file instead of treating it as an empty pool", async () => {
    const store = new StateStore({ home });
    await writeFile(store.paths.state, "{\"version\": 1, ");
    await expect(store.read()).rejects.toThrow(StateCorruptError);
    await expect(store.update(() => undefined)).rejects.toThrow(StateCorruptError);
  });

  it("replaces a corrupt file, setting it aside and logging why", async () => {
    const store = new StateStore({ home });
    await writeFile(store.paths.state, "garbage");
    const rebuilt = { ...emptyState(), slots: { "23-01": newSlot(slot) } };
    const next = await store.replace(rebuilt, "doctor --rebuild-state");
    expect(next.revision).toBe(1);
    expect((await store.read()).slots["23-01"]?.status).toBe("provisioning");
    const aside = (await readdir(home)).filter((n) => n.startsWith("state.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(home, aside[0] ?? ""), "utf8")).toBe("garbage");
    expect((await store.events()).at(-1)).toMatchObject({ event: "state-replaced", reason: "doctor --rebuild-state" });
  });
});

describe("concurrent writers", () => {
  it("lose no update: two processes, 200 transitions each", { timeout: 120_000 }, async () => {
    const store = new StateStore({ home });
    await store.update((tx) => {
      tx.addSlot(slot);
      tx.transition("23-01", { to: "free", golden_hash: "g", reset_ms: 1 });
    });
    const results = await Promise.all([worker({ ST_MODE: "cycle", ST_COUNT: "200" }), worker({ ST_MODE: "cycle", ST_COUNT: "200" })]);
    for (const r of results) expect(r).toMatchObject({ code: 0, signal: null, stderr: "" });

    const state = await store.read();
    // One commit for the setup and one per transition: a lost update would repeat a revision.
    expect(state.revision).toBe(1 + 400);
    // 400 moves around the four-step cycle free -> leased -> dirty -> resetting -> free.
    expect(state.slots["23-01"]?.status).toBe("free");
    const events = await store.events();
    expect(events.filter((e) => e.event === "transition")).toHaveLength(2 + 400);
    expect(events.filter((e) => e.event.startsWith("lock-"))).toEqual([]);
    expect(new Set(events.map((e) => e.pid)).size).toBe(3);
    expect(existsSync(store.paths.lock)).toBe(false);
  });

  it("serialise updates inside one process too", async () => {
    const store = new StateStore({ home });
    await store.update((tx) => void tx.addSlot(slot));
    await Promise.all(
      Array.from({ length: 25 }, async () => {
        await store.update((tx) => {
          const s = tx.slot("23-01");
          if (s?.status === "provisioning" || s?.status === "resetting") {
            tx.transition("23-01", { to: "free", golden_hash: "g", reset_ms: 1 });
          } else if (s?.status === "free") tx.transition("23-01", { to: "dirty" });
          else tx.transition("23-01", { to: "resetting", pid: 7 });
        });
      }),
    );
    expect((await store.read()).revision).toBe(26);
  });
});

describe("a crash between the temp write and the rename", () => {
  it("leaves the old file readable (the write fails in process)", async () => {
    const good = new StateStore({ home });
    await good.update((tx) => void tx.addSlot(slot));
    const before = await readFile(good.paths.state, "utf8");
    const flaky = new StateStore({
      home,
      beforeRename: async (tmp) => {
        expect(await readFile(tmp, "utf8")).toContain("12sp9-01");
        throw new Error("power cut");
      },
    });
    await expect(flaky.update((tx) => void tx.addSlot({ flavor: "12sp9", slot: 1 }))).rejects.toThrow("power cut");
    expect(await readFile(good.paths.state, "utf8")).toBe(before);
    expect((await good.read()).slots["12sp9-01"]).toBeUndefined();
    expect((await readdir(home)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(good.paths.lock)).toBe(false);
  });

  it("leaves the old file readable when the process is killed there, and the next update recovers", { timeout: 60_000 }, async () => {
    const store = new StateStore({ home });
    await store.update((tx) => void tx.addSlot(slot));
    const before = await readFile(store.paths.state, "utf8");

    const crashed = await worker({ ST_MODE: "crash" });
    expect(crashed.signal).toBe("SIGKILL");

    // The wreckage: the old state untouched, a stale temp file and the dead writer's lock.
    expect(await readFile(store.paths.state, "utf8")).toBe(before);
    expect((await store.read()).slots["12sp9-01"]).toBeUndefined();
    expect((await readdir(home)).some((n) => n.startsWith("state.json.") && n.endsWith(".tmp"))).toBe(true);
    expect(existsSync(store.paths.lock)).toBe(true);

    // The next writer steals the dead pid's lock, logs it, sweeps the temp file and carries on.
    await store.update((tx) => void tx.addSlot({ flavor: "35", slot: 2 }));
    const state = await store.read();
    expect(Object.keys(state.slots).sort()).toEqual(["23-01", "35-02"]);
    expect((await readdir(home)).filter((n) => n.endsWith(".tmp") || n.includes(".stale-"))).toEqual([]);
    expect((await store.events()).filter((e) => e.event === "lock-stolen")).toHaveLength(1);
  });

  it("writeFileAtomic replaces the file whole", async () => {
    const path = join(home, "f.json");
    await writeFileAtomic(path, "one");
    await writeFileAtomic(path, "two");
    expect(await readFile(path, "utf8")).toBe("two");
  });
});

describe("the lock", () => {
  const lockPath = () => join(home, "state.lock");
  const deadHolder = (pid: number) =>
    JSON.stringify({ pid, token: "dead-token", acquired_at: "2026-10-22T08:00:00.000Z", start_time: null });

  it("steals a lock held by a dead pid, and logs the steal", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(lockPath(), deadHolder(2_000_000_000));
    const store = new StateStore({ home });
    await store.update((tx) => void tx.addSlot(slot));
    expect(existsSync(lockPath())).toBe(false);
    const stolen = (await store.events()).filter((e) => e.event === "lock-stolen");
    expect(stolen).toEqual([expect.objectContaining({ held_by: 2_000_000_000 })]);
  });

  it("steals an unreadable lock", async () => {
    await writeFile(lockPath(), "not json");
    const store = new StateStore({ home });
    await store.update((tx) => void tx.addSlot(slot));
    expect((await store.events()).filter((e) => e.event === "lock-stolen")).toHaveLength(1);
  });

  it("steals a lock whose pid now belongs to another process (pid reuse)", async () => {
    await writeFile(
      lockPath(),
      JSON.stringify({ pid: process.pid, token: "old", acquired_at: "2026-10-22T08:00:00.000Z", start_time: "1" }),
    );
    const store = new StateStore({ home });
    await store.update((tx) => void tx.addSlot(slot));
    expect((await store.events()).filter((e) => e.event === "lock-stolen")).toHaveLength(1);
  });

  it("never steals a lock held by a live pid: it waits, then times out", async () => {
    const holder = await acquireLock(lockPath());
    const store = new StateStore({ home, lockTimeoutMs: 150, lockPollMs: 5 });
    await expect(store.update((tx) => void tx.addSlot(slot))).rejects.toThrow(LockTimeoutError);
    expect(existsSync(lockPath())).toBe(true);
    expect((await store.events()).filter((e) => e.event === "lock-stolen")).toEqual([]);
    await holder.release();
    await store.update((tx) => void tx.addSlot(slot));
  });

  it("a waiter proceeds as soon as the holder releases", async () => {
    const holder = await acquireLock(lockPath());
    const store = new StateStore({ home, lockPollMs: 5 });
    const waiting = store.update((tx) => void tx.addSlot(slot));
    await new Promise((r) => setTimeout(r, 60));
    await holder.release();
    await waiting;
    expect((await store.read()).slots["23-01"]).toBeDefined();
  });

  it("concurrent thieves of one dead lock never leave two holders", async () => {
    await writeFile(lockPath(), JSON.stringify({ pid: 999_999_999, token: "dead", acquired_at: "x", start_time: null }));
    const deadOnly = (info: { token: string }) => info.token !== "dead";
    for (let round = 0; round < 20; round++) {
      let inside = 0;
      let overlap = false;
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          const held = await acquireLock(lockPath(), { isAlive: deadOnly, pollMs: 1 });
          inside++;
          if (inside > 1) overlap = true;
          await new Promise((r) => setTimeout(r, 2));
          inside--;
          await held.release();
        }),
      );
      expect(overlap).toBe(false);
      await writeFile(lockPath(), JSON.stringify({ pid: 999_999_999, token: "dead", acquired_at: "x", start_time: null }));
    }
    expect((await readdir(home)).filter((n) => n.endsWith(".steal") || n.endsWith(".tmp"))).toEqual([]);
  });

  it("a thief whose stale observation was overtaken leaves the new live lock in place", async () => {
    const dead = { pid: 999_999_999, token: "dead", acquired_at: "x", start_time: null };
    const live = { ...dead, token: "live" };
    await writeFile(lockPath(), JSON.stringify(dead));
    let overtaken = false;
    const isAlive = (info: { token: string }) => {
      if (!overtaken) {
        overtaken = true;
        unlinkSync(lockPath());
        writeFileSync(lockPath(), JSON.stringify(live));
      }
      return info.token !== "dead";
    };
    await expect(acquireLock(lockPath(), { isAlive, timeoutMs: 50, pollMs: 5 })).rejects.toBeInstanceOf(LockTimeoutError);
    expect(JSON.parse(await readFile(lockPath(), "utf8")).token).toBe("live");
  });

  it("a thief leaves a live lock that reused the stale lock's inode", async () => {
    const dead = { pid: 999_999_999, token: "dead", acquired_at: "x", start_time: null };
    await writeFile(lockPath(), JSON.stringify(dead));
    let overtaken = false;
    const isAlive = (info: { token: string }) => {
      if (!overtaken) {
        overtaken = true;
        writeFileSync(lockPath(), JSON.stringify({ ...dead, token: "live" }));
      }
      return info.token !== "dead";
    };
    await expect(acquireLock(lockPath(), { isAlive, timeoutMs: 50, pollMs: 5 })).rejects.toBeInstanceOf(LockTimeoutError);
    expect(JSON.parse(await readFile(lockPath(), "utf8")).token).toBe("live");
  });

  it("release leaves a lock that is no longer ours", async () => {
    const mine = await acquireLock(lockPath(), { isAlive: () => false });
    const theirs = await acquireLock(lockPath(), { isAlive: () => false }); // judges mine dead and steals it
    await mine.release();
    expect(existsSync(lockPath())).toBe(true);
    await theirs.release();
    expect(existsSync(lockPath())).toBe(false);
  });
});

describe("no secrets in the files", () => {
  it("writes none of a lease's surroundings to the state file or the event log", async () => {
    // Assembled from parts so this file holds no secret-shaped literal.
    const canary = ["hunter", "2-canary-", "pw"].join("");
    const store = new StateStore({ home });
    await store.update((tx) => {
      tx.addSlot(slot);
      tx.transition("23-01", { to: "free", golden_hash: "g", reset_ms: 1 });
      const leased = tx.transition("23-01", { to: "leased", holder: "task-7" });
      Object.assign(leased.lease ?? {}, { password: canary });
      Object.assign(leased, { aras_password: canary });
    });
    expect(serialiseState(await store.read())).not.toContain(canary);
    for (const name of await readdir(home)) {
      expect(await readFile(join(home, name), "utf8").catch(() => "")).not.toContain(canary);
    }
  });
});
