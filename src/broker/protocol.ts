// The broker protocol (ticket 20): one request, one response, JSON, one line each, size-limited and
// timeout-bounded. Shared by the broker (the Windows service), its Windows-side client and
// `BrokerHost` on WSL. The verb list is fixed (the host-driver methods); there is no verb that runs
// a command, SQL or a path from the client. A request names its target as a slot record or a flavor,
// and the broker derives every name from it and runs the guards (ticket 10) before it acts.

import { isFlavorKey, type FlavorKey } from "../core/flavors.js";
import { parseSlotId, slotId, type SlotRef } from "../core/names.js";
import { HOST_METHODS, type HostMethod, type SlotStamp } from "../host/driver.js";
import { HOST_ERROR_KINDS, type HostErrorKind } from "../host/errors.js";

export const PROTOCOL_VERSION = 1;

/** The broker's named pipe. Node gives it a DACL of its own; see docs/broker.md for why a token is checked as well. */
export const PIPE_PATH = "\\\\.\\pipe\\arashouse-broker";

/** The largest request line (the envelope with its token), in bytes. */
export const MAX_REQUEST_BYTES = 64 * 1024;
/** The largest response line, in bytes. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;
/** How long the broker waits for a connection's request line before it drops the connection. */
export const READ_TIMEOUT_MS = 5_000;
/** How long the client waits to connect to the pipe. */
export const CONNECT_TIMEOUT_MS = 3_000;
/** How long a verb may run unless it sets its own bound. */
export const DEFAULT_VERB_TIMEOUT_MS = 30_000;

/** Bounds for the verbs that are slower or faster than the default; the broker and `BrokerHost` share them. */
export const VERB_TIMEOUT_MS: Readonly<Partial<Record<HostMethod, number>>> = {
  ping: 5_000,
  hostInfo: 20_000,
  readStamp: 10_000,
  listSlots: 20_000,
  // `full` hashes every file of a golden tree: about 560 to 750 MB, at the 2 MB/s measured with real-time scanning (design 8.3).
  baselineVerify: 30 * 60_000,
  // A provision mirrors a golden tree (about 560 MB) and restores a database; a destroy deletes the tree. Minutes at most.
  provisionSlot: 30 * 60_000,
  destroySlot: 30 * 60_000,
  // A start waits for each pool and the agent, then warms three URLs (up to 2 minutes each, in parallel); a stop waits for them to end.
  startSlot: 10 * 60_000,
  stopSlot: 5 * 60_000,
  // The pool stop waits up to a minute per pool and a minute for the slot's processes (slot-steps.ts).
  quiesce: 10 * 60_000,
  // The reset's mirror is under a second over a used slot (spike 06), but a cold cache or a lease that filled the tree costs more.
  resetTree: 30 * 60_000,
  // A reset's restore took 0.5 to 1.7 s for a 77 MB 12sp9 backup (spike 06, ticket 31); the golden check and a second
  // restore after kill_connections add seconds. The bound leaves room for a larger backup on a busy disk.
  resetDatabase: 10 * 60_000,
  // A login, two edits and a login again through the slot's server: seconds when warm, up to 2 minutes each when cold.
  setLeaseCredentials: 10 * 60_000,
};

/** How long `verb` may run on the broker. */
export function verbTimeout(verb: HostMethod): number {
  return VERB_TIMEOUT_MS[verb] ?? DEFAULT_VERB_TIMEOUT_MS;
}

/** What `arashouse` prints when the broker cannot be reached (exit code 6). */
export const UNREACHABLE_HINT = "run `arashouse doctor` (the broker is installed by `arashouse setup`)";

const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
const REQUEST_KEYS = new Set(["id", "verb", "slot", "flavor", "args"]);

/** One call to the broker. `slot` and `flavor` are mutually exclusive; `args` is verb-specific and never logged. */
export interface BrokerRequest {
  readonly id: string;
  readonly verb: HostMethod;
  readonly slot?: SlotRef;
  readonly flavor?: FlavorKey;
  readonly args?: Readonly<Record<string, unknown>>;
}

/** A verb's result: the host-driver result without `ms`, which each side measures by its own clock. */
export interface WireResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly [field: string]: unknown;
}

export interface WireError {
  readonly kind: HostErrorKind;
  readonly message: string;
}

export type BrokerResponse =
  | { readonly id: string; readonly ok: true; readonly result: WireResult }
  | { readonly id: string; readonly ok: false; readonly error: WireError };

/** A request or response that breaks the protocol. The broker answers it `Refused`. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

export function isHostMethod(value: unknown): value is HostMethod {
  return typeof value === "string" && (HOST_METHODS as readonly string[]).includes(value);
}

/** The request's id when it has a well-formed one, else "" (for answering a malformed request). */
export function requestIdOf(value: unknown): string {
  return isRecord(value) && isRequestId(value.id) ? value.id : "";
}

/**
 * Validates the shape of a request: known keys only, a well-formed id, a host-method verb, a slot
 * record of exactly `{ flavor, slot }` or a flavor, and `args` as a plain object. Whether the slot or
 * flavor is one the tool owns is the guards' question, which the broker asks next.
 */
