// The worker-facing command surface: `get`, `return`, `status`, `flavors`, `run`, `extract` (ticket 43), `help`, `version`
// (and `media check`, ticket 18, `baseline verify`, ticket 28, and `reset-worker`, ticket 14), thin
// over the lease core, and the operator commands (`doctor`, `repair`, `destroy`, `prune`,
// `force-return`, `disable`, `enable`, ticket 16; `baseline build`, ticket 24; `teardown`, ticket 49), thin over
// operator.ts. Output rules: no command prints a password except `get --json`, once; `--verbose`
// never adds a secret; an error is one line plus a hint, with the stack only under `ARASHOUSE_DEBUG=1`. The exit codes are docs/cli.md's table.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODES } from "../core/exit-codes.js";
import { FLAVOR_KEYS, getFlavor } from "../core/flavors.js";
import { GuardError } from "../core/guards.js";
import {
  UsageError,
  asLeaseError,
  exitCodeFor,
  formatStatus,
  getLease,
  leaseStatus,
  renderGetJson,
  returnLease,
  type LeaseDeps,
} from "../core/lease.js";
import { LeaseFileStore } from "../core/lease-files.js";
import { LicenceRequiredError, SECRET_REQUIRED_EXIT_CODE } from "../core/licence.js";
import { loadConfig } from "../core/config.js";
import { LockTimeoutError, acquireLock } from "../core/lock.js";
import {
  type OperatorDeps,
  type OperatorResult,
  destroySlot,
  disableSlot,
  doctor,
  enableSlot,
  forceReturn,
  provisionPool,
  prune,
  repairSlot,
} from "../core/operator.js";
import { parseSlotId, slotId } from "../core/names.js";
import { type ResetDeps, describeOutcome, resetHooks, runResetWorker } from "../core/reset.js";
import { redactError } from "../core/redact.js";
import { StateStore } from "../core/store.js";
import { createMsiReader, windowsTempDir } from "../host/msi.js";
import { parseArgs, parseSeconds, stringOption, type ParsedArgs } from "./args.js";
import { buildFlavors, formatFlavors, mediaPresent } from "./flavors.js";
import { selectHost, type SelectedHost } from "./host.js";
import { MEDIA_USAGE, runMediaCheck } from "./media.js";
import { parsePasswordFd, writePasswordFd } from "./password-fd.js";
import { runWithLease } from "./run.js";
import { EXTRACT_HELP, runExtract } from "./extract.js";
import { runBaselineCommand, writeBaselineBundle } from "./baseline.js";
import { checkMedia } from "../core/media-check.js";
import { DIST_DIR, PACKAGE_JSON, defaultRun, flavorsToCheck, observeSetup, workerIdentity, writeSetupBundle, writeSetupSqlScript } from "./setup.js";
import { teardownPool, teardownSwitches, type TeardownRequest } from "../core/teardown.js";
import { writeTeardownBundle } from "./teardown.js";

export const DEBUG_ENV = "ARASHOUSE_DEBUG";

