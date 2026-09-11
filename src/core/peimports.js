'use strict';
// Reads a PE's machine word (32/64-bit) and its imported DLL names, so Refract can pick the
// right ReShade proxy (dxgi/d3d9/opengl32/vulkan) the way the game's renderer actually hooks.
const fs = require('fs');
const path = require('path');

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return n === len ? b : b.subarray(0, n);
}

function open(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const dos = readAt(fd, 0, 64);
    if (dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) return null;
    const peOff = dos.readUInt32LE(0x3c);
    const coff = readAt(fd, peOff, 24);
    if (coff.readUInt32LE(0) !== 0x00004550) return null;
    const machine = coff.readUInt16LE(4);
    const numSections = coff.readUInt16LE(6);
    const optSize = coff.readUInt16LE(20);
    const opt = readAt(fd, peOff + 24, optSize);
    const magic = opt.readUInt16LE(0);
    const bitness = magic === 0x20b ? 64 : magic === 0x10b ? 32 : (machine === 0x8664 || machine === 0xaa64 ? 64 : 32);
    const ddBase = magic === 0x20b ? 112 : 96;
    const importRva = opt.length >= ddBase + 8 ? opt.readUInt32LE(ddBase) : 0;
    const sec = readAt(fd, peOff + 24 + optSize, numSections * 40);
    const sections = [];
    for (let i = 0; i < numSections; i++) {
      const b = i * 40;
      sections.push({ va: sec.readUInt32LE(b + 12), vsize: Math.max(sec.readUInt32LE(b + 8), sec.readUInt32LE(b + 16)), raw: sec.readUInt32LE(b + 20) });
    }
    const toOff = rva => { const s = sections.find(x => rva >= x.va && rva < x.va + x.vsize); return s ? rva - s.va + s.raw : -1; };
    return { fd, bitness, importRva, toOff, close: () => { try { fs.closeSync(fd); } catch {} } };
  } catch { try { fs.closeSync(fd); } catch {} return null; }
}

function getBitness(file) {
  const h = open(file);
  if (!h) return null;
  const b = h.bitness; h.close(); return b;
}

function readCString(fd, off) {
  let s = '', pos = off;
  while (s.length < 256) {
    const b = readAt(fd, pos, 32);
    if (!b.length) break;
    const z = b.indexOf(0);
    if (z >= 0) { s += b.subarray(0, z).toString('latin1'); break; }
    s += b.toString('latin1'); pos += 32;
  }
  return s;
}

function imports(file) {
  const h = open(file);
  if (!h) return [];
  const names = [];
  try {
    const off = h.importRva ? h.toOff(h.importRva) : -1;
    if (off >= 0) {
      for (let i = 0; i < 4096; i++) {
        const e = readAt(h.fd, off + i * 20, 20);
        if (e.length < 20) break;
        const nameRva = e.readUInt32LE(12);
        if (nameRva === 0 && e.readUInt32LE(0) === 0 && e.readUInt32LE(16) === 0) break;
        if (nameRva === 0) continue;
        const nOff = h.toOff(nameRva);
        if (nOff >= 0) { const n = readCString(h.fd, nOff).toLowerCase(); if (n) names.push(n); }
      }
    }
  } catch {}
  h.close();
  return names;
}

// Map imported DLLs to a render API. dxgi covers DX10/11/12 (ReShade's shared hook).
// `dx` is 11 or 12 when known — DLSS 5 routing needs that distinction.
function detectApi(file) {
  const imp = imports(file);
  const has = n => imp.some(x => x === n || x.startsWith(n.replace('.dll', '.')));
  if (has('vulkan-1.dll')) return { api: 'vulkan', label: 'Vulkan', dx: null };
  if (has('d3d12.dll')) return { api: 'dxgi', label: 'DirectX 12', dx: 12 };
  if (has('d3d11.dll')) return { api: 'dxgi', label: 'DirectX 11', dx: 11 };
  if (has('dxgi.dll')) return { api: 'dxgi', label: 'DirectX 11/12', dx: null };
  if (has('d3d10.dll') || has('d3d10_1.dll')) return { api: 'dxgi', label: 'DirectX 10', dx: null };
  if (has('d3d9.dll')) return { api: 'd3d9', label: 'DirectX 9', dx: null };
  if (has('opengl32.dll')) return { api: 'opengl', label: 'OpenGL', dx: null };
  if (has('d3d8.dll')) return { api: 'd3d8', label: 'DirectX 8', dx: null };
  if (has('ddraw.dll')) return { api: 'ddraw', label: 'DirectDraw', dx: null };
  return { api: null, label: null, dx: null };
}

