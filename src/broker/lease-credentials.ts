// The broker's `setLeaseCredentials` verb (ticket 34, docs/lease-credentials.md): a leased slot's `root` and `admin`
// get the lease's password. A free slot has a random `root` password that nobody knows, kept only in the host's
// secret store (`slot-<key>-<NN>-root`, made by the reset after the pools start, ticket 32). The verb logs in as
// `root` with it, edits the `User` items of `admin` and `root` to the lease's password through the slot's own server
// (an AML `edit`: SQL cannot do it, spike 06), checks that `root` logs in with the new password, and deletes the
// stored one. From then on only the leaseholder knows the slot's password, and the next reset restores the golden
// database over it, so it dies with the lease.
//
// The password arrives in the request's `args` (the request line, on the client's stdin and the pipe: never an
// argument list) and is wrapped in a `Secret` before anything else, so `redact` replaces it in every line. The audit
// log records the verb, the slot and the outcome only.

import { databaseName, slotId, slotRootSecretName, stampFile, webAlias, type SlotRef } from "../core/names.js";
import { Secret } from "../core/secret.js";
import { HostError } from "../host/errors.js";
import type { ArasAnswer } from "./aras-http.js";
import { ProtocolError, type WireResult } from "./protocol.js";
import { seconds, type SlotSystem } from "./provision.js";

/** The Aras user the slot is logged in to as, and whose password a lease gets. */
export const LEASE_LOGIN = "root";

/** The users that get the lease's password, `admin` first, so `root`'s own edit is the last thing its token does. */
export const LEASE_USERS: readonly string[] = ["admin", "root"];

/** A lease password: 128 random bits as base64url are 22 characters; anything from 16 to 128 URL-safe ones is taken. */
const PASSWORD = /^[A-Za-z0-9_-]{16,128}$/;

export interface LeaseCredentialArgs {
  readonly password: Secret;
}

/** Refuses any argument but `password`, which is wrapped at once and never quoted in an error. */
export function parseLeaseCredentialArgs(args: Readonly<Record<string, unknown>>): LeaseCredentialArgs {
  const { password } = args;
  // Wrapped before the checks, so even a refused value is redacted wherever it would appear.
  const secret = typeof password === "string" ? Secret.of(password, "lease-password") : undefined;
  for (const key of Object.keys(args)) {
    if (key !== "password") throw new ProtocolError(`setLeaseCredentials takes only "password", not "${key.slice(0, 32)}"`);
  }
  if (secret === undefined || !PASSWORD.test(password as string)) {
    throw new ProtocolError("setLeaseCredentials needs the lease's password: 16 to 128 letters, digits, '-' or '_'");
  }
  return { password: secret };
}

/** A refusal by the server is the slot's state being wrong (`Quarantine`); a server that did not answer is `Retryable`. */
function failed(id: string, what: string, answer: Extract<ArasAnswer, { ok: false }>): HostError {
  return answer.refused
    ? new HostError("Quarantine", `${id}: ${what} was refused: ${answer.detail}`)
    : new HostError("Retryable", `${id}: ${what} did not complete: ${answer.detail}`);
}

/**
 * `setLeaseCredentials`: `root` and `admin` of the slot get `args.password`. Throws a `HostError`: `Refused` for a slot
 * that is not provisioned; `Retryable` when the slot has no stored `root` password (it has not been reset since it was
 * provisioned or last leased) or its server does not answer; `Quarantine` when the server refuses the stored password,
 * the edit, or the new password, since the slot is then not in the state a free slot must be in.
 */
export async function setLeaseCredentialsOnHost(system: SlotSystem, slot: SlotRef, root: string, args: LeaseCredentialArgs): Promise<WireResult> {
  const id = slotId(slot);
  const started = system.now();
  if ((await system.readFile(stampFile(slot, root))) === null) throw new HostError("Refused", `slot ${id} is not provisioned`);
  const name = slotRootSecretName(slot);
  const current = await system.secrets.get(name);
  if (current === undefined) {
    throw new HostError("Retryable", `${id} has no stored root password: it has not been reset since it was provisioned or last leased`);
  }
  const alias = webAlias(slot);
  const database = databaseName(slot);

  const edited = await system.aras.setPasswords(alias, database, { user: LEASE_LOGIN, password: current }, LEASE_USERS, args.password);
  if (!edited.ok) throw failed(id, `the password edit as ${LEASE_LOGIN}`, edited);
  const proved = await system.aras.login(alias, database, LEASE_LOGIN, args.password);
  if (!proved.ok) throw failed(id, `the login as ${LEASE_LOGIN} with the lease's password`, proved);
  // The old password no longer logs in; it is forgotten, so nothing on the host knows the slot's password now.
  await system.secrets.delete(name);
  return { ok: true, detail: `lease credentials set for ${LEASE_USERS.join(" and ")} of ${id} in ${seconds(system.now() - started)} s` };
}