/** `off` stops `return` (and `get`) from starting a detached reset worker; a lazy reset in `get` still runs. */
export const RESET_WORKER_ENV = "ARASHOUSE_RESET_WORKER";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const COMMAND_HELP: Readonly<Record<string, readonly string[]>> = {
  get: [
    "usage: arashouse get <flavor> --holder <task> [--wait <seconds>] [--agent] [--json] [--password-fd <n>]",
    "",
    `Leases a clean slot of <flavor> (${FLAVOR_KEYS.join(", ")}) to <task>. With --json, stdout is the`,
    "lease contract (docs/schemas/get.schema.json) and nothing else; it holds the lease's password,",
    "shown this once. Without --json the password is not shown: reach it through `arashouse run`.",
    "--wait <seconds> waits up to that long for a slot; without it, no free slot exits 3 at once.",
    "--agent also starts the slot's agent service (conversion tasks, scheduled methods); without it the",
    "agent stays stopped. A flavor whose golden has no agent refuses it (exit 7).",
    "--password-fd <n> writes the password and a newline to descriptor <n> (3 or more, opened for the",
    "command, for example `3>file`) instead, and --json then leaves it out.",
  ],
  return: [
    "usage: arashouse return <lease_id> [--wait[=<seconds>]] [--quiet]",
    "       arashouse return <slot> --if-lease-id <lease_id> [--wait[=<seconds>]] [--quiet]",
    "",
    "Gives the lease back. Everything in the slot is discarded: take out what you need first",
    "(`arashouse extract`). It returns at once; the slot is reset before it is handed out again.",
    "Returning twice is a no-op. --wait blocks until the slot is free again (exit 5 if its reset",
    "fails), with no limit or up to <seconds>. It reminds you on stderr that the slot's state is",
    "discarded; --quiet leaves that line out.",
  ],
  status: ["usage: arashouse status [--json]", "", "One row per slot (status, holder, lease age, last reset), then totals per flavor."],
  flavors: [
    "usage: arashouse flavors [--json]",
    "",
    "Each flavor: its release and build, the libs-js --engine to use, free/leased/total slots, and",
    "whether its media and a verified baseline are present (docs/schemas/flavors.schema.json).",
  ],
  run: [
    "usage: arashouse run --lease <lease_id> -- <command ...>",
    "",
    "Runs <command> with ARAS_URL, ARAS_DATABASE, ARAS_USER and ARAS_PASSWORD (and ARASHOUSE_SLOT,",
    "ARASHOUSE_FLAVOR, ARAS_PKG_ENGINE) in its environment only. Its exit code is passed through.",
    "Example: arashouse run --lease <lease_id> -- aras-pkg export ./out Item:<id>",
  ],
  extract: EXTRACT_HELP,
  media: [MEDIA_USAGE, "", "Are a flavor's installers there, intact and the right version? (docs/media-check.md)"],
  baseline: [
    "usage: arashouse baseline build <flavor> [--replace] [--engine-check <libs-js checkout>]",
    "       arashouse baseline verify <flavor> [--full] [--json]",
    "",
    "build checks the flavor's media (as `media check` does) and writes the bundle the captain runs once,",
    "elevated: staging\\baseline-<flavor>\\baseline-build.ps1. It installs the MSI into a throw-away instance,",
    "checks it serves, copies its tree and database into golden\\<flavor>, then removes the instance. It",
    "refuses a flavor whose golden exists unless --replace, which first marks the flavor's free slots dirty",
    "so they are reset from the new golden. --engine-check bundles a built import-export-libs-js checkout:",
    "with the login check, the build also exports one item with the flavor's libs-js engine. verify asks the broker to check golden\\<flavor> against its",
    "manifest (the fast level, or every file's SHA-256 with --full); exit 1 when it does not verify",
    "(docs/baselines.md).",
  ],
  "reset-worker": [
    "usage: arashouse reset-worker [--slot <slot>]",
    "",
    "Resets <slot> (dirty -> resetting -> free, or quarantined), then every other dirty slot it can.",
    "`return` starts it detached; it is not needed by hand. Without --slot it resets the dirty slots.",
    "Exit 5 if the named slot was quarantined, 6 if the host did not answer (docs/reset.md).",
  ],
  setup: [
    "usage: arashouse setup [--out <dir>]",
    "",
    "Writes setup-host.ps1 and the broker build it installs to <dir> (default: arashouse-setup in the",
    "Windows temp folder) and prints how to run it. The captain runs it once, in an elevated PowerShell:",
    "without -Apply it only prints what it would change. It creates the install root's folders and their",
    "ACLs, lists missing prerequisites, and installs the ArasHouseBroker service (docs/setup.md).",
  ],
  "setup-sql": [
    "usage: arashouse setup-sql [--out <dir>]",
    "",
    "Writes setup-sql.ps1 to <dir> (default: arashouse-setup-sql in the Windows temp folder) and prints how",
    "to run it, once, as a Windows user whose login is a SQL Server sysadmin (Windows authentication; no `sa`,",
    "no password). Without -Apply it only prints the facts and what it would change. It creates arashouse_admin",
    "and its name-checked procedures, and the broker's SQL login in no server role, then checks them as that",
    "login; -SelfTest also creates and drops a throw-away slot database as the broker (docs/setup-sql.md).",
  ],
  doctor: [
    "usage: arashouse doctor [--fix] [--rebuild-state] [--deep] [--yes] [--json]",
    "",
    "Checks the host setup, the state file against the slot stamps, the broker, the SQL login, free disk and RAM,",
    "the media and baselines, orphaned slots (on the host with no record) and resets with no live",
    "worker. Exits 1 when a check fails and was not fixed. --fix re-starts stalled resets, marks a",
    "free slot that is not clean dirty, and with --yes removes orphans. --rebuild-state rebuilds the",
    "state from the slot stamps (a dry run without --yes; the old file is set aside). --deep verifies",
    "each baseline at the full level (every file's SHA-256) instead of the fast level. --json prints",
    "{ ok, exitCode, findings } instead of the lines.",
  ],
  provision: [
    "usage: arashouse provision <flavor> [<count>]",
    "",
    "Makes sure the pool holds slots 01 to <count> of <flavor> (default: slots_per_flavor in the config),",
    "making each missing one on the host from the flavor's golden: its folders, IIS application and pools,",
    "database and logins, rendered configs and stamp. A slot is free once its health check passes; dirty",
    "if the check cannot run. A failed provision is rolled back on the host. See docs/provision.md.",
  ],
  repair: [
    "usage: arashouse repair <slot> [--rebuild]",
    "",
    "The way out of quarantined: resets <slot> from golden (database and tree), then health-checks it.",
    "--rebuild first recreates its IIS application and database shell. Exit 5 if it is quarantined again.",
  ],
  destroy: [
    "usage: arashouse destroy <slot> [--yes] [--include-leased]",
    "",
    "Removes the slot's application, pools, service, folders and database, and its record. A dry run",
    "without --yes. A leased slot is refused (exit 7) unless --include-leased is given; its lease is lost.",
  ],
  prune: [
    "usage: arashouse prune [--yes]",
    "",
    "Lists, and with --yes destroys, the slots that are disabled or orphaned (on the host with no",
    "record). Never by age: a lease has no expiry.",
  ],
  teardown: [
    "usage: arashouse teardown [--goldens] [--keep-sql] [--remove-root] [--include-leased <slot>...] [--yes] [--out <dir>]",
    "",
    "Removes the whole pool. A dry run without --yes. From WSL it destroys every slot (as `destroy` does)",
    "and writes teardown.ps1 to <dir> (default: arashouse-teardown in the Windows temp folder), which the",
    "captain then runs elevated: it drops the SQL objects of setup-sql (not with --keep-sql), uninstalls the",
    "broker service, and with --goldens first removes golden\\<flavor>, with --remove-root last the install",
    "root if it holds only arashouse folders. It refuses while a slot is leased unless every leased slot is",
    "named after --include-leased (their leases are lost). See docs/teardown.md.",
  ],
  "force-return": [
    "usage: arashouse force-return <slot> --lease-id <lease> [--yes]",
    "",
    "The operator's `return` for a holder that crashed. <lease> is the LEASE column of `arashouse",
    "status` (or the whole lease id): if the slot holds another lease, it exits 4 and changes nothing.",
    "The slot is discarded and reset, like `return`. A dry run without --yes.",
  ],
  disable: [
    "usage: arashouse disable <slot>",
    "",
    "Takes the slot out of rotation and stops it on the host (to give its RAM back). A leased slot is",
    "refused (exit 7): return or force-return it first.",
  ],
  enable: ["usage: arashouse enable <slot>", "", "Puts a disabled slot back in rotation; it is reset before it is handed out."],
  help: ["usage: arashouse help [<command>]"],
  version: ["usage: arashouse version"],
};

