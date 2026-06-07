#!/usr/bin/env node
// ecc.parity.v1 verdict — assert per-side contract effects, then cross-side
// normalized equivalence. Exit 0 = parity holds for the scenario.
'use strict';
const fs = require('fs');
const path = require('path');
const { normalize } = require('./normalize');

const [scenarioPath, sandbox] = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
}

function read(side, file) {
  const p = path.join(sandbox, side, 'collected', file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
function norm(side, content) {
  return content === null ? null : normalize(content, path.join(sandbox, side));
}

// ---- layer 1: per-side effect assertions (from scenario.checks) ----
for (const side of ['cc', 'oc']) {
  for (const check of scenario.checks || []) {
    const content = read(side, check.file);
    if (content === null) {
      record(`${side}:${check.file}:exists`, false, 'file missing');
      continue;
    }
    record(`${side}:${check.file}:exists`, true);
    for (const needle of check.must_contain || []) {
      record(`${side}:${check.file}:contains "${needle}"`, content.includes(needle));
    }
    for (const pattern of check.must_match || []) {
      record(`${side}:${check.file}:matches ${pattern}`, new RegExp(pattern, 'm').test(content));
    }
  }
}

// ---- layer 2: cross-side normalized equivalence ----
for (const eq of scenario.equivalence || []) {
  const a = norm('cc', read('cc', eq.file));
  const b = norm('oc', read('oc', eq.file));
  if (a === null || b === null) {
    record(`parity:${eq.file}`, a === b, a === null && b === null ? 'absent on both (ok)' : 'present on one side only');
    continue;
  }
  if (eq.mode === 'exact') {
    record(`parity:${eq.file}:exact`, a.trim() === b.trim(), a.trim() === b.trim() ? '' : 'normalized content differs');
  } else if (eq.mode === 'lines') {
    // same multiset of normalized lines (order-insensitive append logs)
    const sortLines = s => s.trim().split('\n').map(l => l.trim()).filter(Boolean).sort().join('\n');
    record(`parity:${eq.file}:lines`, sortLines(a) === sortLines(b));
  } else if (eq.mode === 'json-keys') {
    try {
      const ja = JSON.parse(read('cc', eq.file));
      const jb = JSON.parse(read('oc', eq.file));
      const missing = (eq.keys || []).filter(k => !(k in ja) || !(k in jb));
      record(`parity:${eq.file}:json-keys`, missing.length === 0, missing.length ? `missing: ${missing}` : '');
      for (const k of eq.equal_keys || []) {
        record(`parity:${eq.file}:json[${k}]`, JSON.stringify(ja[k]) === JSON.stringify(jb[k]),
          `cc=${JSON.stringify(ja[k])} oc=${JSON.stringify(jb[k])}`);
      }
    } catch (e) {
      record(`parity:${eq.file}:json-keys`, false, `parse error: ${e.message}`);
    }
  }
}

// ---- report ----
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
}
console.log(`\n[e2e] ${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
