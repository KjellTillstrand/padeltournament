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
//     when it could see everything, retries a transient error once, stays
//     inside its fetch and time bounds, and fails closed (exit 2) otherwise.
// Plain assert, no dependencies, no network beyond 127.0.0.1. Exits non-zero
// if any case fails.

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clean, evaluate, InputError, DEPLOYMENT_LIMIT, MAX_CALLS, RUN_PAGE, STALE_AFTER_MS, STATUS_PAGE, WORST_CASE_MS,
} from './check-deploy-freshness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, 'check-deploy-freshness.mjs');
const WORKFLOW = resolve(HERE, '../.github/workflows/deploy-freshness.yml');

const HOUR = STALE_AFTER_MS;
const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-03T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ago = (ms, now = NOW) => iso(now - ms);

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const OLDER = 'c'.repeat(40);

const head = (sha = HEAD, age = 2 * HOUR, now = NOW) => ({ sha, commit: { committer: { date: ago(age, now) } } });
// Ids rise over time, as GitHub's do: a newer deployment has a higher id.
const depId = (age) => 1e9 - Math.floor(age / 1000);
// A deployment as listed, plus its statuses (newest first, as the API returns;
// the newest status has the highest id).
const deployment = (sha, age, states = ['success'], now = NOW) => ({
  id: depId(age),
  sha,
  created_at: ago(age, now),
  statuses: states.map((s, i) => ({
    id: states.length - i,
    state: s,
    created_at: ago(age - (states.length - i) * 1000, now),
  })),
});
// A push-event Test and deploy run of a sha (what the head's age is read from).
const pushRun = (sha, age, status = 'completed', conclusion = 'success', id = 500, now = NOW) => ({
  id,
  head_sha: sha,
  event: 'push',
  status,
  conclusion: status === 'completed' ? conclusion : null,
  created_at: ago(age, now),
  run_started_at: ago(age, now),
  html_url: `https://github.com/o/r/actions/runs/${id}`,
});
// A run as listed by the stalled-status listings.
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
  headRuns: [pushRun(HEAD, 2 * HOUR)],
  deployments: [deployment(HEAD, 90 * MIN)],
  runs: [],
  ...over,
});

const codes = (result) => result.failures.map((f) => f.code);
const throwsInput = (fn, re) => assert.throws(fn, (err) => err instanceof InputError && re.test(err.message));

// Every code point clean() must neutralise: C0/C1 line breaks, the Arabic
// letter mark, zero-width and LRM/RLM marks, LINE/PARAGRAPH SEPARATOR, bidi
// embeddings/overrides/isolates, word joiner, BOM. Built from numbers so that
// no invisible character is written literally in this file either.
const INVISIBLE = [0x0a, 0x0d, 0x1b, 0x85, 0x061c, 0x200b, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029,
  0x202a, 0x202d, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff];
// The same set (and the rest of C0 but TAB/LF, DEL, C1) as a source-file scan.
const RAW_INVISIBLE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