const OVERVIEW: readonly string[] = [
  "arashouse: a pool of disposable, per-version Aras instances, leased like worktrees.",
  "",
  "usage: arashouse <command> [options]",
  "",
  "  get <flavor> --holder <task> [--wait <seconds>] [--json]  lease a clean slot",
  "      [--agent]                                             ... with its agent service started",
  "  return <lease_id> [--wait[=<seconds>]] [--quiet]           give a lease back (its slot is discarded)",
  "  status [--json]                                            every slot and its holder",
  "  flavors [--json]                                           flavors, engines, free slots, media, baselines",
  "  run --lease <lease_id> -- <command ...>                    run a command with the lease's ARAS_* environment",
  "  extract code --lease <lease_id> <path> --to <dir>          copy code out of a lease before returning it",
  "  extract db --lease <lease_id> --to <file.bak>              ... or a COPY_ONLY backup of its database",
  "  media check [<flavor>...] [--json] [--write-sums]          check the installers",
  "  baseline verify <flavor> [--full] [--json]                 check a flavor's golden against its manifest",
  "  reset-worker [--slot <slot>]                               reset returned slots (return starts it)",
  "",
  "Operator commands (destructive ones are dry runs without --yes):",
  "  setup [--out <dir>]                                        write the one-time, elevated host setup script",
  "  setup-sql [--out <dir>]                                    write the one-time SQL Server setup script",
  "  baseline build <flavor> [--replace]                        write the elevated script that builds a golden",
  "  doctor [--fix] [--rebuild-state] [--deep] [--yes] [--json] check the pool against the host",
  "  provision <flavor> [<count>]                               make the flavor's slots 01 to <count> from golden",
  "  repair <slot> [--rebuild]                                  reset a quarantined slot from golden",
  "  destroy <slot> [--yes] [--include-leased]                  remove a slot from the host and the pool",
  "  prune [--yes]                                              destroy disabled and orphaned slots",
  "  teardown [--goldens] [--keep-sql] [--remove-root] [--yes]  remove the whole pool, then the broker (elevated)",
  "  force-return <slot> --lease-id <lease> [--yes]             return a crashed holder's lease",
  "  disable <slot>                                             take a slot out of rotation",
  "  enable <slot>                                              put a disabled slot back (through a reset)",
  "",
  "  help [<command>]                                           this text, or one command's",
  "  version                                                    the arashouse version",
  "",
  "Options for every command: --help, --verbose (more detail on stderr, never a secret).",
  "Exit codes: 0 ok, 1 other failure, 2 usage, 3 no slot available, 4 lease mismatch,",
  "5 reset failed, 6 host unreachable, 7 refused by a guard, 8 a secret is needed and no terminal",
  "can ask; `run` passes its command's code through. See docs/cli.md.",
];

