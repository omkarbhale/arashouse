import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildZip } from "./zip.fixture.js";
import { MEDIA_ENV, MediaError, expectedMediaFiles } from "./media.js";
import {
  CHECKSUM_FILE,
  checkMedia,
  diffPropertyNames,
  isPublicPropertyName,
  missingProperties,
  parseChecksumFile,
  publicPropertyNames,
  versionMatches,
  writeChecksums,
  type MediaCheckOptions,
  type MsiProperties,
  type MsiReader,
} from "./media-check.js";

let root: string;
let scratch: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "arashouse-mc-"));
  scratch = join(root, "scratch");
  mkdirSync(scratch);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function msiProps(version: string, extra: Partial<MsiProperties> = {}): MsiProperties {
  return {
    productName: "Aras Innovator",
    manufacturer: "Aras Corporation",
    productVersion: version,
    names: ["ProductCode", "UpgradeCode", "WEBALIAS", "INSTALL_DATABASE", "LICENSEKEY", "IS_SQLSERVER_SERVER"],
    ...extra,
  };
}

/** A reader that records the paths it was given and what was there when it was called. */
function stubReader(props: MsiProperties | Error): MsiReader & { calls: string[]; seen: string[] } {
  const calls: string[] = [];
  const seen: string[] = [];
  const reader = (async (path: string) => {
    calls.push(path);
    seen.push(readFileSync(path, "utf8"));
    if (props instanceof Error) throw props;
    return props;
  }) as MsiReader & { calls: string[]; seen: string[] };
  reader.calls = calls;
  reader.seen = seen;
  return reader;
}

const options = (readMsi: MsiReader, extra: Partial<MediaCheckOptions> = {}): MediaCheckOptions => ({
  env: { [MEDIA_ENV]: root },
  startDir: root,
  readMsi,
  scratchDir: scratch,
  ...extra,
});

function loose(flavor: string, files: Record<string, string> = {}): string {
  const dir = join(root, flavor);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const files23 = { "InnovatorSetup.msi": "msi bytes", "Core140.bak": "core", "CoreAndSolutions140.bak": "core+sol" };

describe("pure helpers", () => {
  it("matches a version by dotted prefix", () => {
    expect(versionMatches("12.0.0", "12.0")).toBe(true);
    expect(versionMatches("14.0.9", "14.0.9")).toBe(true);
    expect(versionMatches("14.0.9.1", "14.0.9")).toBe(true);
    expect(versionMatches("14.0.18", "14.0.9")).toBe(false);
    expect(versionMatches("14.0.90", "14.0.9")).toBe(false);
    expect(versionMatches("12.0.0", "14.0.9")).toBe(false);
  });

  it("keeps only public-looking property names", () => {
    expect(isPublicPropertyName("WEBALIAS")).toBe(true);
    expect(isPublicPropertyName("IS_SQLSERVER_SERVER")).toBe(true);
    expect(isPublicPropertyName("ProductCode")).toBe(false);
    expect(isPublicPropertyName("_X")).toBe(false);
    expect(publicPropertyNames(["WEBALIAS", "ProductCode", "A_B", "WEBALIAS"])).toEqual(["A_B", "WEBALIAS"]);
  });

  it("diffs two property name lists and finds the ones an unattended command needs but the MSI lacks", () => {
    expect(diffPropertyNames(["A", "B", "C"], ["B", "C", "D"])).toEqual({ onlyInA: ["A"], onlyInB: ["D"] });
    expect(diffPropertyNames(["A"], ["A"])).toEqual({ onlyInA: [], onlyInB: [] });
    expect(missingProperties(["WEBALIAS", "INSTALL_DATABASE"], ["WEBALIAS", "SQL_ADO_CONN_DRIVER"])).toEqual([
      "SQL_ADO_CONN_DRIVER",
    ]);
  });

  it("parses sha256sum lines in text and binary mode and ignores the rest", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    expect(parseChecksumFile(`${a}  one.msi\n${b} *two file.zip\r\nnot a line\n\n`)).toEqual([
      { hash: a, name: "one.msi" },
      { hash: b.toLowerCase(), name: "two file.zip" },
    ]);
  });
});

