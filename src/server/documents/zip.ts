import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * A small ZIP writer (deflate, UTF-8 names) for case-file exports. Entries are built in memory; a case file is
 * bounded by the upload limit per original. No ZIP64: exports over 4 GB are refused.
 */
export interface ZipEntry {
  name: string;
  data: Buffer;
  modified: Date;
}

function dosTime(d: Date): { time: number; date: number } {
  // The archive records wall-clock time; IST is what the officers read.
  const t = new Date(d.getTime() + 330 * 60 * 1000);
  return {
    time: (t.getUTCHours() << 11) | (t.getUTCMinutes() << 5) | Math.floor(t.getUTCSeconds() / 2),
    date: ((Math.max(1980, t.getUTCFullYear()) - 1980) << 9) | ((t.getUTCMonth() + 1) << 5) | t.getUTCDate(),
  };
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    const name = e.name.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!name || name.split("/").some((p) => p === ".." || p === ".")) throw new Error(`Unsafe name in archive: ${e.name}`);
    if (seen.has(name)) throw new Error(`Duplicate name in archive: ${name}`);
    seen.add(name);
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(e.data, { level: 6 });
    const crc = crc32(e.data) >>> 0;
    const { time, date } = dosTime(e.modified);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, compressed);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
    if (offset > 0xffffffff) throw new Error("The case file is too large to export as one archive.");
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

/** Reads back the names and contents of an archive written by buildZip (used to verify exports). */
export function readZip(zip: Buffer): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = [];
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error("Not a ZIP archive");
  const count = zip.readUInt16LE(endAt + 10);
  let p = zip.readUInt32LE(endAt + 16);
  for (let i = 0; i < count; i++) {
    // 0 = stored as is, 8 = deflate; any other method is skipped rather than misread.
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extra = zip.readUInt16LE(p + 30);
    const comment = zip.readUInt16LE(p + 32);
    const localAt = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lName = zip.readUInt16LE(localAt + 26);
    const lExtra = zip.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + lName + lExtra;
    const raw = zip.subarray(dataAt, dataAt + csize);
    if (method === 0) out.push({ name, data: Buffer.from(raw) });
    else if (method === 8) out.push({ name, data: inflateRawSync(raw) });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}