/** What to try next, by exit code; printed under the error line. */
const HINTS: Readonly<Record<number, string>> = {
  1: `set ${DEBUG_ENV}=1 to see the stack`,
  [EXIT_CODES.usage]: "see `arashouse help <command>`",
  [EXIT_CODES.noSlot]: "wait with `--wait <seconds>`, or see `arashouse status`",
  [EXIT_CODES.leaseMismatch]: "see `arashouse status`; take a new lease with `arashouse get`",
  [EXIT_CODES.resetFailed]: "see `arashouse status` for the slot and its quarantine reason",
  [EXIT_CODES.hostUnreachable]: "is the Windows host up and the arashouse broker running?",
  [EXIT_CODES.refused]: "arashouse touches only what it owns; check the name",
  [SECRET_REQUIRED_EXIT_CODE]: "run the command again from a terminal",
};

export function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "unknown";
}

function helpFor(topic: string | undefined): readonly string[] {
  if (topic === undefined) return OVERVIEW;
  const lines = COMMAND_HELP[topic];
  if (!lines) throw new UsageError(`no command "${topic}"`);
  return lines;
}

/** The exit code for any error the CLI catches. */
export function cliExitCode(err: unknown): number {
  if (err instanceof LicenceRequiredError) return SECRET_REQUIRED_EXIT_CODE;
  if (err instanceof GuardError) return EXIT_CODES.refused;
  return exitCodeFor(err);
}

/** One line (redacted, newlines folded), a hint, and the stack only when debugging. */
export function reportError(err: unknown, io: CliIo, debug: boolean): number {
  const code = cliExitCode(err);
  const shown = redactError(asLeaseError(err));
  io.err(`arashouse: ${shown.message.replace(/\s*\n\s*/g, " ")}`);
  const hint = HINTS[code];
  if (hint !== undefined) io.err(`hint: ${hint}`);
  if (debug && shown.stack !== undefined) io.err(shown.stack);
  return code;
}

interface Context {
  readonly io: CliIo;
  readonly env: NodeJS.ProcessEnv;
  readonly verbose: boolean;
  readonly store: StateStore;
}

async function host(ctx: Context): Promise<SelectedHost> {
  const selected = await selectHost(ctx.env, ctx.store);
  if (ctx.verbose) ctx.io.err(`arashouse: host ${selected.kind}, state in ${ctx.store.paths.home}`);
  return selected;
}

/** The CLI entry a detached reset worker runs; absent when the CLI is not built (source runs in tests). */
const CLI_ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));

/** Starts `arashouse reset-worker --slot <slot>` detached, with no output, and does not wait for it. */
function spawnResetWorker(env: NodeJS.ProcessEnv, slot: string): void {
  if (env[RESET_WORKER_ENV] === "off" || !existsSync(CLI_ENTRY)) return;
  const child = spawn(process.execPath, [CLI_ENTRY, "reset-worker", "--slot", slot], { detached: true, stdio: "ignore", env });
  child.on("error", () => undefined);
  child.unref();
}

async function resetDeps(ctx: Context, selected: SelectedHost): Promise<ResetDeps> {
  return { store: ctx.store, host: selected.host, golden: selected.golden, config: await loadConfig({ home: ctx.store.paths.home }) };
}

async function leaseDeps(ctx: Context): Promise<LeaseDeps> {
  const selected = await host(ctx);
  const reset = await resetDeps(ctx, selected);
  return {
    store: ctx.store,
    host: selected.host,
    secrets: new LeaseFileStore(ctx.store.paths.home),
    resolveUrl: selected.resolveUrl,
    config: reset.config,
    reset: resetHooks(reset, (slot) => spawnResetWorker(ctx.env, slot)),
    golden: selected.golden,
  };
}

async function operatorDeps(ctx: Context): Promise<OperatorDeps> {
  const selected = await host(ctx);
  return {
    store: ctx.store,
    host: selected.host,
    secrets: new LeaseFileStore(ctx.store.paths.home),
    reset: await resetDeps(ctx, selected),
    startWorker: (slot) => spawnResetWorker(ctx.env, slot),
    media: (flavor) => mediaPresent(flavor, { env: ctx.env }),
    setup: selected.kind === "broker" ? () => observeSetup() : undefined,
  };
}

function noPositionals(parsed: ParsedArgs, command: string): void {
  if (parsed.positionals.length > 0) throw new UsageError(`${command} takes no argument "${parsed.positionals[0]}"`);
}

