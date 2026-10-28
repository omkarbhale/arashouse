// The guards: hard-coded allowlists and deny-list, and `assertOwned`, the one function every
// host-driver call and every broker verb runs first. The tool never lists, opens, backs up,
// restores over or contacts anything on the deny-list, and touches only what matches an allowlist.

import { isFlavorKey } from "./flavors.js";
import {
  APP_POOL_ROLES,
  BUILD_SCRATCH_SUFFIXES,
  DEFAULT_INSTALL_ROOT,
  agentServiceName,
  appPoolName,
  databaseName,
  loginName,
  slotNumber,
  webAlias,
  type SlotRef,
} from "./names.js";

export type OwnedKind = "root" | "database" | "alias" | "appPool" | "service" | "login" | "path";

export type GuardCode = "denied" | "not-allowlisted" | "not-derived" | "bad-path" | "bad-root" | "bad-slot";

/** A refused name or path. The message names the subject, never a credential. */
export class GuardError extends Error {
  constructor(
    readonly code: GuardCode,
    readonly kind: OwnedKind,
    readonly subject: string,
    detail: string,
  ) {
    super(`refused ${kind} "${subject}": ${detail}`);
    this.name = "GuardError";
  }
}

// ---- the deny-list -----------------------------------------------------------------------------

/** The captain's existing install roots. */
export const DENIED_INSTALL_ROOTS: readonly string[] = [
  "C:\\Program Files (x86)\\Aras\\Innovator",
  "C:\\Program Files (x86)\\Aras12\\Innovator",
  "C:\\Program Files (x86)\\Aras28\\Innovator",
];

export const DENIED_DATABASES: readonly string[] = [
  "12sp9",
  "OLM_Local",
  "InnovatorSolutions",
  "RabbitDemo1",
  "InnovatorSolutions28",
];

export const DENIED_ALIASES: readonly string[] = ["12sp9", "InnovatorServer", "InnovatorServer23"];

/** Service-name prefixes: the captain's own agent services. */
export const DENIED_SERVICE_PREFIXES: readonly string[] = ["ArasInnovatorAgent_"];

/** Anything containing one of these, in any case, in any name or path. */
export const DENIED_SUBSTRINGS: readonly string[] = ["olm", "prod"];

/** Name prefixes: the map's `InnovatorSolutions*` databases and `InnovatorServer*` aliases (ticket 50, docs/audit.md). */
export const DENIED_NAME_PREFIXES: readonly string[] = ["InnovatorSolutions", "InnovatorServer"];

/** `C:\Aras`, `C:\Aras12`, `C:\Aras28`: the top-level folders of the captain's existing installs. */
const DENIED_TOP_FOLDER = /^aras\d*$/i;

/** `text` folded for a deny-list comparison: compatibility forms (`ＯＬＭ` is `OLM`) and case. */
function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

