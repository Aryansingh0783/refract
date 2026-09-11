'use strict';
// Order-preserving INI editor. Keeps comments, unknown keys and section order intact,
// so we can change a couple of ReShade keys without rewriting the user's config.

function parse(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const sections = [{ name: '', lines: [] }];
  for (const line of lines) {
    const m = /^\s*\[([^\]]*)\]\s*$/.exec(line);
    if (m) sections.push({ name: m[1], lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return { sections };
}

function keyOf(line) {
  const m = /^\s*([^=;#\[][^=]*?)\s*=/.exec(line);
  return m ? m[1] : null;
}

function get(doc, section, key) {
  const sec = doc.sections.find(s => s.name.toLowerCase() === section.toLowerCase());
  if (!sec) return undefined;
  for (const line of sec.lines) {
    const k = keyOf(line);
    if (k && k.toLowerCase() === key.toLowerCase()) return line.slice(line.indexOf('=') + 1).trim();
  }
  return undefined;
}

function set(doc, section, key, value) {
  let sec = doc.sections.find(s => s.name.toLowerCase() === section.toLowerCase());
  if (!sec) {
    const last = doc.sections[doc.sections.length - 1];
    if (last.lines.length && last.lines[last.lines.length - 1].trim() !== '') last.lines.push('');
    sec = { name: section, lines: [] };
    doc.sections.push(sec);
  }
  const idx = sec.lines.findIndex(l => { const k = keyOf(l); return k && k.toLowerCase() === key.toLowerCase(); });
  const line = `${key}=${value}`;
  if (idx >= 0) sec.lines[idx] = line;
  else {
    // insert before trailing blank lines so sections stay visually grouped
    let at = sec.lines.length;
    while (at > 0 && sec.lines[at - 1].trim() === '') at--;
    sec.lines.splice(at, 0, line);
  }
  return doc;
}

function stringify(doc) {
  const out = [];
  doc.sections.forEach((s, i) => {
    if (i > 0 || s.name) out.push(`[${s.name}]`);
    out.push(...s.lines);
  });
  let text = out.join('\r\n');
  if (!text.endsWith('\r\n')) text += '\r\n';
  return text;
}

module.exports = { parse, get, set, stringify };