const unitCases = [
  ['fresh: the head of main is deployed -> no failures', () => {
    const r = evaluate(input());
    assert.deepStrictEqual(r.failures, []);
    assert.strictEqual(r.headLive, true);
    assert.strictEqual(r.newestSuccess, HEAD);
  }],
  ['fresh even when the head is days old', () => {
    assert.deepStrictEqual(evaluate(input({ head: head(HEAD, 72 * HOUR), headRuns: [pushRun(HEAD, 72 * HOUR)] })).failures, []);
  }],
  ['lagging but the head reached main under 1h ago -> passes (grace hour)', () => {
    const r = evaluate(input({ headRuns: [pushRun(HEAD, 59 * MIN, 'in_progress')], deployments: [deployment(OLD, 2 * HOUR)] }));
    assert.deepStrictEqual(r.failures, []);
    assert.strictEqual(r.headLive, false);
  }],
  ['lagging over 1h with the head run waiting -> head-not-live (a), says the run is stuck', () => {
    const r = evaluate(input({
      head: head(HEAD, 3 * HOUR),
      headRuns: [pushRun(HEAD, 3 * HOUR, 'waiting')],
      deployments: [deployment(OLD, 4 * HOUR)],
    }));
    assert.deepStrictEqual(codes(r), ['head-not-live']);
    assert.strictEqual(
      r.failures[0].reason,
      'Main head aaaaaaa has no successful github-pages deployment 180 min after its push run was created ' +
        '(limit 60 min); the newest successful deployment record is bbbbbbb. Its Test and deploy run 500 is ' +
        'still "waiting" 180 min after it was created: the run or its publication is stuck. ' +
        'https://github.com/o/r/actions/runs/500',
    );
  }],
  ['(a) on a failed main run names the conclusion, not a stalled publication', () => {
    const r = evaluate(input({ headRuns: [pushRun(HEAD, 2 * HOUR, 'completed', 'failure')], deployments: [deployment(OLD, 4 * HOUR)] }));
    assert.deepStrictEqual(codes(r), ['head-not-live']);
    assert.match(r.failures[0].reason, /Its Test and deploy run 500 completed with conclusion "failure": the run failed \(tests, a gate or the deploy job; see the run\), not necessarily the publication\. https:/);
    assert.doesNotMatch(r.failures[0].reason, /stuck/);
  }],
  ['(a) on a successful run without a live deployment says the publication was skipped', () => {
    const r = evaluate(input({ deployments: [deployment(OLD, 4 * HOUR)] }));
    assert.match(r.failures[0].reason, /run 500 completed with conclusion "success", yet no deployment of the head is live: the publication was skipped or not recorded\./);
  }],
  ['(a) with no push run ([skip ci]) ages the head from its committer date and says so', () => {
    const r = evaluate(input({ head: head(HEAD, 2 * HOUR), headRuns: [], deployments: [deployment(OLD, 4 * HOUR)] }));
    assert.deepStrictEqual(codes(r), ['head-not-live']);
    assert.match(r.failures[0].reason, /deployment 120 min after its committer date \(limit 60 min\)/);
    assert.match(r.failures[0].reason, /No push-event Test and deploy run exists for it \(a \[skip ci\] commit, or CI never started\)/);
    assert.strictEqual(r.headSinceSource, 'committer date (no push run)');
    assert.deepStrictEqual(evaluate(input({ head: head(HEAD, 59 * MIN), headRuns: [], deployments: [deployment(OLD, 4 * HOUR)] })).failures, []);
  }],
  ['boundary (a): head run exactly 1h old passes, 1 ms more fails', () => {
    const deployments = [deployment(OLD, 4 * HOUR)];
    assert.deepStrictEqual(evaluate(input({ headRuns: [pushRun(HEAD, HOUR)], deployments })).failures, []);
    assert.deepStrictEqual(codes(evaluate(input({ headRuns: [pushRun(HEAD, HOUR + 1)], deployments }))), ['head-not-live']);
  }],
  ['the grace hour runs from the push run, not the committer date (old commit pushed now)', () => {
    const r = evaluate(input({
      head: head(HEAD, 72 * HOUR),
      headRuns: [pushRun(HEAD, 10 * MIN, 'in_progress')],
      deployments: [deployment(OLD, 4 * HOUR)],
    }));
    assert.deepStrictEqual(r.failures, []);
    assert.strictEqual(r.headSince, NOW - 10 * MIN);
  }],
  ['the newest push run of the head sets its age (main pushed to the same sha twice)', () => {
    const headRuns = [pushRun(HEAD, 5 * HOUR, 'completed', 'success', 400), pushRun(HEAD, 10 * MIN, 'queued', null, 600)];
    const r = evaluate(input({ headRuns, deployments: [deployment(OLD, 4 * HOUR)] }));
    assert.deepStrictEqual(r.failures, []);
    assert.strictEqual(r.headSinceSource, 'push run 600 created');
  }],
  ['a future committer date or run time is not trusted (InputError, never silence)', () => {
    throwsInput(() => evaluate(input({ head: head(HEAD, -6 * MIN), headRuns: [] })), /main head committer date is 6 min in the future/);
    throwsInput(() => evaluate(input({ head: head(HEAD, -50 * 365 * 24 * HOUR) })), /main head committer date is .* in the future/);
    throwsInput(() => evaluate(input({ headRuns: [pushRun(HEAD, -6 * MIN)] })), /head run #0 created_at is 6 min in the future/);
    // Clock skew within FUTURE_SKEW_MS is tolerated.
    assert.deepStrictEqual(evaluate(input({ head: head(HEAD, -4 * MIN), headRuns: [pushRun(HEAD, -4 * MIN)] })).failures, []);
  }],
  ['a head run of another sha is refused', () => {
    throwsInput(() => evaluate(input({ headRuns: [pushRun(OLD, HOUR)] })), /head run #0 is not a run of the main head/);
  }],
  ['the head deployment decides: a newer "success" record of an older sha (skipped publish) is not live', () => {
    // A's run reaches its deploy job after B (the head) published; its
    // freshness guard skips publishing, but the job succeeds, so GitHub
    // records a newer "success" deployment for A.
    const deployments = [deployment(OLD, 20 * MIN), deployment(HEAD, 40 * MIN)];
    const r = evaluate(input({ deployments }));
    assert.deepStrictEqual(r.failures, []);
    assert.strictEqual(r.headLive, true);
    assert.strictEqual(r.newestSuccess, OLD);
  }],
  ['the head deployment decides: an older-sha success does not cover a failed head deployment', () => {
    const deployments = [
      deployment(HEAD, 30 * MIN, ['failure', 'in_progress', 'queued']),
      deployment(OLD, 2 * HOUR, ['success', 'in_progress']),
      deployment(OLDER, 5 * HOUR, ['success']),
    ];
    const r = evaluate(input({ deployments }));
    assert.deepStrictEqual(codes(r), ['head-not-live']);
    assert.match(r.failures[0].reason, /the newest successful deployment record is bbbbbbb\./);
  }],
  ['any successful deployment of the head counts, in any order', () => {
    const deployments = [deployment(HEAD, 20 * MIN, ['failure']), deployment(OLD, 5 * HOUR), deployment(HEAD, 2 * HOUR)];
    assert.deepStrictEqual(evaluate(input({ deployments })).failures, []);
  }],
  ['latest status decides, whatever the listing order of statuses', () => {
    const d = deployment(HEAD, 2 * HOUR, ['success', 'in_progress']);
    d.statuses.reverse();
    assert.deepStrictEqual(evaluate(input({ deployments: [d] })).failures, []);
    const failed = deployment(HEAD, 2 * HOUR, ['failure', 'success']);
    failed.statuses.reverse();
    assert.deepStrictEqual(codes(evaluate(input({ deployments: [failed] }))), ['no-successful-deployment']);
  }],
  ['statuses with the same timestamp: the higher id is the latest', () => {
    const at = ago(HOUR);
    const tie = (successId, progressId) => ({
      ...deployment(HEAD, 2 * HOUR),
      statuses: [{ id: progressId, state: 'in_progress', created_at: at }, { id: successId, state: 'success', created_at: at }],
    });
    assert.deepStrictEqual(evaluate(input({ deployments: [tie(9, 8)] })).failures, []);
    assert.deepStrictEqual(codes(evaluate(input({ deployments: [tie(8, 9)] }))), ['no-successful-deployment']);
  }],
  ['no successful deployment at all -> no-successful-deployment, even inside the grace hour', () => {
    for (const deployments of [[], [deployment(HEAD, 10 * MIN, ['in_progress'])], [deployment(HEAD, 2 * HOUR, [])]]) {
      const r = evaluate(input({ head: head(HEAD, 5 * MIN), headRuns: [pushRun(HEAD, 5 * MIN, 'in_progress')], deployments }));
      assert.deepStrictEqual(codes(r), ['no-successful-deployment']);
      assert.match(r.failures[0].reason, new RegExp(`^No successful github-pages deployment among the ${deployments.length} listed: main head aaaaaaa is not live\\.$`));
    }
  }],
  ['stalled run over 1h -> stalled-run (b), for every stalled status', () => {
    for (const state of ['waiting', 'queued', 'pending', 'requested']) {
      const r = evaluate(input({ runs: [run(36765228696, state, 72 * HOUR)] }));
      assert.deepStrictEqual(codes(r), ['stalled-run'], state);
      assert.strictEqual(
        r.failures[0].reason,
        `Test and deploy run 36765228696 has been "${state}" since an attempt started 4320 min ago ` +
          '(limit 60 min): https://github.com/o/r/actions/runs/36765228696',
      );
    }
  }],
  ['stalled run under 1h passes', () => {
    assert.deepStrictEqual(evaluate(input({ runs: [run(1, 'waiting', 59 * MIN), run(2, 'queued', 1 * MIN)] })).failures, []);
  }],
  ['boundary (b): exactly 1h passes, 1 ms more fails', () => {
    assert.deepStrictEqual(evaluate(input({ runs: [run(1, 'waiting', HOUR)] })).failures, []);
    assert.deepStrictEqual(codes(evaluate(input({ runs: [run(1, 'waiting', HOUR + 1)] }))), ['stalled-run']);
  }],
  ['completed and in-progress runs never trip (b), however old', () => {
    const runs = [run(1, 'completed', 500 * HOUR), run(2, 'in_progress', 3 * HOUR)];
    assert.deepStrictEqual(evaluate(input({ runs })).failures, []);
  }],
  ['a run listed under two statuses (it moved between listings) is reported once', () => {
    const r = evaluate(input({ runs: [run(7, 'queued', 3 * HOUR), run(7, 'waiting', 3 * HOUR), run(8, 'waiting', 2 * HOUR)] }));
    assert.deepStrictEqual(codes(r), ['stalled-run', 'stalled-run']);
    assert.match(r.failures[0].reason, /^Test and deploy run 7 /);
    assert.match(r.failures[1].reason, /^Test and deploy run 8 /);
    assert.strictEqual(r.runsListed, 2);
  }],
  ['re-run attempt is aged from run_started_at, not created_at', () => {
    const rerun = { ...run(7, 'queued', 10 * MIN), created_at: ago(48 * HOUR) };
    assert.deepStrictEqual(evaluate(input({ runs: [rerun] })).failures, []);
    const noStart = { ...run(8, 'queued', 0), run_started_at: undefined, created_at: ago(2 * HOUR) };
    assert.deepStrictEqual(codes(evaluate(input({ runs: [noStart] }))), ['stalled-run']);
  }],
  ['the AB#65 incident trips both (a) and (b)', () => {
    const r = evaluate(input({
      head: head(HEAD, 70 * HOUR),
      headRuns: [pushRun(HEAD, 70 * HOUR, 'waiting', null, 36765228696)],
      deployments: [deployment(OLD, 72 * HOUR)],
      runs: [run(36765228696, 'waiting', 70 * HOUR), run(2, 'completed', 60 * HOUR)],
    }));
    assert.deepStrictEqual(codes(r), ['head-not-live', 'stalled-run']);
    assert.match(r.failures[0].reason, /is still "waiting" 4200 min after it was created: the run or its publication is stuck/);
  }],
  ['clean() neutralises every control, bidi, zero-width and line-separator code point', () => {
    for (const cp of INVISIBLE) {
      const hex = cp.toString(16).padStart(4, '0');
      assert.strictEqual(clean(`a${String.fromCodePoint(cp)}b`), 'a b', `U+${hex}`);
    }
    assert.strictEqual(clean('x##[error]y'), 'x# #[error]y');
  }],
  ['echoed run fields are sanitized', () => {
    const evil = (url) => ({ ...run(1, 'waiting', 2 * HOUR), html_url: url });
    for (const cp of INVISIBLE) {
      const [f] = evaluate(input({ runs: [evil(`x${String.fromCodePoint(cp)}::error::pwned ##[error]bad`)] })).failures;
      assert.doesNotMatch(f.reason, RAW_INVISIBLE_RE);
      assert.doesNotMatch(f.reason, /##\[/);
    }
    const headRun = { ...pushRun(HEAD, 2 * HOUR, 'completed', `x\u2028y`), html_url: `u\u202ev` };
    const [g] = evaluate(input({ headRuns: [headRun], deployments: [deployment(OLD, 4 * HOUR)] })).failures;
    assert.doesNotMatch(g.reason, RAW_INVISIBLE_RE);
  }],
  ['no raw invisible or control character in the monitor, its self-test or the workflows', () => {
    const files = [CLI, fileURLToPath(import.meta.url), WORKFLOW, resolve(HERE, '../.github/workflows/playwright-tests.yml')];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      const bad = lines.findIndex((line) => RAW_INVISIBLE_RE.test(line));
      assert.strictEqual(bad, -1, `${file}:${bad + 1} holds a raw invisible character; use a \\u escape`);
    }
  }],
  ['malformed input fails closed (InputError, never a verdict)', () => {
    throwsInput(() => evaluate(), /"now" is not a time/);
    throwsInput(() => evaluate(input({ now: NaN })), /"now" is not a time/);
    throwsInput(() => evaluate(input({ head: { sha: HEAD } })), /main head has no commit\.committer/);
    throwsInput(() => evaluate(input({ head: head('main') })), /main head sha is not a commit sha/);
    throwsInput(() => evaluate(input({ head: { sha: HEAD, commit: { committer: { date: 'yesterday' } } } })), /committer date is not a timestamp/);
    throwsInput(() => evaluate(input({ headRuns: undefined })), /head runs is not an array/);
    throwsInput(() => evaluate(input({ headRuns: [{ ...pushRun(HEAD, HOUR), id: '5' }] })), /head run #0 has no integer id/);
    throwsInput(() => evaluate(input({ headRuns: [{ ...pushRun(HEAD, HOUR), status: 3 }] })), /head run #0 has no status/);
    throwsInput(() => evaluate(input({ headRuns: [{ ...pushRun(HEAD, HOUR), conclusion: 1 }] })), /head run #0 has a malformed conclusion/);
    throwsInput(() => evaluate(input({ headRuns: [{ ...pushRun(HEAD, HOUR), created_at: 'x' }] })), /head run #0 created_at is not a timestamp/);
    throwsInput(() => evaluate(input({ deployments: { message: 'Not Found' } })), /deployments is not an array/);
    throwsInput(() => evaluate(input({ runs: null })), /runs is not an array/);
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), sha: undefined }] })), /deployment #0 sha/);
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), id: undefined }] })), /deployment #0 has no integer id/);
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), created_at: '' }] })), /deployment #0 created_at is not a timestamp/);
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), statuses: undefined }] })), /deployment #0 has no "statuses" array/);
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), statuses: [{ id: 1, created_at: ago(1) }] }] })), /status #0 has no state/);
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), statuses: [{ state: 'success', created_at: ago(1) }] }] })), /status #0 has no integer id/);
    throwsInput(() => evaluate(input({ runs: [{ id: 1 }] })), /run #0 has no status/);
    throwsInput(() => evaluate(input({ runs: [{ status: 'waiting' }] })), /run #0 has no integer id/);
    throwsInput(() => evaluate(input({ runs: [{ ...run(1, 'waiting', HOUR), run_started_at: 'soon' }] })), /run #0 run_started_at is not a timestamp/);
  }],
  ['the worst-case time budget fits well inside the job timeout', () => {
    const match = /^\s*timeout-minutes:\s*(\d+)\s*$/m.exec(readFileSync(WORKFLOW, 'utf8'));
    assert.ok(match, 'deploy-freshness.yml declares timeout-minutes');
    const jobMs = Number(match[1]) * MIN;
    // Checkout and setup-node get at least 4 minutes of the job's time.
    assert.ok(WORST_CASE_MS <= jobMs - 4 * MIN, `worst case ${WORST_CASE_MS} ms vs job ${jobMs} ms`);
    assert.strictEqual(MAX_CALLS, 3 + DEPLOYMENT_LIMIT + 4);
  }],
];

