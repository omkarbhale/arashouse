import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildZip } from "./zip.fixture.js";
import { ZipError, extractZipEntry, findZipEntry, listZip } from "./zip.js";

let dir: string;
const payload = Buffer.from("Aras ".repeat(5000));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "arashouse-zip-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, bytes: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe("zip reader", () => {
  const entries = [
    { name: "InnovatorSetup.msi", data: payload },
    { name: "Docs/", data: "" , method: 0 as const },
    { name: "Core140.bak", data: "stored bytes", method: 0 as const },
    { name: "Empty.txt", data: "", method: 0 as const },
  ];

  it("lists entries from the central directory and extracts them with a CRC check", async () => {
    const path = write("good.zip", buildZip(entries));
    const listing = await listZip(path);
    expect(listing.centralDirectory).toBe(true);
    expect(listing.entries.map((e) => e.name)).toEqual(["InnovatorSetup.msi", "Docs/", "Core140.bak", "Empty.txt"]);
    const msi = findZipEntry(listing, "innovatorsetup.MSI");
    expect(msi?.uncompressedSize).toBe(payload.length);
    expect(findZipEntry(listing, "Docs/")).toBeUndefined();
    expect(findZipEntry(listing, "missing.bak")).toBeUndefined();
    const out = join(dir, "out", "msi.bin");
    expect(await extractZipEntry(path, msi!, out)).toEqual({ bytes: payload.length });
    expect(readFileSync(out).equals(payload)).toBe(true);
    expect(await extractZipEntry(path, findZipEntry(listing, "Core140.bak")!, null)).toEqual({ bytes: 12 });
    expect(await extractZipEntry(path, findZipEntry(listing, "Empty.txt")!, null)).toEqual({ bytes: 0 });
  });

  it("falls back to the local headers when the central directory is gone, and says so", async () => {
    const path = write("damaged.zip", buildZip(entries, { centralDirectory: false }));
    const listing = await listZip(path);
    expect(listing.centralDirectory).toBe(false);
    expect(listing.damage).toMatch(/central-directory/);
    expect(listing.entries.map((e) => e.name)).toEqual(["InnovatorSetup.msi", "Docs/", "Core140.bak", "Empty.txt"]);
    expect(await extractZipEntry(path, findZipEntry(listing, "InnovatorSetup.msi")!, null)).toEqual({ bytes: payload.length });
  });

  it("marks an entry cut off at the end of a damaged zip and refuses to extract it", async () => {
    const whole = buildZip(entries, { centralDirectory: false });
    const path = write("cut.zip", whole.subarray(0, whole.length - 40));
    const listing = await listZip(path);
    const last = listing.entries.at(-1)!;
    expect(listing.entries.some((e) => e.truncated)).toBe(true);
    await expect(extractZipEntry(path, listing.entries.find((e) => e.truncated) ?? last, null)).rejects.toThrow(/cut off/);
  });

  it("fails an entry whose CRC-32 does not match", async () => {
    const path = write("badcrc.zip", buildZip([{ name: "Core140.bak", data: payload, crc: 1234 }]));
    const listing = await listZip(path);
    await expect(extractZipEntry(path, listing.entries[0]!, null)).rejects.toThrow(/CRC-32/);
  });

  it("fails a damaged deflate stream", async () => {
    const good = buildZip([{ name: "a.bin", data: payload }]);
    const bad = Buffer.from(good);
    for (let i = 40; i < 60; i++) bad[i] = 0xff;
    const path = write("badstream.zip", bad);
    const listing = await listZip(path);
    await expect(extractZipEntry(path, listing.entries[0]!, null)).rejects.toThrow(ZipError);
  });

  it("rejects a file that is not a zip at all", async () => {
    const path = write("notzip.zip", Buffer.from("this is not a zip file, just text".repeat(4)));
    await expect(listZip(path)).rejects.toThrow(/not a readable zip/);
  });
});
