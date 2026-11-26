// The state store: `<home>/state.json` under an exclusive lock, written atomically, with an
// append-only event log. No daemon: every command takes the lock, reads, changes and writes back. The home is
// `%LOCALAPPDATA%\arashouse` on Windows (one per machine and worker user, on NTFS: every Windows copy of arashouse
// shares it) and `~/.arashouse` elsewhere.

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, win32 } from "node:path";
import { BUSY_SHORT_MS, acquireLock, isPidAlive, isProcessAlive, retryBusy, type LockEvent, type LockInfo } from "./lock.js";
import type { SlotRef } from "./names.js";
import {
  type BootstrapInfo,
  type Slot,
  type State,
  type TransitionRequest,
  type Waiter,
  StateCorruptError,
  checkBootstrap,
  emptyState,
  newSlot,
  newLeaseId,
  parseState,
  serialiseState,
  transitionSlot,
} from "./state.js";

export const HOME_ENV = "ARASHOUSE_HOME";

export interface StorePaths {
  readonly home: string;
  readonly state: string;
  readonly lock: string;
  readonly events: string;
}

/**
 * The state's home when `ARASHOUSE_HOME` is not set: `%LOCALAPPDATA%\arashouse` on Windows (the profile's ACL keeps it
 * the worker user's, and it is the same for every copy of arashouse on the machine); `~/.arashouse` elsewhere.
 */
export function defaultHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return join(homedir(), ".arashouse");
  const local = env.LOCALAPPDATA?.trim();
  return win32.join(local !== undefined && win32.isAbsolute(local) ? local : win32.join(homedir(), "AppData", "Local"), "arashouse");
}

/** `$ARASHOUSE_HOME`, else `defaultHome`. Always absolute, and never inside a worktree by default. */
export function resolveStorePaths(env: NodeJS.ProcessEnv = process.env): StorePaths {
  const override = env[HOME_ENV];
  const home = override !== undefined && override !== "" ? override : defaultHome(env);
  if (!isAbsolute(home)) throw new Error(`${HOME_ENV} must be an absolute path, got "${home}"`);
  return { home, state: join(home, "state.json"), lock: join(home, "state.lock"), events: join(home, "events.log") };
}

/** One line of `events.log`. Never carries a secret; a lease id appears only as its first 8 characters. */
export interface StoreEvent {
  readonly ts: string;
  readonly pid: number;
  readonly event: "transition" | "slot-removed" | "lease-extracted" | "bootstrap" | "queue-join" | "queue-leave" | "state-replaced" | LockEvent["event"];
  readonly slot?: string;
  /** The queue ticket of a `queue-join` or `queue-leave`. */
  readonly ticket?: number;
  readonly flavor?: string;
  readonly from?: string | null;
  readonly to?: string;
  readonly lease?: string;
  readonly holder?: string;
  readonly reason?: string;
  readonly held_by?: number | null;
  readonly revision?: number;
}

export interface StoreOptions {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly pid?: number;
  readonly lockTimeoutMs?: number;
  readonly lockPollMs?: number;
  readonly newLeaseId?: () => string;
  readonly isAlive?: (info: LockInfo) => boolean;
  /** Test seam: runs after the temp file is written and synced, before it replaces the state file. */
  readonly beforeRename?: (tempPath: string) => void | Promise<void>;
}

/**
 * Writes `data` to `path` atomically: a temp file in the same directory, `fsync`, then rename. On Windows the rename
 * is retried while a reader has `path` open (NTFS will not replace an open file; `status` reads without the lock).
 */
export async function writeFileAtomic(
  path: string,
  data: string,
  options: { beforeRename?: (tempPath: string) => void | Promise<void> } = {},
): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.beforeRename?.(tmp);
    await retryBusy(() => rename(tmp, path));
  } catch (err) {
    await retryBusy(() => unlink(tmp), { totalMs: BUSY_SHORT_MS }).catch(() => undefined);
    throw err;
  }
  // Make the rename itself durable; not every filesystem lets a directory be synced.
  try {
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // best effort
  }
}

/** The changes one `update` makes: every status move goes through the table and is logged. */
export class Transaction {
  private readonly slots: Record<string, Slot>;
  private queue: Waiter[];
  private nextTicket: number;
  private readonly pending: StoreEvent[] = [];

  constructor(
    base: State,
    private readonly env: { now: () => Date; pid: number; newLeaseId: () => string },
  ) {
    this.slots = { ...base.slots };
    this.queue = [...base.queue];
    this.nextTicket = base.next_ticket;
  }

  get changed(): boolean {
    return this.pending.length > 0;
  }

  get events(): readonly StoreEvent[] {
    return this.pending;
  }

  /** The slots as this transaction sees them. */
  snapshot(): Readonly<Record<string, Slot>> {
    return { ...this.slots };
  }

  slot(id: string): Slot | undefined {
    return this.slots[id];
  }