// ---- CLI black box against a loopback fixture server -----------------------

const CHILD_LIMIT_MS = 15 * 1000;

// routes: key -> [status, body] | 'hang' (never answers) | (n) => either of
// those, for the n-th request to that key (1-based). The key is the path without
// /repos/o/r/, plus "?<status>" for a status listing or "?head_sha" for the
// head's push runs. Unlisted keys answer 404.
async function cli(routes, env = {}) {
  const seen = [];
  const hits = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const params = url.searchParams;
    seen.push({ path: url.pathname, query: url.search, params, auth: req.headers.authorization });
    const suffix = params.get('status') ? `?${params.get('status')}` : params.get('head_sha') ? '?head_sha' : '';
    const key = url.pathname.replace(/^\/repos\/o\/r\//, '') + suffix;
    hits[key] = (hits[key] ?? 0) + 1;
    const route = routes[key] ?? [404, { message: 'Not Found' }];
    const answer = typeof route === 'function' ? route(hits[key]) : route;
    if (answer === 'hang') return;
    const [code, body] = answer;
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
    DEPLOY_FRESHNESS_RETRY_DELAY_MS: '10',
    ...env,
  };
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  const result = await new Promise((ok) => {
    const child = spawn(process.execPath, [CLI], { env: childEnv });
    // A CLI that does not exit on its own (e.g. a request without a timeout)
    // fails the case instead of hanging the self-test.
    const killer = setTimeout(() => child.kill('SIGKILL'), CHILD_LIMIT_MS);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      clearTimeout(killer);
      ok({ code, out: code === null ? `${out}\n(killed: no exit within ${CHILD_LIMIT_MS} ms)` : out });
    });
  });
  server.closeAllConnections();
  server.close();
  return { ...result, seen, hits };
}