describe("checkMedia with loose files", () => {
  it("passes a complete folder whose checksums and MSI version match", async () => {
    const dir = loose("23", files23);
    writeFileSync(
      join(dir, CHECKSUM_FILE),
      Object.entries(files23).map(([n, t]) => `${sha(t)}  ${n}`).join("\n"),
    );
    const reader = stubReader(msiProps("14.0.9"));
    const report = await checkMedia("23", options(reader));
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.files.map((f) => [f.name, f.state, f.location])).toEqual([
      ["InnovatorSetup.msi", "present", "folder"],
      ["Core140.bak", "present", "folder"],
      ["CoreAndSolutions140.bak", "present", "folder"],
    ]);
    expect(report.checksums).toMatchObject({ state: "verified", source: join(dir, CHECKSUM_FILE), uncovered: [] });
    expect(report.msi).toMatchObject({
      read: true,
      productName: "Aras Innovator",
      productVersion: "14.0.9",
      versionMatch: true,
      publicProperties: ["INSTALL_DATABASE", "IS_SQLSERVER_SERVER", "LICENSEKEY", "WEBALIAS"],
    });
    expect(reader.calls).toEqual([join(dir, "InnovatorSetup.msi")]);
    expect(report.notes).toEqual([]);
  });

  it("names every missing file by exact path", async () => {
    const dir = loose("23", { "InnovatorSetup.msi": "msi bytes" });
    const report = await checkMedia("23", options(stubReader(msiProps("14.0.9"))));
    expect(report.ok).toBe(false);
    expect(report.problems).toContain(`missing media file: ${join(dir, "Core140.bak")}`);
    expect(report.problems).toContain(`missing media file: ${join(dir, "CoreAndSolutions140.bak")}`);
    expect(report.files.filter((f) => f.state === "missing").map((f) => f.path)).toEqual([
      join(dir, "Core140.bak"),
      join(dir, "CoreAndSolutions140.bak"),
    ]);
  });

  it("reports a missing folder, with all three files by path, and reads no MSI", async () => {
    const reader = stubReader(msiProps("14.35.0"));
    const report = await checkMedia("35", options(reader));
    const dir = join(root, "35");
    expect(report.folderExists).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.msi).toBeNull();
    expect(report.problems[0]).toBe(`media folder does not exist: ${dir}`);
    for (const name of expectedMediaFiles("35")) expect(report.problems).toContain(`missing media file: ${join(dir, name)}`);
    expect(reader.calls).toEqual([]);
  });

  it("reports a bad checksum", async () => {
    const dir = loose("23", files23);
    writeFileSync(
      join(dir, CHECKSUM_FILE),
      [`${sha("different")}  InnovatorSetup.msi`, `${sha("core")}  Core140.bak`].join("\n"),
    );
    const report = await checkMedia("23", options(stubReader(msiProps("14.0.9"))));
    expect(report.ok).toBe(false);
    expect(report.checksums.state).toBe("mismatch");
    expect(report.checksums.results).toEqual([
      { name: "InnovatorSetup.msi", state: "mismatch" },
      { name: "Core140.bak", state: "ok" },
    ]);
    expect(report.checksums.uncovered).toEqual(["CoreAndSolutions140.bak"]);
    expect(report.problems).toEqual([
      `checksum mismatch: ${join(dir, "InnovatorSetup.msi")} does not match ${join(dir, CHECKSUM_FILE)}`,
    ]);
  });

  it("reports a file listed in the checksum file that is not there", async () => {
    const dir = loose("23", files23);
    writeFileSync(join(dir, CHECKSUM_FILE), `${sha("x")}  Gone.bak\n${sha("y")}  ../escape.bak\n`);
    const report = await checkMedia("23", options(stubReader(msiProps("14.0.9"))));
    expect(report.problems).toHaveLength(2);
    expect(report.problems[0]).toMatch(/lists Gone\.bak, which is not in/);
    expect(report.problems[1]).toMatch(/lists \.\.\/escape\.bak/);
  });

  it("warns, but does not fail, when there is no checksum file", async () => {
    loose("23", files23);
    const report = await checkMedia("23", options(stubReader(msiProps("14.0.9"))));
    expect(report.ok).toBe(true);
    expect(report.checksums.state).toBe("absent");
    expect(report.warnings.join("\n")).toMatch(/no SHA256SUMS for 23.*--write-sums/);
  });

  it("falls back to the one shared SHA256SUMS at the top of media/, by <flavor>/ path", async () => {
    loose("23", files23);
    writeFileSync(
      join(root, CHECKSUM_FILE),
      [`${sha("msi bytes")}  23/InnovatorSetup.msi`, `${sha("zzz")}  12sp9/other.zip`].join("\n"),
    );
    const report = await checkMedia("23", options(stubReader(msiProps("14.0.9"))));
    expect(report.checksums).toMatchObject({ state: "verified", source: join(root, CHECKSUM_FILE) });
    expect(report.checksums.results).toEqual([{ name: "InnovatorSetup.msi", state: "ok" }]);
  });

  it("reports a version mismatch and a wrong product", async () => {
    loose("23", files23);
    const wrongVersion = await checkMedia("23", options(stubReader(msiProps("14.0.18"))));
    expect(wrongVersion.ok).toBe(false);
    expect(wrongVersion.msi).toMatchObject({ versionMatch: false, productVersion: "14.0.18", expectedVersion: "14.0.9" });
    expect(wrongVersion.problems).toEqual([
      expect.stringMatching(/version mismatch: .*InnovatorSetup\.msi has ProductVersion 14\.0\.18, but flavor 23 .* expects 14\.0\.9/),
    ]);
    const wrongProduct = await checkMedia("23", options(stubReader(msiProps("14.0.9", { productName: "Something Else" }))));
    expect(wrongProduct.problems).toEqual([expect.stringMatching(/not an Aras Innovator installer: ProductName is "Something Else"/)]);
    const noVersion = await checkMedia("23", options(stubReader(msiProps("x", { productVersion: undefined }))));
    expect(noVersion.problems).toEqual([expect.stringMatching(/no ProductVersion/)]);
  });

  it("reports an unreadable Property table without failing the other checks", async () => {
    loose("23", files23);
    const report = await checkMedia("23", options(stubReader(new Error("powershell.exe could not open it"))));
    expect(report.ok).toBe(false);
    expect(report.msi).toMatchObject({ read: false, publicProperties: [] });
    expect(report.problems).toEqual([expect.stringMatching(/cannot read the Property table of .*could not open it/)]);
    expect(report.files.every((f) => f.state === "present")).toBe(true);
  });

  it("notes that 12.0's ProductVersion cannot tell the service packs apart, and passes 12.0.x", async () => {
    loose("12sp9", {
      "InnovatorSetup.msi": "m",
      "Core120.bak": "c",
      "CoreAndSolutions120.bak": "cs",
    });
    const report = await checkMedia("12sp9", options(stubReader(msiProps("12.0.0"))));
    expect(report.ok).toBe(true);
    expect(report.msi).toMatchObject({ versionMatch: true, expectedVersion: "12.0" });
    expect(report.notes).toHaveLength(1);
    expect(report.notes[0]).toMatch(/does not distinguish/);
    expect(report.notes[0]).toMatch(/12\.0\.0\.24090/);
    expect((await checkMedia("12sp9", options(stubReader(msiProps("14.0.9"))))).ok).toBe(false);
  });

  it("puts only names, plus ProductName, Manufacturer and ProductVersion, in the report", async () => {
    loose("23", files23);
    const report = await checkMedia("23", options(stubReader(msiProps("14.0.9"))));
    const json = JSON.stringify(report);
    expect(json).toContain("LICENSEKEY");
    // The reader's type has no room for any other value, so nothing else can be in the report.
    expect(Object.keys(report.msi!).sort()).toEqual(
      ["expectedVersion", "from", "manufacturer", "productName", "productVersion", "publicProperties", "read", "versionMatch"].sort(),
    );
  });
});