  /** Adds a slot in `provisioning`; throws if it exists. */
  addSlot(ref: SlotRef): Slot {
    const slot = newSlot(ref);
    if (this.slots[slot.id]) throw new Error(`slot ${slot.id} already exists`);
    this.slots[slot.id] = slot;
    this.log({ slot: slot.id, from: null, to: slot.status });
    return slot;
  }

  /**
   * Moves a slot along the status table; throws `IllegalTransitionError` or on an unknown slot.
   * `note` is logged as the event's reason (a quarantine reason is logged either way).
   */
  transition(id: string, request: TransitionRequest, note?: string): Slot {
    const slot = this.slots[id];
    if (!slot) throw new Error(`no slot "${id}"`);
    const next = transitionSlot(slot, request, { now: this.env.now(), newLeaseId: this.env.newLeaseId });
    this.slots[id] = next;
    const lease = next.lease ?? slot.lease;
    this.log({
      slot: id,
      from: slot.status,
      to: next.status,
      ...(lease ? { lease: lease.lease_id.slice(0, 8), holder: lease.holder } : {}),
      ...(next.quarantine_reason !== undefined ? { reason: next.quarantine_reason } : note !== undefined ? { reason: note } : {}),
    });
    return next;
  }

  /**
   * Drops a slot's record (`arashouse destroy`, ticket 16); throws on an unknown slot. Not a status
   * move: the slot leaves the pool, and the event records the status it had and its lease, if any.
   */
  removeSlot(id: string, note: string): Slot {
    const slot = this.slots[id];
    if (!slot) throw new Error(`no slot "${id}"`);
    delete this.slots[id];
    this.pending.push({
      ts: this.env.now().toISOString(),
      pid: this.env.pid,
      event: "slot-removed",
      slot: id,
      from: slot.status,
      ...(slot.lease ? { lease: slot.lease.lease_id.slice(0, 8), holder: slot.lease.holder } : {}),
      reason: note,
    });
    return slot;
  }

  /**
   * Marks the slot's lease as extracted from (`arashouse extract`, ticket 43): information only, not a status move.
   * False, and nothing logged, when the slot no longer holds that lease.
   */
  markExtracted(id: string, leaseId: string, what: string): boolean {
    const slot = this.slots[id];
    if (slot?.status !== "leased" || slot.lease?.lease_id !== leaseId) return false;
    if (slot.lease.extracted !== true) this.slots[id] = { ...slot, lease: { ...slot.lease, extracted: true } };
    this.pending.push({
      ts: this.env.now().toISOString(),
      pid: this.env.pid,
      event: "lease-extracted",
      slot: id,
      lease: leaseId.slice(0, 8),
      holder: slot.lease.holder,
      reason: what,
    });
    return true;
  }

  /**
   * Merges `info` into the bootstrap record of the slot's lease (what a deploy put on it, ticket 40), when the slot is
   * still leased with `leaseId`; false (and nothing changed) otherwise. Not a status move: the event names the keys only.
   */
  recordBootstrap(id: string, leaseId: string, info: BootstrapInfo): boolean {
    const slot = this.slots[id];
    if (!slot || slot.status !== "leased" || slot.lease?.lease_id !== leaseId) return false;
    const bootstrap = checkBootstrap({ ...(slot.lease.bootstrap ?? {}), ...info });
    this.slots[id] = { ...slot, lease: { ...slot.lease, bootstrap } };
    this.pending.push({
      ts: this.env.now().toISOString(),
      pid: this.env.pid,
      event: "bootstrap",
      slot: id,
      lease: leaseId.slice(0, 8),
      holder: slot.lease.holder,
      reason: `recorded ${Object.keys(info).join(", ")}`,
    });
    return true;
  }

  /** The `get --wait` callers, in ticket order, as this transaction sees them. */
  waiters(): readonly Waiter[] {
    return [...this.queue];
  }

  /** Puts a caller at the back of the queue with the next ticket. */
  joinQueue(waiter: Omit<Waiter, "ticket" | "queued_at">): Waiter {
    const joined: Waiter = { ...waiter, ticket: this.nextTicket, queued_at: this.env.now().toISOString() };
    this.nextTicket++;
    this.queue.push(joined);
    this.pending.push({
      ts: this.env.now().toISOString(),
      pid: this.env.pid,
      event: "queue-join",
      ticket: joined.ticket,
      flavor: joined.flavor,
      holder: joined.holder,
    });
    return joined;
  }

  /** Takes a ticket out of the queue; false (and nothing logged) if it is not there. */
  leaveQueue(ticket: number, reason: string): boolean {
    const waiter = this.queue.find((w) => w.ticket === ticket);
    if (!waiter) return false;
    this.queue = this.queue.filter((w) => w.ticket !== ticket);
    this.pending.push({ ts: this.env.now().toISOString(), pid: this.env.pid, event: "queue-leave", ticket, flavor: waiter.flavor, holder: waiter.holder, reason });
    return true;
  }

