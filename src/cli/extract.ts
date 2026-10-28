// `arashouse extract`: take code and data out of a lease before it is returned (ticket 43, docs/extract.md). The
// captain's principle: "anything durable should be taken out by whoever took the lease before giving it back."
// arashouse keeps nothing of a returned lease, so the leaseholder copies out what it needs:
//
// - `extract code --lease <id> <subpath> --to <dir>` copies a file or folder of the slot's tree, read through the
//   worker's read grant on `slots\` (ticket 21; `/mnt/c/aras_installations/slots/...` from WSL). Only under the slot
//   folder, never through a link or junction, and none of the slot's config and key files without `--allow-config`.
// - `extract db --lease <id> --to <file>` has the broker take a `COPY_ONLY` backup of the slot's database into
//   `staging\<lease_id>\`, copies it to `<file>` and deletes the staged copy.
//
// Packages and items are exported with libs-js through `arashouse run` (ticket 15). Each command marks the lease
// `extracted` in the state (`status --json`); that is information only and gates nothing.

import { constants, type Dirent, type Stats } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rename, rm, rmdir, stat, utimes } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { EXIT_CODES } from "../core/exit-codes.js";
import { ExtractPathError, isProtectedFile, parseSlotSubpath, stagedBackupName, stagedBackupPath } from "../core/extract.js";
import { LeaseError, UsageError } from "../core/lease.js";
import { slotDir, type SlotRef } from "../core/names.js";
import type { Slot } from "../core/state.js";
import { isLeaseId } from "../core/state.js";
import type { StateStore } from "../core/store.js";
import type { HostDriver } from "../host/driver.js";
import { parseArgs, stringOption } from "./args.js";
import { heldSlot } from "./run.js";

export const EXTRACT_USAGE = [
  "usage: arashouse extract code --lease <lease_id> <path in the slot> --to <dir> [--allow-config]",
  "       arashouse extract db --lease <lease_id> --to <file.bak>",
];

export const EXTRACT_HELP: readonly string[] = [
  ...EXTRACT_USAGE,
  "",
  "Takes code or data out of a lease before it is returned: a returned slot is discarded, and arashouse keeps",
  "nothing of it. code copies a file or folder of the slot's tree (for example Innovator/Client/javascript)",
  "to <dir>/<its name>; a slot's config and key files (InnovatorServerConfig.xml, *.pfx, *.cer, key-*.xml,",
  "vault.config and the other files holding a secret) are refused without --allow-config. db writes a",
  "COPY_ONLY backup of the slot's database to <file.bak>. Neither replaces what is there. Packages and items:",
  "arashouse run --lease <lease_id> -- aras-pkg export <dir> ... (--use-import, --from-manifest or",
  "--all-packages). See docs/extract.md.",
];

export interface ExtractDeps {
  readonly store: StateStore;
  readonly host: Pick<HostDriver, "backupDatabase">;
  /** The install root, as a Windows path. */
  readonly root: string;
  /** The path this process opens for a Windows path under the root. */
  readonly toLocal: (windowsPath: string) => string;
  /** Where a relative `--to` is resolved from; defaults to `process.cwd()`. */
  readonly cwd?: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Also print the broker's own line (the backup's size and times) on stderr. */
  readonly verbose?: boolean;
}

function refused(message: string): LeaseError {
  return new LeaseError(EXIT_CODES.refused, message);
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    throw err;
  }
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function leaseOption(value: string | undefined, command: string): string {
  if (value === undefined) throw new UsageError(`extract ${command} needs --lease <lease_id>`);
  if (!isLeaseId(value)) throw new UsageError("--lease must be a lease id (32 lower-case hex characters)");
  return value;
}

function slotRef(slot: Slot): SlotRef {
  return { flavor: slot.flavor, slot: slot.number };
}

