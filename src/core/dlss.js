'use strict';
const fs = require('fs');
const path = require('path');
const { getFileVersion } = require('./peversion');
const { DLSS_RE } = require('./library');

// Refract never ships NVIDIA binaries. The user points at a DLL they obtained
// (NVIDIA's DLSS SDK / Streamline release, or another game), we validate it,
// back up the game's copy once, and swap. Restore puts the original back.

const SUFFIX = '.refract-backup';

function describe(file) {
  const v = getFileVersion(file);
  if (!v) throw new Error('Not a valid Windows DLL (no version resource).');
  return { version: v.text, description: v.strings.FileDescription || '', company: v.strings.CompanyName || '',
    original: v.strings.OriginalFilename || '' };
}

async function swap(targetPath, sourcePath) {
  const tName = path.basename(targetPath);
  const sName = path.basename(sourcePath);
  if (!DLSS_RE.test(tName)) throw new Error('Target is not a DLSS runtime DLL.');
  if (tName.toLowerCase() !== sName.toLowerCase()) {
    throw new Error(`File name mismatch: game uses ${tName}, you picked ${sName}. Pick the same runtime.`);
  }
  const src = describe(sourcePath);
  if (src.company && !/nvidia/i.test(src.company)) throw new Error(`Refusing: DLL publisher is "${src.company}", not NVIDIA.`);
  const backup = targetPath + SUFFIX;
  try { await fs.promises.access(backup); } catch { await fs.promises.copyFile(targetPath, backup); }
  await fs.promises.copyFile(sourcePath, targetPath);
  const after = getFileVersion(targetPath);
  return { file: tName, version: after ? after.text : null, backup };
}

async function restore(targetPath) {
  const backup = targetPath + SUFFIX;
  await fs.promises.access(backup);
  await fs.promises.copyFile(backup, targetPath);
  await fs.promises.unlink(backup);
  const v = getFileVersion(targetPath);
  return { file: path.basename(targetPath), version: v ? v.text : null };
}

function explain(err) {
  if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return 'Windows blocked the write. Close the game, or run Refract as administrator for games under Program Files.';
  if (err && err.code === 'EBUSY') return 'The DLL is in use. Close the game and try again.';
  return err ? err.message : 'Unknown error';
}

module.exports = { swap, restore, describe, explain, SUFFIX };
