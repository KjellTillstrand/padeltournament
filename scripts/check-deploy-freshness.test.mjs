#!/usr/bin/env node
// Fixture self-test for scripts/check-deploy-freshness.mjs (the deploy freshness
// monitor, AB#65).
//
// Usage: node scripts/check-deploy-freshness.test.mjs
//
// Two layers:
//   - the pure decision function evaluate(), against inline fixtures shaped
//     like the GitHub REST responses it is fed (every failing case asserts the
//     specific failure code and reason, not just "some failure");
//   - the CLI as a black box (a child node process, as CI runs it) against a
//     loopback HTTP server serving fixtures, to prove it reports green only
//     when it could see everything and fails closed (exit 2) otherwise.
// Plain assert, no dependencies, no network beyond 127.0.0.1. Exits non-zero
// if any case fails.

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluate, InputError, STALE_AFTER_MS } from './check-deploy-freshness.mjs';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), 'check-deploy-freshness.mjs');

const HOUR = STALE_AFTER_MS;
const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-03T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ago = (ms, now = NOW) => iso(now - ms);

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const OLDER = 'c'.repeat(40);

const head = (sha = HEAD, age = 2 * HOUR, now = NOW) => ({ sha, commit: { committer: { date: ago(age, now) } } });
// A deployment as listed, plus its statuses (newest first, as the API returns).
const deployment = (sha, age, states = ['success'], now = NOW) => ({
  id: Math.floor(age / 1000),
  sha,
  created_at: ago(age, now),
  statuses: states.map((s, i) => ({ id: i, state: s, created_at: ago(age - (states.length - i) * 1000, now) })),
});
const run = (id, state, age, now = NOW) => ({
  id,
  status: state,
  created_at: ago(age, now),
  run_started_at: ago(age, now),
  html_url: `https://github.com/o/r/actions/runs/${id}`,
});

const input = (over = {}) => ({
  now: NOW,
  head: head(),
  deployments: [deployment(HEAD, 90 * MIN)],
  runs: [],
  ...over,
});

const codes = (failures) => failures.map((f) => f.code);
const throwsInput = (fn, re) => assert.throws(fn, (err) => err instanceof InputError && re.test(err.message));

