// The resource governor (ticket 17): what protects the laptop, rather than the slot count. Three
// rules, all from `config.ts`:
// - `get` hands out a slot only while fewer than `max_active` slots are `leased` and the host has at
//   least `min_free_ram_mb` free; a `get --wait` caller holds a ticket in the state file's queue and
//   callers are served in ticket order.
// - A reset starts only while fewer than `max_resets` are running (`beginReset`).
// - A provision or a baseline build starts only with `min_free_disk_gb` free (`checkDiskForBuild`).
// The checks are pure functions of the state and the host's reply; the lease core and the reset
// worker (ticket 14) call them under the state lock, so a count they take cannot go stale.

import type { HostDriver, HostInfo } from "../host/driver.js";
import type { ArashouseConfig } from "./config.js";
import type { FlavorKey } from "./flavors.js";
import { isProcessAlive, processStartTime } from "./lock.js";
import type { Slot, Waiter } from "./state.js";
import type { StateStore } from "./store.js";

export interface GovernorContext {
  /** Every slot, as the update that is about to lease one sees them. */
  readonly slots: readonly Slot[];
  readonly flavor: FlavorKey;
  readonly holder: string;
  /** The live `get --wait` callers, in ticket order. */
  readonly queue: readonly Waiter[];
  /** The caller's own ticket; null for a call that does not wait, which stands behind every waiter. */
  readonly ticket: number | null;
  /** The host's `hostInfo` reply, asked just before. */
  readonly host: HostInfo;
}

export type GovernorVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Decides whether one more lease may start. It runs under the state lock, immediately before the slot is marked leased. */
export interface Governor {
  check(context: GovernorContext): GovernorVerdict | Promise<GovernorVerdict>;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The config-driven governor. In order: the host must have `min_free_ram_mb` free; fewer than
 * `max_active` slots may be leased; and the waiters ahead of the caller are served first. Each
 * earlier waiter whose flavor has a free slot takes one of the remaining `max_active` places and
 * one of those free slots; the caller goes only if a place and a free slot of its flavor are left.
 * A waiter whose flavor has nothing free does not hold up a caller who could use a slot now.
 */
export function poolGovernor(config: Pick<ArashouseConfig, "max_active" | "min_free_ram_mb">): Governor {
  return {
    check({ slots, flavor, queue, ticket, host }) {
      if (host.freeRamMb < config.min_free_ram_mb) {
        return { ok: false, reason: `the host has ${host.freeRamMb} MB of free RAM, under min_free_ram_mb ${config.min_free_ram_mb}` };
      }
      const leased = slots.filter((s) => s.status === "leased").length;
      if (leased >= config.max_active) return { ok: false, reason: `max_active ${config.max_active} reached (${leased} leased)` };
      let places = config.max_active - leased;
      const free = new Map<FlavorKey, number>();
      for (const s of slots) if (s.status === "free") free.set(s.flavor, (free.get(s.flavor) ?? 0) + 1);
      let ahead = 0;
      for (const w of [...queue].sort((a, b) => a.ticket - b.ticket)) {
        if (places === 0) break;
        if (ticket !== null && w.ticket >= ticket) break;
        const left = free.get(w.flavor) ?? 0;
        if (left === 0) continue;
        free.set(w.flavor, left - 1);
        places--;
        ahead++;
      }
      if (places === 0 || (free.get(flavor) ?? 0) === 0) {
        return { ok: false, reason: `${plural(ahead, "earlier waiter")} ahead in the queue` };
      }
      return { ok: true };
    },
  };
}

/** Whether a waiter's process is still running; a reused pid with another start time is not it. */
export function isWaiterAlive(waiter: Waiter): boolean {
  return isProcessAlive({ pid: waiter.pid, token: "", acquired_at: "", start_time: waiter.start_time });
}

/** The fields of a new waiter that identify its process. */
export function waiterProcess(pid: number = process.pid): { pid: number; start_time: string | null } {
  return { pid, start_time: processStartTime(pid) };
}

/** The waiters that still hold their place: their process runs and their wait has not run out. */
export function liveWaiters(queue: readonly Waiter[], now: Date, isAlive: (waiter: Waiter) => boolean = isWaiterAlive): Waiter[] {
  return queue.filter((w) => (w.expires_at === null || Date.parse(w.expires_at) > now.getTime()) && isAlive(w));
}

// ---- the reset cap ---------------------------------------------------------------------------------

/** Whether a reset worker's process is still running (ticket 14 recovers a dead one's slot as dirty). */
export function isResetWorkerAlive(pid: number): boolean {
  return isProcessAlive({ pid, token: "", acquired_at: "", start_time: null });
}

/** The slots whose reset is running now: `resetting`, with a live worker. */
export function runningResets(slots: readonly Slot[], isAlive: (pid: number) => boolean = isResetWorkerAlive): Slot[] {
  return slots.filter((s) => s.status === "resetting" && s.reset !== undefined && isAlive(s.reset.pid));
}

export type ResetStart = { readonly started: true; readonly slot: Slot } | { readonly started: false; readonly reason: string };

export interface BeginResetOptions {
  /** The reset worker's pid, recorded on the slot. */
  readonly pid: number;
  readonly maxResets: number;
  readonly isAlive?: (pid: number) => boolean;
}

/**
 * Moves a `dirty` slot to `resetting` for the worker `pid`, under the state lock, only while fewer
 * than `maxResets` resets are running. Ticket 14's reset worker and `get`'s lazy reset start every
 * reset through here; a caller that is refused leaves the slot `dirty` and tries again later.
 */
export async function beginReset(store: StateStore, slotId: string, options: BeginResetOptions): Promise<ResetStart> {
  return store.update<ResetStart>((tx) => {
    const slot = tx.slot(slotId);
    if (!slot) return { started: false, reason: `no slot "${slotId}" in the pool` };
    if (slot.status !== "dirty") return { started: false, reason: `slot ${slotId} is ${slot.status}, not dirty` };
    const running = runningResets(Object.values(tx.snapshot()), options.isAlive).length;
    if (running >= options.maxResets) return { started: false, reason: `max_resets ${options.maxResets} reached (${running} resetting)` };
    return { started: true, slot: tx.transition(slotId, { to: "resetting", pid: options.pid }) };
  });
}

// ---- the disk gate ---------------------------------------------------------------------------------

/**
 * Whether a provision (ticket 25) or a baseline build (ticket 24) may start: the host must have
 * `min_free_disk_gb` free at the install root. A lease needs no disk check.
 */
export async function checkDiskForBuild(host: Pick<HostDriver, "hostInfo">, config: Pick<ArashouseConfig, "min_free_disk_gb">): Promise<GovernorVerdict> {
  const { info } = await host.hostInfo();
  if (info.freeDiskGb < config.min_free_disk_gb) {
    return { ok: false, reason: `the host has ${info.freeDiskGb} GB free at the install root, under min_free_disk_gb ${config.min_free_disk_gb}` };
  }
  return { ok: true };
}
