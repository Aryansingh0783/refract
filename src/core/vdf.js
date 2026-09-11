'use strict';
// Minimal parser for Valve's text KeyValues format (libraryfolders.vdf, appmanifest_*.acf).
// Supports quoted and bare tokens, nested blocks, // comments and escaped characters.

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '{' || c === '}') { tokens.push(c); i++; continue; }
    if (c === '"') {
      let s = '';
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const e = text[i + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else { s += text[i++]; }
      }
      i++; // closing quote
      tokens.push({ s });
      continue;
    }
    let s = '';
    while (i < n && !/[\s{}"]/.test(text[i])) s += text[i++];
    tokens.push({ s });
  }
  return tokens;
}

function parse(text) {
  const tokens = tokenize(String(text).replace(/^﻿/, ''));
  let p = 0;
  function block() {
    const obj = {};
    while (p < tokens.length) {
      const t = tokens[p];
      if (t === '}') { p++; return obj; }
      if (typeof t !== 'object') { p++; continue; }
      const key = t.s;
      p++;
      const v = tokens[p];
      if (v === '{') { p++; obj[key] = block(); }
      else if (v && typeof v === 'object') { obj[key] = v.s; p++; }
      else { obj[key] = ''; }
    }
    return obj;
  }
  return block();
}

module.exports = { parse };
