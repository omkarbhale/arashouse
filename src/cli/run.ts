// `arashouse run --lease <lease_id> -- <command ...>`: runs a command with the lease's
// connection in its environment, and nowhere else (from WSL, the launcher runs it in WSL). The password reaches the child only as
// `ARAS_PASSWORD` (libs-js's rule: "The password reaches tools only through the environment
// (`ARAS_PASSWORD`) or stdin, never through a flag or a file"), so
// `arashouse run --lease L -- aras-pkg export ./out Item:id` needs no glue. The child's exit code is
// passed through.
//
// Without a shell, Windows starts only `.exe` and `.com` programs; Node refuses a `.cmd` or `.bat` (an npm shim,
// for example) without one. `run` refuses such a program up front with how to run it instead, rather than quote a
// command line for `cmd.exe`, whose rules are its own.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { constants } from "node:os";
import { extname, win32 } from "node:path";
import { EXIT_CODES } from "../core/exit-codes.js";
import { getFlavor } from "../core/flavors.js";
import { LEASE_USER, LeaseError, UsageError, leaseRef, leaseSecretName } from "../core/lease.js";
import { databaseName, webAlias } from "../core/names.js";
import type { SecretStore } from "../core/secret-store.js";
import { isLeaseId, type Slot } from "../core/state.js";
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

/** The slot that holds `leaseId` now; exit 4 when the lease was returned or never existed (`run`, `extract`). */
export async function heldSlot(store: StateStore, leaseId: string): Promise<Slot> {
  const slot = Object.values((await store.read()).slots).find((s) => s.lease?.lease_id === leaseId);
  if (!slot || slot.status !== "leased") {
    throw staleLease(`lease ${leaseRef(leaseId)} is not held: it was returned, or never existed`);
  }
  return slot;
}

/** The lease's connection, as the variables `run` (and `get --import`) put in a child's environment. */
export async function leaseEnvironment(deps: Pick<RunDeps, "store" | "secrets" | "resolveUrl">, leaseId: string): Promise<Record<(typeof RUN_ENV_NAMES)[number], string>> {
  const slot = await heldSlot(deps.store, leaseId);
  const secret = await deps.secrets.get(leaseSecretName(leaseId));
  if (!secret) {
    throw staleLease(`the password of lease ${leaseRef(leaseId)} on ${slot.id} is gone (the state was recovered); return the lease and take a new one`);
  }
  const ref = { flavor: slot.flavor, slot: slot.number };
  return {
    ARAS_URL: await deps.resolveUrl(webAlias(ref)),
    ARAS_DATABASE: databaseName(ref),
    ARAS_USER: LEASE_USER,
    ARAS_PASSWORD: secret.reveal(),
    ARASHOUSE_SLOT: slot.id,
    ARASHOUSE_FLAVOR: slot.flavor,
    ARAS_PKG_ENGINE: getFlavor(slot.flavor).libsJsEngine,
  };
}

export interface ChildOptions {
  readonly env: NodeJS.ProcessEnv;
  /** `inherit` (the default) or where the child's stdout and stderr go, line by line. */
  readonly output?: (line: string) => void;
  readonly err: (line: string) => void;
}

/**
 * Starts a program without a shell and resolves with its exit code: 128 plus the signal's number when a signal ended it,
 * 127 when it could not start. Ctrl-C reaches the child too; this process waits for it rather than dying first.
 */
export function runChild(program: string, args: readonly string[], options: ChildOptions): Promise<number> {
  return new Promise<number>((resolve) => {
    const { output } = options;
    const child = spawn(program, args, { stdio: output === undefined ? "inherit" : ["ignore", "pipe", "pipe"], env: options.env });
    if (output !== undefined) {
      for (const stream of [child.stdout, child.stderr]) {
        let pending = "";
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => {
          const lines = (pending + chunk).split(/\r?\n/);
          pending = lines.pop() ?? "";
          for (const line of lines) output(line);
        });
        stream?.on("end", () => {
          if (pending !== "") output(pending);
          pending = "";
        });
      }
    }
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
      options.err(`arashouse: cannot run "${program}": ${error.code ?? error.message}`);
      done(COMMAND_NOT_STARTED);
    });
    // "close", not "exit": with piped output the last lines are read before the code is reported.
    child.on("close", (code, signal) => {
      done(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0));
    });
  });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A variable of `env` whatever its case, as Windows reads it (`Path`, `PATHEXT`). */
function variable(env: NodeJS.ProcessEnv, name: string): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? "" : (env[key] ?? "");
}

/**
 * On Windows, the batch script `program` would start (a `.cmd` or `.bat`, named or found first on the PATH as cmd.exe
 * would find it), or undefined: an `.exe`, or nothing found (the start then fails as usual, exit 127).
 */
export function windowsBatchScript(program: string, env: NodeJS.ProcessEnv): string | undefined {
  const batch = (path: string) => /^\.(cmd|bat)$/i.test(extname(path));
  if (extname(program) !== "") return batch(program) ? program : undefined;
  const exts = (variable(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e.startsWith("."));
  const dirs = /[\\/]/.test(program) ? [""] : ["", ...variable(env, "PATH").split(";")];
  for (const dir of dirs) {
    for (const ext of exts) {
      const path = dir === "" ? `${program}${ext}` : win32.join(dir, `${program}${ext}`);
      if (isFile(path)) return batch(path) ? path : undefined;
    }
  }
  return undefined;
}

/** Refuses, on Windows, a command that is a batch script (exit 2), with how to run it instead. */
export function assertRunnable(program: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") return;
  const script = windowsBatchScript(program, env);
  if (script === undefined) return;
  throw new UsageError(
    `"${program}" is a batch script (${script}), which Windows starts only through cmd.exe: run its program directly (for an npm shim, \`node <its .js>\`), or \`powershell.exe -File <script.ps1>\``,
  );
}

/** Starts the command with the lease's environment and resolves with its exit code. */
export async function runWithLease(deps: RunDeps, request: RunRequest): Promise<number> {
  const { leaseId, command } = request;
  if (leaseId === undefined) throw new UsageError("run needs --lease <lease_id>");
  if (!isLeaseId(leaseId)) throw new UsageError("--lease must be a lease id (32 lower-case hex characters)");
  const [program, ...args] = command;
  if (program === undefined || program === "") throw new UsageError("run needs a command after --");
  const base = deps.env ?? process.env;
  assertRunnable(program, base);
  const env = { ...base, ...(await leaseEnvironment(deps, leaseId)) };
  return runChild(program, args, { env, err: deps.err });
}
