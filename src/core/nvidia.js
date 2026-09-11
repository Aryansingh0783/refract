'use strict';
const { execFile, spawn } = require('child_process');
const { compare } = require('./peversion');

// Driver the tool was built and tested against.
const TESTED_DRIVER = '616.92';

const INFO_FIELDS = ['name', 'driver_version', 'power.limit', 'power.max_limit', 'memory.total'];
const LIVE_FIELDS = ['power.draw', 'power.limit', 'utilization.gpu', 'temperature.gpu',
  'clocks.gr', 'memory.used', 'memory.total', 'pstate'];

function smiPath() {
  return process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi';
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// DLSS 5 neural rendering ships enabled only on Blackwell (RTX 50). Ampere and Ada (RTX 30/40)
// run it with the universal 310.8 runtime Refract bundles: it carries sm_86/sm_89 kernels and
// its architecture gate accepts 0x170/0x190. Turing (RTX 20, 0x160) is refused by that same
// gate in every known build, so it is reported as unsupported rather than promised.
const ARCH = { 20: 'Turing', 30: 'Ampere', 40: 'Ada Lovelace', 50: 'Blackwell' };
function gpuGeneration(name) {
  const m = /\bRTX\s*(\d{4})\b/i.exec(name || '');
  if (!m) return { family: /\bGTX\b/i.test(name || '') ? 'gtx' : null, model: null, series: null, arch: null };
  const model = Number(m[1]);
  const series = Math.floor(model / 1000) * 10; // 3060 -> 30
  return { family: 'rtx', model, series, arch: ARCH[series] || null };
}

// 'native' = works as shipped; 'patch' = needs the universal neural-rendering runtime;
// 'unsupported' = cannot run DLSS 5 neural rendering (GTX, RTX 20 and older).
function dlss5Support(gen) {
  if (gen.family !== 'rtx' || !gen.series) return 'unsupported';
  if (gen.series >= 50) return 'native';
  if (gen.series >= 30) return 'patch';
  return 'unsupported';
}

function parseInfo(line) {
  const [name, driver, plimit, pmax, mem] = line.split(',').map(s => s.trim());
  const gen = gpuGeneration(name);
  const dlss5 = dlss5Support(gen);
  const cmp = compare(driver, TESTED_DRIVER);
  return {
    name, driver,
    powerLimit: num(plimit), powerMax: num(pmax), memoryTotal: num(mem),
    model: gen.model, series: gen.series, arch: gen.arch,
    rtx50: gen.series === 50,
    dlss5,
    // Honest expectation setting: neural rendering on pre-Blackwell is heavy.
    dlss5Note: dlss5 === 'patch'
      ? `DLSS 5 neural rendering is not enabled for ${gen.arch || 'this card'} by default. Refract's universal runtime runs it, but expect a large frame-rate cost on RTX ${gen.series} series.`
      : gen.series === 20
        ? 'RTX 20 (Turing) cannot run DLSS 5 neural rendering: every available runtime refuses the Turing architecture.'
        : null,
    driverStatus: cmp === 0 ? 'tested' : cmp > 0 ? 'newer' : 'older',
    testedDriver: TESTED_DRIVER,
  };
}

function parseLive(line) {
  const [draw, limit, util, temp, clock, used, total, pstate] = line.split(',').map(s => s.trim());
  const s = {
    powerDraw: num(draw), powerLimit: num(limit), util: num(util), temp: num(temp),
    clock: num(clock), memUsed: num(used), memTotal: num(total), pstate,
  };
  // DLSS 5 neural rendering is reported to pin cards at their power limit. Flag it
  // when draw sits within 4% of the limit under heavy load.
  s.powerLimited = s.powerDraw != null && s.powerLimit != null && s.util != null
    && s.util >= 90 && s.powerDraw >= s.powerLimit * 0.96;
  return s;
}

function getInfo() {
  return new Promise(resolve => {
    execFile(smiPath(), ['--query-gpu=' + INFO_FIELDS.join(','), '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        if (err || !stdout.trim()) return resolve({ available: false, error: err ? err.message : 'no output', testedDriver: TESTED_DRIVER });
        const gpus = stdout.trim().split(/\r?\n/).map(parseInfo);
        const gpu = gpus.find(g => /nvidia|geforce|rtx/i.test(g.name)) || gpus[0];
        resolve({ available: true, ...gpu, gpus });
      });
  });
}

// One long-lived nvidia-smi process sampling once per interval; cheaper than polling.
function watch(onSample, intervalMs = 1000) {
  const p = spawn(smiPath(), ['-i', '0', '--query-gpu=' + LIVE_FIELDS.join(','), '--format=csv,noheader,nounits',
    '-lms', String(intervalMs)], { windowsHide: true });
  let buf = '';
  p.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onSample(parseLive(line.split(/\r?\n/)[0]));
    }
  });
  p.on('error', () => onSample(null));
  return () => { try { p.kill(); } catch {} };
}

module.exports = { getInfo, watch, parseInfo, parseLive, gpuGeneration, dlss5Support, TESTED_DRIVER };
