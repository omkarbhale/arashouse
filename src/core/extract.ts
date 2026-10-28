// The rules of `arashouse extract` (ticket 43, docs/extract.md): what a leaseholder may copy out of its slot's tree,
// and where a database backup is staged. Pure: no I/O. The CLI (src/cli/extract.ts) reads the tree through the
// worker's read grant on `slots\` (ticket 21); the broker's `backupDatabase` verb writes the backup.
//
// The captain's principle: "anything durable should be taken out by whoever took the lease before giving it back."

import { randomBytes } from "node:crypto";
import { win32 } from "node:path";
import { editList } from "./edit-lists.js";
import type { FlavorKey } from "./flavors.js";
import { stagingDir } from "./names.js";

/**
 * The secrets and identity files of a slot (ticket 40's protected list), by file name: its server config, certificates
 * and keys, and the vault's config. `extract code` refuses them without `--allow-config`.
 */
export const PROTECTED_FILE_PATTERNS: readonly string[] = ["InnovatorServerConfig.xml", "*.pfx", "*.cer", "key-*.xml", "vault.config"];

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

const PROTECTED_NAMES = PROTECTED_FILE_PATTERNS.map(globToRegExp);

/** The files the flavor's edit list renders a secret into (a login password, the licence): protected as well, by path. */
function secretFiles(flavor: FlavorKey): Set<string> {
  const files = new Set<string>();
  for (const edit of editList(flavor).edits) if (/\{\{secret:/.test(edit.value)) files.add(edit.file.replace(/\\/g, "/").toLowerCase());
  return files;
}

/**
 * Whether `rel` (a path inside the slot folder, `/`-separated) is one of the slot's protected files: a name on
 * `PROTECTED_FILE_PATTERNS`, or a file the flavor's edit list writes a secret into.
 */
export function isProtectedFile(flavor: FlavorKey, rel: string): boolean {
  const path = rel.replace(/\\/g, "/");
  const name = path.slice(path.lastIndexOf("/") + 1);
  return PROTECTED_NAMES.some((re) => re.test(name)) || secretFiles(flavor).has(path.toLowerCase());
}

export class ExtractPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractPathError";
  }
}

/**
 * The segments of a path inside the slot folder, as `extract code` takes it (`Innovator/Client/x.js`, `/` or `\`).
 * `.` or an empty path is the whole slot folder (no segments). An absolute path, a drive, a UNC path, `..`, a control
 * character or a character Windows forbids in a name is refused.
 */
export function parseSlotSubpath(text: string): string[] {
  if (/^[A-Za-z]:/.test(text) || text.startsWith("/") || text.startsWith("\\")) {
    throw new ExtractPathError(`"${text}" is absolute; name a path inside the slot folder, such as Innovator/Client`);
  }
  const segments = text.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  for (const segment of segments) {
    if (segment === "..") throw new ExtractPathError(`"${text}" leaves the slot folder (..)`);
    if (/[\x00-\x1f<>:"|?*]/.test(segment) || /[. ]$/.test(segment)) throw new ExtractPathError(`"${text}" has a name Windows does not allow ("${segment}")`);
  }
  return segments;
}

/** A new file name for a database backup `extract db` stages: `extract-db-<8 hex>.bak`. */
export function stagedBackupName(random: () => string = () => randomBytes(4).toString("hex")): string {
  return `extract-db-${random()}.bak`;
}

/** Where `extract db` stages a backup: `<root>\staging\<lease_id>\<name>`. */
export function stagedBackupPath(leaseId: string, name: string, root?: string): string {
  return win32.join(stagingDir(leaseId, root), name);
}
