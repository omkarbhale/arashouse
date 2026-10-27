// The reset policy (ticket 14): when a returned slot is reset, by whom, and what a failed reset does.
//
// The captain's words: "It doesn't necessarily clean it up ON freeing the lease, but the worker can
// assume it has cleaned up. The rest is implementation detail." So the invariant is that a slot `get`
// hands out is always clean; when the reset runs is a choice, and it is not "return wipes at once":
// - `return` marks the slot `dirty`, starts a detached `arashouse reset-worker --slot <id>` and exits.
// - The worker takes the slot `dirty -> resetting` through the reset cap (`beginReset`), runs the
//   sequence below and ends `free` or `quarantined`; then it resets any other dirty slot it can.
// - A `get` that finds no free slot of its flavor resets a dirty one itself (`resetSlot`, the same
//   code) and waits on it; a `resetting` one it waits for.
// - The worker records its pid and start time on the slot; anything that finds a `resetting` slot
//   whose worker has ended treats it as `dirty` (`recoverDeadResets`).
//
// The sequence: golden (resolve the flavor's tree and backup) -> quiesce -> database -> tree -> start
// -> health (the host's health check, then the stamp against the golden). A step that fails is tried
// once more (every step is idempotent); a second failure quarantines the slot with the step named. A
// host that does not answer gives the slot back as `dirty` instead, for a later reset.

import type { BackupRef, GoldenRef, HostDriver, HostResult } from "../host/driver.js";
import { isHostError } from "../host/errors.js";
import { type ArashouseConfig, DEFAULT_CONFIG } from "./config.js";
import { HostUnreachableError, type ResetHooks } from "./lease.js";
import type { FlavorKey } from "./flavors.js";
import { type ResetWorkerAlive, beginReset, isResetWorkerAlive } from "./governor.js";
import { processStartTime } from "./lock.js";
import { parseSlotId, slotId, type SlotRef } from "./names.js";
import { redact } from "./redact.js";
import type { Slot, TransitionRequest } from "./state.js";
import type { StateStore } from "./store.js";

/** The part of the host driver a reset uses. */
export type ResetHost = Pick<HostDriver, "quiesce" | "resetDatabase" | "resetTree" | "startSlot" | "healthCheck" | "readStamp">;

/** A flavor's golden: the tree a slot is mirrored from and the backup its database is restored from. */
export interface GoldenSet {
  readonly tree: GoldenRef;
  readonly backup: BackupRef;
}

export interface ResetDeps {
  readonly store: StateStore;
  readonly host: ResetHost;
  /** The flavor's golden tree and backup (tickets 28, 30 and 31). */
  readonly golden: (flavor: FlavorKey) => Promise<GoldenSet>;
  /** `max_resets` comes from here; defaults to `DEFAULT_CONFIG`. */
  readonly config?: ArashouseConfig;
  /** The pid recorded on the slot while this process resets it; defaults to this process. */
  readonly pid?: number;
  /** The start time recorded with the pid; defaults to this process's. */
  readonly startTime?: string | null;
  /** Whether another reset's worker still runs; defaults to a process check. */
  readonly isWorkerAlive?: ResetWorkerAlive;
  readonly now?: () => Date;
}

/** The flavor's golden manifest hash now, or undefined when the host cannot name it. */
export async function currentGoldenHash(golden: ResetDeps["golden"], flavor: FlavorKey): Promise<string | undefined> {
  try {
    return (await golden(flavor)).tree.hash;
  } catch (err) {
    if (isHostError(err)) return undefined;
    throw err;
  }
}

export const RESET_STEPS = ["golden", "quiesce", "database", "tree", "start", "health"] as const;
export type ResetStep = (typeof RESET_STEPS)[number];

/** A slot whose reset has been started this many times without finishing is quarantined, not started again. */
export const MAX_RESET_ATTEMPTS = 3;

/** Room for the step and the error in a quarantine reason (state.ts allows 500 characters). */
const MAX_REASON = 480;

