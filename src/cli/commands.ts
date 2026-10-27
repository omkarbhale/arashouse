// The worker-facing command surface: `get`, `return`, `status`, `flavors`, `run`, `help`, `version`
// (and `media check`, ticket 18), thin over the lease core. Output rules: no command prints a
// password except `get --json`, once; `--verbose` never adds a secret; an error is one line plus a
// hint, with the stack only under `ARASHOUSE_DEBUG=1`. The exit codes are docs/cli.md's table.

import { readFileSync } from "node:fs";
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
import { redactError } from "../core/redact.js";
import { StateStore } from "../core/store.js";
import { createMsiReader, windowsTempDir } from "../host/msi.js";
import { parseArgs, parseSeconds, stringOption, type ParsedArgs } from "./args.js";
import { buildFlavors, formatFlavors } from "./flavors.js";
import { selectHost, type SelectedHost } from "./host.js";
import { MEDIA_USAGE, runMediaCheck } from "./media.js";
import { runWithLease } from "./run.js";

export const DEBUG_ENV = "ARASHOUSE_DEBUG";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const COMMAND_HELP: Readonly<Record<string, readonly string[]>> = {
  get: [
    "usage: arashouse get <flavor> --holder <task> [--wait <seconds>] [--json]",
    "",
    `Leases a clean slot of <flavor> (${FLAVOR_KEYS.join(", ")}) to <task>. With --json, stdout is the`,
    "lease contract (docs/schemas/get.schema.json) and nothing else; it holds the lease's password,",
    "shown this once. Without --json the password is not shown: reach it through `arashouse run`.",
    "--wait <seconds> waits up to that long for a slot; without it, no free slot exits 3 at once.",
  ],
  return: [
    "usage: arashouse return <lease_id> [--wait[=<seconds>]]",
    "       arashouse return <slot> --if-lease-id <lease_id> [--wait[=<seconds>]]",
    "",
    "Gives the lease back. Everything in the slot is discarded: take out what you need first.",
    "It returns at once; the slot is reset before it is handed out again. Returning twice is a",
    "no-op. --wait blocks until the slot is free again (exit 5 if its reset fails), with no limit",
    "or up to <seconds>.",
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
  media: [MEDIA_USAGE, "", "Are a flavor's installers there, intact and the right version? (docs/media-check.md)"],
  help: ["usage: arashouse help [<command>]"],
  version: ["usage: arashouse version"],
};

const OVERVIEW: readonly string[] = [
  "arashouse: a pool of disposable, per-version Aras instances, leased like worktrees.",
  "",
  "usage: arashouse <command> [options]",
  "",
  "  get <flavor> --holder <task> [--wait <seconds>] [--json]  lease a clean slot",
  "  return <lease_id> [--wait[=<seconds>]]                     give a lease back (its slot is discarded)",
  "  status [--json]                                            every slot and its holder",
  "  flavors [--json]                                           flavors, engines, free slots, media, baselines",
  "  run --lease <lease_id> -- <command ...>                    run a command with the lease's ARAS_* environment",
  "  media check [<flavor>...] [--json] [--write-sums]          check the installers",
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

async function leaseDeps(ctx: Context): Promise<LeaseDeps> {
  const selected = await host(ctx);
  return { store: ctx.store, host: selected.host, secrets: new LeaseFileStore(ctx.store.paths.home), resolveUrl: selected.resolveUrl };
}

function noPositionals(parsed: ParsedArgs, command: string): void {
  if (parsed.positionals.length > 0) throw new UsageError(`${command} takes no argument "${parsed.positionals[0]}"`);
}

function printJson(io: CliIo, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

async function cmdGet(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { holder: "value", wait: "value", json: "flag" });
  const [flavor, extra] = parsed.positionals;
  if (flavor === undefined) throw new UsageError(`get needs a flavor: ${FLAVOR_KEYS.join(", ")}`);
  if (extra !== undefined) throw new UsageError(`get takes one flavor, not "${extra}" too`);
  const holder = stringOption(parsed, "holder");
  if (holder === undefined) throw new UsageError("get needs --holder <task>: who is taking the lease");
  const wait = stringOption(parsed, "wait");
  const grant = await getLease(await leaseDeps(ctx), { flavor, holder, waitSeconds: wait === undefined ? 0 : parseSeconds(wait, "--wait") });
  const returnHint = `return it with: arashouse return ${grant.lease_id}`;
  if (parsed.options.json === true) {
    printJson(ctx.io, renderGetJson(grant));
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
    `password:  not shown; use \`arashouse run --lease ${grant.lease_id} -- <command>\``,
    returnHint,
  ]) {
    ctx.io.out(line);
  }
  return EXIT_CODES.ok;
}

async function cmdReturn(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { "if-lease-id": "value", wait: "optional" });
  const [target, extra] = parsed.positionals;
  if (target === undefined) throw new UsageError("return needs a lease id, or a slot and --if-lease-id");
  if (extra !== undefined) throw new UsageError(`return takes one lease or slot, not "${extra}" too`);
  const wait = parsed.options.wait;
  const result = await returnLease(await leaseDeps(ctx), {
    target,
    ifLeaseId: stringOption(parsed, "if-lease-id"),
    waitSeconds: wait === undefined ? undefined : wait === true ? Number.POSITIVE_INFINITY : parseSeconds(wait, "--wait"),
  });
  ctx.io.out(result.message);
  if (wait !== undefined && result.slot !== null) ctx.io.out(`${result.slot} is free again`);
  return EXIT_CODES.ok;
}

async function cmdStatus(ctx: Context, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { json: "flag" });
  noPositionals(parsed, "status");
  if (ctx.verbose) ctx.io.err(`arashouse: state in ${ctx.store.paths.home}`);
  const report = await leaseStatus({ store: ctx.store });
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

async function cmdMedia(ctx: Context, args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command !== "check") throw new UsageError(command === undefined ? `media needs a command: ${MEDIA_USAGE}` : `unknown command "media ${command}"`);
  // An MSI unpacked from a zip must land where Windows Installer can open it: a Windows drive.
  const scratchDir = await windowsTempDir().catch(() => undefined);
  return runMediaCheck(rest, { readMsi: createMsiReader(), scratchDir }, ctx.io);
}

const COMMANDS: Readonly<Record<string, (ctx: Context, args: readonly string[]) => Promise<number>>> = {
  get: cmdGet,
  return: cmdReturn,
  status: cmdStatus,
  flavors: cmdFlavors,
  run: cmdRun,
  media: cmdMedia,
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
