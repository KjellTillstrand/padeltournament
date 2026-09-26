#!/usr/bin/env node
// Release gate: requirement coverage (R-RELEASE-GATE, AB#18).
//
// Usage: node scripts/check-req-coverage.mjs <playwright-json-report> [manifest]
//   manifest defaults to docs/requirements-manifest.json (resolved from the repo root).
//
// Passes (exit 0) only when every manifest requirement whose method is
// "Automated Test" has at least one passing test whose OWN title (not its
// describe path) carries that requirement's tag, per the manifest title
// convention: "R-TAG: <scenario>" or "R-A, R-B: <scenario>". A test passing in
// at least one browser project counts.
//
// Exit codes:
//   0  every Automated Test requirement is covered by a passing test
//   1  one or more requirements lack a passing test (each one is named)
//   2  the gate could not read or trust its inputs (missing/unparsable report or
//      manifest, unexpected shape, unknown title convention). A gate that
//      cannot read its inputs never passes.
//
// Requirements with any other verification method are listed as informational
// skips. R-RELEASE-GATE itself is deliberately NOT in the manifest: this gate is
// process-verified by its own falsification evidence (a run shown to fail and
// name an uncovered tag), not by a Playwright test.
//
// Both inputs are treated as untrusted data: they are parsed as JSON only,
// never evaluated, the manifest's regex is compared as a string (never
// compiled), and every string echoed to the log has control characters
// stripped so it cannot inject CI workflow commands or terminal escapes.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = resolve(REPO_ROOT, 'docs/requirements-manifest.json');

// The only title convention this gate implements. If the manifest declares a
// different one, the gate refuses to judge rather than silently mis-parse.
const SUPPORTED_CONVENTION = '^(R-[A-Z0-9-]+)(, R-[A-Z0-9-]+)*: ';
const TAG_RE = /^R-[A-Z0-9-]+$/;
const AUTOMATED = 'Automated Test';

const EXIT_UNCOVERED = 1;
const EXIT_BAD_INPUT = 2;

function clean(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 200);
}

function inputError(message) {
  console.error(`REQUIREMENT COVERAGE GATE: CANNOT EVALUATE - ${message}`);
  console.error('Release blocked: the gate never passes when it cannot read its inputs.');
  process.exit(EXIT_BAD_INPUT);
}

function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    inputError(`${label} not readable at ${clean(path)} (${clean(err.code || err.message)})`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    inputError(`${label} at ${clean(path)} is not valid JSON (${clean(err.message)})`);
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadManifest(path) {
  const manifest = readJson(path, 'requirements manifest');
  if (!isObject(manifest)) inputError('manifest is not a JSON object');
  if (manifest.title_convention !== SUPPORTED_CONVENTION) {
    inputError(
      `manifest title_convention ${JSON.stringify(clean(manifest.title_convention))} ` +
        `is not the one this gate implements (${JSON.stringify(SUPPORTED_CONVENTION)})`,
    );
  }
  if (!Array.isArray(manifest.requirements) || manifest.requirements.length === 0) {
    inputError('manifest has no "requirements" array');
  }
  const seen = new Set();
  for (const [i, req] of manifest.requirements.entries()) {
    if (!isObject(req)) inputError(`manifest requirement #${i} is not an object`);
    if (typeof req.tag !== 'string' || !TAG_RE.test(req.tag)) {
      inputError(`manifest requirement #${i} has an invalid tag ${JSON.stringify(clean(req.tag))}`);
    }
    if (typeof req.method !== 'string' || req.method === '') {
      inputError(`manifest requirement ${req.tag} has no verification method`);
    }
    if (seen.has(req.tag)) inputError(`manifest lists ${req.tag} more than once`);
    seen.add(req.tag);
  }
  const automated = manifest.requirements.filter((r) => r.method === AUTOMATED);
  if (automated.length === 0) {
    inputError(`manifest has no "${AUTOMATED}" requirements - nothing to gate on`);
  }
  return manifest.requirements;
}

// Tags a test title claims, or [] when the title does not follow the convention.
function tagsOf(title) {
  if (typeof title !== 'string') return [];
  const sep = title.indexOf(': ');
  if (sep <= 0) return [];
  const tags = title.slice(0, sep).split(', ');
  return tags.every((t) => TAG_RE.test(t)) ? tags : [];
}

// A test counts as passing only if it was expected to pass and its final
// attempt passed (a test that passed on retry still passes; skipped, failed,
// timed-out, interrupted and test.fail()-inverted tests do not).
function passed(test) {
  if (!isObject(test) || test.expectedStatus !== 'passed') return false;
  const results = Array.isArray(test.results) ? test.results : [];
  const last = results[results.length - 1];
  return isObject(last) && last.status === 'passed';
}

function collectPassingTags(report) {
  if (!isObject(report) || !Array.isArray(report.suites)) {
    inputError('Playwright report has no "suites" array - not a Playwright JSON report');
  }
  const covered = new Set();
  let specCount = 0;
  const walk = (suite) => {
    if (!isObject(suite)) return;
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      if (!isObject(spec)) continue;
      specCount += 1;
      const tests = Array.isArray(spec.tests) ? spec.tests : [];
      if (tests.some(passed)) tagsOf(spec.title).forEach((t) => covered.add(t));
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) walk(child);
  };
  report.suites.forEach(walk);
  if (specCount === 0) inputError('Playwright report contains no tests');
  return covered;
}

const [reportPath, manifestArg] = process.argv.slice(2);
if (!reportPath) inputError('usage: check-req-coverage.mjs <playwright-json-report> [manifest]');

const requirements = loadManifest(manifestArg ? resolve(manifestArg) : DEFAULT_MANIFEST);
const covered = collectPassingTags(readJson(resolve(reportPath), 'Playwright JSON report'));

const gated = requirements.filter((r) => r.method === AUTOMATED);
const skipped = requirements.filter((r) => r.method !== AUTOMATED);
const uncovered = gated.filter((r) => !covered.has(r.tag));

for (const r of skipped) {
  console.log(`skip  ${r.tag} (method: ${clean(r.method)}; not gated on an automated test)`);
}
for (const r of gated) {
  console.log(`${covered.has(r.tag) ? 'ok   ' : 'MISS '} ${r.tag}  ${clean(r.title ?? '')}`);
}

if (uncovered.length > 0) {
  console.error('');
  console.error(
    `REQUIREMENT COVERAGE GATE FAILED: ${uncovered.length} of ${gated.length} Approved ` +
      'Requirement(s) have no passing acceptance test mapped to them:',
  );
  for (const r of uncovered) console.error(`  - ${r.tag}: ${clean(r.title ?? '')}`);
  console.error('Release blocked: add or fix a passing test titled "<TAG>: <scenario>" for each.');
  process.exit(EXIT_UNCOVERED);
}

console.log('');
console.log(
  `REQUIREMENT COVERAGE GATE PASSED: all ${gated.length} Approved Requirement(s) ` +
    'verified by at least one passing acceptance test.',
);