export type ResetOutcome =
  | { readonly kind: "free"; readonly slot: string; readonly ms: number }
  | { readonly kind: "quarantined"; readonly slot: string; readonly step: ResetStep | null; readonly reason: string }
  /** The host did not answer: the slot is `dirty` again and a later reset tries again. */
  | { readonly kind: "dirty"; readonly slot: string; readonly reason: string }
  /** Another process took the slot over (this worker was judged dead, or an operator moved it); nothing more was done. */
  | { readonly kind: "lost"; readonly slot: string; readonly reason: string }
  /** The reset did not start: the slot was not dirty, or `max_resets` resets were running. */
  | { readonly kind: "not-started"; readonly slot: string; readonly reason: string };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clip(text: string): string {
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 3)}...` : text;
}

function isDeadReset(slot: Slot, isAlive: ResetWorkerAlive): boolean {
  return slot.status === "resetting" && (slot.reset === undefined || !isAlive(slot.reset.pid, slot.reset.start_time ?? null));
}

/**
 * Sends every `resetting` slot whose worker has ended back to `dirty`, so it is reset again from the
 * start. Returns the slots it moved. Cheap when there is nothing to do: the lock is taken only if the
 * unlocked state shows a dead reset.
 */
export async function recoverDeadResets(store: StateStore, isAlive: ResetWorkerAlive = isResetWorkerAlive): Promise<string[]> {
  const seen = Object.values((await store.read()).slots).filter((s) => isDeadReset(s, isAlive));
  if (seen.length === 0) return [];
  return store.update((tx) => {
    const moved: string[] = [];
    for (const slot of Object.values(tx.snapshot())) {
      if (!isDeadReset(slot, isAlive)) continue;
      tx.transition(slot.id, { to: "dirty", crashed: true }, `reset worker ${slot.reset?.pid ?? "?"} ended before the reset finished`);
      moved.push(slot.id);
    }
    return moved;
  });
}

/**
 * Resets one `dirty` slot in this process: recovers dead resets, takes the slot through the reset
 * cap, and runs the sequence. The same code runs in the reset worker and in `get`'s lazy path.
 */
export async function resetSlot(deps: ResetDeps, id: string): Promise<ResetOutcome> {
  const isAlive = deps.isWorkerAlive ?? isResetWorkerAlive;
  await recoverDeadResets(deps.store, isAlive);
  const pid = deps.pid ?? process.pid;
  const started = await beginReset(deps.store, id, {
    pid,
    startTime: deps.startTime !== undefined ? deps.startTime : processStartTime(pid),
    maxResets: (deps.config ?? DEFAULT_CONFIG).max_resets,
    isAlive,
  });
  if (!started.started) return { kind: "not-started", slot: id, reason: started.reason };
  return runReset(deps, started.slot);
}

/**
 * The reset worker (`arashouse reset-worker`): resets `first` if given, then every other dirty slot
 * it can, lowest id first, each at most once. It stops when none is left, when `max_resets` resets
 * are running (those workers carry on with the rest), or when the host does not answer.
 */
export async function runResetWorker(deps: ResetDeps, first?: string): Promise<ResetOutcome[]> {
  const outcomes: ResetOutcome[] = [];
  const tried = new Set<string>();
  let next = first;
  for (;;) {
    if (next === undefined) {
      const dirty = Object.values((await deps.store.read()).slots)
        .filter((s) => s.status === "dirty" && !tried.has(s.id))
        .map((s) => s.id)
        .sort();
      next = dirty[0];
      if (next === undefined) return outcomes;
    }
    tried.add(next);
    const outcome = await resetSlot(deps, next);
    outcomes.push(outcome);
    if (outcome.kind === "dirty") return outcomes;
    // Still dirty after a refusal means the cap is full: the running resets drain the rest.
    if (outcome.kind === "not-started" && (await deps.store.read()).slots[next]?.status === "dirty") return outcomes;
    next = undefined;
  }
}

type StepResult = { readonly ok: true } | { readonly ok: false; readonly outcome: ResetOutcome };

/** Runs the reset sequence on `slot`, which this process has just moved to `resetting`. */
export async function runReset(deps: ResetDeps, slot: Slot): Promise<ResetOutcome> {
  const { store, host } = deps;
  const owner = slot.reset;
  if (slot.status !== "resetting" || owner === undefined) {
    return { kind: "not-started", slot: slot.id, reason: `slot ${slot.id} is ${slot.status}, not resetting` };
  }
  const now = deps.now ?? (() => new Date());
  const started = now().getTime();

  const owns = (current: Slot | undefined): current is Slot =>
    current?.status === "resetting" && current.reset?.pid === owner.pid && current.reset.started_at === owner.started_at;

  /** Moves the slot on, under the lock, only while this reset still owns it. */
  const settle = async (request: TransitionRequest, note: string | undefined, outcome: ResetOutcome): Promise<ResetOutcome> => {
    const moved = await store.update((tx) => {
      if (!owns(tx.slot(slot.id))) return false;
      tx.transition(slot.id, request, note);
      return true;
    });
    return moved ? outcome : lost(slot.id);
  };
  const quarantine = (step: ResetStep | null, why: string) => {
    const reason = clip(redact(step === null ? why : `reset step ${step} ${why}`));
    return settle({ to: "quarantined", reason }, undefined, { kind: "quarantined", slot: slot.id, step, reason });
  };

  if (owner.attempt > MAX_RESET_ATTEMPTS) {
    return quarantine(null, `reset started ${owner.attempt} times without finishing`);
  }

  /**
   * The slot as the state now records it, re-derived before every destructive step: still this
   * reset's, and its name parses to the flavor and number the record carries (ticket 10).
   */
  const target = async (): Promise<SlotRef | null> => {
    const current = (await store.read()).slots[slot.id];
    if (!owns(current)) return null;
    const ref = parseSlotId(current.id);
    if (ref.flavor !== current.flavor || ref.slot !== current.number || slotId(ref) !== slot.id) {
      throw new Error(`slot record ${current.id} does not match its own name`);
    }
    return ref;
  };

  let golden: GoldenSet | undefined;
  const actions: Record<ResetStep, (ref: SlotRef) => Promise<HostResult>> = {
    golden: async (ref) => {
      const set = await deps.golden(ref.flavor);
      if (set.tree.flavor !== ref.flavor || set.backup.flavor !== ref.flavor) return notOk(`the golden is not the ${ref.flavor} golden`);
      if (set.tree.hash !== set.backup.hash) return notOk("the golden tree and backup carry different hashes");
      golden = set;
      return { ok: true, ms: 0, detail: `golden ${set.tree.hash.slice(0, 12)}` };
    },
    quiesce: (ref) => host.quiesce(ref),
    database: (ref) => host.resetDatabase(ref, (golden as GoldenSet).backup),
    tree: (ref) => host.resetTree(ref, (golden as GoldenSet).tree),
    start: (ref) => host.startSlot(ref, { agent: false }),
    health: async (ref) => {
      const health = await host.healthCheck(ref);
      if (!health.ok) return health;
      const { stamp } = await host.readStamp(ref);
      const hash = (golden as GoldenSet).tree.hash;
      if (stamp === null) return notOk("the slot has no stamp");
      if (stamp.goldenHash !== hash) return notOk("the stamp does not carry the golden hash");
      if (stamp.leaseId) return notOk("the stamp still names a lease");
      if (!stamp.lastResetAt) return notOk("the stamp records no reset");
      return health;
    },
  };

  const runStep = async (step: ResetStep): Promise<StepResult> => {
    let failure = "";
    let unreachable = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const ref = await target();
        if (ref === null) return { ok: false, outcome: lost(slot.id) };
        const result = await actions[step](ref);
        if (result.ok) return { ok: true };
        failure = result.detail;
        unreachable = false;
      } catch (err) {
        // A guard refusal or a slot the host says is beyond retrying is quarantined at once.
        if (isHostError(err, "Refused") || isHostError(err, "Quarantine")) {
          return { ok: false, outcome: await quarantine(step, `was refused: ${errorText(err)}`) };
        }
        failure = errorText(err);
        unreachable = isHostError(err, "Unreachable") || (step === "golden" && isHostError(err, "Retryable"));
        if (unreachable && !isHostError(err, "Unreachable")) break;
      }
    }
    if (unreachable) {
      const reason = clip(redact(`reset step ${step}: ${step === "golden" ? "the golden could not be read" : "the host did not answer"}: ${failure}`));
      return { ok: false, outcome: await settle({ to: "dirty" }, reason, { kind: "dirty", slot: slot.id, reason }) };
    }
    return { ok: false, outcome: await quarantine(step, `failed twice: ${failure}`) };
  };

  for (const step of RESET_STEPS) {
    const result = await runStep(step);
    if (!result.ok) return result.outcome;
  }
  const ms = Math.max(0, now().getTime() - started);
  const hash = (golden as GoldenSet).tree.hash;
  if ((await currentGoldenHash(deps.golden, slot.flavor)) !== hash) {
    const reason = "the golden changed during the reset";
    return settle({ to: "dirty" }, reason, { kind: "dirty", slot: slot.id, reason });
  }
  return settle({ to: "free", golden_hash: (golden as GoldenSet).tree.hash, reset_ms: ms }, "reset", { kind: "free", slot: slot.id, ms });
}

function notOk(detail: string): HostResult {
  return { ok: false, ms: 0, detail };
}

function lost(id: string): ResetOutcome {
  return { kind: "lost", slot: id, reason: `slot ${id} is no longer this reset's (its worker was judged dead, or an operator moved it)` };
}