const now = Date.now();
const runsPage = (runs = []) => [200, { total_count: runs.length, workflow_runs: runs }];
const listed = (...ds) => [200, ds.map(({ statuses, ...d }) => d)];
const statusesOf = (d) => ({ [`deployments/${d.id}/statuses`]: [200, d.statuses] });
const D_HEAD = deployment(HEAD, 2 * HOUR, ['success'], now);
const D_OLD = deployment(OLD, 5 * HOUR, ['success'], now);
const freshRoutes = (over = {}) => ({
  'commits/main': [200, head(HEAD, 3 * HOUR, now)],
  'actions/workflows/playwright-tests.yml/runs?head_sha': runsPage([pushRun(HEAD, 3 * HOUR, 'completed', 'success', 500, now)]),
  deployments: listed(D_HEAD, D_OLD),
  ...statusesOf(D_HEAD),
  ...statusesOf(D_OLD),
  'actions/workflows/playwright-tests.yml/runs?waiting': runsPage(),
  'actions/workflows/playwright-tests.yml/runs?queued': runsPage(),
  'actions/workflows/playwright-tests.yml/runs?pending': runsPage(),
  'actions/workflows/playwright-tests.yml/runs?requested': runsPage(),
  ...over,
});
const statusesFetched = (r, d) => r.seen.some((s) => s.path.endsWith(`/deployments/${d.id}/statuses`));
const CANNOT = '^::error::DEPLOY FRESHNESS: CANNOT EVALUATE - ';