function sameName(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

/** Why `text` (a name or a whole path) is on the deny-list by substring, or undefined. */
function substringDenial(text: string): string | undefined {
  const lower = fold(text);
  const hit = DENIED_SUBSTRINGS.find((s) => lower.includes(s));
  return hit ? `contains "${hit}"` : undefined;
}

/** Why a non-path name is on the deny-list, or undefined. Case-insensitive; applies to every kind. */
export function nameDenial(name: string): string | undefined {
  const sub = substringDenial(name);
  if (sub) return `deny-listed (${sub})`;
  if (DENIED_DATABASES.some((d) => sameName(d, name))) return "deny-listed database name";
  if (DENIED_ALIASES.some((a) => sameName(a, name))) return "deny-listed web alias";
  if (DENIED_NAME_PREFIXES.some((p) => fold(name).startsWith(fold(p)))) return "deny-listed name prefix";
  if (DENIED_SERVICE_PREFIXES.some((p) => fold(name).startsWith(fold(p)))) {
    return "deny-listed service name";
  }
  return undefined;
}

// ---- allowlists --------------------------------------------------------------------------------

// Hard-coded globs (`arashouse_*`, `ah-*`, `ArasHouseAgent_*`) over a safe character set.
const ALLOW_DATABASE = /^arashouse_[a-z0-9_]+$/;
const ALLOW_LOGIN = /^arashouse_[a-z0-9_]+$/;
const ALLOW_ALIAS = /^ah-[a-z0-9-]+$/;
const ALLOW_APP_POOL = /^ah-[a-z0-9-]+$/;
const ALLOW_SERVICE = /^ArasHouseAgent_[a-z0-9_]+$/;

const ALLOWLIST: Readonly<Record<Exclude<OwnedKind, "root" | "path">, RegExp>> = {
  database: ALLOW_DATABASE,
  login: ALLOW_LOGIN,
  alias: ALLOW_ALIAS,
  appPool: ALLOW_APP_POOL,
  service: ALLOW_SERVICE,
};

const MAX_NAME_LENGTH = 128;
const SLOT_FOLDER = /^(0[1-9]|[1-9]\d)$/;
const VAULT_FOLDER = /^([a-z0-9]+)-(0[1-9]|[1-9]\d)$/;
const STAGING_FOLDER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// ---- paths -------------------------------------------------------------------------------------

interface ParsedPath {
  drive: string;
  segments: string[];
}

const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Splits a Windows drive path, refusing anything that is not a plain, literal, absolute one. */
function parseWindowsPath(raw: unknown, kind: OwnedKind, code: "bad-path" | "bad-root"): ParsedPath {
  const subject = typeof raw === "string" ? raw : String(raw);
  const bad = (detail: string) => new GuardError(code, kind, subject, detail);
  if (typeof raw !== "string" || raw.length === 0) throw bad("a path is required");
  if (/[\u0000-\u001f<>"|?*]/.test(raw)) throw bad("path has an illegal character");
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(raw);
  if (!match) throw bad("must be an absolute path on a Windows drive (no UNC, WSL or relative paths)");
  const rest = match[2] ?? "";
  const parts = rest.split(/[\\/]/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  for (const seg of parts) {
    if (seg === "") throw bad("path has an empty segment");
    if (seg === "." || seg === "..") throw bad(`path has a "${seg}" segment`);
    if (/[. ]$/.test(seg)) throw bad("path segment ends in a dot or space");
    if (seg.includes(":")) throw bad("path segment has a colon (alternate data stream)");
    if (/~\d/.test(seg)) throw bad("path segment looks like an 8.3 short name");
    if (RESERVED_DEVICE.test(seg)) throw bad("path segment is a reserved device name");
  }
  return { drive: (match[1] ?? "").toUpperCase(), segments: parts };
}

function render(parsed: ParsedPath, upTo: number = parsed.segments.length): string {
  const head = `${parsed.drive}:\\`;
  return head + parsed.segments.slice(0, upTo).join("\\");
}

/** Why a parsed path is on the deny-list (the captain's installs, Program Files), or undefined. */
function pathDenial(parsed: ParsedPath): string | undefined {
  const sub = substringDenial(render(parsed));
  if (sub) return `deny-listed (${sub})`;
  const lowered = parsed.segments.map((s) => s.toLowerCase());
  if (lowered.some((s) => s.startsWith("program files"))) return "deny-listed (under Program Files)";
  const top = parsed.segments[0];
  if (top !== undefined && DENIED_TOP_FOLDER.test(top)) return "deny-listed (the captain's existing Aras install)";
  for (const denied of DENIED_INSTALL_ROOTS) {
    const d = parseWindowsPath(denied, "path", "bad-path");
    if (
      d.drive === parsed.drive &&
      d.segments.length <= lowered.length &&
      d.segments.every((s, i) => s.toLowerCase() === lowered[i])
    ) {
      return "deny-listed (the captain's existing Aras install)";
    }
  }
  return undefined;
}

export interface RootOptions {
  /** Resolves symlinks and junctions on the host; when given, the real path is vetted as well. */
  realPath?: (path: string) => string;
}

/**
 * Vets an install root and returns it normalised (backslashes, drive letter upper-case, no trailing
 * separator). Refuses a root that is relative, UNC or on the WSL filesystem, that is a drive root,
 * that is on the deny-list, or whose real path contains `Program Files` or `\Users\`.
 */
export function assertValidRoot(root: string, options: RootOptions = {}): string {
  const parsed = parseWindowsPath(root, "root", "bad-root");
  const subject = typeof root === "string" ? root : String(root);
  if (parsed.segments.length === 0) throw new GuardError("bad-root", "root", subject, "a drive root is not an install root");
  const denial = pathDenial(parsed);
  if (denial) throw new GuardError(denial.includes("Program Files") ? "bad-root" : "denied", "root", subject, denial);
  if (parsed.segments.some((s) => s.toLowerCase() === "users")) {
    throw new GuardError("bad-root", "root", subject, "must not be under \\Users\\");
  }
  const normalised = render(parsed);
  if (options.realPath) {
    const real = options.realPath(normalised);
    try {
      assertValidRoot(real);
    } catch (err) {
      if (err instanceof GuardError) {
        throw new GuardError(err.code, "root", subject, `its real path "${real}" is refused: ${err.message}`);
      }
      throw err;
    }
  }
  return normalised;
}

function isWithin(child: string[], parent: string[]): boolean {
  return parent.length <= child.length && parent.every((s, i) => s.toLowerCase() === child[i]?.toLowerCase());
}

// ---- assertOwned -------------------------------------------------------------------------------

export interface OwnedOptions {
  /** The install root; defaults to `DEFAULT_INSTALL_ROOT`. Vetted by `assertValidRoot`. */
  root?: string;
  /**
   * For paths: reports whether a path is a junction or other reparse point. The core does no I/O,
   * so the host driver and broker supply it; every directory from the root down is probed and a hit
   * is refused. Without it, only the textual checks run.
   */
  isReparsePoint?: (path: string) => boolean;
  /** For roots: forwarded to `assertValidRoot`. */
  realPath?: (path: string) => string;
}

function checkSlot(kind: OwnedKind, slot: SlotRef, subject: string): void {
  let ok = isFlavorKey(slot.flavor);
  if (ok) {
    try {
      slotNumber(slot.slot);
    } catch {
      ok = false;
    }
  }
  if (!ok) throw new GuardError("bad-slot", kind, subject, "the slot record is not a registered (flavor, number)");
}

function assertOwnedName(kind: Exclude<OwnedKind, "root" | "path">, name: unknown, slot?: SlotRef): string {
  const subject = typeof name === "string" ? name : String(name);
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new GuardError("not-allowlisted", kind, subject.slice(0, MAX_NAME_LENGTH), "a name of 1 to 128 characters is required");
  }
  const denial = nameDenial(name);
  if (denial) throw new GuardError("denied", kind, name, denial);
  if (!ALLOWLIST[kind].test(name)) {
    throw new GuardError("not-allowlisted", kind, name, "does not match the allowlist for this kind");
  }
  if (slot) {
    checkSlot(kind, slot, name);
    const expected = derivedNames(kind, slot);
    if (!expected.includes(name)) {
      throw new GuardError("not-derived", kind, name, "is not a name derived from this slot record");
    }
  }
  return name;
}

function derivedNames(kind: Exclude<OwnedKind, "root" | "path">, slot: SlotRef): string[] {
  switch (kind) {
    case "database":
      return [databaseName(slot)];
    case "alias":
      return [webAlias(slot)];
    case "appPool":
      return APP_POOL_ROLES.map((role) => appPoolName(slot, role));
    case "service":
      return [agentServiceName(slot)];
    case "login":
      return [loginName(slot, "dbo"), loginName(slot, "reg")];
  }
}

function assertOwnedPath(raw: unknown, slot: SlotRef | undefined, options: OwnedOptions): string {
  const subject = typeof raw === "string" ? raw : String(raw);
  const fail = (code: GuardCode, detail: string) => new GuardError(code, "path", subject, detail);
  const parsed = parseWindowsPath(raw, "path", "bad-path");
  const denial = pathDenial(parsed);
  if (denial) throw fail("denied", denial);
  const root = parseWindowsPath(assertValidRoot(options.root ?? DEFAULT_INSTALL_ROOT, { realPath: options.realPath }), "root", "bad-root");
  if (parsed.drive !== root.drive || !isWithin(parsed.segments, root.segments)) {
    throw fail("not-allowlisted", "is not under the install root");
  }
  const rel = parsed.segments.slice(root.segments.length).map((s) => s.toLowerCase());
  if (slot) checkSlot("path", slot, subject);
  const notMine = () => fail("not-derived", "belongs to a different slot or flavor than this slot record");
  switch (rel[0]) {
    case "slots": {
      const [, flavor, nn] = rel;
      if (rel.length < 3 || !isFlavorKey(flavor) || !SLOT_FOLDER.test(nn ?? "")) {
        throw fail("not-allowlisted", "is not inside a slot folder (slots\\<key>\\<NN>)");
      }
      if (slot && (flavor !== slot.flavor || nn !== slotNumber(slot.slot))) throw notMine();
      break;
    }
    case "vaults": {
      const m = VAULT_FOLDER.exec(rel[1] ?? "");
      if (rel.length < 2 || !m || !isFlavorKey(m[1])) {
        throw fail("not-allowlisted", "is not inside a vault folder (vaults\\<key>-<NN>)");
      }
      if (slot && rel[1] !== `${slot.flavor}-${slotNumber(slot.slot)}`) throw notMine();
      break;
    }
    case "golden": {
      if (rel.length < 2 || !isFlavorKey(rel[1])) throw fail("not-allowlisted", "is not inside a golden folder (golden\\<key>)");
      if (slot && rel[1] !== slot.flavor) throw notMine();
      break;
    }
    case "staging": {
      if (rel.length < 2 || !STAGING_FOLDER.test(rel[1] ?? "")) {
        throw fail("not-allowlisted", "is not inside a staging folder (staging\\<lease_id>)");
      }
      break;
    }
    case "golden-build": {
      // The baseline build's install directory `golden-build\<key>` and its scratch folders `<key>.<suffix>` (ticket 24).
      const [name = "", suffix] = (rel[1] ?? "").split(/\.(?=[^.]+$)/);
      const scratch = suffix === undefined || (BUILD_SCRATCH_SUFFIXES as readonly string[]).includes(suffix);
      if (rel.length < 2 || !isFlavorKey(name) || !scratch) {
        throw fail("not-allowlisted", "is not inside a baseline build folder (golden-build\\<key>)");
      }
      if (slot) throw notMine();
      break;
    }
    case "sqldata":
    case "secrets":
    case "logs":
    case "broker":
      break;
    default:
      throw fail("not-allowlisted", "is not one of the tool's folders under the install root");
  }
  if (options.isReparsePoint) {
    for (let i = root.segments.length; i <= parsed.segments.length; i++) {
      if (options.isReparsePoint(render(parsed, i))) {
        throw fail("bad-path", "has a junction or reparse point in its path");
      }
    }
  }
  return render(parsed);
}

/**
 * The one guard every host-driver call and every broker verb runs first. Throws `GuardError` when
 * `name` is on the deny-list, is outside the allowlist for `kind`, or (when `slot` is given, which
 * every call that acts on a slot must do) is not exactly the name derived from that slot record.
 * For `path` it also refuses `..`, UNC and WSL paths, 8.3 short names, anything outside the tool's
 * folders under the root, and (given `isReparsePoint`) a junction segment. Returns the canonical
 * name or path to use in place of the input.
 */
export function assertOwned(kind: OwnedKind, name: string, slot?: SlotRef, options: OwnedOptions = {}): string {
  switch (kind) {
    case "root": {
      const expected = assertValidRoot(options.root ?? DEFAULT_INSTALL_ROOT, { realPath: options.realPath });
      const given = assertValidRoot(name);
      if (given.toLowerCase() !== expected.toLowerCase()) {
        throw new GuardError("not-allowlisted", "root", name, "is not the configured install root");
      }
      return expected;
    }
    case "path":
      return assertOwnedPath(name, slot, options);
    default:
      return assertOwnedName(kind, name, slot);
  }
}