/** One line for a reset's outcome, for the worker's output and the event log. */
export function describeOutcome(outcome: ResetOutcome): string {
  switch (outcome.kind) {
    case "free":
      return `${outcome.slot} reset in ${(outcome.ms / 1000).toFixed(1)} s; free`;
    case "quarantined":
      return `${outcome.slot} quarantined: ${outcome.reason}`;
    case "dirty":
    case "lost":
    case "not-started":
      return `${outcome.slot} not reset: ${outcome.reason}`;
  }
}

/**
 * The reset policy as the lease operations take it (`LeaseDeps.reset`): `startWorker` is how this
 * process starts a detached worker; a lazy reset runs `resetSlot` here. A host that does not answer
 * fails the `get` with exit 6 rather than leaving it to wait.
 */
export function resetHooks(deps: ResetDeps, startWorker: (slot: string) => void): ResetHooks {
  return {
    startWorker,
    recover: async () => void (await recoverDeadResets(deps.store, deps.isWorkerAlive ?? isResetWorkerAlive)),
    resetNow: async (slot) => {
      const outcome = await resetSlot(deps, slot);
      if (outcome.kind === "dirty") throw new HostUnreachableError(outcome.reason);
      return outcome.kind === "free" ? "free" : outcome.kind === "not-started" ? "busy" : "failed";
    },
  };
}
