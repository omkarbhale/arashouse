// An exclusive lock file with a stale-lock rule: a lock held by a dead pid is stolen, and the
// steal is reported (the store logs it) before the lock is reused. A lock held by a live pid is
// waited for and never stolen. Created by hard-linking a finished temp file, so the lock file never
// exists half-written.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, open, readFile, unlink } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

export interface LockInfo {
  readonly pid: number;
  readonly token: string;
  readonly acquired_at: string;
  /** `/proc/<pid>/stat` start time, where the platform has it: tells a reused pid from the holder. */
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

/** Start time of `pid` (field 22 of `/proc/<pid>/stat`), or null off Linux or when it is gone. */
export function processStartTime(pid: number): string | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name sits in parentheses and may hold spaces; the fields resume after the last ")".
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

export function isProcessAlive(info: LockInfo): boolean {
  try {
    process.kill(info.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM: it exists and is not ours.
  }
  if (info.start_time !== null) {
    const now = processStartTime(info.pid);
    if (now !== null && now !== info.start_time) return false;
  }
  return true;
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
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

/** Tries once to create the lock; false if it exists. */
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
    if (errnoCode(err) === "EEXIST") return false;
    throw err;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

async function readLockAt(path: string): Promise<{ info: LockInfo | null } | null> {
  try {
    return { info: parseLockInfo(await readFile(path, "utf8")) };
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
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
    if (guard !== null && (guard.info === null || !isAlive(guard.info))) {
      // A thief that died inside its guard; the guard only fences the moment of removal.
      const again = await readLockAt(guardPath);
      if (again !== null && sameHolder(again.info, guard.info)) await unlink(guardPath).catch(() => undefined);
    }
    return false;
  }
  try {
    const current = await readLockAt(path);
    const event = { held_by: info?.pid ?? null, acquired_at: info?.acquired_at ?? null };
    if (current === null) return true;
    if (!sameHolder(current.info, info)) {
      await options.onEvent?.({ event: "lock-steal-conflict", ...event });
      return true;
    }
    await options.onEvent?.({ event: "lock-stolen", ...event });
    await unlink(path);
    return true;
  } finally {
    const guard = await readLockAt(guardPath);
    if (guard?.info?.token === self.token) await unlink(guardPath).catch(() => undefined);
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
          const current = parseLockInfo(await readFile(path, "utf8").catch(() => ""));
          if (current?.token === info.token) await unlink(path).catch(() => undefined);
        },
      };
    }
    const observed = await readLockAt(path);
    if (observed === null) continue; // released between our attempt and our read
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
