#!/usr/bin/env node
// Fixture self-test for scripts/check-req-coverage.mjs (the R-RELEASE-GATE check).
//
// Usage: node scripts/check-req-coverage.test.mjs
//
// Runs the gate as a black box (a child node process, exactly as CI invokes it)
// against inline fixtures written to a private temp dir that is removed
// afterwards. Plain assert, no dependencies, Node 16 compatible. Exits non-zero
// on the first failed case.

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), 'check-req-coverage.mjs');
const CONVENTION = '^(R-[A-Z0-9-]+)(, R-[A-Z0-9-]+)*: ';

const manifest = (requirements, extra = {}) => ({
  title_convention: CONVENTION,
  requirements,
  ...extra,
});
const req = (tag, method = 'Automated Test') => ({ tag, id: 1, title: `${tag} title`, method });
const BASE_REQS = [req('R-ALPHA'), req('R-BETA'), req('R-DEMO', 'Demonstration')];

// One Playwright JSON "test" (a spec run in one project).
const run = (project, statuses, expectedStatus = 'passed') => ({
  projectName: project,
  expectedStatus,
  results: statuses.map((status, retry) => ({ status, retry })),
});
const spec = (title, tests) => ({ title, tests });
// Playwright nests file suite -> describe suite -> specs.
const report = (specs, describe = 'Describe') => ({
  suites: [{ title: 'file.spec.js', specs: [], suites: [{ title: describe, specs, suites: [] }] }],
});
const GREEN_SPECS = [
  spec('R-ALPHA: alpha works', [run('chromium', ['passed']), run('firefox', ['passed'])]),
  spec('R-BETA, R-ALPHA: beta works', [run('chromium', ['passed'])]),
];

const dir = mkdtempSync(join(tmpdir(), 'req-coverage-selftest-'));
let n = 0;
const file = (data) => {
  const path = join(dir, `f${(n += 1)}.json`);
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data));
  return path;
};

function gate(reportData, manifestData = manifest(BASE_REQS)) {
  const args = [GATE];
  if (reportData !== undefined) args.push(reportData === null ? join(dir, 'missing.json') : file(reportData));
  if (reportData !== undefined) args.push(file(manifestData));
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const cases = [
  ['green report passes', () => {
    const r = gate(report(GREEN_SPECS));
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /GATE PASSED: all 2 /);
    assert.match(r.out, /skip {2}R-DEMO \(method: Demonstration/);
  }],
  ['missing tag exits 1 and names it', () => {
    const r = gate(report([GREEN_SPECS[0]]));
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /^ {2}- R-BETA: R-BETA title$/m);
    assert.doesNotMatch(r.out, /^ {2}- R-ALPHA/m);
  }],
  ['failed-only test does not count', () => {
    const r = gate(report([GREEN_SPECS[0], spec('R-BETA: beta', [run('chromium', ['failed', 'failed'])])]));
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /- R-BETA/);
  }],
  ['skipped and test.fail()-inverted tests do not count', () => {
    const r = gate(report([
      GREEN_SPECS[0],
      spec('R-BETA: skipped', [run('chromium', ['skipped'], 'skipped')]),
      spec('R-BETA: inverted', [run('chromium', ['passed'], 'failed')]),
    ]));
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /- R-BETA/);
  }],
  ['describe-only tag is not counted', () => {
    const r = gate(report([GREEN_SPECS[0], spec('beta works', [run('chromium', ['passed'])])], 'R-BETA: Describe'));
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /- R-BETA/);
  }],
  ['pass on retry is counted', () => {
    const r = gate(report([GREEN_SPECS[0], spec('R-BETA: flaky', [run('chromium', ['failed', 'passed'])])]));
    assert.strictEqual(r.code, 0, r.out);
  }],
  ['pass in one project only is counted', () => {
    const r = gate(report([GREEN_SPECS[0], spec('R-BETA: b', [run('firefox', ['failed']), run('chromium', ['passed'])])]));
    assert.strictEqual(r.code, 0, r.out);
  }],
  ['near-miss title warns but does not count', () => {
    const r = gate(report([GREEN_SPECS[0], spec('R-BETA:no space after colon', [run('chromium', ['passed'])])]));
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /^warn: title looks tagged but does not parse: "R-BETA"$/m);
  }],
  ['echoed manifest text is sanitized', () => {
    const evil = { ...req('R-BETA'), title: 'x\n::error::pwned ##[error]bad ‮evil' };
    const r = gate(report([GREEN_SPECS[0]]), manifest([req('R-ALPHA'), evil]));
    assert.strictEqual(r.code, 1, r.out);
    assert.doesNotMatch(r.out, /^::/m);
    assert.doesNotMatch(r.out, /##\[/);
    assert.doesNotMatch(r.out, /‮/);
  }],
  ['missing report exits 2', () => {
    const r = gate(null);
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, /CANNOT EVALUATE - Playwright JSON report not readable/);
  }],
  ['no arguments exits 2', () => {
    assert.strictEqual(gate(undefined).code, 2);
  }],
  ['non-Playwright report exits 2', () => {
    assert.strictEqual(gate({ stale: true }).code, 2);
  }],
  ['report with no tests exits 2', () => {
    assert.strictEqual(gate(report([])).code, 2);
  }],
  ['malformed manifest exits 2', () => {
    const r = gate(report(GREEN_SPECS), '{ "requirements": [ {"tag": ');
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, /requirements manifest .* is not valid JSON/);
  }],
  ['unknown method exits 2 (incl. case and whitespace variants)', () => {
    for (const method of ['Automated test', 'Automated Test ', 'Vibes', '']) {
      const r = gate(report(GREEN_SPECS), manifest([req('R-ALPHA'), req('R-BETA', method)]));
      assert.strictEqual(r.code, 2, `${JSON.stringify(method)}: ${r.out}`);
      assert.match(r.out, /unknown verification method/);
    }
  }],
  ['every allowed method is accepted', () => {
    const others = ['Code Review', 'Demonstration', 'Inspection', 'Manual Test'];
    const r = gate(report(GREEN_SPECS), manifest([req('R-ALPHA'), req('R-BETA'), ...others.map((m, i) => req(`R-O${i}`, m))]));
    assert.strictEqual(r.code, 0, r.out);
  }],
  ['bad title convention exits 2', () => {
    const r = gate(report(GREEN_SPECS), manifest(BASE_REQS, { title_convention: '^.*' }));
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, /title_convention/);
  }],
  ['duplicate tag exits 2', () => {
    const r = gate(report(GREEN_SPECS), manifest([...BASE_REQS, req('R-ALPHA')]));
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, /lists R-ALPHA more than once/);
  }],
  ['invalid tag exits 2', () => {
    assert.strictEqual(gate(report(GREEN_SPECS), manifest([req('r-alpha')])).code, 2);
  }],
  ['manifest with no Automated Test requirement exits 2', () => {
    assert.strictEqual(gate(report(GREEN_SPECS), manifest([req('R-DEMO', 'Demonstration')])).code, 2);
  }],
];

let failed = 0;
try {
  for (const [name, fn] of cases) {
    try {
      fn();
      console.log(`ok    ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${name}\n${err.message}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${cases.length - failed}/${cases.length} gate self-test cases passed`);
process.exit(failed === 0 ? 0 : 1);
