import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isResetWorkerAlive } from "./governor.js";
import {
  type BeaconSystem,
  type LockInfo,
  acquireLock,
  beaconName,
  beaconOf,
  isBusy,
  isPidAlive,
  isProcessAlive,
  listPipes,
  processStartTime,
  retryBusy,
  startBeacon,
} from "./lock.js";

/** A beacon system in memory: what `listen` started is listed until `end` takes it away. */
function memoryBeacons(): BeaconSystem & { readonly pipes: Set<string>; end(name: string): void } {
  const pipes = new Set<string>();
  return {
    pipes,
    listPipes: () => new Set(pipes),
    listen: (name) => void pipes.add(name),
    end: (name) => void pipes.delete(name),
  };
}

const info = (pid: number, startTime: string | null): LockInfo => ({ pid, token: "t", acquired_at: "2026-11-26T00:00:00.000Z", start_time: startTime });

describe("liveness on Windows: the beacon", () => {
  it("records pipe:<token> for this process, its pipe started first", () => {
    const beacons = memoryBeacons();
    const start = processStartTime(process.pid, { platform: "win32", beacons });
    expect(start).toMatch(/^pipe:[0-9a-f]{16}$/);
    expect([...beacons.pipes]).toEqual([beaconName(process.pid, start!.slice(5))]);
  });

  it("refuses to go on when the pipe does not start, so this process never holds a lock it cannot be told alive by", () => {
    expect(() => startBeacon({ listPipes: () => new Set(), listen: () => undefined }, 1234)).toThrow(/liveness beacon/);
  });

  it("reads another process's beacon from the listing, or null when it has none", () => {
    const beacons = memoryBeacons();
    beacons.listen(beaconName(4242, "abc"));
    beacons.listen("arashouse-broker");
    expect(processStartTime(4242, { platform: "win32", beacons })).toBe("pipe:abc");
    expect(processStartTime(4243, { platform: "win32", beacons })).toBeNull();
    expect(beaconOf(42, beacons.listPipes())).toBeNull();
  });

  it("judges a holder alive while its beacon is listed, and dead the moment it is gone or its pid was reused", () => {
    const beacons = memoryBeacons();
    const own = processStartTime(process.pid, { platform: "win32", beacons })!;
    const holder = info(process.pid, own);
    expect(isProcessAlive(holder, { platform: "win32", beacons })).toBe(true);
    // The same pid with another beacon: a new process that reused the pid.
    expect(isProcessAlive(info(process.pid, "pipe:0000000000000000"), { platform: "win32", beacons })).toBe(false);
    beacons.end(beaconName(process.pid, own.slice(5)));
    expect(isProcessAlive(holder, { platform: "win32", beacons })).toBe(false);
  });

  it("judges a record without a beacon dead (an older build's, or a Linux start time)", () => {
    const beacons = memoryBeacons();
    expect(isProcessAlive(info(process.pid, null), { platform: "win32", beacons })).toBe(false);
    expect(isProcessAlive(info(process.pid, "123456"), { platform: "win32", beacons })).toBe(false);
  });

  it("tells a temp file's live writer by its pid's beacon, and any pid elsewhere", () => {
    const beacons = memoryBeacons();
    expect(isPidAlive(process.pid, { platform: "win32", beacons })).toBe(false);
    processStartTime(process.pid, { platform: "win32", beacons });
    expect(isPidAlive(process.pid, { platform: "win32", beacons })).toBe(true);
    expect(isPidAlive(process.pid, { platform: "linux" })).toBe(true);
    expect(isPidAlive(2_000_000_000, { platform: "linux" })).toBe(false);
  });
});

