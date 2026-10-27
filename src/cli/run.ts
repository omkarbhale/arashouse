// `arashouse run --lease <lease_id> -- <command ...>`: runs a command in WSL with the lease's
// connection in its environment, and nowhere else. The password reaches the child only as
// `ARAS_PASSWORD` (libs-js's rule: "The password reaches tools only through the environment
// (`ARAS_PASSWORD`) or stdin, never through a flag or a file"), so
// `arashouse run --lease L -- aras-pkg export ./out Item:id` needs no glue. The child's exit code is
// passed through.

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { EXIT_CODES } from "../core/exit-codes.js";
import { getFlavor } from "../core/flavors.js";
import { LEASE_USER, LeaseError, UsageError, leaseRef, leaseSecretName } from "../core/lease.js";
import { databaseName, webAlias } from "../core/names.js";
import type { SecretStore } from "../core/secret-store.js";
import { isLeaseId } from "../core/state.js";
import type { StateStore } from "../core/store.js";

/** The variables `run` sets in the child's environment. */
export const RUN_ENV_NAMES = [
  "ARAS_URL",
  "ARAS_DATABASE",
  "ARAS_USER",
  "ARAS_PASSWORD",
  "ARASHOUSE_SLOT",
  "ARASHOUSE_FLAVOR",
  "ARAS_PKG_ENGINE",
] as const;

/** The exit code when the command cannot be started (not found, not executable), as a shell reports it. */
export const COMMAND_NOT_STARTED = 127;

export interface RunDeps {
  readonly store: StateStore;
  readonly secrets: SecretStore;
  readonly resolveUrl: (alias: string) => Promise<string>;
  /** The environment the child starts from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  readonly err: (line: string) => void;
}

export interface RunRequest {
  readonly leaseId: string | undefined;
  readonly command: readonly string[];
}

function staleLease(message: string): LeaseError {
  return new LeaseError(EXIT_CODES.leaseMismatch, message);
}

/** Starts the command with the lease's environment and resolves with its exit code. */
export async function runWithLease(deps: RunDeps, request: RunRequest): Promise<number> {
  const { leaseId, command } = request;
  if (leaseId === undefined) throw new UsageError("run needs --lease <lease_id>");
  if (!isLeaseId(leaseId)) throw new UsageError("--lease must be a lease id (32 lower-case hex characters)");
  const [program, ...args] = command;
  if (program === undefined || program === "") throw new UsageError("run needs a command after --");

  const slot = Object.values((await deps.store.read()).slots).find((s) => s.lease?.lease_id === leaseId);
  if (!slot || slot.status !== "leased") {
    throw staleLease(`lease ${leaseRef(leaseId)} is not held: it was returned, or never existed`);
  }
  const secret = await deps.secrets.get(leaseSecretName(leaseId));
  if (!secret) {
    throw staleLease(`the password of lease ${leaseRef(leaseId)} on ${slot.id} is gone (the state was recovered); return the lease and take a new one`);
  }
  const ref = { flavor: slot.flavor, slot: slot.number };
  const url = await deps.resolveUrl(webAlias(ref));
  const env: NodeJS.ProcessEnv = {
    ...(deps.env ?? process.env),
    ARAS_URL: url,
    ARAS_DATABASE: databaseName(ref),
    ARAS_USER: LEASE_USER,
    ARAS_PASSWORD: secret.reveal(),
    ARASHOUSE_SLOT: slot.id,
    ARASHOUSE_FLAVOR: slot.flavor,
    ARAS_PKG_ENGINE: getFlavor(slot.flavor).libsJsEngine,
  };

  return new Promise<number>((resolve) => {
    const child = spawn(program, args, { stdio: "inherit", env });
    // A terminal's Ctrl-C reaches the child too; this process waits for it rather than dying first.
    const forward = (signal: NodeJS.Signals) => () => {
      if (signal !== "SIGINT") child.kill(signal);
    };
    const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => [signal, forward(signal)] as const);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(code);
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      deps.err(`arashouse: cannot run "${program}": ${error.code ?? error.message}`);
      done(COMMAND_NOT_STARTED);
    });
    child.on("exit", (code, signal) => {
      done(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0));
    });
  });
}
