// The golden manifest: pure types, canonical hashing, parsing and the comparison that turns a tree
// listing into a diff. Reading the disk is the broker's job (src/broker/manifest-fs.ts).
//
// A manifest lists every file of a baseline's code tree outside the runtime directories (flavor
// registry): relative path, size, last-write time (UTC, 100 ns) and SHA-256. `manifestHash` covers
// the sorted list. A diff names paths and counts, never file contents.

import { createHash } from "node:crypto";
import { type FlavorKey, type RuntimeRule, isFlavorKey } from "./flavors.js";

export const MANIFEST_SCHEMA = 1;

/** `fast` is the reset path, `full` hashes everything, `golden` checks the golden folder itself. */
export const VERIFY_LEVELS = ["fast", "full", "golden"] as const;
export type VerifyLevel = (typeof VERIFY_LEVELS)[number];

/** How many paths a diff lists per class before it only counts. */
export const DEFAULT_DIFF_LIMIT = 20;

/**
 * The `fast` verify must finish a 40 000-file tree inside this budget: the upper end of ticket 06's
 * stat scan, which took 6 to 25 s in PowerShell on the host.
 */
export const FAST_VERIFY_BUDGET_MS = 25_000;

export class ManifestError extends Error {
  constructor(
    readonly code: "malformed" | "tampered" | "unsupported-entry" | "exists" | "empty",
    message: string,
  ) {
    super(message);
    this.name = "ManifestError";
  }
}

export interface ManifestEntry {
  /** Relative to the tree root, `/` separated. */
  readonly path: string;
  readonly size: number;
  /** Last-write time, UTC, 100 ns: `2026-10-22T10:11:12.1234567Z`. */
  readonly mtime: string;
  /** Lower-case hex SHA-256 of the content. */
  readonly sha256: string;
}

export interface Manifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly flavor: FlavorKey;
  /** The server build the baseline builder read from the installed tree (ticket 24); null if not read. */
  readonly serverBuild: string | null;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** SHA-256 over the sorted entry list; the golden hash that stamps and markers carry. */
  readonly manifestHash: string;
  /** Sorted by `path`, ordinal. */
  readonly files: readonly ManifestEntry[];
}

/** What a scan saw on disk for one path. */
export interface ObservedFile {
  readonly path: string;
  /** `file` is a regular file; anything else (link, junction, device) is `other` and is never followed. */
  readonly kind: "file" | "other";
  readonly size: number;
  readonly mtime: string;
}

export type ChangeReason = "size" | "mtime" | "content" | "type" | "unreadable";

export interface ChangedFile {
  readonly path: string;
  readonly reasons: readonly ChangeReason[];
}

export interface ManifestDiff {
  readonly level: VerifyLevel;
  readonly ok: boolean;
  /** Manifest entries compared. */
  readonly checked: number;
  /** Files whose content was hashed. */
  readonly hashed: number;
  /** Runtime-directory entries seen and left out of the comparison. */
  readonly skippedRuntime: number;
  readonly counts: { readonly missing: number; readonly changed: number; readonly extra: number };
  /** The first `limit` paths of each class. */
  readonly missing: readonly string[];
  readonly changed: readonly ChangedFile[];
  readonly extra: readonly string[];
  readonly truncated: boolean;
  /** Whole-baseline problems that are not a path: wrong flavor, wrong build, wrong golden hash, no tree. */
  readonly problems: readonly string[];
}

// ---- ordering, times, paths -------------------------------------------------------------------

export function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const MTIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Formats a nanosecond UTC timestamp as an ISO time at 100 ns resolution. */
export function formatMtime(mtimeNs: bigint): string {
  const ticks = mtimeNs / 100n;
  const seconds = ticks / 10_000_000n;
  const fraction = String(ticks % 10_000_000n).padStart(7, "0");
  return new Date(Number(seconds) * 1000).toISOString().replace(".000Z", `.${fraction}Z`);
}

/** Throws unless `path` is a safe relative manifest path. */
export function assertManifestPath(path: string): void {
  if (path === "" || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new ManifestError("malformed", `unsafe manifest path ${JSON.stringify(path)}`);
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ManifestError("malformed", `unsafe manifest path ${JSON.stringify(path)}`);
    }
  }
}

// ---- runtime directories ----------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

function norm(path: string): string {
  return path.toLowerCase();
}

/** True when a whole directory is runtime state, so a scan need not descend into it. */
export function isRuntimeDir(dirPath: string, rules: readonly RuntimeRule[]): boolean {
  const dir = norm(dirPath);
  return rules.some((rule) => {
    if (rule.files !== undefined) return false;
    const base = norm(rule.dir);
    return dir === base || dir.startsWith(`${base}/`);
  });
}