const unitCases = [
  ['fresh: live sha is the main head -> no failures', () => {
    assert.deepStrictEqual(evaluate(input()), []);
  }],
  ['fresh even when the head is days old', () => {
    assert.deepStrictEqual(evaluate(input({ head: head(HEAD, 72 * HOUR) })), []);
  }],
  ['lagging but the head is under 1h old -> passes (grace hour)', () => {
    const r = evaluate(input({ head: head(HEAD, 59 * MIN), deployments: [deployment(OLD, 2 * HOUR)] }));
    assert.deepStrictEqual(r, []);
  }],
  ['lagging and the head is over 1h old -> live-not-head (a)', () => {
    const r = evaluate(input({ head: head(HEAD, 3 * HOUR), deployments: [deployment(OLD, 4 * HOUR)] }));
    assert.deepStrictEqual(codes(r), ['live-not-head']);
    assert.match(r[0].reason, /^Live github-pages deployment is bbbbbbb, but main head aaaaaaa was committed 180 min ago \(limit 60 min\)\.$/);
  }],
  ['boundary (a): head exactly 1h old passes, 1 ms more fails', () => {
    const deployments = [deployment(OLD, 4 * HOUR)];
    assert.deepStrictEqual(evaluate(input({ head: head(HEAD, HOUR), deployments })), []);
    assert.deepStrictEqual(codes(evaluate(input({ head: head(HEAD, HOUR + 1), deployments }))), ['live-not-head']);
  }],
  ['live = newest SUCCESSFUL deployment; a newer failed/in-progress one is not live', () => {
    const deployments = [
      deployment(HEAD, 30 * MIN, ['failure', 'in_progress', 'queued']),
      deployment(OLD, 2 * HOUR, ['success', 'in_progress']),
      deployment(OLDER, 5 * HOUR, ['success']),
    ];
    const r = evaluate(input({ head: head(HEAD, 2 * HOUR), deployments }));
    assert.deepStrictEqual(codes(r), ['live-not-head']);
    assert.match(r[0].reason, /deployment is bbbbbbb,/);
  }],
  ['an older deployment still marked success does not mask a newer live one (order-independent)', () => {
    // GitHub does not mark superseded Pages deployments inactive.
    const deployments = [deployment(OLD, 5 * HOUR), deployment(HEAD, 2 * HOUR)];
    assert.deepStrictEqual(evaluate(input({ deployments })), []);
  }],
  ['latest status decides, whatever the listing order of statuses', () => {
    const d = deployment(HEAD, 2 * HOUR, ['success', 'in_progress']);
    d.statuses.reverse();
    assert.deepStrictEqual(evaluate(input({ deployments: [d] })), []);
    const failed = deployment(HEAD, 2 * HOUR, ['failure', 'success']);
    failed.statuses.reverse();
    assert.deepStrictEqual(codes(evaluate(input({ deployments: [failed] }))), ['no-successful-deployment']);
  }],
  ['no successful deployment at all -> no-successful-deployment, even inside the grace hour', () => {
    for (const deployments of [[], [deployment(HEAD, 10 * MIN, ['in_progress'])], [deployment(HEAD, 2 * HOUR, [])]]) {
      const r = evaluate(input({ head: head(HEAD, 5 * MIN), deployments }));
      assert.deepStrictEqual(codes(r), ['no-successful-deployment']);
      assert.match(r[0].reason, new RegExp(`^No successful github-pages deployment among the ${deployments.length} listed: main head aaaaaaa is not live\\.$`));
    }
  }],
  ['stalled run over 1h -> stalled-run (b), for every stalled status', () => {
    for (const state of ['waiting', 'queued', 'pending', 'requested']) {
      const r = evaluate(input({ runs: [run(36765228696, state, 72 * HOUR)] }));
      assert.deepStrictEqual(codes(r), ['stalled-run'], state);
      assert.strictEqual(
        r[0].reason,
        `Test and deploy run 36765228696 has been "${state}" since an attempt started 4320 min ago ` +
          '(limit 60 min): https://github.com/o/r/actions/runs/36765228696',
      );
    }
  }],
  ['stalled run under 1h passes', () => {
    assert.deepStrictEqual(evaluate(input({ runs: [run(1, 'waiting', 59 * MIN), run(2, 'queued', 1 * MIN)] })), []);
  }],
  ['boundary (b): exactly 1h passes, 1 ms more fails', () => {
    assert.deepStrictEqual(evaluate(input({ runs: [run(1, 'waiting', HOUR)] })), []);
    assert.deepStrictEqual(codes(evaluate(input({ runs: [run(1, 'waiting', HOUR + 1)] }))), ['stalled-run']);
  }],
  ['completed and in-progress runs never trip (b), however old', () => {
    const runs = [run(1, 'completed', 500 * HOUR), run(2, 'in_progress', 3 * HOUR)];
    assert.deepStrictEqual(evaluate(input({ runs })), []);
  }],
  ['re-run attempt is aged from run_started_at, not created_at', () => {
    const rerun = { ...run(7, 'queued', 10 * MIN), created_at: ago(48 * HOUR) };
    assert.deepStrictEqual(evaluate(input({ runs: [rerun] })), []);
    const noStart = { ...run(8, 'queued', 0), run_started_at: undefined, created_at: ago(2 * HOUR) };
    assert.deepStrictEqual(codes(evaluate(input({ runs: [noStart] }))), ['stalled-run']);
  }],
  ['the AB#65 incident trips both (a) and (b)', () => {
    const r = evaluate(input({
      head: head(HEAD, 70 * HOUR),
      deployments: [deployment(OLD, 72 * HOUR)],
      runs: [run(36765228696, 'waiting', 72 * HOUR), run(2, 'completed', 60 * HOUR)],
    }));
    assert.deepStrictEqual(codes(r), ['live-not-head', 'stalled-run']);
  }],
  ['echoed run fields are sanitized', () => {
    const evil = { ...run(1, 'waiting', 2 * HOUR), html_url: 'x\n::error::pwned ##[error]bad ‮evil' };
    const [f] = evaluate(input({ runs: [evil] }));
    assert.doesNotMatch(f.reason, /\n/);
    assert.doesNotMatch(f.reason, /##\[/);
    assert.doesNotMatch(f.reason, /‮/);
  }],
  ['malformed input fails closed (InputError, never [])', () => {
    throwsInput(() => evaluate(), /"now" is not a time/);
    throwsInput(() => evaluate(input({ now: NaN })), /"now" is not a time/);
    throwsInput(() => evaluate(input({ head: { sha: HEAD } })), /main head has no commit\.committer/);
    throwsInput(() => evaluate(input({ head: head('main') })), /main head sha is not a commit sha/);
    throwsInput(() => evaluate(input({ head: { sha: HEAD, commit: { committer: { date: 'yesterday' } } } })), /committer date is not a timestamp/);
    throwsInput(() => evaluate(input({ deployments: { message: 'Not Found' } })), /deployments is not an array/);
    throwsInput(() => evaluate(input({ runs: null })), /runs is not an array/);
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), sha: undefined }] })), /deployment #0 sha/);
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), statuses: undefined }] })), /deployment #0 has no "statuses" array/);
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), statuses: [{ created_at: ago(1) }] }] })), /status #0 has no state/);
    throwsInput(() => evaluate(input({ runs: [{ id: 1 }] })), /run #0 has no status/);
    throwsInput(() => evaluate(input({ runs: [{ ...run(1, 'waiting', HOUR), run_started_at: 'soon' }] })), /run #0 run_started_at is not a timestamp/);
  }],
];

// ---- CLI black box against a loopback fixture server -----------------------

