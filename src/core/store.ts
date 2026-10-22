// The state store: `~/.arashouse/state.json` under an exclusive lock, written atomically, with an
// append-only event log. No daemon: every command takes the lock, reads, changes and writes back.

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { acquireLock, isProcessAlive, type LockEvent, type LockInfo } from "./lock.js";
import type { SlotRef } from "./names.js";
import {
  type Slot,
  type State,
  type TransitionRequest,
  StateCorruptError,
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

/** `$ARASHOUSE_HOME`, else `~/.arashouse`. Always absolute, and never inside a worktree by default. */
export function resolveStorePaths(env: NodeJS.ProcessEnv = process.env): StorePaths {
  const override = env[HOME_ENV];
  const home = override !== undefined && override !== "" ? override : join(homedir(), ".arashouse");
  if (!isAbsolute(home)) throw new Error(`${HOME_ENV} must be an absolute path, got "${home}"`);
  return { home, state: join(home, "state.json"), lock: join(home, "state.lock"), events: join(home, "events.log") };
}

/** One line of `events.log`. Never carries a secret; a lease id appears only as its first 8 characters. */
export interface StoreEvent {
  readonly ts: string;
  readonly pid: number;
  readonly event: "transition" | "state-replaced" | LockEvent["event"];
  readonly slot?: string;
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

/** Writes `data` to `path` atomically: a temp file in the same directory, `fsync`, then rename. */
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
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
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
  private readonly pending: StoreEvent[] = [];

  constructor(
    base: State,
    private readonly env: { now: () => Date; pid: number; newLeaseId: () => string },
  ) {
    this.slots = { ...base.slots };
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

  /** Moves a slot along the status table; throws `IllegalTransitionError` or on an unknown slot. */
  transition(id: string, request: TransitionRequest): Slot {
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
      ...(next.quarantine_reason !== undefined ? { reason: next.quarantine_reason } : {}),
    });
    return next;
  }

  /** @internal */
  result(base: State): State {
    return { ...base, revision: base.revision + 1, updated_at: this.env.now().toISOString(), slots: this.slots };
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
      text = await readFile(this.paths.state, "utf8");
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
        await rename(this.paths.state, `${this.paths.state}.corrupt-${this.now().toISOString().replace(/[:.]/g, "-")}`);
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

  /** Removes temp files left by a writer that crashed before its rename (their owner pid is gone). */
  private async sweepTempFiles(): Promise<void> {
    const owned = new Set([basename(this.paths.state), basename(this.paths.lock)]);
    for (const name of await readdir(this.paths.home).catch(() => [] as string[])) {
      const m = /^(.+)\.(\d+)\.[0-9a-f]{12}\.tmp$/.exec(name);
      const pid = m ? Number(m[2]) : NaN;
      if (!m || !owned.has(m[1] ?? "") || pid === this.pid) continue;
      if (!isProcessAlive({ pid, token: "", acquired_at: "", start_time: null })) {
        await unlink(join(this.paths.home, name)).catch(() => undefined);
      }
    }
  }
}
