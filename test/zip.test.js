'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zip, crc32 } = require('../src/core/zip');

test('the zip writer produces an archive real tools can read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-zip-'));
  const big = 'log line\n'.repeat(5000);
  const buf = zip([
    { name: 'report.json', data: JSON.stringify({ hello: 'world' }) },
    { name: 'logs/ReShade.log', data: big },
    { name: 'tiny.txt', data: 'x' },
  ]);
  const file = path.join(dir, 'bundle.zip');
  fs.writeFileSync(file, buf);
  assert.ok(buf.length < big.length / 5, 'the log compresses');
  const read = unzipPure(buf);
  assert.deepStrictEqual(Object.keys(read).sort(), ['logs/ReShade.log', 'report.json', 'tiny.txt']);
  assert.strictEqual(read['logs/ReShade.log'].toString('utf8'), big);
  assert.deepStrictEqual(JSON.parse(read['report.json'].toString('utf8')), { hello: 'world' });
  // and, where the OS has one, a real unzip agrees
  let real = null;
  try { real = cp.execFileSync('unzip', ['-l', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
  if (real) for (const n of ['report.json', 'logs/ReShade.log', 'tiny.txt']) assert.match(real, new RegExp(n.replace('/', '\\/')));
  fs.rmSync(dir, { recursive: true, force: true });
});

// A minimal reader, so the writer is checked on every platform, not only where unzip exists.
function unzipPure(buf) {
  const zlib = require('zlib');
  const out = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const comp = buf.readUInt32LE(i + 18), raw = buf.readUInt32LE(i + 22);
    const nameLen = buf.readUInt16LE(i + 26), extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    const body = buf.slice(start, start + comp);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    assert.strictEqual(data.length, raw, 'declared size matches');
    out[name] = data;
    i = start + comp;
  }
  assert.strictEqual(buf.readUInt32LE(i), 0x02014b50, 'central directory follows the entries');
  return out;
}

test('crc32 matches the known value for "123456789"', () => {
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
});
