// The disk side of the golden manifest: scan a tree, hash files, build and verify. The Windows side
// (the broker) runs this against `golden\<key>\tree` and against slot trees; the pure rules live in
// src/core/manifest.ts. Callers pass paths the guards have already approved (`assertOwned`).
//
// A scan never follows a link or junction and never reads outside `root`. It reads file content only
// to hash it, and nothing it returns carries content.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Flavor, type FlavorKey, getFlavor } from "../core/flavors.js";
import {
  type CompareOptions,
  DEFAULT_DIFF_LIMIT,
  type Manifest,
  type ManifestDiff,
  type ManifestEntry,
  ManifestError,
  type ObservedFile,
  type VerifyLevel,
  compareOrdinal,
  compareTree,
  formatMtime,
  isRuntimeDir,
  isRuntimePath,
  makeManifest,
  parseManifest,
  pathsToHash,
  serializeManifest,
} from "../core/manifest.js";
import type { RuntimeRule } from "../core/flavors.js";

const STAT_CONCURRENCY = 64;
const HASH_CONCURRENCY = 8;

/** Runs `fn` over `items` with at most `limit` in flight; results keep the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface ScanResult {
  /** Every non-runtime entry that is not a directory, sorted by path. */
  readonly files: ObservedFile[];
  /** Runtime directories pruned and runtime files skipped. */
  readonly skippedRuntime: number;
}

/** Walks `root` with `lstat` only. Runtime directories are pruned; links are listed as `other`, never entered. */
export async function scanTree(root: string, runtimeDirs: readonly RuntimeRule[]): Promise<ScanResult> {
  const files: ObservedFile[] = [];
  let skippedRuntime = 0;
  let level: string[] = [""];
  while (level.length > 0) {
    const listings = await mapLimit(level, STAT_CONCURRENCY, async (dir) => ({
      dir,
      entries: await readdir(join(root, dir), { withFileTypes: true }),
    }));
    const nextLevel: string[] = [];
    const pending: { path: string }[] = [];
    for (const { dir, entries } of listings) {
      for (const entry of entries) {
        const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (isRuntimeDir(path, runtimeDirs)) skippedRuntime++;
          else nextLevel.push(path);
        } else if (isRuntimePath(path, runtimeDirs)) {
          skippedRuntime++;
        } else {
          pending.push({ path });
        }
      }
    }
    const stats = await mapLimit(pending, STAT_CONCURRENCY, async ({ path }) => ({
      path,
      stat: await lstat(join(root, path), { bigint: true }),
    }));
    for (const { path, stat } of stats) {
      files.push({
        path,
        kind: stat.isFile() ? "file" : "other",
        size: Number(stat.size),
        mtime: formatMtime(stat.mtimeNs),
      });
    }
    level = nextLevel;
  }
  files.sort((a, b) => compareOrdinal(a.path, b.path));
  return { files, skippedRuntime };
}

/** Lower-case hex SHA-256 of a file's content, streamed. */
export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function hashAll(root: string, paths: readonly string[]): Promise<Map<string, string | null>> {
  const results = await mapLimit(paths, HASH_CONCURRENCY, async (path) => {
    try {
      return [path, await hashFile(join(root, path))] as const;
    } catch {
      return [path, null] as const;
    }
  });
  return new Map(results);
}

/**
 * Builds a manifest of the tree at `root`: every file outside the flavor's runtime directories,
 * hashed. Deterministic: the same tree gives the same entries and the same `manifestHash`. Refuses a
 * tree that holds a link or junction, which a manifest cannot represent.
 */
export async function buildManifest(root: string, flavor: FlavorKey | Flavor, serverBuild: string | null = null): Promise<Manifest> {
  const f = typeof flavor === "string" ? getFlavor(flavor) : flavor;
  const { files } = await scanTree(root, f.runtimeDirs);
  const odd = files.find((o) => o.kind !== "file");
  if (odd) throw new ManifestError("unsupported-entry", `the tree holds a link or special file at ${JSON.stringify(odd.path)}`);
  const hashes = await hashAll(root, files.map((o) => o.path));
  const entries: ManifestEntry[] = files.map((o) => {
    const sha256 = hashes.get(o.path);
    if (!sha256) throw new ManifestError("malformed", `could not read ${JSON.stringify(o.path)} to hash it`);
    return { path: o.path, size: o.size, mtime: o.mtime, sha256 };
  });
  return makeManifest(f.key, serverBuild, entries);
}

