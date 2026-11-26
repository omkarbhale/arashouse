// An exclusive lock file with a stale-lock rule: a lock held by a dead pid is stolen, and the
// steal is reported (the store logs it) before the lock is reused. A lock held by a live pid is
// waited for and never stolen. Created by hard-linking a finished temp file, so the lock file never
// exists half-written.
//
// Liveness is this file's: a pid and a token that tells a reused pid from the holder. On Linux the token is the
// process's start time (`/proc/<pid>/stat`). Windows reuses pids quickly and has no `/proc`, so each arashouse process
// there listens on a named pipe of its own, `\\.\pipe\arashouse-live-<pid>-<random>` (its beacon), and records
// `pipe:<random>`: the pipe is listed while the process runs and is gone the moment it ends, whatever ends it. A
// record without a beacon (an older build's, or another OS's) is judged dead on Windows. Every lock, reset-worker
// record and queue ticket goes through `processStartTime` and `isProcessAlive`.
//
// NTFS refuses to replace or link over a name another process has open or is deleting (EPERM, EBUSY), and an
// antivirus scanner may hold a fresh file for a moment; `retryBusy` retries those for a bounded time on Windows.

import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { link, open, readFile, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export interface LockInfo {
  readonly pid: number;
  readonly token: string;
  readonly acquired_at: string;
  /**
   * What tells a reused pid from the holder, where the platform has it: the `/proc/<pid>/stat` start time on Linux,
   * `pipe:<beacon>` on Windows.
   */
  readonly start_time: string | null;
}

export interface LockEvent {
  readonly event: "lock-stolen" | "lock-steal-conflict";
  /** The pid that held the lock, or null when the lock file was unreadable. */
  readonly held_by: number | null;
  readonly acquired_at: string | null;
}

export interface LockOptions {
  readonly pid?: number;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly now?: () => Date;
  /** Whether the process that wrote a lock is still running. */
  readonly isAlive?: (info: LockInfo) => boolean;
  readonly onEvent?: (event: LockEvent) => void | Promise<void>;
}

export class LockTimeoutError extends Error {
  constructor(
    readonly path: string,
    readonly heldBy: number | null,
    timeoutMs: number,
  ) {
    super(`timed out after ${timeoutMs} ms waiting for the lock ${path}${heldBy === null ? "" : ` (held by pid ${heldBy})`}`);
    this.name = "LockTimeoutError";
  }
}

export interface HeldLock {
  readonly info: LockInfo;
  release(): Promise<void>;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

// ---- the beacon (Windows) ---------------------------------------------------------------------------

const PIPE_DIR = "\\\\.\\pipe\\";
const BEACON_PREFIX = "arashouse-live-";
const BEACON_MARK = "pipe:";

/** The pipe name of `pid`'s beacon with `token`, without the `\\.\pipe\` folder. */
export function beaconName(pid: number, token: string): string {
  return `${BEACON_PREFIX}${pid}-${token}`;
}

/**
 * The names of the pipes listed now (a synchronous listing of `\\.\pipe\`, about a millisecond), or null when it cannot
 * be listed: off Windows, and on Node 20, whose `readdir` of `\\.\pipe\` throws ENOTDIR. A failure is never an empty set.
 */
export function listPipes(): Set<string> | null {
  try {
    return new Set(readdirSync(PIPE_DIR));
  } catch {
    return null;
  }
}

/**
 * Whether `\\.\pipe\<name>` is listening now. From the listing where Node can list pipes (it has no side effect).
 * Where it cannot (Node 20), by opening the name: that connects to the pipe (the beacon's server drops the connection),
 * and while the server has no free instance the open fails EBUSY, so only ENOENT means there is no such pipe; any other
 * answer counts as there, so a lock is never taken from a holder on a doubt.
 */
export function pipeExists(name: string): boolean {
  const pipes = listPipes();
  if (pipes !== null) return pipes.has(name);
  try {
    statSync(`${PIPE_DIR}${name}`);
    return true;
  } catch (err) {
    return errnoCode(err) !== "ENOENT";
  }
}

/** Where the beacons are looked up and this process's beacon is started; replaced in tests. */
export interface BeaconSystem {
  /** Every pipe's name, or null when they cannot be listed. */
  readonly listPipes: () => Set<string> | null;
  /** Whether a pipe of exactly this name is listening. */
  readonly exists: (name: string) => boolean;
  /** Starts listening on `\\.\pipe\<name>` for the rest of the process, without keeping it alive; throws when it cannot. */
  readonly listen: (name: string) => void;
}

const nativeBeacons: BeaconSystem = {
  listPipes,
  exists: pipeExists,
  listen(name) {
    const server = createServer((socket) => socket.destroy());
    server.on("error", () => undefined);
    server.listen(`${PIPE_DIR}${name}`);
    // Binding a pipe is synchronous: a server not listening now never will be.
    if (!server.listening) throw new Error(`cannot start this process's liveness beacon (${PIPE_DIR}${name})`);
    server.unref();
  },
};

let ownBeacon: string | undefined;

/**
 * This process's beacon token, its pipe started the first time (before its first lock or record). Throws when the pipe
 * cannot be started: a process that cannot be told alive must not hold a lock, or the next one would steal it.
 */
export function startBeacon(system: BeaconSystem = nativeBeacons, pid: number = process.pid): string {
  if (ownBeacon !== undefined && system === nativeBeacons && pid === process.pid) return ownBeacon;
  const token = randomBytes(8).toString("hex");
  const name = beaconName(pid, token);
  system.listen(name);
  if (!system.exists(name)) throw new Error(`cannot start this process's liveness beacon (${PIPE_DIR}${name})`);
  if (system === nativeBeacons && pid === process.pid) ownBeacon = token;
  return token;
}

/** The token of `pid`'s beacon if one is listed, else null (also when the pipes cannot be listed). */
export function beaconOf(pid: number, pipes: Set<string> | null = listPipes()): string | null {
  if (pipes === null) return null;
  const prefix = `${BEACON_PREFIX}${pid}-`;
  for (const name of pipes) if (name.startsWith(prefix)) return name.slice(prefix.length);
  return null;
}

// ---- liveness --------------------------------------------------------------------------------------

export interface LivenessOptions {
  readonly platform?: NodeJS.Platform;
  readonly beacons?: BeaconSystem;
}

/** Start time of `pid` (field 22 of `/proc/<pid>/stat`) on Linux; `pipe:<token>` of its beacon on Windows; else null. */
export function processStartTime(pid: number, options: LivenessOptions = {}): string | null {
  if ((options.platform ?? process.platform) === "win32") {
    const beacons = options.beacons ?? nativeBeacons;
    if (pid === process.pid) return `${BEACON_MARK}${startBeacon(beacons)}`;
    const token = beaconOf(pid, beacons.listPipes());
    return token === null ? null : `${BEACON_MARK}${token}`;
  }
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name sits in parentheses and may hold spaces; the fields resume after the last ")".
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/** Whether a process with `pid` exists (`ESRCH` is the only no; `EPERM` is someone else's). */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  return true;
}

export function isProcessAlive(info: LockInfo, options: LivenessOptions = {}): boolean {
  if (!pidExists(info.pid)) return false;
  if ((options.platform ?? process.platform) === "win32") {
    // Only a beacon tells the holder from a reused pid; a record without one is an older build's or another OS's.
    if (info.start_time === null || !info.start_time.startsWith(BEACON_MARK)) return false;
    return (options.beacons ?? nativeBeacons).exists(beaconName(info.pid, info.start_time.slice(BEACON_MARK.length)));
  }
  if (info.start_time !== null) {
    const now = processStartTime(info.pid, options);
    if (now !== null && now !== info.start_time) return false;
  }
  return true;
}

/**
 * Whether an arashouse process with `pid` may still be running, when only the pid is known (a temp file named for it):
 * on Windows, one whose beacon is listed; elsewhere, any process with that pid.
 */
export function isPidAlive(pid: number, options: LivenessOptions = {}): boolean {
  if (!pidExists(pid)) return false;
  if ((options.platform ?? process.platform) === "win32") {
    const pipes = (options.beacons ?? nativeBeacons).listPipes();
    // Without a listing (Node 20) the pid is all there is: a reused pid only leaves a stale temp file behind.
    return pipes === null ? true : beaconOf(pid, pipes) !== null;
  }
  return true;
}

// ---- NTFS's busy names -----------------------------------------------------------------------------

/**
 * The codes NTFS gives for a name another process has open, is deleting, or (an antivirus scanner) holds for a moment.
 * libuv maps ERROR_ACCESS_DENIED (a delete-pending name, and also a real ACL denial) to EPERM and ERROR_SHARING_VIOLATION
 * to EBUSY, so the codes cannot tell a transient busy name from a real denial; what bounds a real denial is the window.
 */
const BUSY_CODES = new Set(["EPERM", "EBUSY"]);

/** How long `retryBusy` waits where a writer must outlast readers (the renames of the state file): they only ever hold a name briefly. */
export const BUSY_RETRY_MS = 15_000;

/** The short window for reads and deletes, which need no reader to finish: a real denial fails within it. */
export const BUSY_SHORT_MS = 2_000;

export interface RetryBusyOptions {
  readonly platform?: NodeJS.Platform;
  readonly totalMs?: number;
}

/** Whether `err` is one NTFS gives for a busy name (on Windows only). */
export function isBusy(err: unknown, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && BUSY_CODES.has(errnoCode(err) ?? "");
}

/** Runs `fn`, and on Windows runs it again while it fails with a busy code, for up to `totalMs`; then the last error. */
export async function retryBusy<T>(fn: () => Promise<T>, options: RetryBusyOptions = {}): Promise<T> {
  const platform = options.platform ?? process.platform;
  const deadline = Date.now() + (options.totalMs ?? BUSY_RETRY_MS);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isBusy(err, platform) || Date.now() >= deadline) throw err;
      // Short and jittered, so a rename finds the moment between two readers' opens.
      await sleep(Math.min(2 * 2 ** attempt, 40) + Math.floor(Math.random() * 10));
    }
  }
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function parseLockInfo(text: string): LockInfo | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof raw.pid === "number" &&
      Number.isInteger(raw.pid) &&
      raw.pid > 0 &&
      typeof raw.token === "string" &&
      typeof raw.acquired_at === "string"
    ) {
      return {
        pid: raw.pid,
        token: raw.token,
        acquired_at: raw.acquired_at,
        start_time: typeof raw.start_time === "string" ? raw.start_time : null,
      };
    }
  } catch {
    // fall through: an unreadable lock is as good as a dead holder's
  }
  return null;
}

