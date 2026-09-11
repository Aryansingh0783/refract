// Real display tier round-trip: switches to the Balanced tier for 2.5 s, then restores native.
//   node verify/display-live.js
const { WinHelper } = require('../src/core/winhelper');
const { Session } = require('../src/core/session');
const w = new WinHelper();
let data = { nativeMode: null };
const store = { get: () => data, patch: p => (data = { ...data, ...p }), game: () => ({}) };
const s = new Session(w, store, () => {});
(async () => {
  const before = await w.call('current');
  const applied = await s.applyTier('balanced');
  const during = await w.call('current');
  await new Promise(r => setTimeout(r, 2500));
  await s.restore();
  const after = await w.call('current');
  const restored = after.width === before.width && after.height === before.height && after.hz === before.hz;
  console.log(JSON.stringify({ before, applied, during, after, restored }));
  w.stop();
  process.exit(restored && during.width === applied.width ? 0 : 1);
})().catch(e => { console.error(e); w.stop(); process.exit(1); });
