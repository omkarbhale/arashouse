// The worker-facing command surface: `get`, `return`, `status`, `flavors`, `run`, `extract` (ticket 43), `help`, `version`
// (and `get --import` and `import`, ticket 41, `media check`, ticket 18, `baseline verify`, ticket 28, and `reset-worker`, ticket 14), thin
// over the lease core, and the operator commands (`doctor`, `repair`, `destroy`, `prune`,
// `force-return`, `disable`, `enable`, ticket 16; `baseline build`, ticket 24; `teardown`, ticket 49), thin over
// operator.ts. Output rules: no command prints a password except `get --json`, once; `--verbose`
// never adds a secret; an error is one line plus a hint, with the stack only under `ARASHOUSE_DEBUG=1`. The exit codes are docs/cli.md's table.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { release, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODES } from "../core/exit-codes.js";
import { FLAVOR_KEYS, getFlavor, isFlavorKey, type FlavorKey } from "../core/flavors.js";
import { GuardError } from "../core/guards.js";
import {
  LeaseError,
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
import { isLeaseId } from "../core/state.js";
import { createMsiReader, windowsTempDir } from "../host/msi.js";
import { parseArgs, parseSeconds, stringOption, type ParsedArgs } from "./args.js";
import { buildFlavors, formatFlavors, mediaPresent } from "./flavors.js";
import { selectHost, type CliHost, type SelectedHost } from "./host.js";
import { deployCodeOnLease, formatOutcomes, localInstallRoot, planSource, refusedDeploy, type CodeDeployReport, type CodeRules, type PlannedSource } from "./code.js";
import { assertNoGitTargets, checkGitTool, formatGitOutcome, gitBaselineOnLease, refusedBaseline, selectGitTool, type GitReport } from "./git.js";
import { MEDIA_USAGE, runMediaCheck } from "./media.js";
import { parsePasswordFd, writePasswordFd } from "./password-fd.js";
import { runWithLease } from "./run.js";
import { EXTRACT_HELP, runExtract } from "./extract.js";
import { describeArasPkg, prepareImports, requireArasPkg, runImports, splitImports, leaseFlavor, type ImportDeps, type ImportResult } from "./import.js";
import { runBaselineCommand, writeBaselineBundle } from "./baseline.js";
import { checkMedia } from "../core/media-check.js";
import { DIST_DIR, PACKAGE_JSON, defaultRun, flavorsToCheck, observeSetup, workerIdentity, writeSetupBundle, writeSetupSqlScript } from "./setup.js";
import { folderStaging, hostStaging, resolveRestoreSource } from "./restore.js";
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
    "                     [--code <dir|zip>[:<subpath>]]... [--allow-config] [--allow-servers] [--atomic]",
    "                     [--import <manifest|folder> [<import options>]]... [--keep-on-fail] [--git]",
    "                     [--restore <backup.bak | profile> [--allow-foreign-origin] [--skip-version-check]]",
    "",
    `Leases a clean slot of <flavor> (${FLAVOR_KEYS.join(", ")}) to <task>. With --json, stdout is the`,
    "lease contract (docs/schemas/get.schema.json) and nothing else; it holds the lease's password,",
    "shown this once. Without --json the password is not shown: reach it through `arashouse run`.",
    "--wait <seconds> waits up to that long for a slot; without it, no free slot exits 3 at once.",
    "--agent also starts the slot's agent service (conversion tasks, scheduled methods); without it the",
    "agent stays stopped. A flavor whose golden has no agent refuses it (exit 7).",
    "--password-fd <n> writes the password and a newline to descriptor <n> (3 or more, opened for the",
    "command, for example `3>file`) instead, and --json then leaves it out.",
    "--restore restores a SQL Server backup over the lease's database before it is handed over: a",
    "file (a WSL or Windows path), or a profile, media/<flavor>/profiles/<name>.bak. A backup taken of a",
    "deny-listed database (OLM_Local, ...) is refused unless --allow-foreign-origin; a database of another",
    "flavor fails with the flavor to use unless --skip-version-check. If the restore fails, the lease is",
    "given back. The return resets the slot as always (docs/restore.md). A --skip-version-check before",
    "the first --import is --restore's; one after an --import is that import's.",
    "--import <manifest|folder> imports a package manifest (imports.mf, or the folder that holds one) onto the",
    "lease with import-export-libs-js (`aras-pkg import`, the flavor's engine), in the order given; the options",
    "after an --import are its own (see `arashouse help import`). A failed import returns the lease and exits 9",
    "with aras-pkg's exit code and log; --keep-on-fail keeps the lease instead, so a human can look (still exit 9).",
    "--code deploys a folder or zip into the slot's tree once it is leased, as `deploy-code` does, in the",
    "order given and before the imports; a deploy a guard refuses is refused before the lease is taken (exit 7).",
    "If a deploy fails, the lease is still held and shown, no import runs, and get exits 10; with --atomic it is",
    "returned (and reset) instead.",
    "--git makes the slot's Innovator\\ tree a git repository last, as `git-baseline` does: its one commit is the",
    "tree as handed over (with the code deployed), so `git status` and `git diff` show only what changes after.",
    "A failed baseline keeps the lease and exits 10, like a failed deploy (--atomic returns it).",
  ],
  "git-baseline": [
    "usage: arashouse git-baseline --lease <lease_id> [--json]",
    "",
    "Makes the leased slot's Innovator\\ tree a git repository whose one commit is the tree as it is now, by",
    "\"arashouse <arashouse@localhost>\": git status and git diff then show only what changed after. A generated",
    ".gitignore leaves out the secrets and identity files, the files that tie the tree to the slot and the files",
    "the server writes as it runs; a commit that would hold a secret is refused. Git for Windows builds it, as",
    "you (ARASHOUSE_WINDOWS_GIT says where git.exe is); the slot is recycled when it is put in place. The repository",
    "has no remote, and returning the lease removes it. Exit 7 when refused (nothing changed), 10 when it failed",
    "(the lease is still held). See docs/git-baseline.md.",
  ],
  "deploy-code": [
    "usage: arashouse deploy-code --lease <lease_id> <dir|zip>[:<subpath>]... [--allow-config] [--allow-servers] [--json]",
    "",
    "Copies a folder or zip over the leased slot's tree (an overlay: nothing else changes), then starts",
    "and warms the slot again. <subpath> is where it lands in the tree (default Innovator; `.` is the",
    "top). Only Innovator\\ is written, and VaultServer\\ and OAuthServer\\ with --allow-servers; the",
    "secrets and identity files (InnovatorServerConfig.xml, *.pfx, *.cer, key-*.xml, vault.config) need",
    "--allow-config. A deploy.json at the top of the source may list the files to copy (\"files\") and",
    "files to delete (\"delete\"). Returning the lease discards all of it. Exit 7 when a guard refuses",
    "(nothing changed), 10 when a deploy failed (the lease is still held). See docs/code-deploy.md.",
  ],
  import: [
    "usage: arashouse import --lease <lease_id> <manifest|folder> [<import options>] [<manifest|folder> [<import options>]]...",
    "",
    "Imports package manifests onto a held lease, in order, with import-export-libs-js: `aras-pkg import <manifest>",
    "--engine <the flavor's> --url --database --user root`, with the lease's password in its environment only. Its",
    "log goes to $ARASHOUSE_HOME/logs/<lease_id>-import-<n>.log. The first import that fails stops the run with",
    "exit 9 (aras-pkg's exit code and log on stderr); the lease is kept. aras-pkg is $ARASHOUSE_APKG (a checkout's",
    "dist/cli.js) or aras-pkg on PATH.",
    "",
    "Import options (each belongs to the manifest before it):",
    "  --merge | --no-merge     merge into existing items, or skip them (aras-pkg's default)",
    "  --release <text>         the target_release of the DatabaseUpgrade rows",
    "  --description <text>     their description",
    "  --package <name>         import only this package of the manifest (repeatable)",
    "  --os-user <name>         the os_user of the rows",
    "  --languages <codes|*>    engine 14.35 only: import only these languages",
    "  --collect-errors, --batch  engine 14.35 only",
    "  --timeout <ms>           the engine's response timeout (0 its default, -1 for ever)",
    "  --engine <version>       run this engine, not the flavor's (12.0, 14.0.7, 14.35)",
    "  --skip-version-check     refused unless --engine is given too",
    "--verbose also makes aras-pkg verbose. An ARAS_PKG_ENGINE in the environment that is not the flavor's engine",
    "is refused unless the import names --engine.",
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
  "      [--code <dir|zip>[:<subpath>]]... [--atomic]          ... with code deployed into it",
  "      [--restore <backup.bak | profile>]                    ... brought up from a SQL Server backup",
  "      [--git]                                               ... and its tree committed as a git baseline",
  "  deploy-code --lease <lease_id> <dir|zip>[:<subpath>]...   deploy code into a leased slot",
  "  git-baseline --lease <lease_id> [--json]                   make a held lease's tree a git repository",
  "  return <lease_id> [--wait[=<seconds>]] [--quiet]           give a lease back (its slot is discarded)",
  "  status [--json]                                            every slot and its holder",
  "  flavors [--json]                                           flavors, engines, free slots, media, baselines",
  "      [--import <manifest|folder> [...]]... [--keep-on-fail]  ... with packages imported onto it (aras-pkg)",
  "  import --lease <lease_id> <manifest|folder> [...]           import packages onto a held lease (aras-pkg)",
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
  "can ask, 9 an import failed, 10 a code deploy or git baseline failed after the lease was taken; `run`",
  "passes its command's code through. See docs/cli.md.",
];