/**
 * Tries once to create the lock; false if it exists. On Windows a name being deleted (its last reader has not closed
 * it yet) cannot be linked over either (EPERM): that is busy too, and the caller waits.
 */
async function tryCreate(path: string, info: LockInfo): Promise<boolean> {
  const tmp = `${path}.${info.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(info));
  } finally {
    await handle.close();
  }
  try {
    await link(tmp, path);
    return true;
  } catch (err) {
    if (errnoCode(err) === "EEXIST" || isBusy(err)) return false;
    throw err;
  } finally {
    await retryBusy(() => unlink(tmp), { totalMs: BUSY_SHORT_MS }).catch(() => undefined);
  }
}

/** The lock at `path`: `null` when there is none, `busy` when Windows will not open it now (it is being deleted). */
async function readLockAt(path: string): Promise<{ info: LockInfo | null } | null | "busy"> {
  try {
    return { info: parseLockInfo(await readFile(path, "utf8")) };
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    if (isBusy(err)) return "busy";
    throw err;
  }
}

function sameHolder(a: LockInfo | null, b: LockInfo | null): boolean {
  return (a?.token ?? null) === (b?.token ?? null);
}

/**
 * Removes the lock at `path` that was judged stale with content `info`. Steals are serialised through a
 * second exclusive guard file; only thieves and the owner ever remove a lock, so while the guard
 * is held the lock at `path` can only change by its owner releasing it: its token is re-checked under
 * the guard and a live lock taken since the observation is never removed. Returns false when the
 * guard is busy, so the caller retries.
 */
async function steal(
  path: string,
  info: LockInfo | null,
  self: LockInfo,
  isAlive: (info: LockInfo) => boolean,
  options: LockOptions,
): Promise<boolean> {
  const guardPath = `${path}.steal`;
  if (!(await tryCreate(guardPath, self))) {
    const guard = await readLockAt(guardPath);
    if (guard !== null && guard !== "busy" && (guard.info === null || !isAlive(guard.info))) {
      // A thief that died inside its guard; the guard only fences the moment of removal.
      const again = await readLockAt(guardPath);
      if (again !== null && again !== "busy" && sameHolder(again.info, guard.info)) await retryBusy(() => unlink(guardPath), { totalMs: BUSY_SHORT_MS }).catch(() => undefined);
    }
    return false;
  }
  try {
    const current = await readLockAt(path);
    const event = { held_by: info?.pid ?? null, acquired_at: info?.acquired_at ?? null };
    if (current === null) return true;
    if (current === "busy") return false;
    if (!sameHolder(current.info, info)) {
      await options.onEvent?.({ event: "lock-steal-conflict", ...event });
      return true;
    }
    await options.onEvent?.({ event: "lock-stolen", ...event });
    await retryBusy(() => unlink(path), { totalMs: BUSY_SHORT_MS });
    return true;
  } finally {
    const guard = await readLockAt(guardPath);
    if (guard !== null && guard !== "busy" && guard.info?.token === self.token) await retryBusy(() => unlink(guardPath), { totalMs: BUSY_SHORT_MS }).catch(() => undefined);
  }
}

/** Waits for, then takes, the exclusive lock at `path`. */
export async function acquireLock(path: string, options: LockOptions = {}): Promise<HeldLock> {
  const pid = options.pid ?? process.pid;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 10;
  const now = options.now ?? (() => new Date());
  const isAlive = options.isAlive ?? isProcessAlive;
  const deadline = Date.now() + timeoutMs;
  const info: LockInfo = {
    pid,
    token: randomBytes(16).toString("hex"),
    acquired_at: now().toISOString(),
    start_time: processStartTime(pid),
  };

  for (;;) {
    if (await tryCreate(path, info)) {
      return {
        info,
        async release() {
          // Remove the lock only if it is still ours (it may have been judged stale and replaced).
          const current = parseLockInfo(await retryBusy(() => readFile(path, "utf8"), { totalMs: BUSY_SHORT_MS }).catch(() => ""));
          if (current?.token === info.token) await retryBusy(() => unlink(path), { totalMs: BUSY_SHORT_MS }).catch(() => undefined);
        },
      };
    }
    const observed = await readLockAt(path);
    if (observed === null) continue; // released between our attempt and our read
    if (observed === "busy") {
      // Being deleted on Windows: its holder released it, and a reader still has it open.
      if (Date.now() >= deadline) throw new LockTimeoutError(path, null, timeoutMs);
      await sleep(pollMs + Math.floor(Math.random() * pollMs));
      continue;
    }
    if (observed.info === null || !isAlive(observed.info)) {
      if (await steal(path, observed.info, info, isAlive, options)) continue;
      if (Date.now() >= deadline) throw new LockTimeoutError(path, observed.info?.pid ?? null, timeoutMs);
      await sleep(pollMs + Math.floor(Math.random() * pollMs));
      continue;
    }
    if (Date.now() >= deadline) throw new LockTimeoutError(path, observed.info.pid, timeoutMs);
    await sleep(pollMs + Math.floor(Math.random() * pollMs));
  }
}