describe("checkMedia with a CD-image zip", () => {
  const entries23 = [
    { name: "Documentation/", data: "", method: 0 as const },
    { name: "InnovatorSetup.msi", data: "msi inside the zip" },
    { name: "Core140.bak", data: "core inside" },
    { name: "CoreAndSolutions140.bak", data: "core+sol inside" },
  ];

  it("finds the files in the zip, unpacks the MSI to the scratch folder, reads it, and cleans up", async () => {
    const dir = loose("23");
    writeFileSync(join(dir, "Release 23 CD Image.zip"), buildZip(entries23));
    const reader = stubReader(msiProps("14.0.9"));
    const report = await checkMedia("23", options(reader));
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.files.map((f) => [f.name, f.location, f.crc])).toEqual([
      ["InnovatorSetup.msi", "zip", "ok"],
      ["Core140.bak", "zip", "ok"],
      ["CoreAndSolutions140.bak", "zip", "ok"],
    ]);
    expect(report.zips).toEqual([
      expect.objectContaining({ path: join(dir, "Release 23 CD Image.zip"), centralDirectory: true, entries: 4 }),
    ]);
    expect(reader.calls).toHaveLength(1);
    expect(reader.calls[0]!.startsWith(scratch)).toBe(true);
    expect(reader.seen).toEqual(["msi inside the zip"]);
    expect(readdirSync(scratch)).toEqual([]);
    expect(report.msi!.from).toBe(`${join(dir, "Release 23 CD Image.zip")} :: InnovatorSetup.msi`);
  });

  it("reads a zip with no central directory, and warns that it is damaged", async () => {
    const dir = loose("23");
    writeFileSync(join(dir, "Release 23 CD Image.zip"), buildZip(entries23, { centralDirectory: false }));
    const report = await checkMedia("23", options(stubReader(msiProps("14.0.9"))));
    expect(report.ok).toBe(true);
    expect(report.zips[0]).toMatchObject({ centralDirectory: false });
    expect(report.warnings[0]).toMatch(/no readable central directory.*damaged at source.*4 entries/);
  });

  it("prefers a loose file over the same name in the zip", async () => {
    const dir = loose("23", { "Core140.bak": "loose core" });
    writeFileSync(join(dir, "Release 23 CD Image.zip"), buildZip(entries23));
    const report = await checkMedia("23", options(stubReader(msiProps("14.0.9"))));
    expect(report.files.find((f) => f.name === "Core140.bak")).toMatchObject({ location: "folder" });
  });

  it("reports a file the zip does not hold, naming the zip it searched", async () => {
    const dir = loose("23");
    writeFileSync(join(dir, "Release 23 CD Image.zip"), buildZip(entries23.slice(0, 3)));
    const report = await checkMedia("23", options(stubReader(msiProps("14.0.9"))));
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      `missing media file: ${join(dir, "CoreAndSolutions140.bak")} (and no entry of that name in ${join(dir, "Release 23 CD Image.zip")})`,
    ]);
  });

  it("fails a backup that is damaged inside the zip", async () => {
    const dir = loose("23");
    writeFileSync(
      join(dir, "Release 23 CD Image.zip"),
      buildZip(entries23.map((e) => (e.name === "Core140.bak" ? { ...e, crc: 7 } : e))),
    );
    const report = await checkMedia("23", options(stubReader(msiProps("14.0.9"))));
    expect(report.ok).toBe(false);
    expect(report.files.find((f) => f.name === "Core140.bak")).toMatchObject({ crc: "bad" });
    expect(report.problems).toEqual([expect.stringMatching(/Core140\.bak is damaged inside .*CRC-32/)]);
  });

  it("fails an MSI that is damaged inside the zip, without calling the reader", async () => {
    const dir = loose("23");
    writeFileSync(
      join(dir, "Release 23 CD Image.zip"),
      buildZip(entries23.map((e) => (e.name === "InnovatorSetup.msi" ? { ...e, crc: 7 } : e))),
    );
    const reader = stubReader(msiProps("14.0.9"));
    const report = await checkMedia("23", options(reader));
    expect(report.ok).toBe(false);
    expect(reader.calls).toEqual([]);
    expect(report.problems).toEqual([expect.stringMatching(/unpacking InnovatorSetup\.msi failed: .*CRC-32/)]);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("reports a .zip that is not a zip", async () => {
    const dir = loose("23", files23);
    writeFileSync(join(dir, "broken.zip"), "this is plainly not a zip archive at all, not even close");
    const report = await checkMedia("23", options(stubReader(msiProps("14.0.9"))));
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([expect.stringMatching(/cannot read zip .*broken\.zip: .*not a readable zip/)]);
  });
});