/** What to try next, by exit code; printed under the error line. */
const HINTS: Readonly<Record<number, string>> = {
  1: `set ${DEBUG_ENV}=1 to see the stack`,
  [EXIT_CODES.usage]: "see `arashouse help <command>`",
  [EXIT_CODES.noSlot]: "wait with `--wait <seconds>`, or see `arashouse status`",
  [EXIT_CODES.leaseMismatch]: "see `arashouse status`; take a new lease with `arashouse get`",
  [EXIT_CODES.resetFailed]: "see `arashouse status` for the slot and its quarantine reason",
  [EXIT_CODES.hostUnreachable]: "is the Windows host up and the arashouse broker running?",
  [EXIT_CODES.refused]: "arashouse touches only what it owns and refuses what it cannot use: the line above says which; check the name or the backup",
  [SECRET_REQUIRED_EXIT_CODE]: "run the command again from a terminal",
  [EXIT_CODES.importFailed]: "read the import's log; `get --keep-on-fail` keeps the lease to look at it",
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

async function leaseDeps(ctx: Context): Promise<LeaseDeps & Pick<SelectedHost, "resolveUrl" | "kind"> & { readonly host: CliHost }> {
  const selected = await host(ctx);
  const reset = await resetDeps(ctx, selected);
  return {
    kind: selected.kind,
    store: ctx.store,
    host: selected.host,
    secrets: new LeaseFileStore(ctx.store.paths.home),
    // The fake host stages into a folder of the state's home, never the host's staging folder.
    staging: selected.kind === "broker" ? hostStaging() : folderStaging(join(ctx.store.paths.home, "fake-staging")),
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
    importTool: () => describeArasPkg(ctx.env),
    wslMemoryMb: selected.kind === "broker" ? wslMemoryMb : undefined,
  };
}

/** The WSL VM's memory in MB (inside WSL, MemTotal is the VM's cap), or undefined outside WSL. */
function wslMemoryMb(): number | undefined {
  return /microsoft/i.test(release()) ? Math.floor(totalmem() / (1024 * 1024)) : undefined;
}

function noPositionals(parsed: ParsedArgs, command: string): void {
  if (parsed.positionals.length > 0) throw new UsageError(`${command} takes no argument "${parsed.positionals[0]}"`);
}

function printJson(io: CliIo, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

const GET_OPTIONS = {
  holder: "value",
  wait: "value",
  agent: "flag",
  json: "flag",
  "password-fd": "value",
  "keep-on-fail": "flag",
  restore: "value",
  "allow-foreign-origin": "flag",
  // --restore's: before the first --import only; after one it is that import's (splitImports).
  "skip-version-check": "flag",
  code: "list",
  "allow-config": "flag",
  "allow-servers": "flag",
  atomic: "flag",
  git: "flag",
} as const;

/** `--allow-config` and `--allow-servers`, which only a deploy takes. */
function codeRules(parsed: ParsedArgs): CodeRules {
  return { allowConfig: parsed.options["allow-config"] === true, allowServers: parsed.options["allow-servers"] === true };
}

function importDeps(ctx: Context, deps: Pick<ImportDeps, "resolveUrl">): ImportDeps {
  return {
    store: ctx.store,
    secrets: new LeaseFileStore(ctx.store.paths.home),
    resolveUrl: deps.resolveUrl,
    env: ctx.env,
    err: ctx.io.err,
    apkg: requireArasPkg(ctx.env),
    home: ctx.store.paths.home,
  };
}

async function cmdGet(ctx: Context, args: readonly string[]): Promise<number> {
  const { rest, steps } = splitImports(args, GET_OPTIONS, "--import");
  const parsed = parseArgs(rest, GET_OPTIONS);
  const [flavor, extra] = parsed.positionals;
  if (flavor === undefined) throw new UsageError(`get needs a flavor: ${FLAVOR_KEYS.join(", ")}`);
  if (extra !== undefined) throw new UsageError(`get takes one flavor, not "${extra}" too`);
  const holder = stringOption(parsed, "holder");
  if (holder === undefined) throw new UsageError("get needs --holder <task>: who is taking the lease");
  const wait = stringOption(parsed, "wait");
  const fdText = stringOption(parsed, "password-fd");
  const keepOnFail = parsed.options["keep-on-fail"] === true;
  if (keepOnFail && steps.length === 0) throw new UsageError("--keep-on-fail goes with --import");
  const codeTexts = parsed.lists.code ?? [];
  const git = parsed.options.git === true;
  for (const flag of ["allow-config", "allow-servers"]) {
    if (parsed.options[flag] === true && codeTexts.length === 0) throw new UsageError(`--${flag} goes with --code`);
  }
  if (parsed.options.atomic === true && codeTexts.length === 0 && !git) throw new UsageError("--atomic goes with --code or --git");
  // Checked before the lease is taken, so a descriptor that is not open costs no slot.
  const passwordFd = fdText === undefined ? undefined : parsePasswordFd(fdText);
  const restoreValue = stringOption(parsed, "restore");
  const allowForeignOrigin = parsed.options["allow-foreign-origin"] === true;
  const skipVersionCheck = parsed.options["skip-version-check"] === true;
  if (restoreValue === undefined && (allowForeignOrigin || skipVersionCheck)) {
    throw new UsageError("--allow-foreign-origin and --skip-version-check go with --restore");
  }
  // So is the backup, so a missing file costs no slot either.
  const restore =
    restoreValue === undefined
      ? undefined
      : isFlavorKey(flavor)
        ? await resolveRestoreSource(flavor, restoreValue, { allowForeignOrigin, skipVersionCheck, media: { env: ctx.env } })
        : undefined;
  // So are the code deploys: each source read and planned, so one a guard refuses costs no slot (ticket 40).
  const rules = codeRules(parsed);
  const sources: PlannedSource[] = [];
  for (const text of codeTexts) sources.push(await planSource(text, rules));
  // So are the imports: their manifests, their options against the flavor's engine, and aras-pkg itself.
  if (steps.length > 0 && !isFlavorKey(flavor)) throw new UsageError(`unknown flavor "${flavor}"; the flavors are ${FLAVOR_KEYS.join(", ")}`);
  const imports = steps.length === 0 ? [] : prepareImports(steps, { flavor: flavor as FlavorKey, env: ctx.env, verbose: ctx.verbose });
  const apkgCheck = steps.length === 0 ? undefined : requireArasPkg(ctx.env);
  const deps = await leaseDeps(ctx);
  // And the git baseline: no --code may write the repository's place, and git must run (ticket 53).
  const gitTool = git ? selectGitTool(deps.kind, ctx.env, localInstallRoot(ctx.env)) : undefined;
  if (gitTool !== undefined) {
    assertNoGitTargets(sources);
    await checkGitTool(gitTool, ctx.env);
  }
  const agent = parsed.options.agent === true;
  const grant = await getLease(deps, {
    flavor,
    holder,
    waitSeconds: wait === undefined ? 0 : parseSeconds(wait, "--wait"),
    agent,
    ...(restore ? { restore } : {}),
  });
  const returnHint = `return it with: arashouse return ${grant.lease_id}`;
  // The code first, then the imports (the bootstrap order: restore, code, imports).
  let deployed: CodeDeployReport | undefined;
  if (sources.length > 0) {
    deployed = await deployCodeOnLease(
      { store: ctx.store, host: deps.host, localRoot: localInstallRoot(ctx.env) },
      { slot: grant.slot, leaseId: grant.lease_id, agent },
      sources,
      rules,
    );
    if (!deployed.ok && parsed.options.atomic === true) {
      // `--atomic`: a lease whose code did not deploy is not handed out; the reset removes what did.
      await returnLease(deps, { target: grant.lease_id });
      const last = deployed.outcomes.at(-1);
      throw new LeaseError(EXIT_CODES.codeFailed, `the code deploy into ${grant.slot} failed (${last?.detail ?? "no detail"}); --atomic returned the lease, and the slot is reset`);
    }
  }
  const codeFailure = deployed && !deployed.ok ? `the code deploy failed (${deployed.outcomes.at(-1)?.detail ?? "no detail"}); the lease is still held, and no import ran` : undefined;
  let results: readonly ImportResult[] | undefined;
  let failure: string | undefined;
  if (apkgCheck !== undefined && codeFailure === undefined) {
    try {
      ({ results, failure } = await runImports(importDeps(ctx, deps), grant.lease_id, imports));
    } catch (err) {
      // An import that could not even start leaves a lease nobody asked for half made: it goes back.
      await returnLease(deps, { target: grant.lease_id });
      throw err;
    }
    if (failure !== undefined && !keepOnFail) {
      // Atomic: the lease goes back, and the slot is reset before it is handed out again.
      await returnLease(deps, { target: grant.lease_id });
      throw new LeaseError(EXIT_CODES.importFailed, `${failure}; the lease of ${grant.slot} was returned (--keep-on-fail keeps it)`);
    }
  }
  // The git baseline last, after everything that changes the tree (the bootstrap order: restore, code, imports, git).
  let baseline: GitReport | undefined;
  if (gitTool !== undefined && codeFailure === undefined && failure === undefined) {
    baseline = await gitBaselineOnLease(
      { store: ctx.store, host: deps.host, git: gitTool, localRoot: localInstallRoot(ctx.env), env: ctx.env },
      { slot: grant.slot, leaseId: grant.lease_id, flavor: grant.flavor, agent },
    );
    if (!baseline.outcome.ok && parsed.options.atomic === true) {
      await returnLease(deps, { target: grant.lease_id });
      throw new LeaseError(EXIT_CODES.codeFailed, `the git baseline of ${grant.slot} failed (${baseline.outcome.detail}); --atomic returned the lease, and the slot is reset`);
    }
  }
  const gitFailure = baseline && !baseline.outcome.ok ? `the git baseline failed (${baseline.outcome.detail}); the lease is still held` : undefined;
  if (passwordFd !== undefined) {
    try {
      writePasswordFd(passwordFd, grant.password);
    } catch {
      // Nobody has the password, so nobody can use the lease: it goes back at once.
      await returnLease(deps, { target: grant.lease_id });
      throw new UsageError(`the password could not be written to descriptor ${passwordFd}; the lease of ${grant.slot} was returned`);
    }
  }
  const finish = (): number => {
    if (codeFailure !== undefined) {
      ctx.io.err(`arashouse: ${codeFailure}: ${returnHint}`);
      return EXIT_CODES.codeFailed;
    }
    if (gitFailure !== undefined) {
      ctx.io.err(`arashouse: ${gitFailure}: ${returnHint}`);
      return EXIT_CODES.codeFailed;
    }
    if (failure === undefined) return EXIT_CODES.ok;
    ctx.io.err(`arashouse: ${failure}; the lease of ${grant.slot} is kept (--keep-on-fail): ${returnHint}`);
    return EXIT_CODES.importFailed;
  };
  if (parsed.options.json === true) {
    printJson(ctx.io, {
      ...renderGetJson(grant, { password: passwordFd === undefined }),
      ...(deployed === undefined && baseline === undefined
        ? {}
        : { bootstrap: { ...(deployed === undefined ? {} : { code: deployed.outcomes }), ...(baseline === undefined ? {} : { git: baseline.outcome }) } }),
      ...(results === undefined ? {} : { imports: results }),
    });
    ctx.io.err(`arashouse: leased ${grant.slot} to ${grant.holder}; ${returnHint}`);
    return finish();
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
    ...(deployed ? formatOutcomes(deployed.outcomes) : []),
    ...(results ?? []).map((r, i) => `import ${i + 1}:  ${r.manifest} (exit ${r.exit_code}; log ${r.log})`),
    ...(baseline ? [formatGitOutcome(baseline.outcome)] : []),
    returnHint,
  ]) {
    ctx.io.out(line);
  }
  return finish();
}

async function cmdImport(ctx: Context, args: readonly string[]): Promise<number> {
  const outer = { lease: "value" } as const;
  const { rest, steps } = splitImports(args, outer, "positional");
  const parsed = parseArgs(rest, outer);
  const leaseId = stringOption(parsed, "lease");
  if (leaseId === undefined) throw new UsageError("import needs --lease <lease_id>");
  if (!isLeaseId(leaseId)) throw new UsageError("--lease must be a lease id (32 lower-case hex characters)");
  if (steps.length === 0) throw new UsageError("import needs a manifest (imports.mf) or the folder that holds one");
  const selected = await host(ctx);
  const deps = importDeps(ctx, selected);
  const imports = prepareImports(steps, { flavor: await leaseFlavor(deps, leaseId), env: ctx.env, verbose: ctx.verbose });
  const { results, failure } = await runImports(deps, leaseId, imports);
  for (const [i, r] of results.entries()) ctx.io.out(`import ${i + 1}: ${r.manifest} (exit ${r.exit_code}; log ${r.log})`);
  if (failure !== undefined) throw new LeaseError(EXIT_CODES.importFailed, `${failure}; the lease is kept`);
  return EXIT_CODES.ok;
}

/** What `return` prints on stderr, unless `--quiet`, when it gives a lease back (ticket 43; the worker guide says the same). */
export function returnReminder(slot: string): string {
  return `Returning slot ${slot}. Its state will be discarded; anything you want to keep must already be out.`;
}

async function cmdDeployCode(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { lease: "value", "allow-config": "flag", "allow-servers": "flag", json: "flag" });
  const leaseId = stringOption(parsed, "lease");
  if (leaseId === undefined) throw new UsageError("deploy-code needs --lease <lease_id>");
  if (!isLeaseId(leaseId)) throw new UsageError("--lease must be a lease id (32 lower-case hex characters)");
  if (parsed.positionals.length === 0) throw new UsageError("deploy-code needs a folder or zip to deploy: <dir|zip>[:<subpath>]");
  const rules = codeRules(parsed);
  const sources: PlannedSource[] = [];
  for (const text of parsed.positionals) sources.push(await planSource(text, rules));
  const slot = Object.values((await ctx.store.read()).slots).find((s) => s.status === "leased" && s.lease?.lease_id === leaseId);
  if (!slot?.lease) throw new LeaseError(EXIT_CODES.leaseMismatch, "that lease is not held (it was returned, or never existed); nothing was deployed");
  // The lease's git baseline is the holder's record of what changed: a deploy changes the tree, never the repository.
  if (slot.lease.bootstrap?.git !== undefined) assertNoGitTargets(sources);
  const report = await deployCodeOnLease(
    { store: ctx.store, host: (await host(ctx)).host, localRoot: localInstallRoot(ctx.env) },
    { slot: slot.id, leaseId, agent: slot.lease.bootstrap?.agent === true },
    sources,
    rules,
  );
  if (parsed.options.json === true) printJson(ctx.io, { slot: slot.id, code: report.outcomes });
  else for (const line of formatOutcomes(report.outcomes)) ctx.io.out(line);
  if (report.ok) return EXIT_CODES.ok;
  ctx.io.err(`arashouse: the code deploy into ${slot.id} failed (${report.outcomes.at(-1)?.detail ?? "no detail"}); the lease is still held`);
  return refusedDeploy(report) ? EXIT_CODES.refused : EXIT_CODES.codeFailed;
}

