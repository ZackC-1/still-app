// A small ZIP writer whose output depends only on file names and file bytes. Real ZIP tools (and
// `wxt zip`) stamp each entry with its modification time and use the machine's file order, so the
// same build zips to different bytes on different days. This one fixes everything else:
//   - entries sorted by name (plain code-unit order, not locale order)
//   - every timestamp is 1980-01-01 00:00:00, the earliest value a ZIP can hold
//   - every file is mode 0644, created by "unix", UTF-8 names, no extra fields, no comments
//   - fixed deflate settings (zlib level 9)
// Same node version and same inputs give byte-identical archives. The bytes inside each entry are
// exactly the input bytes, so a reviewer can unzip and compare content with any tool.

import { crc32, deflateRawSync } from "node:zlib";

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const UTF8_FLAG = 0x0800;

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/** @param {Array<{name: string, data: Buffer | Uint8Array}>} entries */
export function createZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) if (sorted[i].name === sorted[i - 1].name) throw new Error(`duplicate zip entry ${sorted[i].name}`);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of sorted) {
    if (name.startsWith("/") || name.includes("..") || name.includes("\\")) throw new Error(`unsafe zip entry name ${name}`);
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.from(data);
    const deflated = raw.length === 0 ? raw : deflateRawSync(raw, { level: 9 });
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(UTF8_FLAG), u16(method), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(body.length), u32(raw.length), u16(nameBytes.length), u16(0), nameBytes,
    ]);
    central.push(Buffer.concat([
      u32(0x02014b50), u16((3 << 8) | 20), u16(20), u16(UTF8_FLAG), u16(method), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(body.length), u32(raw.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
      u32((0o100644 << 16) >>> 0), u32(offset), nameBytes,
    ]));
    chunks.push(local, body);
    offset += local.length + body.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(sorted.length), u16(sorted.length), u32(centralBytes.length), u32(offset), u16(0)]);
  return Buffer.concat([...chunks, centralBytes, end]);
}
