// The lease operations, modelled on `treehouse get/return/status`: `getLease`, `returnLease` and
// `leaseStatus`, over the state store (store.ts) and the host driver (src/host, through the narrow
// `LeaseHost` view of it). No daemon: every change is one locked update of the state file.
//
// The captain's rule governs `returnLease`: it marks the slot `dirty`, starts a detached reset
// worker and exits. It does not reset and does not wait for one; arashouse will not hand the slot
// out again until it is clean. When the reset runs is ticket 14's (reset.ts, docs/reset.md): the
// worker, or a `get` that finds no free slot and resets a dirty one itself. Nothing here keeps lease
// data past the return: the per-lease password goes to the secret store and is deleted when the
// lease is returned.

import { randomBytes } from "node:crypto";
import { setTimeout as sleepMs } from "node:timers/promises";
import type { HostDriver, HostInfo, SlotStamp } from "../host/driver.js";
import { isHostError } from "../host/errors.js";
import { hostAddress, slotUrl } from "../host/url.js";
import { EXIT_CODES, type ExitCode } from "./exit-codes.js";
import { FLAVOR_KEYS, type FlavorKey, getFlavor, isFlavorKey } from "./flavors.js";
import { databaseName, parseSlotId, slotId, webAlias } from "./names.js";
import { redact } from "./redact.js";
import { Secret } from "./secret.js";
import { type SecretStore } from "./secret-store.js";
import { type ArashouseConfig, DEFAULT_CONFIG } from "./config.js";
import { type Governor, isWaiterAlive, liveWaiters, poolGovernor, waiterProcess } from "./governor.js";
import { type Lease, SLOT_STATUSES, type Slot, type SlotStatus, type State, type Waiter, isLeaseId } from "./state.js";
import { type StateStore } from "./store.js";

/** The Aras user a lease's password is for. */
export const LEASE_USER = "root";

/** How often `get --wait` and `return --wait` look at the state. */
export const DEFAULT_POLL_MS = 1_000;

const MAX_HOLDER = 500;

/** The part of the host driver the lease operations use. */
export type LeaseHost = Pick<HostDriver, "hostInfo" | "readStamp" | "writeStamp" | "healthCheck" | "setLeaseCredentials">;

/** A queue ticket stays valid this long past its caller's deadline, so a slow last poll keeps its place. */
const TICKET_GRACE_MS = 30_000;

// ---- errors, each with its stable exit code ----------------------------------------------------------

export class LeaseError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UsageError extends LeaseError {
  constructor(message: string) {
    super(EXIT_CODES.usage, message);
  }
}

export class NoSlotAvailableError extends LeaseError {
  constructor(message: string) {
    super(EXIT_CODES.noSlot, message);
  }
}

export class LeaseMismatchError extends LeaseError {
  constructor(slot: string) {
    super(EXIT_CODES.leaseMismatch, `slot ${slot} is not held by that lease (it was returned and leased again); nothing was changed`);
  }
}

export class ResetFailedError extends LeaseError {
  constructor(message: string) {
    super(EXIT_CODES.resetFailed, message);
  }
}

export class HostUnreachableError extends LeaseError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(EXIT_CODES.hostUnreachable, message, options);
  }
}

export class GuardRefusedError extends LeaseError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(EXIT_CODES.refused, message, options);
  }
}

/** A host failure as the lease error the CLI exits with; anything else comes back unchanged. */
export function asLeaseError(err: unknown): unknown {
  if (err instanceof LeaseError || !isHostError(err)) return err;
  const message = redact(err.message);
  return err.kind === "Refused" ? new GuardRefusedError(message, { cause: err }) : new HostUnreachableError(`host ${err.kind}: ${message}`, { cause: err });
}

/** The exit code for an error thrown by a lease operation; 1 for anything that is not one of the table's. */
export function exitCodeFor(err: unknown): number {
  const mapped = asLeaseError(err);
  return mapped instanceof LeaseError ? mapped.exitCode : 1;
}

// ---- dependencies ----------------------------------------------------------------------------------

/** How a lazy reset in `get` ended: the slot is `free`, it could not start (`busy`), or it `failed`. */
export type LazyResetResult = "free" | "busy" | "failed";