function printJson(io: CliIo, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

async function cmdGet(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { holder: "value", wait: "value", agent: "flag", json: "flag", "password-fd": "value" });
  const [flavor, extra] = parsed.positionals;
  if (flavor === undefined) throw new UsageError(`get needs a flavor: ${FLAVOR_KEYS.join(", ")}`);
  if (extra !== undefined) throw new UsageError(`get takes one flavor, not "${extra}" too`);
  const holder = stringOption(parsed, "holder");
  if (holder === undefined) throw new UsageError("get needs --holder <task>: who is taking the lease");
  const wait = stringOption(parsed, "wait");
  const fdText = stringOption(parsed, "password-fd");
  // Checked before the lease is taken, so a descriptor that is not open costs no slot.
  const passwordFd = fdText === undefined ? undefined : parsePasswordFd(fdText);
  const deps = await leaseDeps(ctx);
  const grant = await getLease(deps, {
    flavor,
    holder,
    waitSeconds: wait === undefined ? 0 : parseSeconds(wait, "--wait"),
    agent: parsed.options.agent === true,
  });
  const returnHint = `return it with: arashouse return ${grant.lease_id}`;
  if (passwordFd !== undefined) {
    try {
      writePasswordFd(passwordFd, grant.password);
    } catch {
      // Nobody has the password, so nobody can use the lease: it goes back at once.
      await returnLease(deps, { target: grant.lease_id });
      throw new UsageError(`the password could not be written to descriptor ${passwordFd}; the lease of ${grant.slot} was returned`);
    }
  }
  if (parsed.options.json === true) {
    printJson(ctx.io, renderGetJson(grant, { password: passwordFd === undefined }));
    ctx.io.err(`arashouse: leased ${grant.slot} to ${grant.holder}; ${returnHint}`);
    return EXIT_CODES.ok;
  }
  const f = getFlavor(grant.flavor);
  for (const line of [
    `leased ${grant.slot} (${f.release}, engine ${grant.engine}) to ${grant.holder}`,
    `url:       ${grant.url}`,
    `database:  ${grant.database}`,
    `user:      ${grant.user}`,
    `lease id:  ${grant.lease_id}`,
    passwordFd === undefined
      ? `password:  not shown; use \`arashouse run --lease ${grant.lease_id} -- <command>\``
      : `password:  written to descriptor ${passwordFd}`,
    returnHint,
  ]) {
    ctx.io.out(line);
  }
  return EXIT_CODES.ok;
}

/** What `return` prints on stderr, unless `--quiet`, when it gives a lease back (ticket 43; the worker guide says the same). */
export function returnReminder(slot: string): string {
  return `Returning slot ${slot}. Its state will be discarded; anything you want to keep must already be out.`;
}

async function cmdReturn(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { "if-lease-id": "value", wait: "optional", quiet: "flag" });
  const [target, extra] = parsed.positionals;
  if (target === undefined) throw new UsageError("return needs a lease id, or a slot and --if-lease-id");
  if (extra !== undefined) throw new UsageError(`return takes one lease or slot, not "${extra}" too`);
  const wait = parsed.options.wait;
  const result = await returnLease(await leaseDeps(ctx), {
    target,
    ifLeaseId: stringOption(parsed, "if-lease-id"),
    waitSeconds: wait === undefined ? undefined : wait === true ? Number.POSITIVE_INFINITY : parseSeconds(wait, "--wait"),
  });
  if (result.outcome === "returned" && result.slot !== null && parsed.options.quiet !== true) ctx.io.err(returnReminder(result.slot));
  ctx.io.out(result.message);
  if (wait !== undefined && result.slot !== null) ctx.io.out(`${result.slot} is free again`);
  return EXIT_CODES.ok;
}

async function cmdStatus(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { json: "flag" });
  noPositionals(parsed, "status");
  if (ctx.verbose) ctx.io.err(`arashouse: state in ${ctx.store.paths.home}`);
  const report = await leaseStatus({ store: ctx.store, config: await loadConfig({ home: ctx.store.paths.home }) });
  if (parsed.options.json === true) printJson(ctx.io, report);
  else for (const line of formatStatus(report)) ctx.io.out(line);
  return EXIT_CODES.ok;
}

async function cmdFlavors(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { json: "flag" });
  noPositionals(parsed, "flavors");
  const report = await buildFlavors(await ctx.store.read(), (await host(ctx)).host, { env: ctx.env });
  if (parsed.options.json === true) printJson(ctx.io, report);
  else for (const line of formatFlavors(report)) ctx.io.out(line);
  return EXIT_CODES.ok;
}