describe("writeChecksums", () => {
  it("creates SHA256SUMS in sha256sum format, which the check then verifies", async () => {
    const dir = loose("23", files23);
    writeFileSync(join(dir, ".hidden"), "ignored");
    const written = await writeChecksums("23", { env: { [MEDIA_ENV]: root }, startDir: root });
    expect(written.path).toBe(join(dir, CHECKSUM_FILE));
    expect(written.files).toEqual(["Core140.bak", "CoreAndSolutions140.bak", "InnovatorSetup.msi"]);
    expect(parseChecksumFile(readFileSync(written.path, "utf8"))).toEqual([
      { hash: sha("core"), name: "Core140.bak" },
      { hash: sha("core+sol"), name: "CoreAndSolutions140.bak" },
      { hash: sha("msi bytes"), name: "InnovatorSetup.msi" },
    ]);
    const report = await checkMedia("23", options(stubReader(msiProps("14.0.9"))));
    expect(report.checksums.state).toBe("verified");
    expect(report.checksums.uncovered).toEqual([]);
  });

  it("never overwrites an existing SHA256SUMS", async () => {
    const dir = loose("23", files23);
    writeFileSync(join(dir, CHECKSUM_FILE), "keep me");
    await expect(writeChecksums("23", { env: { [MEDIA_ENV]: root }, startDir: root })).rejects.toThrow(/already exists/);
    expect(readFileSync(join(dir, CHECKSUM_FILE), "utf8")).toBe("keep me");
  });

  it("refuses a missing or empty folder with a MediaError", async () => {
    const opts = { env: { [MEDIA_ENV]: root }, startDir: root };
    await expect(writeChecksums("35", opts)).rejects.toThrow(MediaError);
    loose("35");
    await expect(writeChecksums("35", opts)).rejects.toThrow(/no files to checksum/);
    expect(existsSync(join(root, "35", CHECKSUM_FILE))).toBe(false);
  });
});
