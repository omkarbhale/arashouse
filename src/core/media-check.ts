// `arashouse media check` (ticket 18): are a flavor's installers there, intact and the right version?
// Read-only except for a scratch copy of the MSI when it sits inside a CD-image zip, and the
// SHA256SUMS file that `writeChecksums` creates in the ignored media folder. The MSI's Property table
// is read through an injected `MsiReader` (the real one is `src/host/msi.ts`; tests pass a stub).
// Property VALUES are never part of a report, except ProductName, Manufacturer and ProductVersion.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFlavor, type FlavorKey } from "./flavors.js";
import { MediaError, expectedMediaFiles, mediaDir, resolveMediaRoot, type MediaOptions } from "./media.js";
import { extractZipEntry, findZipEntry, listZip, type ZipEntry, type ZipListing } from "./zip.js";

/** The checksum file, in `sha256sum` format, in each flavor's folder (or, for all flavors, in `media/`). */
export const CHECKSUM_FILE = "SHA256SUMS";

/** The Property table's `ProductName` of an Aras installer. */
export const MSI_PRODUCT_NAME = "Aras Innovator";

/** What the Property table gives us: every property name, and the values of three harmless ones. */
export interface MsiProperties {
  readonly names: readonly string[];
  readonly productName?: string;
  readonly manufacturer?: string;
  readonly productVersion?: string;
}

/** Reads the Property table of the MSI at a WSL path. */
export type MsiReader = (msiPath: string) => Promise<MsiProperties>;

export interface MediaCheckOptions extends MediaOptions {
  readonly readMsi: MsiReader;
  /**
   * Where an MSI from inside a zip is unpacked for reading (a fresh folder below it, removed afterwards).
   * Windows must be able to open it; defaults to the WSL temp folder.
   */
  readonly scratchDir?: string;
}

export interface MediaFileReport {
  readonly name: string;
  readonly state: "present" | "missing";
  /** `folder` for a loose file, `zip` for an entry of a CD-image zip. */
  readonly location?: "folder" | "zip";
  /** The loose file's exact path, which is also where a missing file is expected. */
  readonly path: string;
  /** The zip holding the entry, when `location` is `zip`. */
  readonly zip?: string;
  /** For a zip entry: whether it inflated and matched its CRC-32. */
  readonly crc?: "ok" | "bad";
  readonly detail?: string;
}

export interface ChecksumFileResult {
  readonly name: string;
  readonly state: "ok" | "mismatch" | "missing";
}

export interface ChecksumReport {
  /** The SHA256SUMS file used, or null when there is none. */
  readonly source: string | null;
  readonly state: "verified" | "mismatch" | "absent";
  readonly results: readonly ChecksumFileResult[];
  /** The installer files in the folder that the checksum file does not list. */
  readonly uncovered: readonly string[];
}

export interface MsiReport {
  readonly read: boolean;
  /** Where the MSI was read from: its path, or `<zip> :: <entry>`. */
  readonly from: string;
  readonly productName?: string;
  readonly manufacturer?: string;
  readonly productVersion?: string;
  readonly expectedVersion: string;
  readonly versionMatch?: boolean;
  /** Every property name that looks public (upper case, as `msiexec NAME=value` takes it). */
  readonly publicProperties: readonly string[];
  readonly error?: string;
}

export interface ZipReport {
  readonly path: string;
  readonly size: number;
  readonly centralDirectory: boolean;
  readonly damage?: string;
  readonly entries: number;
}

export interface FlavorMediaReport {
  readonly flavor: FlavorKey;
  readonly folder: string;
  readonly folderExists: boolean;
  readonly zips: readonly ZipReport[];
  readonly files: readonly MediaFileReport[];
  readonly checksums: ChecksumReport;
  readonly msi: MsiReport | null;
  readonly notes: readonly string[];
  readonly warnings: readonly string[];
  readonly problems: readonly string[];
  readonly ok: boolean;
}

// ---- property names ----------------------------------------------------------------------------

const PUBLIC_PROPERTY = /^[A-Z][A-Z0-9_]*$/;

/** True for a name `msiexec` takes as a public property: upper case letters, digits and underscores. */
export function isPublicPropertyName(name: string): boolean {
  return PUBLIC_PROPERTY.test(name);
}

/** The public property names of `names`, sorted and without duplicates. */
export function publicPropertyNames(names: readonly string[]): string[] {
  return [...new Set(names.filter(isPublicPropertyName))].sort();
}