// Modern games almost never import d3d12/dxgi from the executable — they LoadLibrary it, so
// the import table alone reports "unknown" for most real titles. Fall back to the Agility
// SDK marker (D3D12Core.dll, which DX12 games ship next to the exe or in a D3D12/ folder)
// and then to the engine DLLs sitting beside the executable.
const AGILITY = ['D3D12Core.dll', 'D3D12/D3D12Core.dll', 'D3D12/d3d12core.dll', 'd3d12on7/D3D12Core.dll'];
function detectApiDeep(exe) {
  const direct = detectApi(exe);
  if (direct.dx) return { ...direct, via: 'imports' };
  const dir = path.dirname(exe);
  for (const m of AGILITY) {
    if (fs.existsSync(path.join(dir, m.replace(/\//g, path.sep)))) {
      return { api: 'dxgi', label: 'DirectX 12', dx: 12, via: 'agility-sdk' };
    }
  }
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /\.dll$/i.test(n)); } catch {}
  let d11 = false, vk = false;
  for (const n of names.slice(0, 160)) {
    let imp = [];
    try { imp = imports(path.join(dir, n)); } catch { continue; }
    if (imp.includes('d3d12.dll')) return { api: 'dxgi', label: 'DirectX 12', dx: 12, via: 'engine-dll:' + n };
    if (imp.includes('d3d11.dll')) d11 = true;
    if (imp.includes('vulkan-1.dll')) vk = true;
  }
  if (d11) return { api: 'dxgi', label: 'DirectX 11', dx: 11, via: 'engine-dll' };
  if (vk) return { api: 'vulkan', label: 'Vulkan', dx: null, via: 'engine-dll' };
  // Last resort: games LoadLibrary("d3d12.dll") by name, so the literal is in the binary
  // even when nothing imports it. Bounded scan so a 400 MB exe cannot stall a library scan.
  const hits = findAscii(exe, ['d3d12.dll', 'd3d11.dll', 'vulkan-1.dll']);
  if (hits.has('d3d12.dll')) return { api: 'dxgi', label: 'DirectX 12', dx: 12, via: 'strings' };
  if (hits.has('d3d11.dll')) return { api: 'dxgi', label: 'DirectX 11', dx: 11, via: 'strings' };
  if (hits.has('vulkan-1.dll')) return { api: 'vulkan', label: 'Vulkan', dx: null, via: 'strings' };
  return { ...direct, via: 'unknown' };
}

// Streaming ASCII search with chunk overlap, capped so huge executables stay cheap.
function findAscii(file, needles, maxBytes = 96 * 1024 * 1024) {
  const found = new Set();
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return found; }
  try {
    const cap = Math.min(fs.fstatSync(fd).size, maxBytes);
    const CH = 4 * 1024 * 1024;
    const buf = Buffer.alloc(CH);
    const pats = needles.map(n => Buffer.from(n, 'latin1'));
    let pos = 0, prev = Buffer.alloc(0);
    while (pos < cap && found.size < needles.length) {
      const n = fs.readSync(fd, buf, 0, Math.min(CH, cap - pos), pos);
      if (n <= 0) break;
      const hay = prev.length ? Buffer.concat([prev, buf.subarray(0, n)]) : buf.subarray(0, n);
      pats.forEach((p, i) => { if (!found.has(needles[i]) && hay.includes(p)) found.add(needles[i]); });
      prev = Buffer.from(hay.subarray(Math.max(0, hay.length - 32)));
      pos += n;
    }
  } catch {} finally { try { fs.closeSync(fd); } catch {} }
  return found;
}

// The ReShade proxy filename for an API (Vulkan uses a layer, not a proxy).
function proxyName(api) {
  switch (api) {
    case 'd3d9': return 'd3d9.dll';
    case 'd3d8': return 'd3d8.dll';
    case 'ddraw': return 'ddraw.dll';
    case 'opengl': return 'opengl32.dll';
    default: return 'dxgi.dll';
  }
}

module.exports = { getBitness, imports, detectApi, detectApiDeep, proxyName };
