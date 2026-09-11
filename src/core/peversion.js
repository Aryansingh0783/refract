'use strict';
// Reads the VS_FIXEDFILEINFO file version from a Windows PE file (DLL/EXE)
// without loading the whole file: headers + the resource section only.
const fs = require('fs');

const RT_VERSION = 16;
const FIXED_SIG = 0xfeef04bd;
const NUL = String.fromCharCode(0);

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const got = fs.readSync(fd, buf, 0, len, pos);
  return got === len ? buf : buf.subarray(0, got);
}

function getFileVersion(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const dos = readAt(fd, 0, 64);
    if (dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'
    const peOff = dos.readUInt32LE(0x3c);
    const hdr = readAt(fd, peOff, 24 + 240);
    if (hdr.length < 24 + 128 || hdr.readUInt32LE(0) !== 0x00004550) return null; // 'PE' 0 0
    const numSections = hdr.readUInt16LE(6);
    const optSize = hdr.readUInt16LE(20);
    const opt = 24;
    const magic = hdr.readUInt16LE(opt);
    const ddBase = opt + (magic === 0x20b ? 112 : 96);
    const resRva = hdr.readUInt32LE(ddBase + 2 * 8);
    const resSize = hdr.readUInt32LE(ddBase + 2 * 8 + 4);
    if (!resRva || !resSize) return null;

    const secTable = readAt(fd, peOff + 24 + optSize, numSections * 40);
    const sections = [];
    for (let i = 0; i < numSections; i++) {
      const b = i * 40;
      sections.push({
        va: secTable.readUInt32LE(b + 12),
        vsize: Math.max(secTable.readUInt32LE(b + 8), secTable.readUInt32LE(b + 16)),
        raw: secTable.readUInt32LE(b + 20),
      });
    }
    const toOff = rva => {
      const s = sections.find(x => rva >= x.va && rva < x.va + x.vsize);
      return s ? rva - s.va + s.raw : -1;
    };
    const resOff = toOff(resRva);
    if (resOff < 0) return null;
    const res = readAt(fd, resOff, Math.min(resSize, 64 * 1024 * 1024));

    const entries = dirOff => {
      if (dirOff + 16 > res.length) return [];
      const named = res.readUInt16LE(dirOff + 12);
      const ids = res.readUInt16LE(dirOff + 14);
      const list = [];
      for (let i = 0; i < named + ids; i++) {
        const e = dirOff + 16 + i * 8;
        if (e + 8 > res.length) break;
        list.push({ id: res.readUInt32LE(e), off: res.readUInt32LE(e + 4) });
      }
      return list;
    };
    const typeEntry = entries(0).find(e => e.id === RT_VERSION);
    if (!typeEntry || !(typeEntry.off & 0x80000000)) return null;
    const nameEntry = entries(typeEntry.off & 0x7fffffff)[0];
    if (!nameEntry || !(nameEntry.off & 0x80000000)) return null;
    const langEntry = entries(nameEntry.off & 0x7fffffff)[0];
    if (!langEntry || (langEntry.off & 0x80000000)) return null;
    const dataRva = res.readUInt32LE(langEntry.off);
    const dataSize = res.readUInt32LE(langEntry.off + 4);
    const dataOff = toOff(dataRva);
    if (dataOff < 0) return null;
    const data = readAt(fd, dataOff, Math.min(dataSize, 65536));

    for (let i = 0; i + 16 <= data.length; i += 4) {
      if (data.readUInt32LE(i) === FIXED_SIG) {
        const ms = data.readUInt32LE(i + 8);
        const ls = data.readUInt32LE(i + 12);
        const parts = [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff];
        return { parts, text: parts.join('.'), strings: readStrings(data) };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// Pull a few well-known StringFileInfo values (UTF-16LE key, NUL padding, value).
function readStrings(data) {
  const out = {};
  const text = data.toString('utf16le');
  for (const key of ['ProductName', 'FileDescription', 'OriginalFilename', 'CompanyName']) {
    const i = text.indexOf(key + NUL);
    if (i < 0) continue;
    let j = i + key.length + 1;
    while (j < text.length && text[j] === NUL) j++;
    const end = text.indexOf(NUL, j);
    if (end > j) out[key] = text.slice(j, end);
  }
  return out;
}

function compare(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

module.exports = { getFileVersion, compare };