// routes: path (without /repos/o/r/ and query) -> [status, body]; unlisted -> 404.
async function cli(routes, env = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push({ path: url.pathname, query: url.search, auth: req.headers.authorization });
    const key = url.pathname.replace(/^\/repos\/o\/r\//, '') + (url.searchParams.get('status') ? `?${url.searchParams.get('status')}` : '');
    const [code, body] = routes[key] ?? [404, { message: 'Not Found' }];
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  const childEnv = {
    PATH: process.env.PATH,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'fixture-token',
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    ...env,
  };
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  const result = await new Promise((ok) => {
    const child = spawn(process.execPath, [CLI], { env: childEnv });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => ok({ code, out }));
  });
  server.close();
  return { ...result, seen };
}

const now = Date.now();
const runsPage = (runs = []) => [200, { total_count: runs.length, workflow_runs: runs }];
const freshRoutes = (over = {}) => ({
  'commits/main': [200, head(HEAD, 3 * HOUR, now)],
  deployments: [200, [deployment(HEAD, 2 * HOUR, ['success'], now), deployment(OLD, 5 * HOUR, ['success'], now)]],
  [`deployments/${Math.floor((2 * HOUR) / 1000)}/statuses`]: [200, deployment(HEAD, 2 * HOUR, ['success'], now).statuses],
  [`deployments/${Math.floor((5 * HOUR) / 1000)}/statuses`]: [200, deployment(OLD, 5 * HOUR, ['success'], now).statuses],
  'actions/workflows/playwright-tests.yml/runs?waiting': runsPage(),
  'actions/workflows/playwright-tests.yml/runs?queued': runsPage(),
  'actions/workflows/playwright-tests.yml/runs?pending': runsPage(),
  'actions/workflows/playwright-tests.yml/runs?requested': runsPage(),
  ...over,
});

const cliCases = [
  ['CLI: fresh repo exits 0, sends the token, stops at the first live deployment', async () => {
    const r = await cli(freshRoutes());
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DEPLOY FRESHNESS OK/);
    assert.ok(r.seen.every((s) => s.auth === 'Bearer fixture-token'), 'every request is authenticated');
    assert.ok(r.seen.some((s) => s.path.endsWith('/deployments') && s.query.includes('environment=github-pages')));
    assert.ok(!r.seen.some((s) => s.path.includes(`/deployments/${Math.floor((5 * HOUR) / 1000)}/`)), 'older deployment not fetched');
    assert.doesNotMatch(r.out, /fixture-token/);
  }],
  ['CLI: stale deployment and stalled run exit 1 with one ::error:: each', async () => {
    const r = await cli(freshRoutes({
      deployments: [200, [deployment(OLD, 5 * HOUR, ['success'], now)]],
      'actions/workflows/playwright-tests.yml/runs?waiting': runsPage([run(99, 'waiting', 30 * HOUR, now)]),
    }));
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /^::error::DEPLOY FRESHNESS \(live-not-head\): Live github-pages deployment is bbbbbbb/m);
    assert.match(r.out, /^::error::DEPLOY FRESHNESS \(stalled-run\): Test and deploy run 99 has been "waiting"/m);
  }],
  ['CLI: an API error exits 2, never 0', async () => {
    for (const key of ['commits/main', 'deployments', 'actions/workflows/playwright-tests.yml/runs?pending']) {
      const r = await cli(freshRoutes({ [key]: [500, { message: 'boom' }] }));
      assert.strictEqual(r.code, 2, `${key}: ${r.out}`);
      assert.match(r.out, /^::error::DEPLOY FRESHNESS: CANNOT EVALUATE - GET .* returned HTTP 500$/m);
    }
  }],
  ['CLI: an unexpected shape exits 2', async () => {
    for (const [key, body] of [
      ['deployments', { message: 'not a list' }],
      ['commits/main', '<html>not json'],
      ['actions/workflows/playwright-tests.yml/runs?queued', { workflow_runs: 'x' }],
    ]) {
      const r = await cli(freshRoutes({ [key]: [200, body] }));
      assert.strictEqual(r.code, 2, `${key}: ${r.out}`);
      assert.match(r.out, /CANNOT EVALUATE/);
    }
  }],
  ['CLI: more stalled runs than one page holds exits 2 (partial list not judged)', async () => {
    const r = await cli(freshRoutes({
      'actions/workflows/playwright-tests.yml/runs?queued': [200, { total_count: 101, workflow_runs: [run(1, 'queued', MIN, now)] }],
    }));
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, /101 runs are "queued", more than one page/);
  }],
  ['CLI: missing environment exits 2', async () => {
    assert.strictEqual((await cli(freshRoutes(), { GITHUB_TOKEN: undefined })).code, 2);
    assert.strictEqual((await cli(freshRoutes(), { GITHUB_REPOSITORY: undefined })).code, 2);
  }],
  ['CLI: refuses to send the token over plain http to a non-loopback host', async () => {
    const r = await cli(freshRoutes(), { GITHUB_API_URL: 'http://example.com' });
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, /GITHUB_API_URL must be https/);
    assert.strictEqual(r.seen.length, 0);
  }],
];

let failed = 0;
const all = [...unitCases, ...cliCases];
for (const [name, fn] of all) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}\n${err.message}`);
  }
}

console.log(`\n${all.length - failed}/${all.length} deploy freshness self-test cases passed`);
process.exit(failed === 0 ? 0 : 1);