export interface VerifyTreeOptions {
  readonly level: VerifyLevel;
  /** Per-class path limit; default 20. */
  readonly limit?: number;
  /** The golden hash the caller expects the manifest to carry (a stamp's `goldenHash`). */
  readonly expectedHash?: string;
  /** A slot's rendered config files: present, but checked against their rendering by the caller (`CompareOptions`). */
  readonly rendered?: readonly string[];
}

/**
 * Compares the tree at `root` with `manifest`.
 * - `fast`: size and time of every entry, a content hash of configs and `Server\bin` DLLs, and no
 *   extra files outside the runtime directories.
 * - `full`: the same, with every content hash.
 * - `golden`: `fast` for the golden folder against its own manifest; it also fails when the manifest
 *   is not the one the caller expects, or names another flavor or build than the registry.
 * Files in a runtime directory are ignored, not flagged.
 */
export async function verifyTree(root: string, manifest: Manifest, options: VerifyTreeOptions): Promise<ManifestDiff> {
  const flavor = getFlavor(manifest.flavor);
  const problems: string[] = [];
  if (flavor.serverBuild !== null && manifest.serverBuild !== flavor.serverBuild) {
    problems.push(`the manifest records server build ${manifest.serverBuild ?? "none"}, the registry says ${flavor.serverBuild}`);
  }
  if (options.expectedHash !== undefined && manifest.manifestHash !== options.expectedHash) {
    problems.push("the manifest hash is not the expected golden hash");
  }
  let scan: ScanResult;
  try {
    scan = await scanTree(root, flavor.runtimeDirs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    scan = { files: [], skippedRuntime: 0 };
    problems.push("the tree folder does not exist");
  }
  const hashLevel = options.level === "full" ? "full" : "fast";
  const hashes = await hashAll(root, pathsToHash(manifest, scan.files, hashLevel, flavor.runtimeDirs, options.rendered));
  const compare: CompareOptions = {
    level: options.level,
    runtimeDirs: flavor.runtimeDirs,
    limit: options.limit ?? DEFAULT_DIFF_LIMIT,
    skippedRuntime: scan.skippedRuntime,
    problems,
    rendered: options.rendered,
  };
  return compareTree(manifest, scan.files, hashes, compare);
}

/** Reads and validates `manifest.json`; a hand-edited file is `tampered`. */
export async function readManifest(file: string): Promise<Manifest> {
  return parseManifest(await readFile(file, "utf8"));
}

/**
 * Writes the manifest once: it fails with `exists` if the file is already there, so a golden's
 * manifest can only be replaced by deleting it deliberately (`baseline build --replace`, ticket 24).
 * The content is written to a temporary file and linked into place, so a reader never sees half a file.
 */
export async function writeManifestOnce(file: string, manifest: Manifest): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, serializeManifest(manifest), { flag: "wx" });
  try {
    await link(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ManifestError("exists", "the manifest already exists; a golden's manifest is written once");
    }
    throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/**
 * Verifies a flavor's golden folder (`<goldenDir>\manifest.json` against `<goldenDir>\tree`). Default
 * level `golden`; `full` is `arashouse baseline verify <flavor> --full`.
 */
export async function verifyGolden(goldenDir: string, flavor: FlavorKey, options: VerifyTreeOptions): Promise<ManifestDiff> {
  const manifest = await readManifest(join(goldenDir, "manifest.json"));
  if (manifest.flavor !== flavor) {
    throw new ManifestError("malformed", `the manifest in the ${flavor} golden folder names flavor ${manifest.flavor}`);
  }
  return verifyTree(join(goldenDir, "tree"), manifest, options);
}