async function cmdRun(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { lease: "value" });
  if (parsed.positionals.length > 0 || parsed.rest === undefined) {
    throw new UsageError("run takes its command after --: arashouse run --lease <lease_id> -- <command ...>");
  }
  const selected = await host(ctx);
  return runWithLease(
    { store: ctx.store, secrets: new LeaseFileStore(ctx.store.paths.home), resolveUrl: selected.resolveUrl, env: ctx.env, err: ctx.io.err },
    { leaseId: stringOption(parsed, "lease"), command: parsed.rest },
  );
}

async function cmdExtract(ctx: Context, args: readonly string[]): Promise<number> {
  const selected = await host(ctx);
  return runExtract(
    { store: ctx.store, host: selected.host, root: selected.root, toLocal: selected.toLocal, out: ctx.io.out, err: ctx.io.err, verbose: ctx.verbose },
    args,
  );
}

async function cmdMedia(ctx: Context, args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command !== "check") throw new UsageError(command === undefined ? `media needs a command: ${MEDIA_USAGE}` : `unknown command "media ${command}"`);
  // An MSI unpacked from a zip must land where Windows Installer can open it: a Windows drive.
  const scratchDir = await windowsTempDir().catch(() => undefined);
  return runMediaCheck(rest, { readMsi: createMsiReader(), scratchDir }, ctx.io);
}

async function cmdBaseline(ctx: Context, args: readonly string[]): Promise<number> {
  const selected = await host(ctx);
  const config = await loadConfig({ home: ctx.store.paths.home });
  return runBaselineCommand(
    {
      host: selected.host,
      store: ctx.store,
      checkMedia: async (flavor) => checkMedia(flavor, { env: ctx.env, readMsi: createMsiReader(), scratchDir: await windowsTempDir().catch(() => undefined) }),
      writeBundle: (flavor, media, engineDir) =>
        writeBaselineBundle({
          flavor,
          media,
          distDir: DIST_DIR,
          packageJson: PACKAGE_JSON,
          version: version(),
          minFreeDiskGb: config.min_free_disk_gb,
          ...(engineDir !== undefined ? { engineDir } : {}),
        }),
      out: ctx.io.out,
      err: ctx.io.err,
    },
    args,
  );
}

async function cmdResetWorker(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { slot: "value" });
  noPositionals(parsed, "reset-worker");
  const named = stringOption(parsed, "slot");
  let first: string | undefined;
  if (named !== undefined) {
    try {
      first = slotId(parseSlotId(named));
    } catch {
      throw new UsageError(`"${named}" is not a slot id (<flavor>-<NN>)`);
    }
  }
  const outcomes = await runResetWorker(await resetDeps(ctx, await host(ctx)), first);
  for (const outcome of outcomes) ctx.io.out(describeOutcome(outcome));
  const own = outcomes.find((o) => o.slot === first);
  if (own?.kind === "quarantined") return EXIT_CODES.resetFailed;
  if (outcomes.some((o) => o.kind === "dirty")) return EXIT_CODES.hostUnreachable;
  return EXIT_CODES.ok;
}

function printResult(ctx: Context, result: OperatorResult): number {
  for (const line of result.lines) ctx.io.out(line);
  return result.exitCode;
}

/** The one slot an operator command takes. */
function oneSlot(parsed: ParsedArgs, command: string): string {
  const [slot, extra] = parsed.positionals;
  if (slot === undefined) throw new UsageError(`${command} needs a slot (<flavor>-<NN>), as \`arashouse status\` shows it`);
  if (extra !== undefined) throw new UsageError(`${command} takes one slot, not "${extra}" too`);
  return slot;
}

async function cmdDoctor(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { fix: "flag", "rebuild-state": "flag", deep: "flag", yes: "flag", json: "flag" });
  noPositionals(parsed, "doctor");
  const o = parsed.options;
  const result = await doctor(await operatorDeps(ctx), { fix: o.fix === true, rebuildState: o["rebuild-state"] === true, deep: o.deep === true, yes: o.yes === true });
  if (o.json !== true) return printResult(ctx, result);
  printJson(ctx.io, { ok: result.exitCode === EXIT_CODES.ok, exitCode: result.exitCode, findings: result.findings ?? [] });
  return result.exitCode;
}