export function parseRequest(value: unknown): BrokerRequest {
  if (!isRecord(value)) throw new ProtocolError("a request is a JSON object");
  for (const key of Object.keys(value)) {
    if (!REQUEST_KEYS.has(key)) throw new ProtocolError(`a request has no "${key.slice(0, 32)}" field`);
  }
  if (!isRequestId(value.id)) throw new ProtocolError("a request id is 1 to 64 letters, digits or '-'");
  if (!isHostMethod(value.verb)) throw new ProtocolError("the verb is not one of the broker's verbs");
  const request: { id: string; verb: HostMethod; slot?: SlotRef; flavor?: FlavorKey; args?: Record<string, unknown> } = {
    id: value.id,
    verb: value.verb,
  };
  if (value.slot !== undefined && value.flavor !== undefined) throw new ProtocolError("a request names a slot or a flavor, not both");
  if (value.slot !== undefined) {
    const slot = value.slot;
    if (!isRecord(slot) || Object.keys(slot).some((k) => k !== "flavor" && k !== "slot")) {
      throw new ProtocolError("a slot is { flavor, slot }");
    }
    if (typeof slot.flavor !== "string" || typeof slot.slot !== "number") throw new ProtocolError("a slot is { flavor, slot }");
    request.slot = { flavor: slot.flavor as FlavorKey, slot: slot.slot };
  }
  if (value.flavor !== undefined) {
    if (typeof value.flavor !== "string") throw new ProtocolError("a flavor is a string");
    request.flavor = value.flavor as FlavorKey;
  }
  if (value.args !== undefined) {
    if (!isRecord(value.args)) throw new ProtocolError("args is a JSON object");
    request.args = value.args;
  }
  return request;
}

/** What the audit log records as a request's target: the slot id or flavor when they are valid, else null. */
export function targetOf(request: Pick<BrokerRequest, "slot" | "flavor">): string | null {
  if (request.slot) {
    try {
      return slotId(request.slot);
    } catch {
      return null;
    }
  }
  return request.flavor !== undefined && isFlavorKey(request.flavor) ? request.flavor : null;
}

/**
 * Validates a response read back from the broker: the id it answers, `ok`, and a result with
 * `ok` and `detail` or an error of a known kind. Throws `ProtocolError` otherwise.
 */
export function parseResponse(value: unknown, expectedId: string): BrokerResponse {
  if (!isRecord(value)) throw new ProtocolError("a response is a JSON object");
  if (value.id !== expectedId) throw new ProtocolError("the response answers a different request");
  if (value.ok === true) {
    const result = value.result;
    if (!isRecord(result) || typeof result.ok !== "boolean" || typeof result.detail !== "string") {
      throw new ProtocolError("a result carries ok and detail");
    }
    return { id: expectedId, ok: true, result: result as WireResult };
  }
  if (value.ok === false) {
    const error = value.error;
    if (!isRecord(error) || !(HOST_ERROR_KINDS as readonly unknown[]).includes(error.kind) || typeof error.message !== "string") {
      throw new ProtocolError("an error carries a known kind and a message");
    }
    return { id: expectedId, ok: false, error: { kind: error.kind as HostErrorKind, message: error.message } };
  }
  throw new ProtocolError("a response has ok: true or ok: false");
}

/** `value` as one JSON line; throws `ProtocolError` when it is larger than `limit` bytes. */
export function encodeLine(value: unknown, limit: number): string {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > limit) throw new ProtocolError(`the message is larger than ${limit} bytes`);
  return line;
}

export function errorResponse(id: string, kind: HostErrorKind, message: string): BrokerResponse {
  return { id, ok: false, error: { kind, message } };
}

/**
 * A slot stamp as the stamp file or a response holds it, checked against the slot it belongs to.
 * Throws `ProtocolError` when a field is missing or of the wrong type, or the stamp names another slot.
 */
export function parseSlotStamp(value: unknown, slot: SlotRef): SlotStamp {
  if (!isRecord(value)) throw new ProtocolError("a stamp is a JSON object");
  const { slotId: id, flavor, goldenHash, lastResetAt, leaseId } = value;
  if (typeof id !== "string" || typeof flavor !== "string") throw new ProtocolError("a stamp carries slotId and flavor");
  let named: SlotRef;
  try {
    named = parseSlotId(id);
  } catch {
    throw new ProtocolError("the stamp's slotId is not <flavor>-<NN>");
  }
  if (id !== slotId(slot) || flavor !== slot.flavor || named.flavor !== flavor) {
    throw new ProtocolError(`the stamp names ${id.slice(0, 32)}, not ${slotId(slot)}`);
  }
  const nullableString = (v: unknown) => v === null || typeof v === "string";
  if (!nullableString(goldenHash) || !nullableString(lastResetAt)) {
    throw new ProtocolError("a stamp's goldenHash and lastResetAt are strings or null");
  }
  if (leaseId !== undefined && !nullableString(leaseId)) throw new ProtocolError("a stamp's leaseId is a string or null");
  const stamp: { -readonly [K in keyof SlotStamp]: SlotStamp[K] } = {
    slotId: id,
    flavor: slot.flavor,
    goldenHash: goldenHash as string | null,
    lastResetAt: lastResetAt as string | null,
  };
  if (leaseId !== undefined) stamp.leaseId = leaseId as string | null;
  return stamp;
}
