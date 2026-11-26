import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Secret } from "../core/secret.js";
import { LeaseFileStore } from "../core/lease-files.js";
import { StateStore } from "../core/store.js";
import { leaseSecretName } from "../core/lease.js";
import { migrateState } from "./migrate.js";

let dir: string;
let from: string;
let to: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arashouse-migrate-"));
  from = join(dir, "wsl", ".arashouse");
  to = join(dir, "windows", "arashouse");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** WSL's state as an earlier build left it: two slots, one leased with its password file, a config, a log and a recipe. */
async function oldPool(): Promise<{ leaseId: string }> {
  const store = new StateStore({ home: from });
  const lease = await store.update((tx) => {
    for (const n of [1, 2]) {
      const s = tx.addSlot({ flavor: "23", slot: n });
      tx.transition(s.id, { to: "free", golden_hash: "g", reset_ms: 1 });
    }
    return tx.transition("23-01", { to: "leased", holder: "kept" }).lease!;
  });
  await new LeaseFileStore(from).put(leaseSecretName(lease.lease_id), Secret.of(["held", "password"].join("-"), "lease-password"));
  writeFileSync(join(from, "config.json"), JSON.stringify({ max_active: 4 }));
  mkdirSync(join(from, "logs"), { recursive: true });
  writeFileSync(join(from, "logs", `${lease.lease_id}-import-1.log`), "log");
  mkdirSync(join(from, "recipes"), { recursive: true });
  writeFileSync(join(from, "recipes", "r.json"), "{}");
  return { leaseId: lease.lease_id };
}

const request = (extra: { yes?: boolean; busyOk?: boolean } = {}) => ({ from, to, toShown: "C:\\Users\\me\\AppData\\Local\\arashouse", yes: false, busyOk: false, ...extra });

describe("migrate-state", () => {
  it("plans without --yes, naming the leases it carries, and changes nothing", async () => {
    await oldPool();
    const r = await migrateState(request());
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/2 slots \(1 leased: 23-01 to kept\), 0 resetting, 0 waiting/);
    expect(r.lines.at(-1)).toMatch(/dry run: nothing was changed/);
    expect(existsSync(to)).toBe(false);
    expect(existsSync(join(from, "state.json"))).toBe(true);
  });

  it("moves the state, the leases' passwords, the config, logs and recipes, and sets WSL's aside", async () => {
    const { leaseId } = await oldPool();
    const before = readFileSync(join(from, "state.json"), "utf8");
    const r = await migrateState({ ...request({ yes: true }), now: () => new Date("2026-11-26T12:00:00Z") });
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(readFileSync(join(to, "state.json"), "utf8")).toBe(before);
    expect((await new LeaseFileStore(to).get(leaseSecretName(leaseId)))?.reveal()).toBe(["held", "password"].join("-"));
    expect(JSON.parse(readFileSync(join(to, "config.json"), "utf8"))).toEqual({ max_active: 4 });
    expect(readdirSync(join(to, "logs"))).toEqual([`${leaseId}-import-1.log`]);
    expect(readdirSync(join(to, "recipes"))).toEqual(["r.json"]);
    expect(existsSync(join(to, "events.log"))).toBe(true);
    // WSL's is set aside, never deleted: an earlier build sees no pool, the launcher runs.
    expect(existsSync(join(from, "state.json"))).toBe(false);
    expect(existsSync(join(from, "leases"))).toBe(false);
    expect(readdirSync(from).sort()).toEqual(expect.arrayContaining(["state.json.moved-to-windows-2026-11-26T12-00-00-000Z", "leases.moved-to-windows-2026-11-26T12-00-00-000Z"]));
    expect(existsSync(join(from, "state.lock"))).toBe(false);
    // The moved pool reads as the same pool.
    expect((await new StateStore({ home: to }).read()).slots["23-01"]?.lease?.holder).toBe("kept");
    expect(r.lines.join("\n")).not.toContain(["held", "password"].join("-"));
  });

  it("refuses a Windows home that holds a state already, and a WSL home that has none", async () => {
    await oldPool();
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, "state.json"), "{}");
    expect((await migrateState(request({ yes: true }))).lines[0]).toMatch(/already holds a state\.json/);
    expect(existsSync(join(from, "state.json"))).toBe(true);
    rmSync(join(from, "state.json"));
    expect((await migrateState(request({ yes: true }))).lines[0]).toMatch(/there is no state to move/);
  });

  it("refuses a pool with a reset running or a waiter queued, unless told --busy-ok", async () => {
    await oldPool();
    await new StateStore({ home: from }).update((tx) => {
      tx.transition("23-02", { to: "dirty" });
      tx.transition("23-02", { to: "resetting", pid: 4242 });
    });
    const refused = await migrateState(request({ yes: true }));
    expect(refused.code).toBe(1);
    expect(refused.lines.at(-1)).toMatch(/refused: 23-02 is being reset by a WSL process; wait for the pool to be quiet, or give --yes --busy-ok/);
    expect(existsSync(to)).toBe(false);
    expect((await migrateState(request({ yes: true, busyOk: true }))).code).toBe(0);
    expect(existsSync(join(to, "state.json"))).toBe(true);
  });
});
