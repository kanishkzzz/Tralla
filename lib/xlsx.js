// lib/xlsx.js
//
// A read-only XLSX reader for exactly the file we were given, in about
// sixty lines and with no dependencies.
//
// Why not a package: the maintained SheetJS build is not on npm, and the
// npm 'xlsx' package is a 2022 snapshot carrying published advisories.
// Adding a flagged dependency to a project scored on security, to read one
// 250-row spreadsheet, is a bad trade. An .xlsx is a zip of XML, and
// maintenance_log.xlsx is about as simple as one gets: a single sheet, no
// shared string table, no styles that matter, no formulas.
//
// What this deliberately does NOT handle: shared strings, multiple sheets,
// dates stored as styled serials, formulas, zip64. If the client sends a
// spreadsheet that needs any of that, this returns nothing recognisable
// and ingest quarantines the file rather than half-reading it. That is the
// intended failure mode - see the shape check in scripts/ingest.js.
//
// Pure: takes a Buffer, returns rows. The caller does the file reading.

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;   // end of central directory
const CD_SIG = 0x02014b50;     // central directory file header

// Pulls one member out of a zip archive. Walks the central directory rather
// than scanning for local headers, because only the central directory is
// authoritative about compressed sizes.
export function readZipEntry(buf, wantedName) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const entries = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < entries; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CD_SIG) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    if (name === wantedName) {
      // The local header repeats the name and extra fields, and its extra
      // field length often differs from the central directory's, so it must
      // be read from the local header itself.
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);        // stored
      if (method === 8) return inflateRawSync(data);      // deflate
      return null;                                        // anything else: unsupported
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (m, e) =>
    e.charAt(0) === '#' ? String.fromCharCode(Number(e.slice(1))) : ENTITIES[e]);
}

// 'C12' -> 2. Cells can be skipped entirely when empty, so the column
// letter is the only reliable way to keep a row's fields aligned.
function columnIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

// Returns an array of arrays of strings, first row included. Missing cells
// come back as '' so every row has the same width as the header.
export function readSheetRows(buf, sheetPath = 'xl/worksheets/sheet1.xml') {
  const xml = readZipEntry(buf, sheetPath);
  if (xml === null) return [];
  const text = xml.toString('utf8');

  const rows = [];
  let width = 0;

  for (const rowMatch of text.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\s([^>]*?)\/?>([\s\S]*?)<\/c>|<c\s([^>]*?)\/>/g)) {
      const attrs = cellMatch[1] || cellMatch[3] || '';
      const body = cellMatch[2] || '';
      const refMatch = attrs.match(/r="([A-Z]+)\d+"/);
      const idx = refMatch ? columnIndex(refMatch[1]) : cells.length;

      // Inline string, or a plain numeric/boolean value.
      const inline = body.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
      const plain = body.match(/<v>([\s\S]*?)<\/v>/);
      const value = inline ? decodeXml(inline[1]) : plain ? decodeXml(plain[1]) : '';

      while (cells.length < idx) cells.push('');
      cells[idx] = value;
    }
    width = Math.max(width, cells.length);
    rows.push(cells);
  }

  for (const r of rows) while (r.length < width) r.push('');
  return rows;
}