async function cmdSetup(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { out: "value" });
  noPositionals(parsed, "setup");
  const outDir = stringOption(parsed, "out") ?? join(await windowsTempDir(), "arashouse-setup");
  const flavors = await flavorsToCheck((flavor) => mediaPresent(flavor, { env: ctx.env }));
  const bundle = await writeSetupBundle({
    outDir,
    distDir: DIST_DIR,
    packageJson: PACKAGE_JSON,
    version: version(),
    worker: await workerIdentity(),
    flavors,
  });
  const script = (await defaultRun("wslpath", ["-w", bundle.script]).catch(() => bundle.script)).trim();
  for (const line of [
    `wrote ${script} and the broker build it installs (${bundle.files} files, each pinned by SHA-256)`,
    `it checks the prerequisites of ${flavors.join(", ")} and changes nothing without -Apply`,
    "in an elevated Windows PowerShell (Run as administrator):",
    `  powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"           # the plan`,
    `  powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Apply    # make the changes`,
    "then, from WSL: arashouse doctor (docs/setup.md)",
  ]) {
    ctx.io.out(line);
  }
  if (!/^[A-Za-z]:\\/.test(script)) ctx.io.err(`arashouse: ${script} is not on a Windows drive; copy its folder to one before running it`);
  return EXIT_CODES.ok;
}

async function cmdSetupSql(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { out: "value" });
  noPositionals(parsed, "setup-sql");
  const outDir = stringOption(parsed, "out") ?? join(await windowsTempDir(), "arashouse-setup-sql");
  const written = await writeSetupSqlScript({ outDir, version: version() });
  const script = (await defaultRun("wslpath", ["-w", written]).catch(() => written)).trim();
  for (const line of [
    `wrote ${script}`,
    "it connects to the default SQL Server instance by shared memory with your Windows login, which must be a sysadmin",
    "(no `sa`, no password), and changes nothing without -Apply; in Windows PowerShell:",
    `  powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"                     # the facts and the plan`,
    `  powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Apply              # make the changes, then check them`,
    `  powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Apply -SelfTest    # ... and a round trip as the broker`,
    "then, from WSL: arashouse doctor (docs/setup-sql.md)",
  ]) {
    ctx.io.out(line);
  }
  if (!/^[A-Za-z]:\\/.test(script)) ctx.io.err(`arashouse: ${script} is not on a Windows drive; copy it to one before running it`);
  return EXIT_CODES.ok;
}

async function cmdProvision(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, {});
  const [flavor, count, extra] = parsed.positionals;
  if (flavor === undefined) throw new UsageError(`provision needs a flavor: ${FLAVOR_KEYS.join(", ")}`);
  if (extra !== undefined) throw new UsageError(`provision takes a flavor and a count, not "${extra}" too`);
  if (count !== undefined && !/^\d{1,2}$/.test(count)) throw new UsageError(`the slot count must be a whole number from 1 to 99, not "${count}"`);
  const deps = await operatorDeps(ctx);
  const lockPath = join(ctx.store.paths.home, "provision.lock");
  const provisionLock = async () => {
    try {
      return await acquireLock(lockPath, { timeoutMs: 2_000 });
    } catch (err) {
      if (err instanceof LockTimeoutError) throw new Error(`another provision is running${err.heldBy === null ? "" : ` (pid ${err.heldBy})`}; wait for it to finish`);
      throw err;
    }
  };
  return printResult(ctx, await provisionPool({ ...deps, provisionLock }, { flavor, ...(count === undefined ? {} : { count: Number(count) }) }));
}

async function cmdRepair(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { rebuild: "flag" });
  const slot = oneSlot(parsed, "repair");
  return printResult(ctx, await repairSlot(await operatorDeps(ctx), { slot, rebuild: parsed.options.rebuild === true }));
}

async function cmdDestroy(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { yes: "flag", "include-leased": "flag" });
  const slot = oneSlot(parsed, "destroy");
  return printResult(ctx, await destroySlot(await operatorDeps(ctx), { slot, yes: parsed.options.yes === true, includeLeased: parsed.options["include-leased"] === true }));
}

async function cmdPrune(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { yes: "flag" });
  noPositionals(parsed, "prune");
  return printResult(ctx, await prune(await operatorDeps(ctx), { yes: parsed.options.yes === true }));
}