/** The reset policy as the lease operations see it (reset.ts implements it; ticket 14). */
export interface ResetHooks {
  /** Starts a detached reset worker for the slot and returns at once. Best effort: a lazy reset covers a failure. */
  startWorker(slot: string): void;
  /** Resets a dirty slot in this process and resolves when the reset has ended. */
  resetNow(slot: string): Promise<LazyResetResult>;
  /** Sends `resetting` slots whose worker has ended back to `dirty`. */
  recover(): Promise<void>;
}

export interface LeaseDeps {
  readonly store: StateStore;
  readonly host: LeaseHost;
  /** Where the per-lease password is kept for `run --lease` (the CLI's `LeaseFileStore`); deleted on return. */
  readonly secrets: SecretStore;
  /** The URL of a slot as seen from WSL, from its web alias. Defaults to the discovered host address (ticket 29). */
  readonly resolveUrl?: (alias: string) => Promise<string>;
  /** The pool's limits (`loadConfig`); defaults to `DEFAULT_CONFIG`. */
  readonly config?: ArashouseConfig;
  /** The reset policy: `return` starts a worker, `get` resets lazily. Without it nothing here starts a reset. */
  readonly reset?: ResetHooks;
  /** Defaults to `poolGovernor(config)`. */
  readonly governor?: Governor;
  /** Whether a queued caller still runs; defaults to a process check. A dead caller's ticket is dropped. */
  readonly isWaiterAlive?: (waiter: Waiter) => boolean;
  /** The pid recorded on this caller's queue ticket; defaults to this process. */
  readonly pid?: number;
  /** A fresh per-lease password; defaults to 128 random bits, URL-safe. */
  readonly newPassword?: () => Secret;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
}

const defaultResolveUrl = async (alias: string): Promise<string> => slotUrl(await hostAddress(alias), alias);

function defaultPassword(): Secret {
  return Secret.of(randomBytes(16).toString("base64url"), "lease-password");
}

/** The secret-store name of a lease's password. */
export function leaseSecretName(leaseId: string): string {
  if (!isLeaseId(leaseId)) throw new Error("a lease id is 32 lower-case hex characters");
  return `lease-${leaseId}`;
}

/** The first 8 characters of a lease id: enough to tell leases apart, not enough to use one. */
export function leaseRef(leaseId: string): string {
  return leaseId.slice(0, 8);
}

function clock(deps: LeaseDeps): () => number {
  const now = deps.now ?? (() => new Date());
  return () => now().getTime();
}

// ---- get ---------------------------------------------------------------------------------------------

export interface GetRequest {
  readonly flavor: string;
  /** Who is taking the lease: the task or crewmate name. Two `get` calls from one holder get two slots. */
  readonly holder: string;
  /** Seconds to wait for a slot; 0 or absent fails at once when none can be handed out. */
  readonly waitSeconds?: number;
}

/** What `get` hands back. The password is a `Secret`: it is shown once, by `renderGetJson`. */
export interface LeaseGrant {
  readonly slot: string;
  readonly flavor: FlavorKey;
  /** The server build; null until the flavor's baseline has been built (ticket 24). */
  readonly aras: string | null;
  readonly engine: string;
  readonly url: string;
  readonly database: string;
  readonly user: string;
  readonly lease_id: string;
  readonly holder: string;
  readonly password: Secret;
}

/** The `get --json` contract (docs/schemas/get.schema.json). */
export interface GetJson {
  readonly slot: string;
  readonly flavor: FlavorKey;
  readonly aras: string | null;
  readonly engine: string;
  readonly url: string;
  readonly database: string;
  readonly user: string;
  readonly lease_id: string;
  readonly holder: string;
  readonly password: string;
}

/** The one place the password becomes text: the JSON `get --json` prints, once. */
export function renderGetJson(grant: LeaseGrant): GetJson {
  return {
    slot: grant.slot,
    flavor: grant.flavor,
    aras: grant.aras,
    engine: grant.engine,
    url: grant.url,
    database: grant.database,
    user: grant.user,
    lease_id: grant.lease_id,
    holder: grant.holder,
    password: grant.password.reveal(),
  };
}

