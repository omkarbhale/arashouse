import { crc32, deflateRawSync } from "node:zlib";

export interface FixtureEntry {
  name: string;
  data: Buffer | string;
  /** 8 (default) deflates; 0 stores. */
  method?: 0 | 8;
  /** Written into the zip instead of the real CRC-32, to make a damaged entry. */
  crc?: number;
}

export interface FixtureOptions {
  /** False leaves the central directory off, like a CD image damaged at source. */
  centralDirectory?: boolean;
}

/** A small zip, built by hand so tests need no zip tool and no checked-in archive. */
export function buildZip(entries: FixtureEntry[], options: FixtureOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name);
    const crc = entry.crc ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(method, 10);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += 30 + name.length + packed.length;
  }
  if (options.centralDirectory === false) return Buffer.concat(parts);
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}
