// A small zip reader for the CD-image zips in `media/`. It lists entries from the central directory
// and, when that is missing (a CD image damaged at source), by walking the local file headers, then
// extracts one entry at a time with a CRC-32 check. Read-only: it never writes beside the zip.
// Local filesystem I/O only.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

/** A zip that cannot be read, or an entry that fails its checks. The message says what is wrong. */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  readonly name: string;
  /** 0 = stored, 8 = deflate; anything else cannot be extracted. */
  readonly method: number;
  readonly flags: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  /** Offset of the entry's local file header. */
  readonly headerOffset: number;
  /** The data runs past the end of the file (only detectable when walking local headers). */
  readonly truncated: boolean;
}

export interface ZipListing {
  readonly path: string;
  readonly size: number;
  readonly entries: readonly ZipEntry[];
  /** False when the central directory was missing or unreadable and the entries came from local headers. */
  readonly centralDirectory: boolean;
  /** Why the central directory was not used, when it was not. */
  readonly damage?: string;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const FLAG_DATA_DESCRIPTOR = 0x08;

async function readAt(path: string, offset: number, length: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function u64(buf: Buffer, at: number): number {
  return Number(buf.readBigUInt64LE(at));
}

async function readCentralDirectory(path: string, size: number): Promise<ZipEntry[]> {
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = await readAt(path, size - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("no end-of-central-directory record");
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locatorAt = eocd - 20;
    if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== SIG_LOCATOR64) throw new ZipError("zip64 record not found");
    const eocd64 = await readAt(path, u64(tail, locatorAt + 8), 56);
    if (eocd64.length < 56 || eocd64.readUInt32LE(0) !== SIG_EOCD64) throw new ZipError("bad zip64 record");
    count = u64(eocd64, 32);
    cdSize = u64(eocd64, 40);
    cdOffset = u64(eocd64, 48);
  }
  if (cdOffset + cdSize > size) throw new ZipError("central directory runs past the end of the file");
  const cd = await readAt(path, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > cd.length || cd.readUInt32LE(at) !== SIG_CENTRAL) throw new ZipError("bad central directory entry");
    const flags = cd.readUInt16LE(at + 8);
    const method = cd.readUInt16LE(at + 10);
    const crc32 = cd.readUInt32LE(at + 16);
    let compressedSize = cd.readUInt32LE(at + 20);
    let uncompressedSize = cd.readUInt32LE(at + 24);
    const nameLength = cd.readUInt16LE(at + 28);
    const extraLength = cd.readUInt16LE(at + 30);
    const commentLength = cd.readUInt16LE(at + 32);
    let headerOffset = cd.readUInt32LE(at + 42);
    const name = cd.toString("utf8", at + 46, at + 46 + nameLength);
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = cd.readUInt16LE(extra);
      const length = cd.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        if (uncompressedSize === 0xffffffff) (uncompressedSize = u64(cd, field)), (field += 8);
        if (compressedSize === 0xffffffff) (compressedSize = u64(cd, field)), (field += 8);
        if (headerOffset === 0xffffffff) headerOffset = u64(cd, field);
      }
      extra += 4 + length;
    }
    entries.push({ name, method, flags, crc32, compressedSize, uncompressedSize, headerOffset, truncated: false });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Walks the local file headers from the start; stops at the first thing that is not one. */
async function walkLocalHeaders(path: string, size: number): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + 30 <= size) {
    const head = await readAt(path, offset, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== SIG_LOCAL) break;
    const flags = head.readUInt16LE(6);
    const method = head.readUInt16LE(8);
    const crc32 = head.readUInt32LE(14);
    const compressedSize = head.readUInt32LE(18);
    const uncompressedSize = head.readUInt32LE(22);
    const nameLength = head.readUInt16LE(26);
    const extraLength = head.readUInt16LE(28);
    if (flags & FLAG_DATA_DESCRIPTOR && compressedSize === 0 && !(method === 0 && uncompressedSize === 0)) {
      // The sizes follow the data, so the next header cannot be found without inflating.
      break;
    }
    const name = (await readAt(path, offset + 30, nameLength)).toString("utf8");
    const dataEnd = offset + 30 + nameLength + extraLength + compressedSize;
    const truncated = dataEnd > size;
    entries.push({ name, method, flags, crc32, compressedSize, uncompressedSize, headerOffset: offset, truncated });
    if (truncated) break;
    offset = dataEnd;
  }
  return entries;
}

/** The entries of a zip, from its central directory or, if that is damaged, from its local headers. */
export async function listZip(path: string): Promise<ZipListing> {
  const fh = await open(path, "r");
  let size: number;
  try {
    size = (await fh.stat()).size;
  } finally {
    await fh.close();
  }
  try {
    return { path, size, entries: await readCentralDirectory(path, size), centralDirectory: true };
  } catch (cause) {
    const damage = cause instanceof Error ? cause.message : String(cause);
    const entries = await walkLocalHeaders(path, size);
    if (entries.length === 0) throw new ZipError(`${path} is not a readable zip (${damage}, and no local file headers)`);
    return { path, size, entries, centralDirectory: false, damage };
  }
}

/** The file entry called `name` at the top level of the zip (case-insensitive, as Windows is), if any. */
export function findZipEntry(listing: ZipListing, name: string): ZipEntry | undefined {
  const wanted = name.toLowerCase();
  return listing.entries.find((e) => !e.name.endsWith("/") && e.name.toLowerCase() === wanted);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc: number, chunk: Buffer): number {
  let c = crc;
  for (let i = 0; i < chunk.length; i++) c = (CRC_TABLE[(c ^ chunk[i]!) & 0xff] as number) ^ (c >>> 8);
  return c;
}

export interface ExtractResult {
  readonly bytes: number;
}

/**
 * Inflates one entry, checks its size and CRC-32, and writes it to `destPath` (or nowhere when `destPath`
 * is null, which is a pure integrity check). A failed check removes nothing and throws `ZipError`; the
 * caller owns the destination folder.
 */
export async function extractZipEntry(zipPath: string, entry: ZipEntry, destPath: string | null): Promise<ExtractResult> {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipError(`${entry.name} in ${zipPath} uses compression method ${entry.method}, which is not supported`);
  }
  if (entry.truncated) throw new ZipError(`${entry.name} in ${zipPath} is cut off at the end of the file`);
  const head = await readAt(zipPath, entry.headerOffset, 30);
  if (head.length < 30 || head.readUInt32LE(0) !== SIG_LOCAL) {
    throw new ZipError(`${entry.name} in ${zipPath}: no local file header at offset ${entry.headerOffset}`);
  }
  const dataStart = entry.headerOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  let crc = 0xffffffff;
  let bytes = 0;
  const check = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      crc = crc32Update(crc, chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  const sink: Writable =
    destPath === null
      ? new Writable({ write: (_chunk, _encoding, done) => done() })
      : (await mkdir(dirname(destPath), { recursive: true }), createWriteStream(destPath));
  try {
    const source =
      entry.compressedSize === 0
        ? Readable.from([])
        : createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
    if (entry.method === 8 && entry.compressedSize > 0) {
      await pipeline(source, createInflateRaw(), check, sink);
    } else {
      await pipeline(source, check, sink);
    }
  } catch (cause) {
    throw new ZipError(`${entry.name} in ${zipPath} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (bytes !== entry.uncompressedSize) {
    throw new ZipError(`${entry.name} in ${zipPath} is ${bytes} bytes after inflating; the zip says ${entry.uncompressedSize}`);
  }
  if (((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new ZipError(`${entry.name} in ${zipPath} fails its CRC-32 check`);
  return { bytes };
}
