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
// Requirements with any other allowed verification method (Code Review,
// Demonstration, Inspection, Manual Test) are listed as informational skips; any
// other method string is an input error. R-RELEASE-GATE itself is deliberately
// NOT in the manifest: this gate is process-verified by its own falsification
// evidence (a run shown to fail and name an uncovered tag) and by its fixture
// self-test (scripts/check-req-coverage.test.mjs), not by a Playwright test.
//
// A test title that starts with "R-" but does not parse as tags (e.g. a missing
// space after the colon, lower-case tag) is reported as a warning so near-miss
// tagging is visible; it never counts as coverage.
//
// Local repro (same reporter wiring as CI; serve ./web first, e.g. on 8123):
//   BASE_URL=http://localhost:8123 PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/pw-results.json \
//     npx playwright test --reporter=list,json
//   node scripts/check-req-coverage.mjs /tmp/pw-results.json
//
// Both inputs are treated as untrusted data: they are parsed as JSON only,
// never evaluated, the manifest's regex is compared as a string (never
// compiled), and every string echoed to the log is passed through clean(), which
// strips control and bidi characters and defuses runner command markers.

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
// The requirements-definition verification-method picklist, matched exactly.
const METHODS = new Set([AUTOMATED, 'Code Review', 'Demonstration', 'Inspection', 'Manual Test']);

const EXIT_UNCOVERED = 1;
const EXIT_BAD_INPUT = 2;

// Make an untrusted string safe to echo into a CI log: no control characters
// (so no newline can start a "::command" line), no bidi overrides, and no
// legacy "##[command]" marker.
function clean(value, max = 200) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ')
    .replace(/##\[/g, '# #[')
    .slice(0, max);
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
    if (typeof req.method !== 'string' || !METHODS.has(req.method)) {
      inputError(
        `manifest requirement ${req.tag} has unknown verification method ` +
          `${JSON.stringify(clean(req.method))} (allowed: ${[...METHODS].join(', ')})`,
      );
    }
    if (seen.has(req.tag)) inputError(`manifest lists ${req.tag} more than once`);
    seen.add(req.tag);
  }
  const gated = manifest.requirements.filter((r) => r.method === AUTOMATED);
  const skipped = manifest.requirements.filter((r) => r.method !== AUTOMATED);
  if (gated.length === 0) {
    inputError(`manifest has no "${AUTOMATED}" requirements - nothing to gate on`);
  }
  return { gated, skipped };
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
  const nearMisses = new Set();
  let specCount = 0;
  const walk = (suite) => {
    if (!isObject(suite)) return;
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      if (!isObject(spec)) continue;
      specCount += 1;
      const tags = tagsOf(spec.title);
      if (tags.length === 0 && typeof spec.title === 'string' && /^R-/i.test(spec.title)) {
        // Only the would-be tag prefix is echoed, never the full title.
        const sep = spec.title.indexOf(':');
        nearMisses.add(clean(sep > 0 ? spec.title.slice(0, sep) : spec.title, 60));
      }
      const tests = Array.isArray(spec.tests) ? spec.tests : [];
      if (tests.some(passed)) tags.forEach((t) => covered.add(t));
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) walk(child);
  };
  report.suites.forEach(walk);
  if (specCount === 0) inputError('Playwright report contains no tests');
  return { covered, nearMisses };
}

const [reportPath, manifestArg] = process.argv.slice(2);
if (!reportPath) inputError('usage: check-req-coverage.mjs <playwright-json-report> [manifest]');

const { gated, skipped } = loadManifest(manifestArg ? resolve(manifestArg) : DEFAULT_MANIFEST);
const { covered, nearMisses } = collectPassingTags(
  readJson(resolve(reportPath), 'Playwright JSON report'),
);
const uncovered = gated.filter((r) => !covered.has(r.tag));

for (const prefix of nearMisses) {
  console.log(`warn: title looks tagged but does not parse: ${JSON.stringify(prefix)}`);
}
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