/** True when a file is runtime state: under a whole-directory rule, or matching a rule's file globs. */
export function isRuntimePath(path: string, rules: readonly RuntimeRule[]): boolean {
  const lower = norm(path);
  const cut = lower.lastIndexOf("/");
  const dir = cut < 0 ? "" : lower.slice(0, cut);
  const name = cut < 0 ? lower : lower.slice(cut + 1);
  return rules.some((rule) => {
    const base = norm(rule.dir);
    if (rule.files === undefined) return lower.startsWith(`${base}/`) || lower === base;
    return dir === base && rule.files.some((glob) => globToRegExp(glob).test(name));
  });
}

/**
 * The small set whose content the `fast` verify hashes: config files and the `Server\bin` DLLs
 * (design 8.3). A function of the path alone.
 */
export function isFastHashed(path: string): boolean {
  const lower = norm(path);
  return lower.endsWith(".config") || (lower.startsWith("innovator/server/bin/") && lower.endsWith(".dll"));
}

// ---- hashing and (de)serialising --------------------------------------------------------------

/** The manifest hash: SHA-256 over a version line and the sorted entries, one NUL-separated line each. */
export function computeManifestHash(files: readonly ManifestEntry[]): string {
  const hash = createHash("sha256");
  hash.update(`arashouse-manifest-v${MANIFEST_SCHEMA}\n`);
  for (const f of files) hash.update(`${f.path}\0${f.size}\0${f.mtime}\0${f.sha256}\n`);
  return hash.digest("hex");
}

/** Builds a manifest from entries in any order; the result is sorted and hashed. */
export function makeManifest(flavor: FlavorKey, serverBuild: string | null, entries: readonly ManifestEntry[]): Manifest {
  if (entries.length === 0) throw new ManifestError("empty", "a manifest needs at least one file");
  const files = [...entries].sort((a, b) => compareOrdinal(a.path, b.path));
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as ManifestEntry;
    assertEntry(f);
    if (i > 0 && (files[i - 1] as ManifestEntry).path === f.path) {
      throw new ManifestError("malformed", `duplicate manifest path ${JSON.stringify(f.path)}`);
    }
  }
  return {
    schema: MANIFEST_SCHEMA,
    flavor,
    serverBuild,
    fileCount: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    manifestHash: computeManifestHash(files),
    files,
  };
}

function assertEntry(f: ManifestEntry): void {
  assertManifestPath(f.path);
  if (!Number.isSafeInteger(f.size) || f.size < 0) throw new ManifestError("malformed", `bad size for ${JSON.stringify(f.path)}`);
  if (!MTIME.test(f.mtime)) throw new ManifestError("malformed", `bad mtime for ${JSON.stringify(f.path)}`);
  if (!SHA256.test(f.sha256)) throw new ManifestError("malformed", `bad sha256 for ${JSON.stringify(f.path)}`);
}