function checkHolder(holder: unknown): string {
  // eslint-disable-next-line no-control-regex
  if (typeof holder !== "string" || holder.trim().length === 0 || holder.length > MAX_HOLDER || /[\u0000-\u001f\u007f]/.test(holder)) {
    throw new UsageError(`--holder must be 1 to ${MAX_HOLDER} characters, without control characters`);
  }
  return holder;
}

function checkWait(label: string, seconds: number | undefined): number {
  if (seconds === undefined) return 0;
  if (typeof seconds !== "number" || Number.isNaN(seconds) || seconds < 0) throw new UsageError(`${label} must be a number of seconds, 0 or more`);
  return seconds;
}

function tally(slots: readonly Slot[]): Record<SlotStatus, number> {
  const counts = Object.fromEntries(SLOT_STATUSES.map((s) => [s, 0])) as Record<SlotStatus, number>;
  for (const slot of slots) counts[slot.status]++;
  return counts;
}

/** Why no slot of the flavor can be handed out, for the exit-3 message. */
function describeNone(flavor: FlavorKey, slots: readonly Slot[]): string {
  if (slots.length === 0) return `no ${flavor} slot is provisioned`;
  const c = tally(slots);
  const parts = [`${c.leased} leased`, `${c.resetting} resetting`, `${c.quarantined} quarantined`];
  for (const status of ["dirty", "provisioning", "disabled"] as const) if (c[status] > 0) parts.push(`${c[status]} ${status}`);
  return `no ${flavor} slot is free: ${slots.length} slot${slots.length === 1 ? "" : "s"}, ${parts.join(", ")}`;
}

export type Clean = { readonly clean: true; readonly stamp: SlotStamp } | { readonly clean: false; readonly reason: string };

/**
 * The dirty check that runs before a free slot is handed out (ticket 32 owns the markers): the
 * stamp must carry the golden hash the state recorded and no lease, and the host's health check
 * (tree, database marker and applications against that stamp) must pass.
 */
export async function checkClean(host: Pick<LeaseHost, "readStamp" | "healthCheck">, slot: Slot): Promise<Clean> {
  const ref = { flavor: slot.flavor, slot: slot.number };
  const { stamp } = await host.readStamp(ref);
  if (stamp === null) return { clean: false, reason: "the slot has no stamp" };
  if (slot.golden_hash === null || stamp.goldenHash !== slot.golden_hash) {
    return { clean: false, reason: "the stamp does not carry the golden hash the state recorded" };
  }
  if (stamp.leaseId) return { clean: false, reason: "the stamp still names a lease" };
  if (!stamp.lastResetAt) return { clean: false, reason: "the stamp records no reset" };
  const health = await host.healthCheck(ref);
  if (!health.ok) return { clean: false, reason: `health check failed: ${redact(health.detail)}` };
  return { clean: true, stamp };
}

type Attempt =
  | { readonly kind: "granted"; readonly grant: LeaseGrant }
  /** Try again at once: another `get` took the slot, or this one was found dirty or unfit. */
  | { readonly kind: "retry" }
  | { readonly kind: "none"; readonly message: string }
  /** None is free, but `slot` is dirty: reset it (ticket 14's lazy reset) and look again. */
  | { readonly kind: "reset"; readonly slot: string; readonly message: string };

/**
 * Takes a lease on a free slot of `request.flavor` and returns what the holder needs to reach it.
 * `waitSeconds` > 0 takes a queue ticket and polls for a slot up to that long, served in ticket
 * order; otherwise a call that finds none, or that the governor refuses, fails at once with exit 3
 * and the reason.
 *
 * With `deps.reset`, a call that finds no free slot of the flavor but a dirty one resets it: inline
 * when it may wait (the reset runs to its end, even past the deadline, and the slot is then tried),
 * through a detached worker when it may not. A slot whose lazy reset failed is not tried again by
 * the same call.
 */
