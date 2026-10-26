// The lease state: slot records, the status machine and the (de)serialiser of the state file.
// Pure: no file or host I/O. The store (store.ts) owns the file, the lock and the event log.
// The file holds no secret: the serialiser writes a fixed set of fields, so nothing else a caller
// attaches to a record reaches the bytes, and `bootstrap` refuses secret-looking keys.

import { randomBytes } from "node:crypto";
import { type FlavorKey, isFlavorKey } from "./flavors.js";
import { type SlotRef, parseSlotId, slotId } from "./names.js";

export const STATE_VERSION = 1;

export const SLOT_STATUSES = [
  "provisioning",
  "free",
  "leased",
  "dirty",
  "resetting",
  "quarantined",
  "disabled",
] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

/** A lease id: 128 random bits, hex. */
const LEASE_ID = /^[0-9a-f]{32}$/;

/** The holder recorded for a lease found only through a slot stamp (`doctor --rebuild-state`). */
export const RECOVERED_HOLDER = "unknown (recovered)";

const MAX_TEXT = 500;

/** One scalar per key: enough to say what a lease was bootstrapped with, never a place for a secret. */
export type BootstrapInfo = Readonly<Record<string, string | number | boolean | null>>;

export interface Lease {
  /** Random, immutable, unguessable. There is no `expires_at`: a lease lasts until it is returned. */
  readonly lease_id: string;
  readonly holder: string;
  readonly leased_at: string;
  readonly bootstrap?: BootstrapInfo;
}

export interface ResetInfo {
  readonly started_at: string;
  readonly pid: number;
  /** Consecutive reset attempts since the slot was last clean. */
  readonly attempt: number;
}

export interface Slot {
  /** `<flavor>-<NN>`, for example `23-02`. */
  readonly id: string;
  readonly flavor: FlavorKey;
  readonly number: number;
  readonly status: SlotStatus;
  readonly lease?: Lease;
  readonly golden_hash: string | null;
  readonly last_reset_at: string | null;
  readonly last_reset_ms: number | null;
  readonly quarantine_reason?: string;
  readonly reset?: ResetInfo;
}

export interface State {
  readonly version: typeof STATE_VERSION;
  /** Incremented by every committed update; two commits never share a revision. */
  readonly revision: number;
  readonly updated_at: string;
  readonly slots: Readonly<Record<string, Slot>>;
}

export function emptyState(now: Date = new Date()): State {
  return { version: STATE_VERSION, revision: 0, updated_at: now.toISOString(), slots: {} };
}

/** A new slot enters the pool `provisioning`: nothing is handed out until a provision succeeds. */
export function newSlot(ref: SlotRef): Slot {
  return {
    id: slotId(ref),
    flavor: ref.flavor,
    number: ref.slot,
    status: "provisioning",
    golden_hash: null,
    last_reset_at: null,
    last_reset_ms: null,
  };
}

export function newLeaseId(): string {
  return randomBytes(16).toString("hex");
}

export function isLeaseId(value: unknown): value is string {
  return typeof value === "string" && LEASE_ID.test(value);
}

// ---- the status machine --------------------------------------------------------------------------

/**
 * The only legal moves. Only `free` is handed out; `leased` is left only through `dirty` (a return)
 * or `quarantined`, never straight to `free`; `free` is reached only from a provision or a reset.
 * Ticket 14 decides when `dirty` and `resetting` slots are reset.
 */
