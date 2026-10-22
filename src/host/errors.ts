// The four ways a host call fails. A call either returns `{ ok, ms, detail }` or throws one of these;
// nothing else escapes a host driver, so the lease logic can decide on `kind` alone.

import { GuardError } from "../core/guards.js";

export const HOST_ERROR_KINDS = ["Retryable", "Quarantine", "Refused", "Unreachable"] as const;

/**
 * - `Retryable`: a transient failure (a lock, a timeout); the same call may be tried again.
 * - `Quarantine`: the slot is in a state a retry will not fix; park it for the operator.
 * - `Refused`: the call was not allowed (a guard, a slot that does not exist, a bad argument).
 * - `Unreachable`: the host or broker did not answer; nothing is known about the call's effect.
 */
export type HostErrorKind = (typeof HOST_ERROR_KINDS)[number];

/** A failed host call. The message names the subject, never a credential. */
export class HostError extends Error {
  constructor(
    readonly kind: HostErrorKind,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "HostError";
  }
}

export function isHostError(value: unknown, kind?: HostErrorKind): value is HostError {
  return value instanceof HostError && (kind === undefined || value.kind === kind);
}

/** A guard refusal is a `Refused` host error, so a real host and the fake fail the same way. */
export function refusedFromGuard(err: GuardError): HostError {
  return new HostError("Refused", err.message, { cause: err });
}