export async function getLease(deps: LeaseDeps, request: GetRequest): Promise<LeaseGrant> {
  if (!isFlavorKey(request.flavor)) throw new UsageError(`unknown flavor "${String(request.flavor)}"; the flavors are ${FLAVOR_KEYS.join(", ")}`);
  const flavor = request.flavor;
  const holder = checkHolder(request.holder);
  const waitMs = checkWait("--wait", request.waitSeconds) * 1000;
  const now = clock(deps);
  const sleep = deps.sleep ?? ((ms: number) => sleepMs(ms));
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const deadline = now() + waitMs;
  const skipped = new Set<string>();
  const lazyFailed = new Set<string>();
  const ticket = waitMs > 0 ? await joinQueue(deps, flavor, holder, deadline) : null;
  let granted = false;
  try {
    for (;;) {
      const attempt = await attemptGet(deps, flavor, holder, ticket, skipped, lazyFailed);
      if (attempt.kind === "granted") {
        granted = true;
        return attempt.grant;
      }
      if (attempt.kind === "retry") continue;
      if (attempt.kind === "reset" && deps.reset) {
        if (waitMs > 0) {
          const ended = await deps.reset.resetNow(attempt.slot);
          if (ended === "free") continue;
          if (ended === "failed") lazyFailed.add(attempt.slot);
        } else {
          startWorker(deps, attempt.slot);
        }
      }
      const left = deadline - now();
      if (left <= 0) throw new NoSlotAvailableError(attempt.message);
      skipped.clear();
      await sleep(Math.min(pollMs, left));
    }
  } finally {
    // A granted lease left the queue in the same update that leased the slot.
    if (ticket !== null && !granted) await deps.store.update((tx) => void tx.leaveQueue(ticket, "stopped waiting")).catch(() => undefined);
  }
}

/** Puts a `get --wait` caller in the queue; its ticket holds its place until a little past `deadline`. */
async function joinQueue(deps: LeaseDeps, flavor: FlavorKey, holder: string, deadline: number): Promise<number> {
  const expires = deadline + TICKET_GRACE_MS;
  const waiter = await deps.store.update((tx) =>
    tx.joinQueue({
      flavor,
      holder,
      ...waiterProcess(deps.pid),
      expires_at: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
    }),
  );
  return waiter.ticket;
}