export const TRANSITIONS: Readonly<Record<SlotStatus, readonly SlotStatus[]>> = {
  provisioning: ["free", "quarantined", "disabled"],
  // free -> dirty: the stamp or database marker no longer matches the golden, so reset before use.
  free: ["leased", "dirty", "quarantined", "disabled"],
  leased: ["dirty", "quarantined"],
  dirty: ["resetting", "quarantined", "disabled"],
  // resetting -> dirty: the reset was interrupted (its worker died) and starts over.
  resetting: ["free", "dirty", "quarantined"],
  // quarantined -> provisioning is `repair`: re-provision from golden.
  quarantined: ["provisioning", "dirty", "disabled"],
  // Enabling a disabled slot sends it through a reset before it can be handed out.
  disabled: ["dirty"],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly slot: string,
    readonly from: SlotStatus,
    readonly to: SlotStatus,
  ) {
    super(`illegal transition for slot ${slot}: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: SlotStatus, to: SlotStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** What a transition needs beyond its target status. */
export type TransitionRequest =
  | { readonly to: "provisioning" | "dirty" | "disabled" }
  | { readonly to: "free"; readonly golden_hash: string; readonly reset_ms: number }
  | { readonly to: "leased"; readonly holder: string; readonly bootstrap?: BootstrapInfo }
  | { readonly to: "resetting"; readonly pid: number }
  | { readonly to: "quarantined"; readonly reason: string };

export interface TransitionContext {
  readonly now?: Date;
  readonly newLeaseId?: () => string;
}

function requireText(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_TEXT) {
    throw new Error(`${label} must be 1 to ${MAX_TEXT} characters`);
  }
  return value;
}

/**
 * The slot after moving to `request.to`; throws `IllegalTransitionError` for a move the table does
 * not allow. The fields that belong to a status come and go with it: the lease exists only while
 * `leased`, the quarantine reason only while `quarantined`, and the reset record only from
 * `resetting` until the slot is next clean.
 */
export function transitionSlot(slot: Slot, request: TransitionRequest, context: TransitionContext = {}): Slot {
  const from = slot.status;
  if (!canTransition(from, request.to)) throw new IllegalTransitionError(slot.id, from, request.to);
  const now = (context.now ?? new Date()).toISOString();
  const { lease: _lease, quarantine_reason: _reason, reset: _reset, ...kept } = slot;
  const base = { ...kept, status: request.to };
  switch (request.to) {
    case "provisioning":
      return { ...base, golden_hash: null, last_reset_at: null, last_reset_ms: null };
    case "disabled":
      return base;
    case "dirty":
      return slot.reset && from === "resetting" ? { ...base, reset: slot.reset } : base;
    case "free": {
      requireText("golden_hash", request.golden_hash);
      if (!Number.isFinite(request.reset_ms) || request.reset_ms < 0) throw new Error("reset_ms must be a non-negative number");
      return { ...base, golden_hash: request.golden_hash, last_reset_at: now, last_reset_ms: Math.round(request.reset_ms) };
    }
    case "leased": {
      const lease: Lease = {
        lease_id: (context.newLeaseId ?? newLeaseId)(),
        holder: requireText("holder", request.holder),
        leased_at: now,
        ...(request.bootstrap ? { bootstrap: checkBootstrap(request.bootstrap) } : {}),
      };
      if (!isLeaseId(lease.lease_id)) throw new Error("a lease id is 32 lower-case hex characters");
      return { ...base, lease };
    }
    case "resetting": {
      if (!Number.isInteger(request.pid) || request.pid <= 0) throw new Error("pid must be a positive integer");
      return { ...base, reset: { started_at: now, pid: request.pid, attempt: (slot.reset?.attempt ?? 0) + 1 } };
    }
    case "quarantined": {
      const reason = requireText("quarantine reason", request.reason);
      return { ...base, quarantine_reason: reason, ...(slot.reset ? { reset: slot.reset } : {}) };
    }
  }
}

// ---- no secrets ----------------------------------------------------------------------------------

const SECRET_KEY = /pass|secret|token|credential|licen[cs]e|api.?key|private|hash|salt|\bkey\b|_key\b/i;

function checkBootstrap(info: BootstrapInfo): BootstrapInfo {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(info)) {
    if (SECRET_KEY.test(key)) throw new Error(`bootstrap key "${key}" looks like a secret; the state file holds none`);
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`bootstrap value for "${key}" must be a string, number, boolean or null`);
    }
    if (typeof value === "string" && value.length > MAX_TEXT) throw new Error(`bootstrap value for "${key}" is too long`);
    out[key] = value;
  }
  return out;
}

// ---- the state file ------------------------------------------------------------------------------

export class StateCorruptError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`the state file ${path} is unusable (${detail}); run \`arashouse doctor --rebuild-state\``);
    this.name = "StateCorruptError";
  }
}

/** Bytes of the state file. Only the fields below are written, whatever else a record carries. */
export function serialiseState(state: State): string {
  const slots = Object.values(state.slots)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((s) => ({
      id: s.id,
      flavor: s.flavor,
      number: s.number,
      status: s.status,
      ...(s.lease
        ? {
            lease: {
              lease_id: s.lease.lease_id,
              holder: s.lease.holder,
              leased_at: s.lease.leased_at,
              ...(s.lease.bootstrap ? { bootstrap: checkBootstrap(s.lease.bootstrap) } : {}),
            },
          }
        : {}),
      golden_hash: s.golden_hash,
      last_reset_at: s.last_reset_at,
      last_reset_ms: s.last_reset_ms,
      ...(s.quarantine_reason !== undefined ? { quarantine_reason: s.quarantine_reason } : {}),
      ...(s.reset ? { reset: { started_at: s.reset.started_at, pid: s.reset.pid, attempt: s.reset.attempt } } : {}),
    }));
  return `${JSON.stringify({ version: STATE_VERSION, revision: state.revision, updated_at: state.updated_at, slots }, null, 2)}\n`;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, detail: string): never {
  throw new StateCorruptError(path, detail);
}

function str(path: string, where: string, value: unknown): string {
  if (typeof value !== "string") fail(path, `${where} is not a string`);
  return value;
}

function strOrNull(path: string, where: string, value: unknown): string | null {
  return value === null ? null : str(path, where, value);
}