/** One entry per line so a diff of two manifests reads. */
export function serializeManifest(manifest: Manifest): string {
  const head = JSON.stringify({
    schema: manifest.schema,
    flavor: manifest.flavor,
    serverBuild: manifest.serverBuild,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    manifestHash: manifest.manifestHash,
  });
  const lines = manifest.files.map((f) => `  ${JSON.stringify({ path: f.path, size: f.size, mtime: f.mtime, sha256: f.sha256 })}`);
  return `${head.slice(0, -1)},"files":[\n${lines.join(",\n")}\n]}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses and validates manifest text: the shape, the sort order, path safety, the counts, and that
 * `manifestHash` equals the hash of the entries (a hand-edited manifest is `tampered`).
 */
export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ManifestError("malformed", "the manifest is not valid JSON");
  }
  if (!isRecord(raw) || raw.schema !== MANIFEST_SCHEMA) throw new ManifestError("malformed", "unsupported manifest schema");
  const { flavor, serverBuild, fileCount, totalBytes, manifestHash, files } = raw;
  if (typeof flavor !== "string" || !isFlavorKey(flavor)) throw new ManifestError("malformed", "the manifest names an unknown flavor");
  if (serverBuild !== null && typeof serverBuild !== "string") throw new ManifestError("malformed", "bad serverBuild");
  if (typeof manifestHash !== "string" || !SHA256.test(manifestHash)) throw new ManifestError("malformed", "bad manifestHash");
  if (!Array.isArray(files) || files.length === 0) throw new ManifestError("malformed", "the manifest lists no files");
  const entries: ManifestEntry[] = [];
  for (const item of files as unknown[]) {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.size !== "number" || typeof item.mtime !== "string" || typeof item.sha256 !== "string") {
      throw new ManifestError("malformed", "a manifest entry is missing a field");
    }
    entries.push({ path: item.path, size: item.size, mtime: item.mtime, sha256: item.sha256 });
  }
  for (let i = 1; i < entries.length; i++) {
    if (compareOrdinal((entries[i - 1] as ManifestEntry).path, (entries[i] as ManifestEntry).path) >= 0) {
      throw new ManifestError("malformed", "the manifest entries are not sorted and unique");
    }
  }
  const manifest = makeManifest(flavor, serverBuild, entries);
  if (fileCount !== manifest.fileCount || totalBytes !== manifest.totalBytes) {
    throw new ManifestError("tampered", "the manifest counts do not match its entries");
  }
  if (manifestHash !== manifest.manifestHash) throw new ManifestError("tampered", "the manifest hash does not match its entries");
  return manifest;
}

// ---- the comparison ---------------------------------------------------------------------------

export interface CompareOptions {
  readonly level: VerifyLevel;
  readonly runtimeDirs: readonly RuntimeRule[];
  /** Per-class path limit; counts are always complete. */
  readonly limit?: number;
  /** Entries the scan skipped because they sit in a runtime directory. */
  readonly skippedRuntime?: number;
  /** Problems found before the comparison (wrong tree root, wrong flavor...). */
  readonly problems?: readonly string[];
}

/** Which manifest paths a level hashes, given what is present on disk. */
export function pathsToHash(manifest: Manifest, observed: readonly ObservedFile[], level: VerifyLevel, runtimeDirs: readonly RuntimeRule[]): string[] {
  const present = new Map(observed.map((o) => [o.path, o]));
  const paths: string[] = [];
  for (const entry of manifest.files) {
    if (isRuntimePath(entry.path, runtimeDirs)) continue;
    const seen = present.get(entry.path);
    if (!seen || seen.kind !== "file") continue;
    if (level === "full" || isFastHashed(entry.path)) paths.push(entry.path);
  }
  return paths;
}

/**
 * Classifies every difference between a manifest and an observed tree. `hashes` maps a path to the
 * SHA-256 the scan computed, or null if the file could not be read.
 */
export function compareTree(
  manifest: Manifest,
  observed: readonly ObservedFile[],
  hashes: ReadonlyMap<string, string | null>,
  options: CompareOptions,
): ManifestDiff {
  const limit = options.limit ?? DEFAULT_DIFF_LIMIT;
  const present = new Map(observed.map((o) => [o.path, o]));
  const wanted = new Set<string>();
  const missing: string[] = [];
  const changed: ChangedFile[] = [];
  const extra: string[] = [];
  let checked = 0;
  let skippedRuntime = options.skippedRuntime ?? 0;
  let hashed = 0;

  for (const entry of manifest.files) {
    if (isRuntimePath(entry.path, options.runtimeDirs)) {
      skippedRuntime++;
      continue;
    }
    checked++;
    wanted.add(entry.path);
    const seen = present.get(entry.path);
    if (!seen) {
      missing.push(entry.path);
      continue;
    }
    const reasons: ChangeReason[] = [];
    if (seen.kind !== "file") {
      reasons.push("type");
    } else {
      if (seen.size !== entry.size) reasons.push("size");
      if (seen.mtime !== entry.mtime) reasons.push("mtime");
      if (hashes.has(entry.path)) {
        hashed++;
        const hash = hashes.get(entry.path);
        if (hash === null) reasons.push("unreadable");
        else if (hash !== entry.sha256) reasons.push("content");
      }
    }
    if (reasons.length > 0) changed.push({ path: entry.path, reasons });
  }
  for (const o of observed) {
    if (!wanted.has(o.path) && !isRuntimePath(o.path, options.runtimeDirs)) extra.push(o.path);
  }
  extra.sort(compareOrdinal);

  const problems = options.problems ?? [];
  const counts = { missing: missing.length, changed: changed.length, extra: extra.length };
  return {
    level: options.level,
    ok: problems.length === 0 && counts.missing + counts.changed + counts.extra === 0,
    checked,
    hashed,
    skippedRuntime,
    counts,
    missing: missing.slice(0, limit),
    changed: changed.slice(0, limit),
    extra: extra.slice(0, limit),
    truncated: counts.missing > limit || counts.changed > limit || counts.extra > limit,
    problems,
  };
}

/** One short line per diff, for a log or the CLI. Paths only, never contents. */
export function summarizeDiff(diff: ManifestDiff): string {
  const { missing, changed, extra } = diff.counts;
  const head = `${diff.level} verify ${diff.ok ? "passed" : "failed"}: ${diff.checked} files checked`;
  if (diff.ok) return head;
  return `${head}; ${missing} missing, ${changed} changed, ${extra} extra${diff.problems.length ? `; ${diff.problems.join("; ")}` : ""}`;
}