async function attemptGet(
  deps: LeaseDeps,
  flavor: FlavorKey,
  holder: string,
  ticket: number | null,
  skipped: Set<string>,
  lazyFailed: Set<string>,
): Promise<Attempt> {
  const { store, host } = deps;
  const nowDate = deps.now ?? (() => new Date());
  const isAlive = deps.isWaiterAlive ?? isWaiterAlive;
  const governor = deps.governor ?? poolGovernor(deps.config ?? DEFAULT_CONFIG);
  const state = await store.read();
  const ofFlavor = Object.values(state.slots)
    .filter((s) => s.flavor === flavor)
    .sort((a, b) => a.number - b.number);
  const candidate = ofFlavor.find((s) => s.status === "free" && !skipped.has(s.id));
  if (!candidate) return noneOrReset(deps, flavor, lazyFailed);

  // The host's free RAM, then a first word from the governor on the unlocked state, so a caller
  // that is refused (or queued behind others) does not probe a slot it cannot have.
  let info: HostInfo;
  try {
    info = (await host.hostInfo()).info;
  } catch (err) {
    if (isHostError(err, "Retryable")) return { kind: "none", message: `the host is busy: ${redact(errorText(err))}` };
    throw asLeaseError(err);
  }
  const refusal = (reason: string): Attempt => ({ kind: "none", message: `${reason}: no ${flavor} slot can be leased now` });
  const early = await governor.check({
    slots: Object.values(state.slots),
    flavor,
    holder,
    queue: liveWaiters(state.queue, nowDate(), isAlive),
    ticket,
    host: info,
  });
  if (!early.ok) return refusal(early.reason);

  // Verify outside the lock: it asks the host, and a free slot is touched by nothing else.
  let stamp: SlotStamp;
  try {
    const verdict = await checkClean(host, candidate);
    if (!verdict.clean) {
      await moveIfStillFree(store, candidate, { to: "dirty" }, verdict.reason);
      return { kind: "retry" };
    }
    stamp = verdict.stamp;
  } catch (err) {
    if (isHostError(err, "Quarantine")) {
      await moveIfStillFree(store, candidate, { to: "quarantined", reason: redact(err.message) });
      return { kind: "retry" };
    }
    if (isHostError(err, "Retryable")) {
      skipped.add(candidate.id);
      return { kind: "retry" };
    }
    throw asLeaseError(err);
  }

  const reserved = await store.update(async (tx) => {
    const current = tx.slot(candidate.id);
    // The same free incarnation that was verified: not taken, and not reset or dirtied since.
    if (!current || current.status !== "free" || current.last_reset_at !== candidate.last_reset_at || current.golden_hash !== candidate.golden_hash) {
      return { kind: "taken" } as const;
    }
    // A waiter that is gone, or whose wait ran out, loses its place for good.
    const live = liveWaiters(tx.waiters(), nowDate(), isAlive);
    for (const w of tx.waiters()) if (w.ticket !== ticket && !live.includes(w)) tx.leaveQueue(w.ticket, "gone");
    const verdict = await governor.check({ slots: Object.values(tx.snapshot()), flavor, holder, queue: live, ticket, host: info });
    if (!verdict.ok) return { kind: "refused", reason: verdict.reason } as const;
    const leased = tx.transition(candidate.id, { to: "leased", holder });
    if (ticket !== null) tx.leaveQueue(ticket, "leased");
    return { kind: "reserved", lease: leased.lease as Lease } as const;
  });
  if (reserved.kind === "taken") return { kind: "retry" };
  if (reserved.kind === "refused") return refusal(reserved.reason);

  const lease = reserved.lease;
  const password = (deps.newPassword ?? defaultPassword)();
  const secretName = leaseSecretName(lease.lease_id);
  const ref = { flavor: candidate.flavor, slot: candidate.number };
  try {
    await deps.secrets.put(secretName, password);
    await host.writeStamp(ref, { ...stamp, leaseId: lease.lease_id });
    await host.setLeaseCredentials(ref, { secretRef: secretName });
    const url = await (deps.resolveUrl ?? defaultResolveUrl)(webAlias(ref));
    const flavorInfo = getFlavor(flavor);
    return {
      kind: "granted",
      grant: {
        slot: candidate.id,
        flavor,
        aras: flavorInfo.serverBuild,
        engine: flavorInfo.libsJsEngine,
        url,
        database: databaseName(ref),
        user: LEASE_USER,
        lease_id: lease.lease_id,
        holder,
        password,
      },
    };
  } catch (err) {
    // The slot may already carry this lease's stamp or credentials, so it is reset before anyone else gets it.
    const quarantine = isHostError(err, "Quarantine");
    await abandon(deps, candidate.id, lease.lease_id, quarantine ? { to: "quarantined", reason: redact(err.message) } : { to: "dirty" }, `get failed: ${redact(errorText(err))}`);
    if (quarantine) return { kind: "retry" };
    throw asLeaseError(err);
  }
}

/**
 * No free slot of the flavor: a `resetting` one whose worker has ended goes back to `dirty`, and the
 * first dirty one (not already failed in this call) is offered for a lazy reset.
 */