/** The names in one list and not the other. */
export function diffPropertyNames(
  a: readonly string[],
  b: readonly string[],
): { onlyInA: string[]; onlyInB: string[] } {
  const inA = new Set(a);
  const inB = new Set(b);
  return { onlyInA: [...inA].filter((n) => !inB.has(n)).sort(), onlyInB: [...inB].filter((n) => !inA.has(n)).sort() };
}

/** The `needed` property names that the MSI does not support. The baseline builder refuses a command that uses one. */
export function missingProperties(supported: readonly string[], needed: readonly string[]): string[] {
  const have = new Set(supported);
  return needed.filter((n) => !have.has(n));
}

/** True when `actual` equals `expected` or starts with it and a dot (`12.0.0` matches `12.0`; `14.0.18` does not match `14.0.9`). */
export function versionMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.startsWith(`${expected}.`);
}

// ---- checksums ---------------------------------------------------------------------------------

export interface ChecksumEntry {
  readonly hash: string;
  readonly name: string;
}

/** Parses `sha256sum` output: `<64 hex>  <name>` or `<64 hex> *<name>`. Other lines are ignored. */
export function parseChecksumFile(text: string): ChecksumEntry[] {
  const entries: ChecksumEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (m) entries.push({ hash: m[1]!.toLowerCase(), name: m[2]! });
  }
  return entries;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True for a plain relative name inside the flavor folder: no `..`, no absolute path, no drive. */
function isInsideFolder(name: string): boolean {
  return !/^([\\/]|[A-Za-z]:)/.test(name) && !name.split(/[\\/]/).includes("..");
}

async function checksumSource(
  key: FlavorKey,
  folder: string,
  rootDir: string,
): Promise<{ source: string; entries: ChecksumEntry[] } | null> {
  const own = join(folder, CHECKSUM_FILE);
  if (isFile(own)) return { source: own, entries: parseChecksumFile(await readFile(own, "utf8")) };
  // The handoff wrote one file for all flavors at the top of `media/`, with `<key>/<name>` paths.
  const shared = join(rootDir, CHECKSUM_FILE);
  if (!isFile(shared)) return null;
  const prefix = `${key}/`;
  const entries = parseChecksumFile(await readFile(shared, "utf8"))
    .filter((e) => e.name.startsWith(prefix))
    .map((e) => ({ hash: e.hash, name: e.name.slice(prefix.length) }));
  return entries.length > 0 ? { source: shared, entries } : null;
}

async function verifyChecksums(
  key: FlavorKey,
  folder: string,
  rootDir: string,
  installerFiles: readonly string[],
): Promise<ChecksumReport> {
  const found = await checksumSource(key, folder, rootDir);
  if (found === null) return { source: null, state: "absent", results: [], uncovered: [...installerFiles] };
  const results: ChecksumFileResult[] = [];
  for (const entry of found.entries) {
    const path = isInsideFolder(entry.name) ? join(folder, entry.name) : null;
    if (path === null || !isFile(path)) {
      results.push({ name: entry.name, state: "missing" });
    } else {
      results.push({ name: entry.name, state: (await sha256File(path)) === entry.hash ? "ok" : "mismatch" });
    }
  }
  const listed = new Set(found.entries.map((e) => e.name));
  return {
    source: found.source,
    state: results.every((r) => r.state === "ok") && results.length > 0 ? "verified" : "mismatch",
    results,
    uncovered: installerFiles.filter((n) => !listed.has(n)),
  };
}

/** The top-level files `writeChecksums` hashes: regular files, not dotfiles, not the checksum file. */
async function folderFiles(folder: string): Promise<string[]> {
  const names = await readdir(folder);
  return names.filter((n) => !n.startsWith(".") && n !== CHECKSUM_FILE && isFile(join(folder, n))).sort();
}

/**
 * Creates `media/<flavor>/SHA256SUMS` from the files now in the folder. It never replaces one: a checksum
 * file that is already there is what `media check` verifies against, and rewriting it would bless whatever
 * is on disk. Delete it first to regenerate.
 */
export async function writeChecksums(
  flavor: FlavorKey,
  options: MediaOptions = {},
): Promise<{ path: string; files: string[] }> {
  const folder = mediaDir(flavor, options);
  if (!existsSync(folder)) throw new MediaError(`media folder ${folder} does not exist; there is nothing to checksum`);
  const target = join(folder, CHECKSUM_FILE);
  if (existsSync(target)) {
    throw new MediaError(`${target} already exists and is not overwritten; delete it to write a new one`);
  }
  const files = await folderFiles(folder);
  if (files.length === 0) throw new MediaError(`media folder ${folder} holds no files to checksum`);
  const lines: string[] = [];
  for (const name of files) lines.push(`${await sha256File(join(folder, name))}  ${name}`);
  await writeFile(target, `${lines.join("\n")}\n`, { flag: "wx" });
  return { path: target, files };
}