/** Marks the lease extracted; says so when it was returned while the copy ran (the copy is kept either way). */
async function markExtracted(deps: ExtractDeps, slot: Slot, leaseId: string, what: string): Promise<void> {
  const marked = await deps.store.update((tx) => tx.markExtracted(slot.id, leaseId, what));
  if (!marked) deps.err(`arashouse: the lease of ${slot.id} was returned while this ran; the copy is kept`);
}

// ---- code ----------------------------------------------------------------------------------------

/** One entry to copy: its path relative to the slot folder (`/`-separated) and whether it is a folder. */
interface Entry {
  readonly rel: string;
  readonly dir: boolean;
}

/** The entries under `local` (itself first), refusing any link or junction, in a stable order. */
async function walk(local: string, rel: string, isDir: boolean, into: Entry[]): Promise<void> {
  into.push({ rel, dir: isDir });
  if (!isDir) return;
  const children: Dirent[] = (await readdir(local, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const child of children) {
    const childRel = rel === "" ? child.name : `${rel}/${child.name}`;
    // Node reports a junction, as well as a symbolic link, as a symbolic link.
    if (child.isSymbolicLink()) throw refused(`${childRel} in the slot is a link or junction; extract copies no link`);
    if (!child.isDirectory() && !child.isFile()) throw refused(`${childRel} in the slot is not a file or folder`);
    await walk(join(local, child.name), childRel, child.isDirectory(), into);
  }
}

async function extractCode(deps: ExtractDeps, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { lease: "value", to: "value", "allow-config": "flag" });
  const leaseId = leaseOption(stringOption(parsed, "lease"), "code");
  const [subpath, extra] = parsed.positionals;
  if (subpath === undefined) throw new UsageError("extract code needs the path to copy, inside the slot folder (for example Innovator/Client)");
  if (extra !== undefined) throw new UsageError(`extract code takes one path, not "${extra}" too`);
  const to = stringOption(parsed, "to");
  if (to === undefined) throw new UsageError("extract code needs --to <dir>");
  let segments: string[];
  try {
    segments = parseSlotSubpath(subpath);
  } catch (err) {
    if (err instanceof ExtractPathError) throw refused(err.message);
    throw err;
  }

  const slot = await heldSlot(deps.store, leaseId);
  const shown = segments.length === 0 ? "." : segments.join("/");
  // Each step from the slot folder down is checked, so no link or junction on the way is followed.
  let source = deps.toLocal(slotDir(slotRef(slot), deps.root));
  let info: Stats;
  for (let i = 0; ; i++) {
    try {
      info = await lstat(source);
    } catch (err) {
      if (errorCode(err) === "ENOENT") throw new Error(`${slot.id} has no ${i === 0 ? "slot folder" : shown}`);
      if (errorCode(err) === "EACCES" || errorCode(err) === "EPERM") throw refused(`this user cannot read ${shown} of ${slot.id} (is the worker's read grant on slots\\ in place? see docs/setup.md)`);
      throw err;
    }
    if (info.isSymbolicLink()) throw refused(`${i === 0 ? "the slot folder" : segments.slice(0, i).join("/")} of ${slot.id} is a link or junction; extract copies no link`);
    if (i === segments.length) break;
    if (!info.isDirectory()) throw new Error(`${slot.id} has no ${shown}`);
    source = join(source, segments[i] as string);
  }
  const entries: Entry[] = [];
  await walk(source, segments.join("/"), info.isDirectory(), entries);

  const guarded = entries.filter((e) => !e.dir && isProtectedFile(slot.flavor, e.rel));
  if (guarded.length > 0 && parsed.options["allow-config"] !== true) {
    const named = guarded.slice(0, 3).map((e) => e.rel).join(", ");
    const more = guarded.length > 3 ? ` and ${guarded.length - 3} more` : "";
    throw refused(`${shown} holds the slot's config or key files (${named}${more}); narrow the path, or pass --allow-config to copy them`);
  }

  const destDir = resolve(deps.cwd ?? process.cwd(), to);
  const target = join(destDir, segments.at(-1) ?? slot.id);
  if (await exists(target)) throw refused(`${target} exists; extract never replaces a file: remove it or choose another --to`);
  await mkdir(destDir, { recursive: true });
  const base = segments.join("/");
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    const rel = base === "" ? entry.rel : entry.rel.slice(base.length).replace(/^\//, "");
    const from = rel === "" ? source : join(source, ...rel.split("/"));
    const dest = rel === "" ? target : join(target, ...rel.split("/"));
    if (entry.dir) {
      await mkdir(dest, { recursive: true });
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(from, dest, constants.COPYFILE_EXCL);
    const copied = await stat(from);
    await utimes(dest, copied.atime, copied.mtime);
    files++;
    bytes += copied.size;
  }
  await markExtracted(deps, slot, leaseId, "code");
  deps.out(`extracted ${files} file${files === 1 ? "" : "s"} (${megabytes(bytes)} MB) from ${slot.id}:${shown} to ${target}`);
  if (guarded.length > 0) deps.err(`arashouse: ${guarded.length} of them hold the slot's secrets (--allow-config); keep them out of commits and logs`);
  return EXIT_CODES.ok;
}

// ---- db ------------------------------------------------------------------------------------------

async function extractDb(deps: ExtractDeps, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { lease: "value", to: "value" });
  const leaseId = leaseOption(stringOption(parsed, "lease"), "db");
  if (parsed.positionals.length > 0) throw new UsageError(`extract db takes no argument "${parsed.positionals[0]}"`);
  const to = stringOption(parsed, "to");
  if (to === undefined) throw new UsageError("extract db needs --to <file.bak>");
  const dest = resolve(deps.cwd ?? process.cwd(), to);
  if (await exists(dest)) throw refused(`${dest} exists; extract never replaces a file: remove it or choose another --to`);
  try {
    if (!(await stat(dirname(dest))).isDirectory()) throw new Error();
  } catch {
    throw new UsageError(`${dirname(dest)} is not a folder; --to names a file in a folder that exists`);
  }

  const slot = await heldSlot(deps.store, leaseId);
  const staged = stagedBackupPath(leaseId, stagedBackupName(), deps.root);
  const local = deps.toLocal(staged);
  // The worker may change staging\ (ticket 21); the broker writes the backup into this lease's folder only.
  await mkdir(dirname(local), { recursive: true });
  const partial = `${dest}.part-${basename(staged, ".bak").slice(-8)}`;
  try {
    const result = await deps.host.backupDatabase(slotRef(slot), staged);
    await copyFile(local, partial, constants.COPYFILE_EXCL);
    const [from, copied] = await Promise.all([stat(local), stat(partial)]);
    if (copied.size !== from.size) throw new Error(`the copy of the backup is ${copied.size} bytes, not ${from.size}`);
    if (await exists(dest)) throw refused(`${dest} appeared while the backup ran; extract never replaces a file`);
    await rename(partial, dest);
    await markExtracted(deps, slot, leaseId, "db");
    deps.out(`extracted the database of ${slot.id} (COPY_ONLY backup, ${megabytes(copied.size)} MB) to ${dest}`);
    if (deps.verbose === true) deps.err(`arashouse: ${result.detail}`);
  } finally {
    await rm(partial, { force: true });
    await rm(local, { force: true });
    await rmdir(dirname(local)).catch(() => undefined);
  }
  return EXIT_CODES.ok;
}

/** `arashouse extract <code|db> ...`. */
export async function runExtract(deps: ExtractDeps, args: readonly string[]): Promise<number> {
  const [what, ...rest] = args;
  if (what === "code") return extractCode(deps, rest);
  if (what === "db") return extractDb(deps, rest);
  throw new UsageError(what === undefined ? `extract needs code or db: ${EXTRACT_USAGE[0]}` : `unknown command "extract ${what}"`);
}
