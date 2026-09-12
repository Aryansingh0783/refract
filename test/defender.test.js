'use strict';
const test = require('node:test');
const assert = require('node:assert');
const defender = require('../src/core/defender');

const SAMPLE = JSON.stringify([
  { at: new Date().toISOString(), id: 2147963166, action: 'True', files: ['file:_C:\\Users\\me\\AppData\\Roaming\\Refract\\dlss5\\1-Click-DLSS5-v3.0.2.zip'] },
  { at: new Date(Date.now() - 60000).toISOString(), id: 2147963166, action: 'True', files: ['file:_D:\\Steam\\steamapps\\common\\Cyberpunk 2077\\bin\\x64\\nvngx_dlssnr.dll'] },
  { at: new Date(Date.now() - 40 * 24 * 3600e3).toISOString(), id: 42, action: 'True', files: ['file:_C:\\old\\thing.exe'] },
]);
const fakeExec = (file, args, opts, cb) => cb(null, SAMPLE);
const only = process.platform === 'win32' ? test : test.skip;

only('detections are filtered to the paths asked about, and to recent ones', async () => {
  const all = await defender.detectionsFor([], { exec: fakeExec });
  assert.strictEqual(all.length, 2, 'the 40-day-old detection is out of the window');
  const game = await defender.detectionsFor(['D:\\Steam\\steamapps\\common\\Cyberpunk 2077'], { exec: fakeExec });
  assert.strictEqual(game.length, 1);
  assert.match(game[0].files[0], /nvngx_dlssnr\.dll$/, 'the resource prefix is stripped');
  assert.match(defender.explain(game), /Windows Defender removed nvngx_dlssnr\.dll/);
});

only('a machine without Defender, or a failing query, is simply empty', async () => {
  const boom = (f, a, o, cb) => cb(new Error('no such cmdlet'));
  assert.deepStrictEqual(await defender.detectionsFor(['x'], { exec: boom }), []);
  assert.strictEqual(defender.explain([]), null);
});

test('off Windows it returns nothing', async () => {
  if (process.platform === 'win32') return;
  assert.deepStrictEqual(await defender.detectionsFor(['x']), []);
});