function parseLease(path: string, where: string, raw: unknown): Lease {
  if (!isObject(raw)) return fail(path, `${where} is not an object`);
  const lease_id = str(path, `${where}.lease_id`, raw.lease_id);
  if (!isLeaseId(lease_id)) fail(path, `${where}.lease_id is not 128 bits of hex`);
  let bootstrap: BootstrapInfo | undefined;
  if (raw.bootstrap !== undefined) {
    if (!isObject(raw.bootstrap)) fail(path, `${where}.bootstrap is not an object`);
    try {
      bootstrap = checkBootstrap(raw.bootstrap as BootstrapInfo);
    } catch (err) {
      fail(path, `${where}.bootstrap: ${(err as Error).message}`);
    }
  }
  return {
    lease_id,
    holder: str(path, `${where}.holder`, raw.holder),
    leased_at: str(path, `${where}.leased_at`, raw.leased_at),
    ...(bootstrap ? { bootstrap } : {}),
  };
}

function parseSlot(path: string, key: string, raw: unknown): Slot {
  const where = `slots.${key}`;
  if (!isObject(raw)) return fail(path, `${where} is not an object`);
  const id = str(path, `${where}.id`, raw.id);
  let ref: SlotRef;
  try {
    ref = parseSlotId(id);
  } catch {
    return fail(path, `${where}.id is not a slot id`);
  }
  if (id !== key) fail(path, `${where} is filed under the wrong key`);
  if (raw.flavor !== ref.flavor || !isFlavorKey(raw.flavor)) fail(path, `${where}.flavor does not match its id`);
  if (raw.number !== ref.slot) fail(path, `${where}.number does not match its id`);
  const status = raw.status;
  if (!(SLOT_STATUSES as readonly unknown[]).includes(status)) fail(path, `${where}.status is not a status`);
  const slotStatus = status as SlotStatus;
  const lease = raw.lease === undefined ? undefined : parseLease(path, `${where}.lease`, raw.lease);
  if ((slotStatus === "leased") !== (lease !== undefined)) fail(path, `${where} has a lease exactly when it is leased`);
  const golden_hash = strOrNull(path, `${where}.golden_hash`, raw.golden_hash);
  const last_reset_at = strOrNull(path, `${where}.last_reset_at`, raw.last_reset_at);
  const last_reset_ms = raw.last_reset_ms;
  if (last_reset_ms !== null && (typeof last_reset_ms !== "number" || !Number.isFinite(last_reset_ms))) {
    fail(path, `${where}.last_reset_ms is not a number or null`);
  }
  const quarantine_reason = raw.quarantine_reason === undefined ? undefined : str(path, `${where}.quarantine_reason`, raw.quarantine_reason);
  if ((slotStatus === "quarantined") !== (quarantine_reason !== undefined)) {
    fail(path, `${where} has a quarantine reason exactly when it is quarantined`);
  }
  let reset: ResetInfo | undefined;
  if (raw.reset !== undefined) {
    const r = raw.reset;
    if (!isObject(r) || !Number.isInteger(r.pid) || !Number.isInteger(r.attempt)) fail(path, `${where}.reset is malformed`);
    reset = { started_at: str(path, `${where}.reset.started_at`, r.started_at), pid: r.pid as number, attempt: r.attempt as number };
  }
  if (slotStatus === "resetting" && !reset) fail(path, `${where} is resetting without a reset record`);
  return {
    id,
    flavor: ref.flavor,
    number: ref.slot,
    status: slotStatus,
    ...(lease ? { lease } : {}),
    golden_hash,
    last_reset_at,
    last_reset_ms: last_reset_ms as number | null,
    ...(quarantine_reason !== undefined ? { quarantine_reason } : {}),
    ...(reset ? { reset } : {}),
  };
}

/** Parses and validates the bytes of a state file; throws `StateCorruptError` (naming `path`) on any defect. */
export function parseState(text: string, path = "state.json"): State {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(path, "not valid JSON");
  }
  if (!isObject(raw)) return fail(path, "not a JSON object");
  if (raw.version !== STATE_VERSION) fail(path, `version ${String(raw.version)} is not supported`);
  if (!Number.isInteger(raw.revision) || (raw.revision as number) < 0) fail(path, "revision is not a non-negative integer");
  if (!Array.isArray(raw.slots)) fail(path, "slots is not a list");
  const slots: Record<string, Slot> = {};
  for (const entry of raw.slots as unknown[]) {
    const id = isObject(entry) && typeof entry.id === "string" ? entry.id : "?";
    if (slots[id]) fail(path, `slot ${id} appears twice`);
    slots[id] = parseSlot(path, id, entry);
  }
  return {
    version: STATE_VERSION,
    revision: raw.revision as number,
    updated_at: str(path, "updated_at", raw.updated_at),
    slots,
  };
}