  /** @internal */
  result(base: State): State {
    return {
      ...base,
      revision: base.revision + 1,
      updated_at: this.env.now().toISOString(),
      slots: this.slots,
      next_ticket: this.nextTicket,
      queue: this.queue,
    };
  }

  private log(fields: Omit<StoreEvent, "ts" | "pid" | "event">): void {
    this.pending.push({ ts: this.env.now().toISOString(), pid: this.env.pid, event: "transition", ...fields });
  }
}

export class StateStore {
  readonly paths: StorePaths;
  private readonly now: () => Date;
  private readonly pid: number;
  private readonly leaseIds: () => string;

  constructor(private readonly options: StoreOptions = {}) {
    const base = resolveStorePaths(options.env);
    const home = options.home ?? base.home;
    if (!isAbsolute(home)) throw new Error(`the state home must be an absolute path, got "${home}"`);
    this.paths = { home, state: join(home, "state.json"), lock: join(home, "state.lock"), events: join(home, "events.log") };
    this.now = options.now ?? (() => new Date());
    this.pid = options.pid ?? process.pid;
    this.leaseIds = options.newLeaseId ?? newLeaseId;
  }

  /**
   * The current state without the lock: the file is only ever replaced by a rename, so a read sees
   * a whole old or a whole new file. A missing file is an empty pool; an unusable one throws
   * `StateCorruptError`.
   */
  async read(): Promise<State> {
    let text: string;
    try {
      text = await retryBusy(() => readFile(this.paths.state, "utf8"), { totalMs: BUSY_SHORT_MS });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState(this.now());
      throw err;
    }
    return parseState(text, this.paths.state);
  }

  /** Every logged event, oldest first. */
  async events(): Promise<StoreEvent[]> {
    let text: string;
    try {
      text = await readFile(this.paths.events, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoreEvent);
  }

  /**
   * Takes the lock, reads the state, runs `fn` against a transaction and, if it changed anything,
   * writes the state back and logs its events. If `fn` throws, nothing is written.
   */
  async update<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T> {
    return this.locked(async () => {
      const base = await this.read();
      const tx = new Transaction(base, { now: this.now, pid: this.pid, newLeaseId: this.leaseIds });
      const value = await fn(tx);
      if (tx.changed) {
        await this.write(tx.result(base));
        await this.log(tx.events);
      }
      return value;
    });
  }

  /**
   * Replaces the whole state, setting a corrupt or stale file aside (`state.json.corrupt-<ts>`).
   * The primitive under `arashouse doctor --rebuild-state` (ticket 16).
   */
  async replace(state: State, reason: string): Promise<State> {
    return this.locked(async () => {
      let revision = 0;
      try {
        revision = (await this.read()).revision;
      } catch (err) {
        if (!(err instanceof StateCorruptError)) throw err;
      }
      try {
        const aside = `${this.paths.state}.corrupt-${this.now().toISOString().replace(/[:.]/g, "-")}`;
        await retryBusy(() => rename(this.paths.state, aside));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const next: State = { ...state, revision: Math.max(state.revision, revision) + 1, updated_at: this.now().toISOString() };
      await this.write(next);
      await this.log([{ ts: this.now().toISOString(), pid: this.pid, event: "state-replaced", reason, revision: next.revision }]);
      return next;
    });
  }

  private async write(state: State): Promise<void> {
    await writeFileAtomic(this.paths.state, serialiseState(state), { beforeRename: this.options.beforeRename });
  }

  private async log(events: readonly StoreEvent[]): Promise<void> {
    if (events.length === 0) return;
    await appendFile(this.paths.events, events.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.paths.home, { recursive: true, mode: 0o700 });
    const lock = await acquireLock(this.paths.lock, {
      pid: this.pid,
      now: this.now,
      timeoutMs: this.options.lockTimeoutMs,
      pollMs: this.options.lockPollMs,
      isAlive: this.options.isAlive ?? isProcessAlive,
      onEvent: (e) => this.log([{ ts: this.now().toISOString(), pid: this.pid, event: e.event, held_by: e.held_by }]),
    });
    try {
      await this.sweepTempFiles();
      return await fn();
    } finally {
      await lock.release();
    }
  }

  /** Removes temp files left by a writer that crashed before its rename (their owner process is gone). */
  private async sweepTempFiles(): Promise<void> {
    const owned = new Set([basename(this.paths.state), basename(this.paths.lock)]);
    for (const name of await readdir(this.paths.home).catch(() => [] as string[])) {
      const m = /^(.+)\.(\d+)\.[0-9a-f]{12}\.tmp$/.exec(name);
      const pid = m ? Number(m[2]) : NaN;
      if (!m || !owned.has(m[1] ?? "") || pid === this.pid) continue;
      if (!isPidAlive(pid)) {
        await retryBusy(() => unlink(join(this.paths.home, name)), { totalMs: 1_000 }).catch(() => undefined);
      }
    }
  }
}
