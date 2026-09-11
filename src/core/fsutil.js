'use strict';
const fs = require('fs');
const path = require('path');

// Bounded async directory walk. Game folders can hold 100k+ files, so we cap depth,
// skip asset folders that never hold DLSS runtimes, and stop after maxEntries.
const SKIP = new Set(['__overlay', 'redist', '_commonredist', 'directx', 'vcredist', 'movies',
  'content', 'paks', 'textures', 'shadercache', 'logs', 'saves', 'screenshots', '.git']);

async function walk(root, { maxDepth = 5, maxEntries = 40000, match } = {}) {
  const hits = [];
  let seen = 0;
  async function rec(dir, depth) {
    if (depth > maxDepth || seen > maxEntries) return;
    let list;
    try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      if (++seen > maxEntries) return;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP.has(d.name.toLowerCase())) await rec(p, depth + 1);
      } else if (match(d.name, p)) hits.push(p);
    }
  }
  await rec(root, 0);
  return hits;
}

async function exists(p) {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

module.exports = { walk, exists };