async function cmdTeardown(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { yes: "flag", "include-leased": "flag", goldens: "flag", "keep-sql": "flag", "remove-root": "flag", out: "value" });
  const o = parsed.options;
  if (o["include-leased"] !== true && parsed.positionals.length > 0) throw new UsageError(`teardown names slots only after --include-leased, not "${parsed.positionals[0]}"`);
  if (o["include-leased"] === true && parsed.positionals.length === 0) throw new UsageError("--include-leased needs the exact name of every leased slot (<flavor>-<NN>)");
  const request: TeardownRequest = { yes: o.yes === true, includeLeased: parsed.positionals, goldens: o.goldens === true, keepSql: o["keep-sql"] === true, removeRoot: o["remove-root"] === true };
  const switches = teardownSwitches(request);
  const deps = await operatorDeps(ctx);
  const out = stringOption(parsed, "out");
  let script = "";
  const writeBundle = async () => {
    const written = await writeTeardownBundle({
      outDir: out ?? join(await windowsTempDir(), "arashouse-teardown"),
      distDir: DIST_DIR,
      packageJson: PACKAGE_JSON,
      version: version(),
      worker: await workerIdentity(),
      flavors: await flavorsToCheck((flavor) => mediaPresent(flavor, { env: ctx.env })),
    });
    script = (await defaultRun("wslpath", ["-w", written]).catch(() => written)).trim();
  };
  const result = await teardownPool(deps, request, writeBundle);
  for (const line of result.lines) ctx.io.out(line);
  const command = (extra: string) => `  powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"${[...switches, extra].filter(Boolean).map((s) => ` ${s}`).join("")}`;
  if (!request.yes) {
    ctx.io.out(`with --yes it first writes teardown.ps1 and the two scripts it runs to ${out ?? "arashouse-teardown in the Windows temp folder"}`);
  } else if (!result.slotsGone) {
    ctx.io.out(`wrote ${script}, but slots are left, and it refuses until they are gone: run arashouse teardown --yes again`);
  } else {
    for (const line of [
      `wrote ${script} and the two scripts it runs (each pinned by SHA-256)`,
      "in an elevated Windows PowerShell (Run as administrator):",
      `${command("")}           # the plan`,
      `${command("-Apply")}    # make the changes`,
      "it prints the deny-list before and after, what is left, and the result as JSON (docs/teardown.md)",
    ]) {
      ctx.io.out(line);
    }
    if (!/^[A-Za-z]:\\/.test(script)) ctx.io.err(`arashouse: ${script} is not on a Windows drive; copy its folder to one before running it`);
  }
  return result.exitCode;
}

async function cmdForceReturn(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { "lease-id": "value", yes: "flag" });
  const slot = oneSlot(parsed, "force-return");
  return printResult(ctx, await forceReturn(await operatorDeps(ctx), { slot, leaseId: stringOption(parsed, "lease-id"), yes: parsed.options.yes === true }));
}

async function cmdDisable(ctx: Context, args: readonly string[]): Promise<number> {
  const slot = oneSlot(parseArgs(args, {}), "disable");
  return printResult(ctx, await disableSlot(await operatorDeps(ctx), slot));
}

async function cmdEnable(ctx: Context, args: readonly string[]): Promise<number> {
  const slot = oneSlot(parseArgs(args, {}), "enable");
  return printResult(ctx, await enableSlot(await operatorDeps(ctx), slot));
}

const COMMANDS: Readonly<Record<string, (ctx: Context, args: readonly string[]) => Promise<number>>> = {
  get: cmdGet,
  return: cmdReturn,
  status: cmdStatus,
  flavors: cmdFlavors,
  run: cmdRun,
  extract: cmdExtract,
  media: cmdMedia,
  baseline: cmdBaseline,
  "reset-worker": cmdResetWorker,
  setup: cmdSetup,
  "setup-sql": cmdSetupSql,
  doctor: cmdDoctor,
  provision: cmdProvision,
  repair: cmdRepair,
  destroy: cmdDestroy,
  prune: cmdPrune,
  teardown: cmdTeardown,
  "force-return": cmdForceReturn,
  disable: cmdDisable,
  enable: cmdEnable,
};

/** Splits off what follows `--` (only `run` has it), so the global flags are looked for before it. */
function splitRest(argv: readonly string[]): [readonly string[], readonly string[] | undefined] {
  const at = argv.indexOf("--");
  return at === -1 ? [argv, undefined] : [argv.slice(0, at), argv.slice(at)];
}

async function dispatch(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv): Promise<number> {
  const [head, rest] = splitRest(argv);
  const verbose = head.includes("--verbose");
  const wantsHelp = head.includes("--help") || head.includes("-h");
  const words = head.filter((a) => a !== "--verbose" && a !== "--help" && a !== "-h");
  const [command, ...args] = words;

  if (command === "--version" || command === "version") {
    io.out(`arashouse ${version()}`);
    return EXIT_CODES.ok;
  }
  if (command === "help") {
    for (const line of helpFor(args[0])) io.out(line);
    return EXIT_CODES.ok;
  }
  if (wantsHelp) {
    for (const line of helpFor(command !== undefined && COMMAND_HELP[command] ? command : undefined)) io.out(line);
    return EXIT_CODES.ok;
  }
  if (command === undefined) {
    for (const line of OVERVIEW) io.err(line);
    return EXIT_CODES.usage;
  }
  const handler = COMMANDS[command];
  if (!handler) throw new UsageError(`unknown command "${command}"`);
  const store = new StateStore({ env });
  return handler({ io, env, verbose, store }, rest === undefined ? args : [...args, ...rest]);
}

/** Runs one CLI invocation and resolves with its exit code. It never throws. */
export async function runCli(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    return await dispatch(argv, io, env);
  } catch (err) {
    return reportError(err, io, env[DEBUG_ENV] === "1");
  }
}