async function cmdGitBaseline(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { lease: "value", json: "flag" });
  noPositionals(parsed, "git-baseline");
  const leaseId = stringOption(parsed, "lease");
  if (leaseId === undefined) throw new UsageError("git-baseline needs --lease <lease_id>");
  if (!isLeaseId(leaseId)) throw new UsageError("--lease must be a lease id (32 lower-case hex characters)");
  const slot = Object.values((await ctx.store.read()).slots).find((s) => s.status === "leased" && s.lease?.lease_id === leaseId);
  if (!slot?.lease) throw new LeaseError(EXIT_CODES.leaseMismatch, "that lease is not held (it was returned, or never existed); nothing was committed");
  const selected = await host(ctx);
  const localRoot = localInstallRoot(ctx.env);
  const git = selectGitTool(selected.kind, ctx.env, localRoot);
  await checkGitTool(git, ctx.env);
  const report = await gitBaselineOnLease(
    { store: ctx.store, host: selected.host, git, localRoot, env: ctx.env },
    { slot: slot.id, leaseId, flavor: slot.flavor, agent: slot.lease.bootstrap?.agent === true },
  );
  if (parsed.options.json === true) printJson(ctx.io, { slot: slot.id, git: report.outcome });
  else ctx.io.out(formatGitOutcome(report.outcome));
  if (report.outcome.ok) return EXIT_CODES.ok;
  ctx.io.err(`arashouse: the git baseline of ${slot.id} failed (${report.outcome.detail}); the lease is still held`);
  return refusedBaseline(report) ? EXIT_CODES.refused : EXIT_CODES.codeFailed;
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
  "deploy-code": cmdDeployCode,
  "git-baseline": cmdGitBaseline,
  return: cmdReturn,
  status: cmdStatus,
  flavors: cmdFlavors,
  run: cmdRun,
  extract: cmdExtract,
  import: cmdImport,
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
