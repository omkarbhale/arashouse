// `arashouse flavors [--json]`: what each flavor is, the libs-js engine to use with it, how many of
// its slots are free, and whether its media and a verified baseline are present.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FLAVOR_KEYS, getFlavor, type FlavorKey } from "../core/flavors.js";
import { expectedMediaFiles, mediaDir, type MediaOptions } from "../core/media.js";
import type { State } from "../core/state.js";
import { findZipEntry, listZip } from "../core/zip.js";
import type { CliHost } from "./host.js";

export interface FlavorRow {
  readonly flavor: FlavorKey;
  readonly release: string;
  /** The server build; null until the flavor's baseline has been built (ticket 24). */
  readonly aras: string | null;
  /** The import-export-libs-js `--engine` (and `ARAS_PKG_ENGINE`) for this flavor. */
  readonly engine: string;
  readonly slots: { readonly free: number; readonly leased: number; readonly total: number };
  /** Every expected media file is in `media/<flavor>/`, loose or inside a CD-image zip; null when the folder cannot be found. */
  readonly media: boolean | null;
  /** The golden baseline verifies (fast level); null when the host could not be asked. */
  readonly baseline: boolean | null;
}

/** The `flavors --json` contract (docs/schemas/flavors.schema.json). */
export interface FlavorsReport {
  readonly flavors: readonly FlavorRow[];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether the flavor's media folder holds every expected file, loose or as an entry of a zip in it.
 * It reads only zip directories, never inflates anything; `arashouse media check` is the full check.
 */
export async function mediaPresent(flavor: FlavorKey, options: MediaOptions = {}): Promise<boolean | null> {
  let folder: string;
  try {
    folder = mediaDir(flavor, options);
  } catch {
    return null;
  }
  if (!existsSync(folder)) return false;
  const missing = expectedMediaFiles(flavor).filter((name) => !isFile(join(folder, name)));
  if (missing.length === 0) return true;
  const zips = readdirSync(folder).filter((n) => n.toLowerCase().endsWith(".zip") && isFile(join(folder, n)));
  const listings = await Promise.all(zips.map((n) => listZip(join(folder, n)).catch(() => undefined)));
  return missing.every((name) => listings.some((listing) => listing !== undefined && findZipEntry(listing, name) !== undefined));
}

async function baselineVerified(host: CliHost, flavor: FlavorKey): Promise<boolean | null> {
  try {
    return (await host.baselineVerify(flavor, { level: "fast" })).ok;
  } catch {
    return null;
  }
}

export async function buildFlavors(state: State, host: CliHost, media: MediaOptions = {}): Promise<FlavorsReport> {
  const slots = Object.values(state.slots);
  const flavors: FlavorRow[] = [];
  for (const key of FLAVOR_KEYS) {
    const f = getFlavor(key);
    const ofFlavor = slots.filter((s) => s.flavor === key);
    flavors.push({
      flavor: key,
      release: f.release,
      aras: f.serverBuild,
      engine: f.libsJsEngine,
      slots: {
        free: ofFlavor.filter((s) => s.status === "free").length,
        leased: ofFlavor.filter((s) => s.status === "leased").length,
        total: ofFlavor.length,
      },
      media: await mediaPresent(key, media),
      baseline: await baselineVerified(host, key),
    });
  }
  return { flavors };
}

export function formatFlavors(report: FlavorsReport): string[] {
  const yesNo = (v: boolean | null) => (v === null ? "unknown" : v ? "yes" : "no");
  const table: string[][] = [["FLAVOR", "RELEASE", "BUILD", "ENGINE", "FREE", "LEASED", "TOTAL", "MEDIA", "BASELINE"]];
  for (const r of report.flavors) {
    table.push([
      r.flavor,
      r.release,
      r.aras ?? "-",
      r.engine,
      String(r.slots.free),
      String(r.slots.leased),
      String(r.slots.total),
      yesNo(r.media),
      yesNo(r.baseline),
    ]);
  }
  const widths = table[0]!.map((_, i) => Math.max(...table.map((row) => (row[i] ?? "").length)));
  return table.map((row) => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd());
}