async function noneOrReset(deps: LeaseDeps, flavor: FlavorKey, lazyFailed: ReadonlySet<string>): Promise<Attempt> {
  if (deps.reset) await deps.reset.recover();
  const ofFlavor = Object.values((await deps.store.read()).slots)
    .filter((s) => s.flavor === flavor)
    .sort((a, b) => a.number - b.number);
  const message = describeNone(flavor, ofFlavor);
  const dirty = deps.reset ? ofFlavor.find((s) => s.status === "dirty" && !lazyFailed.has(s.id)) : undefined;
  if (!dirty) return { kind: "none", message };
  return { kind: "reset", slot: dirty.id, message: `${message}; ${dirty.id} is being reset` };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Moves a slot that is still free (and so unobserved by any lease) to dirty or quarantined; a no-op if it moved on. */
async function moveIfStillFree(
  store: StateStore,
  slot: Slot,
  request: { readonly to: "dirty" } | { readonly to: "quarantined"; readonly reason: string },
  note?: string,
): Promise<void> {
  await store.update((tx) => {
    const current = tx.slot(slot.id);
    if (current?.status === "free" && current.last_reset_at === slot.last_reset_at) tx.transition(slot.id, request, note);
  });
}

/** Undoes a lease that could not be completed: drops its password and sends the slot to reset (best effort). */
async function abandon(
  deps: LeaseDeps,
  slotId: string,
  leaseId: string,
  request: { readonly to: "dirty" } | { readonly to: "quarantined"; readonly reason: string },
  note: string,
): Promise<void> {
  await deps.secrets.delete(leaseSecretName(leaseId)).catch(() => undefined);
  const moved = await deps.store
    .update((tx) => {
      if (tx.slot(slotId)?.lease?.lease_id !== leaseId) return false;
      tx.transition(slotId, request, note);
      return true;
    })
    .catch(() => false);
  if (moved && request.to === "dirty") startWorker(deps, slotId);
}

// ---- return ------------------------------------------------------------------------------------------

export interface ReturnRequest {
  /** A slot id (`23-02`, which needs `ifLeaseId`) or a lease id. */
  readonly target: string;
  /** The lease the caller believes it holds: a return of any other lease of the slot changes nothing (exit 4). */
  readonly ifLeaseId?: string;
  /** Block until the slot is free again, up to this many seconds (`Infinity` for no limit); absent: do not wait. */
  readonly waitSeconds?: number;
}

export interface ReturnResult {
  readonly outcome: "returned" | "already-returned";
  /** The slot, when the call could tell which one it was. */
  readonly slot: string | null;
  readonly message: string;
}

type ReturnDecision =
  | { readonly kind: "returned"; readonly slot: string; readonly leaseId: string }
  | { readonly kind: "already"; readonly slot: string | null; readonly leaseId: string | null };

/**
 * Marks the caller's lease `dirty` and returns at once; it does not reset and does not wait for the
 * reset. Returning a lease that is already returned is a no-op (outcome `already-returned`). A
 * caller that names a slot must pass the lease id it holds; one that no longer holds it, because
 * the slot was returned and leased again, gets `LeaseMismatchError` and changes nothing.
 */
export async function returnLease(deps: LeaseDeps, request: ReturnRequest): Promise<ReturnResult> {
  const { store } = deps;
  const target = typeof request.target === "string" ? request.target : "";
  const ifLeaseId = request.ifLeaseId;
  if (ifLeaseId !== undefined && !isLeaseId(ifLeaseId)) throw new UsageError("--if-lease-id must be a lease id (32 lower-case hex characters)");
  const wait = request.waitSeconds === undefined ? undefined : checkWait("--wait", request.waitSeconds);
  let slotName: string | undefined;
  let byLease: string | undefined;
  if (isLeaseId(target)) {
    if (ifLeaseId !== undefined && ifLeaseId !== target) throw new UsageError("--if-lease-id disagrees with the lease id given to return");
    byLease = target;
  } else {
    try {
      slotName = slotId(parseSlotId(target));
    } catch {
      throw new UsageError(`"${target}" is neither a slot id (<flavor>-<NN>) nor a lease id`);
    }
    if (ifLeaseId === undefined) throw new UsageError("returning by slot name needs --if-lease-id, so a stale caller cannot return a later lease");
  }
  const expected = byLease ?? (ifLeaseId as string);

  const decision = await store.update<ReturnDecision>((tx) => {
    const slot = slotName !== undefined ? tx.slot(slotName) : Object.values(tx.snapshot()).find((s) => s.lease?.lease_id === byLease);
    if (!slot) {
      if (slotName !== undefined) throw new UsageError(`no slot "${slotName}" in the pool`);
      return { kind: "already", slot: null, leaseId: expected };
    }
    if (slot.status !== "leased" || !slot.lease) return { kind: "already", slot: slot.id, leaseId: expected };
    if (slot.lease.lease_id !== expected) throw new LeaseMismatchError(slot.id);
    tx.transition(slot.id, { to: "dirty" }, "returned");
    return { kind: "returned", slot: slot.id, leaseId: expected };
  });

  if (decision.leaseId !== null) await deps.secrets.delete(leaseSecretName(decision.leaseId)).catch(() => undefined);
  if (decision.kind === "returned") startWorker(deps, decision.slot);
  const result: ReturnResult =
    decision.kind === "returned"
      ? { outcome: "returned", slot: decision.slot, message: `returned ${decision.slot}; it is reset before it is handed out again` }
      : { outcome: "already-returned", slot: decision.slot, message: "already returned" };
  if (wait !== undefined && result.slot !== null) await waitForReset(deps, result.slot, decision.leaseId as string, wait);
  return result;
}

/** Starts the reset worker for a slot just marked dirty; never fails the caller. */
function startWorker(deps: LeaseDeps, slot: string): void {
  try {
    deps.reset?.startWorker(slot);
  } catch {
    // A slot left dirty is reset by the next worker or lazily by `get`.
  }
}

/** Blocks until `slotId`, returned with `leaseId`, is free again; a quarantined, disabled or timed-out slot throws exit 5. */
async function waitForReset(deps: LeaseDeps, slotId: string, leaseId: string, seconds: number): Promise<void> {
  const now = clock(deps);
  const sleep = deps.sleep ?? ((ms: number) => sleepMs(ms));
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const deadline = now() + seconds * 1000;
  for (;;) {
    const slot = (await deps.store.read()).slots[slotId];
    if (!slot) throw new ResetFailedError(`slot ${slotId} is no longer in the pool`);
    // Leased again by someone else means it went through free in between.
    if (slot.status === "free" || (slot.status === "leased" && slot.lease?.lease_id !== leaseId)) return;
    if (slot.status === "quarantined") throw new ResetFailedError(`slot ${slotId} is quarantined: ${slot.quarantine_reason ?? "reset failed"}`);
    if (slot.status === "disabled") throw new ResetFailedError(`slot ${slotId} was disabled before its reset finished`);
    const left = deadline - now();
    if (left <= 0) throw new ResetFailedError(`slot ${slotId} was not free again within ${seconds} s (${slot.status})`);
    await sleep(Math.min(pollMs, left));
  }
}

// ---- status ------------------------------------------------------------------------------------------

export interface StatusRow {
  readonly slot: string;
  readonly flavor: FlavorKey;
  readonly status: SlotStatus;
  readonly holder: string | null;
  /** The first 8 characters of the lease id: not enough to return, run against or identify the full lease. */
  readonly lease: string | null;
  readonly leased_at: string | null;
  readonly lease_age_seconds: number | null;
  readonly last_reset_at: string | null;
  readonly last_reset_ms: number | null;
  readonly quarantine_reason: string | null;
}

export type FlavorTotals = { readonly total: number } & Readonly<Record<SlotStatus, number>>;

/** A `get --wait` caller in the queue, as `status` shows it. */
export interface QueueRow {
  readonly ticket: number;
  readonly flavor: FlavorKey;
  readonly holder: string;
  readonly queued_at: string;
}

/** The `status --json` contract (docs/schemas/status.schema.json). */
export interface StatusReport {
  readonly generated_at: string;
  readonly max_active: { readonly limit: number; readonly in_use: number };
  /** `in_use` counts the `resetting` slots. */
  readonly max_resets: { readonly limit: number; readonly in_use: number };
  readonly slots: readonly StatusRow[];
  readonly flavors: Readonly<Record<FlavorKey, FlavorTotals>>;
  /** The live `get --wait` callers, first served first. */
  readonly queue: readonly QueueRow[];
}

export interface StatusOptions {
  readonly now: Date;
  readonly config?: ArashouseConfig;
  readonly isWaiterAlive?: (waiter: Waiter) => boolean;
}

/** The report for `state`. It carries no password and no lease id beyond its 8-character reference. */
export function buildStatus(state: State, options: StatusOptions): StatusReport {
  const config = options.config ?? DEFAULT_CONFIG;
  const slots = Object.values(state.slots).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rows: StatusRow[] = slots.map((s) => {
    const leasedAt = s.lease ? Date.parse(s.lease.leased_at) : Number.NaN;
    return {
      slot: s.id,
      flavor: s.flavor,
      status: s.status,
      holder: s.lease?.holder ?? null,
      lease: s.lease ? leaseRef(s.lease.lease_id) : null,
      leased_at: s.lease?.leased_at ?? null,
      lease_age_seconds: Number.isNaN(leasedAt) ? null : Math.max(0, Math.floor((options.now.getTime() - leasedAt) / 1000)),
      last_reset_at: s.last_reset_at,
      last_reset_ms: s.last_reset_ms,
      quarantine_reason: s.quarantine_reason ?? null,
    };
  });
  const flavors = Object.fromEntries(
    FLAVOR_KEYS.map((key) => {
      const ofFlavor = slots.filter((s) => s.flavor === key);
      return [key, { total: ofFlavor.length, ...tally(ofFlavor) }];
    }),
  ) as Record<FlavorKey, FlavorTotals>;
  return {
    generated_at: options.now.toISOString(),
    max_active: { limit: config.max_active, in_use: slots.filter((s) => s.status === "leased").length },
    max_resets: { limit: config.max_resets, in_use: slots.filter((s) => s.status === "resetting").length },
    slots: rows,
    flavors,
    queue: liveWaiters(state.queue, options.now, options.isWaiterAlive ?? isWaiterAlive).map((w) => ({
      ticket: w.ticket,
      flavor: w.flavor,
      holder: w.holder,
      queued_at: w.queued_at,
    })),
  };
}

/** Reads the state (without the lock; the file is only ever replaced whole) and reports it. */
export async function leaseStatus(deps: Pick<LeaseDeps, "store" | "now" | "config" | "isWaiterAlive">): Promise<StatusReport> {
  const state = await deps.store.read();
  return buildStatus(state, { now: (deps.now ?? (() => new Date()))(), config: deps.config, isWaiterAlive: deps.isWaiterAlive });
}

/** A lease held this long is marked "old" in the human `status`; nothing reclaims it (no expiry, the captain's answer 5). */
export const OLD_LEASE_SECONDS = 24 * 3600;

/** `2h13m`, `4m05s`, `37s`. */
export function formatAge(seconds: number): string {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** The human `status` output: one row per slot, then the totals. */
export function formatStatus(report: StatusReport): string[] {
  const cell = (s: string | null, fallback = "-") => (s === null || s === "" ? fallback : s);
  const table: string[][] = [["SLOT", "FLAVOR", "STATUS", "HOLDER", "LEASE", "AGE", "LAST RESET"]];
  for (const r of report.slots) {
    table.push([
      r.slot,
      r.flavor,
      r.status,
      cell(r.holder),
      cell(r.lease),
      r.lease_age_seconds === null ? "-" : `${formatAge(r.lease_age_seconds)}${r.lease_age_seconds >= OLD_LEASE_SECONDS ? " old" : ""}`,
      r.last_reset_ms === null ? "-" : `${(r.last_reset_ms / 1000).toFixed(1)}s`,
    ]);
  }
  const widths = table[0]!.map((_, i) => Math.max(...table.map((row) => (row[i] ?? "").length)));
  const lines = table.map((row) => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd());
  for (const r of report.slots) if (r.quarantine_reason !== null) lines.push(`quarantined ${r.slot}: ${r.quarantine_reason}`);
  for (const r of report.slots) {
    if (r.lease_age_seconds === null || r.lease_age_seconds < OLD_LEASE_SECONDS) continue;
    lines.push(
      `old lease ${r.slot}: held by ${cell(r.holder)} for ${formatAge(r.lease_age_seconds)}; nothing reclaims it. If its holder is gone: arashouse force-return ${r.slot} --lease-id ${cell(r.lease)} --yes`,
    );
  }
  for (const key of FLAVOR_KEYS) {
    const t = report.flavors[key];
    lines.push(`${key}: ${t.free} free of ${t.total} (${t.leased} leased, ${t.dirty} dirty, ${t.resetting} resetting, ${t.quarantined} quarantined)`);
  }
  lines.push(`max_active: ${report.max_active.in_use} of ${report.max_active.limit} in use`);
  lines.push(`max_resets: ${report.max_resets.in_use} of ${report.max_resets.limit} running`);
  if (report.queue.length > 0) {
    lines.push(`queue: ${report.queue.map((w) => `#${w.ticket} ${w.flavor} ${w.holder}`).join(", ")}`);
  }
  return lines;
}