// ---- the check ---------------------------------------------------------------------------------

interface Located {
  readonly name: string;
  readonly looseAt: string;
  readonly zip?: { listing: ZipListing; entry: ZipEntry };
  readonly loose: boolean;
}

/** Checks one flavor's media folder. It never throws for a missing or damaged file: those are `problems`. */
export async function checkMedia(flavor: FlavorKey, options: MediaCheckOptions): Promise<FlavorMediaReport> {
  const f = getFlavor(flavor);
  const folder = mediaDir(flavor, options);
  const notes: string[] = [];
  const warnings: string[] = [];
  const problems: string[] = [];
  if (!f.msiVersionIdentifiesRelease) {
    notes.push(
      `ProductVersion of the ${f.release} MSI does not distinguish it from other service packs of the same release, ` +
        `so ${flavor} passes on ${f.msiProductVersion}.x; confirm the build after the first install by ` +
        `Aras.Server.Core.dll = ${f.serverBuild ?? "(recorded by the baseline builder)"} (ticket 24 records it).`,
    );
  }

  const expected = expectedMediaFiles(flavor);
  if (!existsSync(folder)) {
    problems.push(`media folder does not exist: ${folder}`);
    for (const name of expected) problems.push(`missing media file: ${join(folder, name)}`);
    return {
      flavor,
      folder,
      folderExists: false,
      zips: [],
      files: expected.map((name) => ({ name, state: "missing", path: join(folder, name) })),
      checksums: { source: null, state: "absent", results: [], uncovered: [] },
      msi: null,
      notes,
      warnings,
      problems,
      ok: false,
    };
  }

  // The CD-image zips in the folder: where an expected file is looked for when it is not loose.
  const zipReports: ZipReport[] = [];
  const listings: ZipListing[] = [];
  const names = (await readdir(folder)).sort();
  for (const name of names.filter((n) => n.toLowerCase().endsWith(".zip") && isFile(join(folder, n)))) {
    const path = join(folder, name);
    try {
      const listing = await listZip(path);
      listings.push(listing);
      zipReports.push({
        path,
        size: listing.size,
        centralDirectory: listing.centralDirectory,
        damage: listing.damage,
        entries: listing.entries.length,
      });
      if (!listing.centralDirectory) {
        warnings.push(
          `${path} has no readable central directory (${listing.damage}); the zip is damaged at source, ` +
            `so its ${listing.entries.length} entries were read from the local file headers`,
        );
      }
    } catch (cause) {
      problems.push(`cannot read zip ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  const located: Located[] = expected.map((name) => {
    const looseAt = join(folder, name);
    if (isFile(looseAt)) return { name, looseAt, loose: true };
    for (const listing of listings) {
      const entry = findZipEntry(listing, name);
      if (entry) return { name, looseAt, loose: false, zip: { listing, entry } };
    }
    return { name, looseAt, loose: false };
  });

  const files: MediaFileReport[] = [];
  for (const item of located) {
    if (item.loose) {
      files.push({ name: item.name, state: "present", location: "folder", path: item.looseAt });
    } else if (item.zip) {
      files.push({
        name: item.name,
        state: "present",
        location: "zip",
        path: item.looseAt,
        zip: item.zip.listing.path,
      });
    } else {
      files.push({ name: item.name, state: "missing", path: item.looseAt });
      problems.push(
        `missing media file: ${item.looseAt}` +
          (listings.length > 0 ? ` (and no entry of that name in ${listings.map((l) => l.path).join(", ")})` : ""),
      );
    }
  }

  // Zip entries other than the MSI are checked by inflating them and comparing the CRC-32; the MSI is
  // checked when it is unpacked below.
  const msiName = f.msiName;
  for (let i = 0; i < files.length; i++) {
    const item = located[i]!;
    if (!item.zip || item.name === msiName) continue;
    const report = files[i]!;
    try {
      await extractZipEntry(item.zip.listing.path, item.zip.entry, null);
      files[i] = { ...report, crc: "ok" };
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      files[i] = { ...report, crc: "bad", detail };
      problems.push(`${item.name} is damaged inside ${item.zip.listing.path}: ${detail}`);
    }
  }

  // The checksum file covers the files as they sit in the folder: the zips and any loose installer files.
  const rootDir = resolveMediaRoot(options);
  const installerFiles = names.filter((n) => isFile(join(folder, n)) && n !== CHECKSUM_FILE && !n.startsWith("."));
  const checksums = await verifyChecksums(flavor, folder, rootDir, installerFiles);
  if (checksums.state === "absent") {
    warnings.push(`no ${CHECKSUM_FILE} for ${flavor}; run \`arashouse media check ${flavor} --write-sums\` once the files are known good`);
  } else if (checksums.results.length === 0) {
    problems.push(`${checksums.source} lists no files in sha256sum format; delete it and run --write-sums again`);
  } else {
    for (const r of checksums.results) {
      if (r.state === "mismatch") problems.push(`checksum mismatch: ${join(folder, r.name)} does not match ${checksums.source}`);
      if (r.state === "missing") problems.push(`${checksums.source} lists ${r.name}, which is not in ${folder}`);
    }
    if (checksums.uncovered.length > 0) {
      warnings.push(`${checksums.source} does not list: ${checksums.uncovered.join(", ")}`);
    }
  }

  // The MSI: unpack it if it is in a zip, read its Property table, compare ProductVersion.
  let msi: MsiReport | null = null;
  const msiItem = located.find((l) => l.name === msiName)!;
  if (msiItem.loose || msiItem.zip) {
    msi = await readMsiReport(flavor, msiItem, options, problems);
    const fileIndex = files.findIndex((r) => r.name === msiName);
    if (msiItem.zip && msi.error?.startsWith("unpacking")) {
      files[fileIndex] = { ...files[fileIndex]!, crc: "bad", detail: msi.error };
    } else if (msiItem.zip) {
      files[fileIndex] = { ...files[fileIndex]!, crc: "ok" };
    }
  }

  return {
    flavor,
    folder,
    folderExists: true,
    zips: zipReports,
    files,
    checksums,
    msi,
    notes,
    warnings,
    problems,
    ok: problems.length === 0,
  };
}

async function readMsiReport(
  flavor: FlavorKey,
  item: Located,
  options: MediaCheckOptions,
  problems: string[],
): Promise<MsiReport> {
  const f = getFlavor(flavor);
  const from = item.zip ? `${item.zip.listing.path} :: ${item.zip.entry.name}` : item.looseAt;
  const base = { from, expectedVersion: f.msiProductVersion };
  let scratch: string | null = null;
  let msiPath = item.looseAt;
  try {
    if (item.zip) {
      scratch = await mkdtemp(join(options.scratchDir ?? tmpdir(), "arashouse-msi-"));
      msiPath = join(scratch, f.msiName);
      try {
        await extractZipEntry(item.zip.listing.path, item.zip.entry, msiPath);
      } catch (cause) {
        const error = `unpacking ${f.msiName} failed: ${cause instanceof Error ? cause.message : String(cause)}`;
        problems.push(error);
        return { ...base, read: false, publicProperties: [], error };
      }
    }
    let props: MsiProperties;
    try {
      props = await options.readMsi(msiPath);
    } catch (cause) {
      const error = `cannot read the Property table of ${from}: ${cause instanceof Error ? cause.message : String(cause)}`;
      problems.push(error);
      return { ...base, read: false, publicProperties: [], error };
    }
    const versionMatch = props.productVersion !== undefined && versionMatches(props.productVersion, f.msiProductVersion);
    if (props.productName !== MSI_PRODUCT_NAME) {
      problems.push(
        `${from} is not an Aras Innovator installer: ProductName is ${props.productName === undefined ? "absent" : `"${props.productName}"`}, expected "${MSI_PRODUCT_NAME}"`,
      );
    }
    if (props.productVersion === undefined) {
      problems.push(`${from} has no ProductVersion property`);
    } else if (!versionMatch) {
      problems.push(
        `version mismatch: ${from} has ProductVersion ${props.productVersion}, but flavor ${flavor} (${f.release}) expects ${f.msiProductVersion}`,
      );
    }
    return {
      ...base,
      read: true,
      productName: props.productName,
      manufacturer: props.manufacturer,
      productVersion: props.productVersion,
      versionMatch,
      publicProperties: publicPropertyNames(props.names),
    };
  } finally {
    if (scratch !== null) await rm(scratch, { recursive: true, force: true });
  }
}