describe("retryBusy", () => {
  const busy = (code: string) => Object.assign(new Error(code), { code });

  it("on Windows retries a name another process holds, until it is free", async () => {
    let calls = 0;
    const value = await retryBusy(
      async () => {
        calls++;
        if (calls < 3) throw busy("EPERM");
        return "done";
      },
      { platform: "win32" },
    );
    expect(value).toBe("done");
    expect(calls).toBe(3);
  });

  it("gives up after its time with the last error, and never retries elsewhere or another error", async () => {
    let calls = 0;
    await expect(retryBusy(async () => Promise.reject(busy((calls++, "EBUSY"))), { platform: "win32", totalMs: 30 })).rejects.toMatchObject({ code: "EBUSY" });
    expect(calls).toBeGreaterThan(1);
    calls = 0;
    await expect(retryBusy(async () => Promise.reject(busy((calls++, "EPERM"))), { platform: "linux" })).rejects.toMatchObject({ code: "EPERM" });
    expect(calls).toBe(1);
    calls = 0;
    await expect(retryBusy(async () => Promise.reject(busy((calls++, "ENOENT"))), { platform: "win32" })).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
    expect(isBusy(busy("EACCES"), "win32")).toBe(true);
    expect(isBusy(busy("EACCES"), "linux")).toBe(false);
  });
});

// The real thing, on Windows only (CI's windows-latest and the host): a child process with a beacon of its own.
describe.skipIf(process.platform !== "win32")("the beacon of a real process (Windows)", () => {
  let dir: string;
  let child: ChildProcess | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arashouse-beacon-"));
  });

  afterEach(async () => {
    child?.kill();
    child = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  /** Starts a Node child that listens on its beacon and prints its token, as `startBeacon` does. */
  async function beaconChild(): Promise<{ pid: number; startTime: string }> {
    const token = randomBytes(8).toString("hex");
    const script = [
      'const net = require("node:net");',
      `const s = net.createServer((c) => c.destroy()); s.listen("\\\\\\\\.\\\\pipe\\\\arashouse-live-" + process.pid + "-${token}");`,
      's.on("listening", () => process.stdout.write("up\\n"));',
      "setInterval(() => undefined, 1000);",
    ].join("\n");
    child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    await new Promise<void>((resolve, reject) => {
      child!.stdout!.once("data", () => resolve());
      child!.once("exit", (code) => reject(new Error(`the beacon child exited ${code}`)));
    });
    return { pid: child.pid!, startTime: `pipe:${token}` };
  }

  async function killChild(): Promise<void> {
    const c = child!;
    await new Promise<void>((resolve) => {
      c.once("exit", () => resolve());
      c.kill();
    });
  }

  it("lists this process's own beacon", () => {
    const start = processStartTime(process.pid);
    expect(start).toMatch(/^pipe:/);
    expect(listPipes().has(beaconName(process.pid, start!.slice(5)))).toBe(true);
  });

  it("reads a killed holder's lock and resetting record dead at once, and a reused pid as not the holder", async () => {
    const { pid, startTime } = await beaconChild();
    expect(processStartTime(pid)).toBe(startTime);
    expect(isProcessAlive(info(pid, startTime))).toBe(true);
    expect(isResetWorkerAlive(pid, startTime)).toBe(true);
    // A record of the same pid with another beacon is a process that reused the pid: not the holder.
    expect(isProcessAlive(info(pid, "pipe:ffffffffffffffff"))).toBe(false);
    await killChild();
    expect(isProcessAlive(info(pid, startTime))).toBe(false);
    expect(isResetWorkerAlive(pid, startTime)).toBe(false);
  });

  it("steals a killed holder's lock without waiting out its timeout", async () => {
    const { pid, startTime } = await beaconChild();
    const path = join(dir, "state.lock");
    await writeFile(path, JSON.stringify({ pid, token: "held", acquired_at: new Date().toISOString(), start_time: startTime }));
    await expect(acquireLock(path, { timeoutMs: 200 })).rejects.toThrow(/timed out/);
    await killChild();
    const started = Date.now();
    const lock = await acquireLock(path, { timeoutMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(lock.info.start_time).toMatch(/^pipe:/);
    await lock.release();
  });
});
