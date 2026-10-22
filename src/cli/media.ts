// `arashouse media check [<flavor>...] [--json] [--write-sums]` (ticket 18).

import {
  FLAVOR_KEYS,
  MediaError,
  checkMedia,
  diffPropertyNames,
  isFlavorKey,
  writeChecksums,
  type FlavorKey,
  type FlavorMediaReport,
  type MediaCheckOptions,
} from "../core/index.js";

export const MEDIA_USAGE = "usage: arashouse media check [<flavor>...] [--json] [--write-sums]";

export interface MediaCliIo {
  out(line: string): void;
  err(line: string): void;
}

interface ParsedArgs {
  flavors: FlavorKey[];
  json: boolean;
  writeSums: boolean;
}

function parseArgs(args: readonly string[]): ParsedArgs | string {
  const flavors: FlavorKey[] = [];
  let json = false;
  let writeSums = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--write-sums") writeSums = true;
    else if (arg.startsWith("-")) return `unknown option ${arg}`;
    else if (isFlavorKey(arg)) {
      if (!flavors.includes(arg)) flavors.push(arg);
    } else return `unknown flavor "${arg}"; the flavors are ${FLAVOR_KEYS.join(", ")}`;
  }
  return { flavors: flavors.length > 0 ? flavors : [...FLAVOR_KEYS], json, writeSums };
}

function wrap(names: readonly string[], indent: string, width = 100): string[] {
  const lines: string[] = [];
  let line = indent;
  for (const name of names) {
    if (line.length + name.length + 1 > width && line.trim() !== "") {
      lines.push(line.trimEnd());
      line = indent;
    }
    line += `${name} `;
  }
  if (line.trim() !== "") lines.push(line.trimEnd());
  return lines;
}

function formatReport(r: FlavorMediaReport): string[] {
  const out: string[] = [`${r.flavor}: ${r.ok ? "OK" : "PROBLEMS"}  (${r.folder})`];
  for (const file of r.files) {
    const where =
      file.state === "missing"
        ? `missing: ${file.path}`
        : file.location === "zip"
          ? `in zip ${file.zip}${file.crc === "ok" ? " (CRC ok)" : file.crc === "bad" ? " (CRC BAD)" : ""}`
          : "present";
    out.push(`  ${file.name}: ${where}`);
  }
  for (const zip of r.zips) {
    out.push(`  zip ${zip.path}: ${zip.entries} entries${zip.centralDirectory ? "" : ", NO central directory (damaged at source)"}`);
  }
  const c = r.checksums;
  if (c.state === "absent") out.push(`  checksums: no ${"SHA256SUMS"} found`);
  else {
    const bad = c.results.filter((x) => x.state !== "ok").length;
    out.push(`  checksums: ${c.state} (${c.results.length - bad} of ${c.results.length} ok) from ${c.source}`);
  }
  if (r.msi) {
    const m = r.msi;
    if (!m.read) out.push(`  MSI: not read`);
    else {
      out.push(
        `  MSI: ${m.productName ?? "?"} / ${m.manufacturer ?? "?"}, ProductVersion ${m.productVersion ?? "?"}` +
          ` (flavor expects ${m.expectedVersion}.x: ${m.versionMatch ? "match" : "MISMATCH"})`,
      );
      out.push(`  MSI public properties (${m.publicProperties.length}), names only:`);
      out.push(...wrap(m.publicProperties, "    "));
    }
  }
  for (const note of r.notes) out.push(`  note: ${note}`);
  for (const w of r.warnings) out.push(`  warning: ${w}`);
  for (const p of r.problems) out.push(`  PROBLEM: ${p}`);
  return out;
}

function formatDiff(a: FlavorMediaReport, b: FlavorMediaReport): string[] {
  if (!a.msi?.read || !b.msi?.read) return [`property names ${a.flavor} vs ${b.flavor}: not compared (an MSI was not read)`];
  const { onlyInA, onlyInB } = diffPropertyNames(a.msi.publicProperties, b.msi.publicProperties);
  const lines = [`property names ${a.flavor} vs ${b.flavor}:`];
  lines.push(`  only in ${a.flavor} (${onlyInA.length}): ${onlyInA.join(" ") || "-"}`);
  lines.push(`  only in ${b.flavor} (${onlyInB.length}): ${onlyInB.join(" ") || "-"}`);
  return lines;
}

/** Runs the command; returns the process exit code (0 all fine, 1 a problem was found, 2 bad usage). */
export async function runMediaCheck(
  args: readonly string[],
  options: MediaCheckOptions,
  io: MediaCliIo,
): Promise<number> {
  const parsed = parseArgs(args);
  if (typeof parsed === "string") {
    io.err(`arashouse media check: ${parsed}`);
    io.err(MEDIA_USAGE);
    return 2;
  }
  try {
    if (parsed.writeSums) {
      for (const flavor of parsed.flavors) {
        const written = await writeChecksums(flavor, options);
        io.err(`wrote ${written.path} (${written.files.length} files)`);
      }
    }
    const reports: FlavorMediaReport[] = [];
    for (const flavor of parsed.flavors) reports.push(await checkMedia(flavor, options));
    const ok = reports.every((r) => r.ok);
    if (parsed.json) {
      const body: Record<string, unknown> = { ok, flavors: reports };
      if (reports.length === 2 && reports[0]!.msi?.read && reports[1]!.msi?.read) {
        body.propertyDiff = {
          a: reports[0]!.flavor,
          b: reports[1]!.flavor,
          ...diffPropertyNames(reports[0]!.msi.publicProperties, reports[1]!.msi.publicProperties),
        };
      }
      io.out(JSON.stringify(body, null, 2));
    } else {
      for (const r of reports) io.out(formatReport(r).join("\n"));
      if (reports.length === 2) io.out(formatDiff(reports[0]!, reports[1]!).join("\n"));
    }
    return ok ? 0 : 1;
  } catch (cause) {
    if (cause instanceof MediaError) {
      io.err(`arashouse media check: ${cause.message}`);
      return 1;
    }
    throw cause;
  }
}