const cliCases = [
  ['CLI: fresh repo exits 0, sends the token, stays inside its page bounds, stops at the live head', async () => {
    const r = await cli(freshRoutes());
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DEPLOY FRESHNESS OK/);
    assert.match(r.out, /head reached main: .* \(push run 500 created\)/);
    assert.ok(r.seen.every((s) => s.auth === 'Bearer fixture-token'), 'every request is authenticated');
    const listing = r.seen.find((s) => s.path === '/repos/o/r/deployments');
    assert.strictEqual(listing.params.get('environment'), 'github-pages');
    assert.strictEqual(listing.params.get('per_page'), String(DEPLOYMENT_LIMIT));
    const headRuns = r.seen.find((s) => s.params.get('head_sha'));
    assert.deepStrictEqual(
      [headRuns.params.get('branch'), headRuns.params.get('event'), headRuns.params.get('head_sha'), headRuns.params.get('per_page')],
      ['main', 'push', HEAD, String(RUN_PAGE)],
    );
    for (const s of r.seen.filter((x) => x.path.endsWith('/statuses'))) assert.strictEqual(s.params.get('per_page'), String(STATUS_PAGE));
    for (const s of r.seen.filter((x) => x.params.get('status'))) assert.strictEqual(s.params.get('per_page'), String(RUN_PAGE));
    assert.ok(!statusesFetched(r, D_OLD), 'older deployment not fetched');
    assert.doesNotMatch(r.out, /fixture-token/);
  }],
  ['CLI: newest deployment in progress, the next one successful -> scans on to it', async () => {
    const inProgress = deployment(HEAD, 20 * MIN, ['in_progress', 'queued'], now);
    const routes = (age) => freshRoutes({
      'actions/workflows/playwright-tests.yml/runs?head_sha': runsPage([pushRun(HEAD, age, 'in_progress', null, 500, now)]),
      deployments: listed(inProgress, D_OLD),
      ...statusesOf(inProgress),
    });
    const inGrace = await cli(routes(30 * MIN));
    assert.strictEqual(inGrace.code, 0, inGrace.out);
    assert.ok(statusesFetched(inGrace, D_OLD), 'the second deployment\'s statuses were requested');
    assert.match(inGrace.out, /newest successful deployment record: b{40}/);
    const late = await cli(routes(3 * HOUR));
    assert.strictEqual(late.code, 1, late.out);
    assert.match(late.out, /^::error::DEPLOY FRESHNESS \(head-not-live\): Main head aaaaaaa .* record is bbbbbbb\. Its Test and deploy run 500 is still "in_progress"/m);
  }],
  ['CLI: a newer "success" record of an older sha (skipped publish) does not hide the live head', async () => {
    const skipped = deployment(OLD, 20 * MIN, ['success'], now);
    const r = await cli(freshRoutes({ deployments: listed(skipped, D_HEAD), ...statusesOf(skipped) }));
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(statusesFetched(r, D_HEAD), 'scanned on to the head deployment');
    assert.match(r.out, /head deployed: {6}yes/);
  }],
  ['CLI: stale deployment and stalled run exit 1 with one ::error:: each', async () => {
    const r = await cli(freshRoutes({
      deployments: listed(D_OLD),
      'actions/workflows/playwright-tests.yml/runs?waiting': runsPage([run(99, 'waiting', 30 * HOUR, now)]),
      'actions/workflows/playwright-tests.yml/runs?queued': runsPage([run(99, 'queued', 30 * HOUR, now)]),
    }));
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /^::error::DEPLOY FRESHNESS \(head-not-live\): Main head aaaaaaa has no successful github-pages deployment/m);
    assert.strictEqual(r.out.match(/\(stalled-run\): Test and deploy run 99 /g)?.length, 1, r.out);
    assert.match(r.out, /stalled-status runs listed: 1$/m);
  }],
  ['CLI: a transient 5xx, 429 or network error is retried once', async () => {
    const twice = (first) => (n) => (n === 1 ? first : freshRoutes()['commits/main']);
    for (const first of [[502, { message: 'bad gateway' }], [429, { message: 'slow down' }]]) {
      const r = await cli(freshRoutes({ 'commits/main': twice(first) }));
      assert.strictEqual(r.code, 0, r.out);
      assert.strictEqual(r.hits['commits/main'], 2);
    }
    const r = await cli(freshRoutes({
      'actions/workflows/playwright-tests.yml/runs?pending': (n) => (n === 1 ? 'hang' : runsPage()),
    }), { DEPLOY_FRESHNESS_TIMEOUT_MS: '300' });
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(r.hits['actions/workflows/playwright-tests.yml/runs?pending'], 2);
  }],
  ['CLI: an API error that persists exits 2 after exactly one retry, never 0', async () => {
    for (const key of ['commits/main', 'deployments', 'actions/workflows/playwright-tests.yml/runs?pending']) {
      const r = await cli(freshRoutes({ [key]: [500, { message: 'boom' }] }));
      assert.strictEqual(r.code, 2, `${key}: ${r.out}`);
      assert.match(r.out, new RegExp(`${CANNOT}GET .* failed after 2 attempts: HTTP 500$`, 'm'));
      assert.strictEqual(r.hits[key], 2, key);
    }
  }],
  ['CLI: a 4xx other than 429 is not retried', async () => {
    const r = await cli(freshRoutes({ deployments: [403, { message: 'forbidden' }] }));
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, new RegExp(`${CANNOT}GET deployments\\?environment=github-pages&per_page=10 returned HTTP 403$`, 'm'));
    assert.strictEqual(r.hits.deployments, 1);
  }],
  ['CLI: a request that never answers times out, and the run still exits 2 on its own', async () => {
    const r = await cli(freshRoutes({ 'commits/main': 'hang' }), { DEPLOY_FRESHNESS_TIMEOUT_MS: '200' });
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, new RegExp(`${CANNOT}GET commits/main failed after 2 attempts: network error \\(timeout\\)$`, 'm'));
    assert.strictEqual(r.hits['commits/main'], 2);
  }],
  ['CLI: a network error is reported by code, never by the fetch error message', async () => {
    const closed = createServer();
    await new Promise((ok) => closed.listen(0, '127.0.0.1', ok));
    const { port } = closed.address();
    await new Promise((ok) => closed.close(ok));
    const r = await cli(freshRoutes(), { GITHUB_API_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, new RegExp(`${CANNOT}GET commits/main failed after 2 attempts: network error \\(ECONNREFUSED\\)$`, 'm'));
  }],
  ['CLI: a malformed token or a credential in the API URL is refused without echoing it', async () => {
    for (const env of [
      { GITHUB_TOKEN: 'ghp_FAKESECRET123\nline2' },
      { GITHUB_TOKEN: 'ghp_FAKESECRET123 line2' },
      { GITHUB_API_URL: 'https://x-access:FAKESECRET123@127.0.0.1' },
      { GITHUB_API_URL: 'not a url FAKESECRET123' },
    ]) {
      const r = await cli(freshRoutes(), env);
      assert.strictEqual(r.code, 2, r.out);
      assert.match(r.out, /CANNOT EVALUATE - GITHUB_(TOKEN is malformed|API_URL)/);
      assert.doesNotMatch(r.out, /FAKESECRET/);
      assert.strictEqual(r.seen.length, 0);
    }
  }],
  ['CLI: the timing overrides may only shorten the defaults', async () => {
    for (const env of [{ DEPLOY_FRESHNESS_TIMEOUT_MS: '600000' }, { DEPLOY_FRESHNESS_RETRY_DELAY_MS: '-1' }, { DEPLOY_FRESHNESS_TIMEOUT_MS: '0' }]) {
      const r = await cli(freshRoutes(), env);
      assert.strictEqual(r.code, 2, r.out);
      assert.match(r.out, /CANNOT EVALUATE - DEPLOY_FRESHNESS_\w+ must be an integer from/);
      assert.strictEqual(r.seen.length, 0);
    }
  }],
  ['CLI: an unexpected shape exits 2', async () => {
    for (const [key, body] of [
      ['deployments', { message: 'not a list' }],
      ['commits/main', '<html>not json'],
      ['commits/main', { sha: '../../evil' }],
      ['actions/workflows/playwright-tests.yml/runs?queued', { workflow_runs: 'x' }],
      ['actions/workflows/playwright-tests.yml/runs?head_sha', { total_count: 2, workflow_runs: [] }],
    ]) {
      const r = await cli(freshRoutes({ [key]: [200, body] }));
      assert.strictEqual(r.code, 2, `${key}: ${r.out}`);
      assert.match(r.out, /CANNOT EVALUATE/);
    }
  }],
  ['CLI: a malformed head sha is never put into a URL', async () => {
    const r = await cli(freshRoutes({ 'commits/main': [200, { sha: '../../evil', commit: { committer: { date: ago(HOUR, now) } } }] }));
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, /main head sha is not a commit sha/);
    assert.strictEqual(r.seen.length, 1);
  }],
  ['CLI: a listed deployment with a malformed or missing field exits 2 before any scan', async () => {
    const bad = { ...D_OLD, created_at: 'garbage' };
    for (const deployments of [listed(D_HEAD, bad), listed(D_HEAD, { ...D_OLD, id: undefined }), listed(D_HEAD, { ...D_OLD, sha: 'x' })]) {
      const r = await cli(freshRoutes({ deployments }));
      assert.strictEqual(r.code, 2, r.out);
      assert.match(r.out, /CANNOT EVALUATE - deployment #1 /);
      assert.ok(!r.seen.some((s) => s.path.endsWith('/statuses')), 'no statuses fetched');
    }
  }],
  ['CLI: worst case makes exactly MAX_CALLS calls; a longer listing exits 2', async () => {
    const ten = Array.from({ length: DEPLOYMENT_LIMIT }, (_, i) => deployment(OLD, (i + 1) * HOUR, ['failure'], now));
    const routes = freshRoutes({ deployments: listed(...ten) });
    for (const d of ten) Object.assign(routes, statusesOf(d));
    const r = await cli(routes);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /\(no-successful-deployment\): No successful github-pages deployment among the 10 listed/);
    assert.strictEqual(r.seen.length, MAX_CALLS);
    const eleven = [...ten, deployment(OLDER, 20 * HOUR, ['success'], now)];
    const over = await cli(freshRoutes({ deployments: listed(...eleven) }));
    assert.strictEqual(over.code, 2, over.out);
    assert.match(over.out, /deployments listing holds more than 10/);
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
