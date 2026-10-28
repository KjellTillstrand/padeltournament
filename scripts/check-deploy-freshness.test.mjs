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
//     when it could see everything, retries a transient error once, fetches
//     the statuses of every listed deployment while staying inside its fetch
//     and time bounds, and fails closed (exit 2) otherwise.
// Plain assert, no dependencies, no network beyond 127.0.0.1. Exits non-zero
// if any case fails.

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clean, evaluate, InputError, DEPLOYMENT_LIMIT, MAX_CALLS, RUN_PAGE, STALE_AFTER_MS, STATUS_PAGE, WORST_CASE_MS,
} from './check-deploy-freshness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, 'check-deploy-freshness.mjs');
const WORKFLOWS = resolve(HERE, '../.github/workflows');
const WORKFLOW = resolve(WORKFLOWS, 'deploy-freshness.yml');
const TEST_AND_DEPLOY = resolve(WORKFLOWS, 'playwright-tests.yml');

const HOUR = STALE_AFTER_MS;
const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-03T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ago = (ms, now = NOW) => iso(now - ms);

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const OLDER = 'c'.repeat(40);
const PAGES_URL = 'https://o.github.io/r/';

const head = (sha = HEAD, age = 2 * HOUR, now = NOW) => ({ sha, commit: { committer: { date: ago(age, now) } } });
// Ids rise over time, as GitHub's do: a newer deployment or status has a higher id.
const depId = (age) => 1e9 - Math.floor(age / 1000);
const statusId = (age) => 2e9 - Math.floor(age / 1000);
// A deployment as listed, plus its statuses (newest first, as the API returns),
// one second apart. A "success" status carries `url` as its environment_url
// (the deploy job sets it only when actions/deploy-pages ran; withUrl() puts
// one on every state); updated_at is the newest status's time, as GitHub
// sets it (the monitor does not read it).
const deployment = (sha, age, states = ['success'], now = NOW, url = PAGES_URL) => {
  const statuses = states.map((s, i) => {
    const sAge = age - (states.length - i) * 1000;
    return { id: statusId(sAge), state: s, created_at: ago(sAge, now), environment_url: s === 'success' ? url : '' };
  });
  return { id: depId(age), sha, created_at: ago(age, now), updated_at: statuses[0]?.created_at ?? ago(age, now), statuses };
};
// The record a guard-skipped publish leaves: "success" with an empty environment_url.
const skipped = (sha, age, now = NOW) => deployment(sha, age, ['success', 'in_progress', 'queued', 'waiting'], now, '');
// A deployment that published at `pubAge` ago, whatever its created_at.
const publishedAt = (sha, createdAge, pubAge, now = NOW) => ({
  ...deployment(sha, createdAge, [], now),
  updated_at: ago(pubAge, now),
  statuses: [
    { id: statusId(pubAge), state: 'success', created_at: ago(pubAge, now), environment_url: PAGES_URL },
    { id: statusId(createdAge - 1000), state: 'waiting', created_at: ago(createdAge - 1000, now), environment_url: '' },
  ],
});
// The same deployment with a non-empty environment_url on EVERY status, so the
// latest status's state alone decides whether it is a publication.
const withUrl = (d) => ({ ...d, statuses: d.statuses.map((s) => ({ ...s, environment_url: PAGES_URL })) });
// GitHub's "inactive" status, added at `age` ago on top of a deployment's statuses.
const inactivated = (d, age, now = NOW) => ({
  ...d,
  updated_at: ago(age, now),
  statuses: [{ id: statusId(age), state: 'inactive', created_at: ago(age, now), environment_url: '' }, ...d.statuses],
});
// A push-event Test and deploy run on main of a sha (what the head's age is read from).
const pushRun = (sha, age, status = 'completed', conclusion = 'success', id = 500, now = NOW) => ({
  id,
  head_sha: sha,
  event: 'push',
  head_branch: 'main',
  status,
  conclusion: status === 'completed' ? conclusion : null,
  run_attempt: 1,
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

// Rollback fixtures (security review, round 2): X was published 48 h ago, Y
// 24 h ago (Pages serves Y); main was force-pushed back to X 3 h ago.
const X = HEAD;
const Y = OLD;
const rollback = (over) => input({ head: head(X, 49 * HOUR), deployments: [deployment(Y, 24 * HOUR), deployment(X, 48 * HOUR)], ...over });

const unitCases = [
  ['fresh: the head of main is the live publication -> no failures', () => {
    const r = evaluate(input());
    assert.deepStrictEqual(r.failures, []);
    assert.strictEqual(r.headLive, true);
    assert.strictEqual(r.live.sha, HEAD);
    assert.strictEqual(r.live.at, NOW - 90 * MIN + 1000);
    assert.strictEqual(r.deploymentsChecked, 1);
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
      'Main head aaaaaaa is not live 180 min after its push run was created (limit 60 min): github-pages serves ' +
        `bbbbbbb (deployment ${depId(4 * HOUR)}, published 2026-10-03T08:00:01.000Z). Its Test and deploy run 500 is ` +
        'still "waiting" 180 min after it was created: the run or its publication is stuck. ' +
        'https://github.com/o/r/actions/runs/500',
    );
  }],
  ['(a) names how a completed head run ended, neutrally (failure, cancelled, skipped, timed_out, other)', () => {
    const said = (conclusion) => evaluate(input({
      headRuns: [pushRun(HEAD, 2 * HOUR, 'completed', conclusion)],
      deployments: [deployment(OLD, 4 * HOUR)],
    })).failures[0].reason;
    const tail = (conclusion, outcome) =>
      new RegExp(`Its Test and deploy run 500 completed with conclusion "${conclusion}": ${outcome}\\. https://github\\.com/o/r/actions/runs/500$`);
    assert.match(said('failure'), tail('failure', 'the run failed \\(tests, a gate or the deploy job; see the run\\)'));
    assert.match(said('cancelled'), tail('cancelled', 'the run was cancelled \\(by hand, or replaced while it waited for the deploy-gh-pages concurrency group\\)'));
    assert.match(said('skipped'), tail('skipped', 'the run was skipped'));
    assert.match(said('timed_out'), tail('timed_out', 'a job of the run timed out'));
    assert.match(said('startup_failure'), tail('startup_failure', 'the run failed to start'));
    assert.match(said('neutral'), tail('neutral', 'the run did not succeed'));
    // An API value is never looked up as an object property.
    assert.match(said('constructor'), tail('constructor', 'the run did not succeed'));
    assert.match(said(null), tail('none', 'the run did not succeed'));
    for (const c of ['cancelled', 'skipped', 'timed_out']) assert.doesNotMatch(said(c), /failed|stuck/, c);
  }],
  ['(a) on a successful run without a live publication says the publication was skipped', () => {
    const r = evaluate(input({ deployments: [deployment(OLD, 4 * HOUR)] }));
    assert.match(r.failures[0].reason, /run 500 completed with conclusion "success", yet it is not the live publication: the publication was skipped or not recorded\./);
  }],
  ['(a) with no push run ([skip ci]) ages the head from its committer date and says so', () => {
    const r = evaluate(input({ head: head(HEAD, 2 * HOUR), headRuns: [], deployments: [deployment(OLD, 4 * HOUR)] }));
    assert.deepStrictEqual(codes(r), ['head-not-live']);
    assert.match(r.failures[0].reason, /is not live 120 min after its committer date \(limit 60 min\)/);
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
  ['a re-run of the head run keeps its clock and is called a re-run, not stuck', () => {
    const rerun = { ...pushRun(HEAD, 90 * MIN, 'in_progress'), run_attempt: 2, run_started_at: ago(5 * MIN) };
    const r = evaluate(input({ headRuns: [rerun], deployments: [deployment(OLD, 4 * HOUR)] }));
    assert.strictEqual(r.headSince, NOW - 90 * MIN);
    assert.deepStrictEqual(codes(r), ['head-not-live']);
    assert.match(
      r.failures[0].reason,
      /Its Test and deploy run 500 is being re-run \(attempt 2, now "in_progress"\); the run was first created 90 min ago, and a re-run does not restart the head's clock\. https:/,
    );
    assert.doesNotMatch(r.failures[0].reason, /stuck/);
    // Attempt 1 still reads as stuck.
    const first = evaluate(input({ headRuns: [pushRun(HEAD, 90 * MIN, 'in_progress')], deployments: [deployment(OLD, 4 * HOUR)] }));
    assert.match(first.failures[0].reason, /is still "in_progress" 90 min after it was created: the run or its publication is stuck/);
  }],
  ['a future committer date is refused only when it is the age source', () => {
    throwsInput(() => evaluate(input({ head: head(HEAD, -6 * MIN), headRuns: [] })), /main head committer date is 6 min in the future/);
    throwsInput(() => evaluate(input({ head: head(HEAD, -50 * 365 * 24 * HOUR), headRuns: [] })), /main head committer date is .* in the future/);
    // A clock-skewed pusher: the push run's server time is the age source, so
    // the future committer date is not judged.
    const skewed = evaluate(input({ head: head(HEAD, -10 * MIN) }));
    assert.deepStrictEqual(skewed.failures, []);
    assert.strictEqual(skewed.headSince, NOW - 2 * HOUR);
    // Clock skew within FUTURE_SKEW_MS is tolerated.
    assert.deepStrictEqual(evaluate(input({ head: head(HEAD, -4 * MIN), headRuns: [] })).failures, []);
  }],
  ['a future run or status time is not trusted (InputError, never silence)', () => {
    throwsInput(() => evaluate(input({ headRuns: [pushRun(HEAD, -6 * MIN)] })), /head run #0 created_at is 6 min in the future/);
    throwsInput(() => evaluate(input({ runs: [run(1, 'waiting', -6 * MIN)] })), /run #0 run_started_at is 6 min in the future/);
    throwsInput(
      () => evaluate(input({ runs: [{ ...run(1, 'queued', 0), run_started_at: undefined, created_at: ago(-30 * 24 * HOUR) }] })),
      /run #0 run_started_at is 43200 min in the future/,
    );
    throwsInput(() => evaluate(input({ deployments: [deployment(HEAD, -6 * MIN)] })), /deployment #0 status #0 created_at is .* in the future/);
    // Within FUTURE_SKEW_MS is tolerated.
    assert.deepStrictEqual(evaluate(input({ headRuns: [pushRun(HEAD, -4 * MIN)], runs: [run(1, 'waiting', -4 * MIN)] })).failures, []);
  }],
  ['a head run of another sha is refused', () => {
    throwsInput(() => evaluate(input({ headRuns: [pushRun(OLD, HOUR)] })), /head run #0 is not a run of the main head/);
  }],
  ['a pull_request run, or a push to another branch, at main\'s sha never sets the head\'s clock', () => {
    const deployments = [deployment(OLD, 4 * HOUR)];
    const pr = { ...pushRun(HEAD, 10 * MIN, 'in_progress', null, 800), event: 'pull_request', head_branch: 'feature' };
    const forkMain = { ...pushRun(HEAD, 10 * MIN, 'in_progress', null, 801), event: 'pull_request' };
    const otherBranch = { ...pushRun(HEAD, 10 * MIN, 'in_progress', null, 802), head_branch: 'release' };
    for (const other of [pr, forkMain, otherBranch]) {
      // Newer than the head's push run, yet the clock still runs from the push run.
      const r = evaluate(input({ headRuns: [other, pushRun(HEAD, 2 * HOUR)], deployments }));
      assert.deepStrictEqual(codes(r), ['head-not-live'], String(other.id));
      assert.strictEqual(r.headSince, NOW - 2 * HOUR, String(other.id));
      assert.strictEqual(r.headSinceSource, 'push run 500 created', String(other.id));
      assert.match(r.failures[0].reason, /is not live 120 min after its push run was created .* run 500 completed/, String(other.id));
      // Alone, it is as if no run were listed: the committer date is the age source.
      const alone = evaluate(input({ head: head(HEAD, 3 * HOUR), headRuns: [other], deployments }));
      assert.strictEqual(alone.headSinceSource, 'committer date (no push run)', String(other.id));
      assert.match(alone.failures[0].reason, /is not live 180 min after its committer date .* No push-event Test and deploy run exists/, String(other.id));
    }
  }],
  ['a newer "success" record with an empty environment_url (skipped publish) is not a publication', () => {
    // A's run reaches its deploy job after B (the head) published; its
    // freshness guard skips publishing, but the job succeeds, so GitHub
    // records a newer "success" for A, without an environment_url.
    const r = evaluate(input({ deployments: [skipped(OLD, 20 * MIN), deployment(HEAD, 40 * MIN)] }));
    assert.deepStrictEqual(r.failures, []);
    assert.strictEqual(r.headLive, true);
    assert.strictEqual(r.live.sha, HEAD);
  }],
  ['a latest status other than "success" is no publication, even with an environment_url', () => {
    for (const state of ['failure', 'error', 'in_progress', 'queued', 'pending', 'waiting']) {
      // The head's only deployment: published once, then a later status of `state`.
      const none = evaluate(input({ deployments: [withUrl(deployment(HEAD, 90 * MIN, [state, 'success']))] }));
      assert.deepStrictEqual(codes(none), ['no-publication'], state);
      assert.strictEqual(none.live, undefined, state);
      assert.strictEqual(none.headLive, false, state);
      // A newer non-success record of the head with a url does not displace
      // the older publication Pages serves.
      const other = evaluate(input({ deployments: [withUrl(deployment(HEAD, 30 * MIN, [state])), deployment(OLD, 4 * HOUR)] }));
      assert.deepStrictEqual(codes(other), ['head-not-live'], state);
      assert.strictEqual(other.live.sha, OLD, state);
    }
  }],
  ['the head\'s only record a skipped publish -> not live; an absent, null or blank url is no publication either', () => {
    const r = evaluate(input({ deployments: [skipped(HEAD, 30 * MIN), deployment(OLD, 4 * HOUR)] }));
    assert.deepStrictEqual(codes(r), ['head-not-live']);
    assert.match(r.failures[0].reason, /github-pages serves bbbbbbb/);
    for (const url of [undefined, null, '', '  ']) {
      const d = deployment(HEAD, 90 * MIN);
      if (url === undefined) delete d.statuses[0].environment_url;
      else d.statuses[0].environment_url = url;
      const none = evaluate(input({ deployments: [d] }));
      assert.deepStrictEqual(codes(none), ['no-publication'], String(url));
      assert.strictEqual(none.live, undefined);
    }
  }],
  ['rollback: an older published record of the head does not make it live (reviewer fixture)', () => {
    const r = evaluate(rollback({ headRuns: [pushRun(X, 2 * HOUR)] }));
    assert.deepStrictEqual(codes(r), ['head-not-live']);
    assert.strictEqual(r.headLive, false);
    assert.strictEqual(r.live.sha, Y);
  }],
  ['rollback A: the rollback run was cancelled -> head-not-live, Pages still serves Y', () => {
    const headRuns = [pushRun(X, 49 * HOUR, 'completed', 'success', 400), pushRun(X, 3 * HOUR, 'completed', 'cancelled', 700)];
    const r = evaluate(rollback({ headRuns }));
    assert.deepStrictEqual(codes(r), ['head-not-live']);
    assert.match(r.failures[0].reason, /^Main head aaaaaaa is not live 180 min after its push run was created \(limit 60 min\): github-pages serves bbbbbbb /);
    assert.match(r.failures[0].reason, /run 700 completed with conclusion "cancelled": the run was cancelled/);
  }],
  ['rollback B: no run for the rollback push (the query returns X\'s original run) -> head-not-live', () => {
    const r = evaluate(rollback({ headRuns: [pushRun(X, 49 * HOUR, 'completed', 'success', 400)] }));
    assert.deepStrictEqual(codes(r), ['head-not-live']);
    assert.match(r.failures[0].reason, /is not live 2940 min after its push run was created/);
  }],
  ['rollback C: X\'s only record is a skipped publish, the rollback run failed -> head-not-live', () => {
    const r = evaluate(input({
      head: head(X, 25 * HOUR),
      headRuns: [pushRun(X, 3 * HOUR, 'completed', 'failure', 701)],
      deployments: [skipped(X, 24 * HOUR - 10 * MIN), deployment(Y, 24 * HOUR)],
    }));
    assert.deepStrictEqual(codes(r), ['head-not-live']);
    assert.strictEqual(r.live.sha, Y);
  }],
  ['publications are ordered by their success time, not by deployment created_at', () => {
    // OLD's deployment was created first but published last: Pages serves OLD.
    const r = evaluate(input({ deployments: [deployment(HEAD, 2 * HOUR), publishedAt(OLD, 3 * HOUR, 30 * MIN)] }));
    assert.deepStrictEqual(codes(r), ['head-not-live']);
    assert.strictEqual(r.live.sha, OLD);
    const reversed = evaluate(input({ deployments: [publishedAt(HEAD, 3 * HOUR, 30 * MIN), deployment(OLD, 2 * HOUR)] }));
    assert.deepStrictEqual(reversed.failures, []);
  }],
  ['two publications in the same second: the higher status id is the newer', () => {
    const at = ago(HOUR);
    const pub = (sha, age, id) => ({
      ...deployment(sha, age, [], NOW),
      updated_at: at,
      statuses: [{ id, state: 'success', created_at: at, environment_url: PAGES_URL }],
    });
    assert.deepStrictEqual(evaluate(input({ deployments: [pub(HEAD, 2 * HOUR, 9), pub(OLD, 3 * HOUR, 8)] })).failures, []);
    assert.deepStrictEqual(codes(evaluate(input({ deployments: [pub(HEAD, 2 * HOUR, 8), pub(OLD, 3 * HOUR, 9)] }))), ['head-not-live']);
  }],
  ['"inactive" is passed over: a later skipped record does not un-publish the head', () => {
    const r = evaluate(input({ deployments: [skipped(OLD, 20 * MIN), inactivated(deployment(HEAD, 40 * MIN), 20 * MIN - 9000)] }));
    assert.deepStrictEqual(r.failures, []);
    assert.strictEqual(r.live.sha, HEAD);
    // An inactive older publication stays older than a newer one.
    const older = evaluate(input({ deployments: [deployment(OLD, 30 * MIN), inactivated(deployment(HEAD, 3 * HOUR), 30 * MIN - 2000)] }));
    assert.deepStrictEqual(codes(older), ['head-not-live']);
    assert.strictEqual(older.live.sha, OLD);
    // Inactive alone, or after a failure, is no publication.
    assert.deepStrictEqual(codes(evaluate(input({ deployments: [deployment(HEAD, 90 * MIN, ['inactive', 'failure'])] }))), ['no-publication']);
  }],
  ['the newest publication decides, in any listing order', () => {
    const deployments = [deployment(HEAD, 20 * MIN, ['failure']), deployment(OLD, 5 * HOUR), deployment(HEAD, 2 * HOUR)];
    const shuffles = [[0, 1, 2], [2, 0, 1], [1, 2, 0], [2, 1, 0]];
    for (const order of shuffles) {
      const r = evaluate(input({ deployments: order.map((i) => deployments[i]) }));
      assert.deepStrictEqual(r.failures, [], String(order));
      assert.strictEqual(r.live.deploymentId, depId(2 * HOUR), String(order));
    }
  }],
  ['latest status decides, whatever the listing order of statuses', () => {
    const d = deployment(HEAD, 2 * HOUR, ['success', 'in_progress']);
    d.statuses.reverse();
    assert.deepStrictEqual(evaluate(input({ deployments: [d] })).failures, []);
    const failed = deployment(HEAD, 2 * HOUR, ['failure', 'success']);
    failed.statuses.reverse();
    assert.deepStrictEqual(codes(evaluate(input({ deployments: [failed] }))), ['no-publication']);
  }],
  ['statuses with the same timestamp: the higher id is the latest', () => {
    const at = ago(HOUR);
    const tie = (successId, progressId) => ({
      ...deployment(HEAD, 2 * HOUR),
      statuses: [
        { id: progressId, state: 'in_progress', created_at: at, environment_url: '' },
        { id: successId, state: 'success', created_at: at, environment_url: PAGES_URL },
      ],
    });
    assert.deepStrictEqual(evaluate(input({ deployments: [tie(9, 8)] })).failures, []);
    assert.deepStrictEqual(codes(evaluate(input({ deployments: [tie(8, 9)] }))), ['no-publication']);
  }],
  ['no publication at all: the same grace hour as head-not-live, then no-publication', () => {
    for (const deployments of [[], [deployment(HEAD, 10 * MIN, ['in_progress'])], [deployment(HEAD, 2 * HOUR, [])], [skipped(OLD, 2 * HOUR)]]) {
      const inGrace = evaluate(input({ head: head(HEAD, 5 * MIN), headRuns: [pushRun(HEAD, 5 * MIN, 'in_progress')], deployments }));
      assert.deepStrictEqual(inGrace.failures, []);
      assert.strictEqual(inGrace.headLive, false);
      const late = evaluate(input({ headRuns: [pushRun(HEAD, HOUR + 1, 'in_progress')], deployments }));
      assert.deepStrictEqual(codes(late), ['no-publication']);
      assert.strictEqual(
        late.failures[0].reason,
        `Main head aaaaaaa is not live 60 min after its push run was created (limit 60 min): none of the ${deployments.length} ` +
          'github-pages deployments checked records a publication (a latest "success" status with an environment_url). ' +
          'Its Test and deploy run 500 is still "in_progress" 60 min after it was created: the run or its publication is stuck. ' +
          'https://github.com/o/r/actions/runs/500',
      );
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
    const files = [CLI, fileURLToPath(import.meta.url), WORKFLOW, TEST_AND_DEPLOY];
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
    throwsInput(() => evaluate(input({ headRuns: [{ ...pushRun(HEAD, HOUR), id: -5 }] })), /head run #0 has no integer id/);
    throwsInput(() => evaluate(input({ headRuns: [{ ...pushRun(HEAD, HOUR), status: 3 }] })), /head run #0 has no status/);
    throwsInput(() => evaluate(input({ headRuns: [{ ...pushRun(HEAD, HOUR), event: undefined }] })), /head run #0 has no event/);
    throwsInput(() => evaluate(input({ headRuns: [{ ...pushRun(HEAD, HOUR), head_branch: null }] })), /head run #0 has no head_branch/);
    // A passed-over run (not a push to main) is validated too.
    throwsInput(() => evaluate(input({ headRuns: [{ ...pushRun(HEAD, HOUR), event: 'pull_request', created_at: 'x' }] })), /head run #0 created_at is not a timestamp/);
    throwsInput(() => evaluate(input({ headRuns: [{ ...pushRun(HEAD, HOUR), conclusion: 1 }] })), /head run #0 has a malformed conclusion/);
    for (const runAttempt of [0, '2', 1.5]) {
      throwsInput(() => evaluate(input({ headRuns: [{ ...pushRun(HEAD, HOUR), run_attempt: runAttempt }] })), /head run #0 has a malformed run_attempt/);
    }
    throwsInput(() => evaluate(input({ headRuns: [{ ...pushRun(HEAD, HOUR), created_at: 'x' }] })), /head run #0 created_at is not a timestamp/);
    throwsInput(() => evaluate(input({ deployments: { message: 'Not Found' } })), /deployments is not an array/);
    throwsInput(() => evaluate(input({ runs: null })), /runs is not an array/);
    throwsInput(() => evaluate(input({ deployments: [42] })), /deployment #0 is not an object/);
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), sha: undefined }] })), /deployment #0 sha/);
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), id: undefined }] })), /deployment #0 has no integer id/);
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), created_at: '' }] })), /deployment #0 created_at is not a timestamp/);
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), statuses: undefined }] })), /deployment #0 has no "statuses" array/);
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), statuses: [{ id: 1, created_at: ago(1) }] }] })), /status #0 has no state/);
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), statuses: [{ state: 'success', created_at: ago(1) }] }] })), /status #0 has no integer id/);
    throwsInput(
      () => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), statuses: [{ id: 1, state: 'success', created_at: ago(1), environment_url: 7 }] }] })),
      /status #0 has a malformed environment_url/,
    );
    // An "inactive" status is validated too, though it is passed over.
    throwsInput(() => evaluate(input({ deployments: [{ ...deployment(HEAD, HOUR), statuses: [{ id: 1, state: 'inactive', created_at: 'x' }] }] })), /status #0 created_at is not a timestamp/);
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
    assert.strictEqual(WORST_CASE_MS, 17 * 18 * 1000);
  }],
  ['coupling: the deploy job alone uses github-pages, its url only through the freshness-gated deploy-pages step', () => {
    // The monitor reads a "success" status as a publication only when it
    // carries an environment_url (see COUPLING in the script's header). That
    // is sound only while the url is deploy-pages' output, deploy-pages runs
    // only when the freshness guard says the run is current, a deploy-pages
    // failure fails the job, and no other job records github-pages
    // deployments: any other url, non-empty on a guard-skipped deploy or set
    // by another job, would turn the monitor falsely green.
    const COUPLING = 'breaks the github-pages coupling the deploy freshness monitor relies on ' +
      '(see COUPLING in the header of scripts/check-deploy-freshness.mjs)';
    // A line without its YAML comment (a # at the start or after whitespace).
    const code = (line) => line.replace(/(^|\s)#.*$/, '').trimEnd();
    const lines = readFileSync(TEST_AND_DEPLOY, 'utf8').split('\n');
    const start = lines.indexOf('  deploy:');
    assert.ok(start >= 0, 'playwright-tests.yml has a deploy job');
    // The job ends at the next line indented 0-2 spaces that is not a comment.
    const end = lines.findIndex((line, i) => i > start && /^ {0,2}[^\s#]/.test(line));
    const job = lines.slice(start + 1, end < 0 ? lines.length : end);
    // The lines of the job-level block opened by `key:`, comments and blanks dropped.
    const block = (key) => {
      const at = job.indexOf(`    ${key}:`);
      assert.ok(at >= 0, `the deploy job has ${key}:`);
      const rest = job.slice(at + 1);
      const stop = rest.findIndex((line) => /^ {0,4}[^\s#]/.test(line));
      return rest.slice(0, stop < 0 ? rest.length : stop).filter((line) => line.trim() !== '' && !/^\s*#/.test(line));
    };
    const environment = block('environment');
    assert.deepStrictEqual(environment, [
      '      name: github-pages',
      '      url: ${{ steps.deployment.outputs.page_url }}',
    ], `the deploy job's environment block ${COUPLING}:\n${environment.join('\n')}`);
    // Split the steps at each "      - " list item.
    const steps = [];
    for (const line of block('steps')) {
      if (/^ {6}- /.test(line)) steps.push([]);
      steps.at(-1)?.push(line);
    }
    const withId = (id) => steps.filter((step) => step.some((line) => new RegExp(`^ {6}(- | {2})id: ${id}\\s*$`).test(line)));
    const deploying = withId('deployment');
    assert.strictEqual(deploying.length, 1, `exactly one step has id: deployment; otherwise the deploy job ${COUPLING}`);
    // The whole step, line for line (trailing comments dropped); only the
    // action's pinned sha may change.
    const [step] = deploying;
    assert.deepStrictEqual(step.map(code).map((line) => line.replace(/^( {8}uses: actions\/deploy-pages@)[0-9a-f]{40}$/, '$1<sha>')), [
      '      - name: Deploy to GitHub Pages',
      '        id: deployment',
      "        if: steps.freshness.outputs.current == 'true'",
      '        uses: actions/deploy-pages@<sha>',
      '        with:',
      '          artifact_name: ${{ env.PAGES_ARTIFACT }}',
    ], `the id: deployment step ${COUPLING}:\n${step.join('\n')}`);
    assert.strictEqual(withId('freshness').length, 1, `exactly one step has id: freshness; otherwise the deploy job ${COUPLING}`);
    // No continue-on-error anywhere in the job (job or step level): a
    // deploy-pages failure kept green could record "success" with a url.
    const tolerated = job
      .map((line, i) => [start + 2 + i, code(line)])
      .filter(([, text]) => /continue-on-error/i.test(text))
      .map(([n, text]) => `playwright-tests.yml:${n}: ${text.trim()}`);
    assert.deepStrictEqual(tolerated, [], `continue-on-error in the deploy job ${COUPLING}:\n${tolerated.join('\n')}`);
    // github-pages is used as an environment exactly once, in every workflow:
    // the deploy job's environment name. Any non-comment mention counts
    // (environment: github-pages, environment: { name: github-pages },
    // name: github-pages; environment names are case-insensitive), except the
    // github-pages-<attempt> artifact name.
    const nameAt = lines.findIndex((line, i) => i > start + 1 + job.indexOf('    environment:') && line === '      name: github-pages');
    const users = [];
    for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/i.test(f)).sort()) {
      readFileSync(resolve(WORKFLOWS, file), 'utf8').split('\n').forEach((line, i) => {
        if (/\bgithub-pages\b(?!-)/i.test(code(line))) users.push(`${file}:${i + 1}: ${code(line).trim()}`);
      });
    }
    assert.deepStrictEqual(users, [`playwright-tests.yml:${nameAt + 1}: name: github-pages`],
      `github-pages must be used as an environment only by the deploy job of playwright-tests.yml; ` +
        `another user ${COUPLING}:\n${users.join('\n')}`);
  }],
];

// ---- CLI black box against a loopback fixture server -----------------------

const CHILD_LIMIT_MS = 15 * 1000;

// routes: key -> [status, body, headers?] | 'hang' (never answers) | (n) =>
// either of those, for the n-th request to that key (1-based). The key is the
// path without /repos/o/r/, plus "?<status>" for a status listing or
// "?head_sha" for the head's push runs. Unlisted keys answer 404.
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
    const [code, body, headers = {}] = answer;
    res.writeHead(code, { 'content-type': 'application/json', ...headers });
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
const statusesOf = (...ds) => Object.fromEntries(ds.map((d) => [`deployments/${d.id}/statuses`, [200, d.statuses]]));
const D_HEAD = deployment(HEAD, 2 * HOUR, ['success'], now);
const D_OLD = deployment(OLD, 5 * HOUR, ['success'], now);
const D_OLDER = deployment(OLDER, 8 * HOUR, ['success'], now);
const freshRoutes = (over = {}) => ({
  'commits/heads/main': [200, head(HEAD, 3 * HOUR, now)],
  'actions/workflows/playwright-tests.yml/runs?head_sha': runsPage([pushRun(HEAD, 3 * HOUR, 'completed', 'success', 500, now)]),
  deployments: listed(D_HEAD, D_OLD),
  ...statusesOf(D_HEAD, D_OLD),
  'actions/workflows/playwright-tests.yml/runs?waiting': runsPage(),
  'actions/workflows/playwright-tests.yml/runs?queued': runsPage(),
  'actions/workflows/playwright-tests.yml/runs?pending': runsPage(),
  'actions/workflows/playwright-tests.yml/runs?requested': runsPage(),
  ...over,
});
// The deployment ids whose statuses the CLI requested, in request order.
const statusCalls = (r) => r.seen
  .map((s) => /\/deployments\/(\d+)\/statuses$/.exec(s.path)?.[1])
  .filter(Boolean)
  .map(Number);
const CANNOT = '^::error::DEPLOY FRESHNESS: CANNOT EVALUATE - ';

const cliCases = [
  ['CLI: fresh repo exits 0, sends the token, stays inside its page bounds, reads the main branch', async () => {
    const r = await cli(freshRoutes());
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DEPLOY FRESHNESS OK/);
    assert.match(r.out, /head reached main: .* \(push run 500 created\)/);
    assert.match(r.out, new RegExp(`^live publication: {3}a{40} \\(deployment ${D_HEAD.id}, published `, 'm'));
    assert.match(r.out, /^head is live: {7}yes$/m);
    assert.match(r.out, /^deployments checked: 2 \(every one listed\)$/m);
    assert.ok(r.seen.every((s) => s.auth === 'Bearer fixture-token'), 'every request is authenticated');
    assert.strictEqual(r.seen[0].path, '/repos/o/r/commits/heads/main', 'the head is read from the branch ref');
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
    assert.deepStrictEqual(statusCalls(r), [D_HEAD.id, D_OLD.id], 'every listed deployment\'s statuses, newest first');
    assert.strictEqual(r.seen.length, 3 + 2 + 4);
    assert.doesNotMatch(r.out, /fixture-token/);
  }],
  ['CLI: a shuffled listing is fetched newest first, every deployment', async () => {
    const r = await cli(freshRoutes({ deployments: listed(D_OLD, D_OLDER, D_HEAD), ...statusesOf(D_OLDER) }));
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(statusCalls(r), [D_HEAD.id, D_OLD.id, D_OLDER.id]);
  }],
  ['CLI: newest deployment in progress, an older one published -> that one is live', async () => {
    const inProgress = deployment(HEAD, 20 * MIN, ['in_progress', 'queued'], now);
    const routes = (age) => freshRoutes({
      'actions/workflows/playwright-tests.yml/runs?head_sha': runsPage([pushRun(HEAD, age, 'in_progress', null, 500, now)]),
      deployments: listed(D_OLDER, inProgress, D_OLD),
      ...statusesOf(inProgress, D_OLDER),
    });
    const inGrace = await cli(routes(30 * MIN));
    assert.strictEqual(inGrace.code, 0, inGrace.out);
    assert.deepStrictEqual(statusCalls(inGrace), [inProgress.id, D_OLD.id, D_OLDER.id]);
    assert.match(inGrace.out, /^live publication: {3}b{40} /m);
    const late = await cli(routes(3 * HOUR));
    assert.strictEqual(late.code, 1, late.out);
    assert.match(late.out, /^::error::DEPLOY FRESHNESS \(head-not-live\): Main head aaaaaaa is not live 180 min .* github-pages serves bbbbbbb .* Its Test and deploy run 500 is still "in_progress"/m);
  }],
  ['CLI: a newer skipped-publish record of an older sha does not hide the live head', async () => {
    const skip = skipped(OLD, 20 * MIN, now);
    const r = await cli(freshRoutes({ deployments: listed(skip, D_HEAD, D_OLD), ...statusesOf(skip) }));
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(statusCalls(r), [skip.id, D_HEAD.id, D_OLD.id]);
    assert.match(r.out, /^head is live: {7}yes$/m);
  }],
  ['CLI: rollback to a once-published sha is red, though its older record is fetched', async () => {
    const y = deployment(OLD, 24 * HOUR, ['success'], now);
    const x = deployment(HEAD, 48 * HOUR, ['success'], now);
    const r = await cli(freshRoutes({
      'commits/heads/main': [200, head(HEAD, 49 * HOUR, now)],
      'actions/workflows/playwright-tests.yml/runs?head_sha': runsPage([pushRun(HEAD, 3 * HOUR, 'completed', 'cancelled', 700, now)]),
      deployments: listed(y, x),
      ...statusesOf(y, x),
    }));
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /\(head-not-live\): Main head aaaaaaa is not live 180 min .* github-pages serves bbbbbbb .* conclusion "cancelled": the run was cancelled/);
    assert.deepStrictEqual(statusCalls(r), [y.id, x.id]);
  }],
  ['CLI: an older deployment published after the head\'s is live, whatever its updated_at says', async () => {
    // OLD's deployment was created before the head's but published after it;
    // its listed updated_at is stale (long before the head's publication), so
    // a scan that trusted updated_at would stop before it.
    const late = { ...publishedAt(OLD, 3 * HOUR, 30 * MIN, now), updated_at: ago(3 * HOUR, now) };
    const r = await cli(freshRoutes({ deployments: listed(D_HEAD, late, D_OLDER), ...statusesOf(late, D_OLDER) }));
    assert.strictEqual(r.code, 1, r.out);
    assert.deepStrictEqual(statusCalls(r), [D_HEAD.id, late.id, D_OLDER.id]);
    assert.match(r.out, /\(head-not-live\): .* github-pages serves bbbbbbb /);
  }],
  ['CLI: stale deployment and stalled run exit 1 with one ::error:: each', async () => {
    const r = await cli(freshRoutes({
      deployments: listed(D_OLD),
      'actions/workflows/playwright-tests.yml/runs?waiting': runsPage([run(99, 'waiting', 30 * HOUR, now)]),
      'actions/workflows/playwright-tests.yml/runs?queued': runsPage([run(99, 'queued', 30 * HOUR, now)]),
    }));
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /^::error::DEPLOY FRESHNESS \(head-not-live\): Main head aaaaaaa is not live/m);
    assert.strictEqual(r.out.match(/\(stalled-run\): Test and deploy run 99 /g)?.length, 1, r.out);
    assert.match(r.out, /stalled-status runs listed: 1$/m);
  }],
  ['CLI: a transient 5xx, 429, rate-limit 403 or network error is retried once', async () => {
    const twice = (first) => (n) => (n === 1 ? first : freshRoutes()['commits/heads/main']);
    for (const first of [
      [502, { message: 'bad gateway' }],
      [429, { message: 'slow down' }],
      [403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }],
      [403, { message: 'secondary rate limit' }, { 'retry-after': '60' }],
    ]) {
      const r = await cli(freshRoutes({ 'commits/heads/main': twice(first) }));
      assert.strictEqual(r.code, 0, `${first[0]}: ${r.out}`);
      assert.strictEqual(r.hits['commits/heads/main'], 2);
    }
    const r = await cli(freshRoutes({
      'actions/workflows/playwright-tests.yml/runs?pending': (n) => (n === 1 ? 'hang' : runsPage()),
    }), { DEPLOY_FRESHNESS_TIMEOUT_MS: '300' });
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(r.hits['actions/workflows/playwright-tests.yml/runs?pending'], 2);
  }],
  ['CLI: an API error that persists exits 2 after exactly one retry, never 0', async () => {
    for (const key of ['commits/heads/main', 'deployments', 'actions/workflows/playwright-tests.yml/runs?pending']) {
      const r = await cli(freshRoutes({ [key]: [500, { message: 'boom' }] }));
      assert.strictEqual(r.code, 2, `${key}: ${r.out}`);
      assert.match(r.out, new RegExp(`${CANNOT}GET .* failed after 2 attempts: HTTP 500$`, 'm'));
      assert.strictEqual(r.hits[key], 2, key);
    }
    const limited = await cli(freshRoutes({ deployments: [403, { message: 'rate limited' }, { 'x-ratelimit-remaining': '0' }] }));
    assert.strictEqual(limited.code, 2, limited.out);
    assert.match(limited.out, new RegExp(`${CANNOT}GET deployments\\?environment=github-pages&per_page=10 failed after 2 attempts: HTTP 403 \\(rate limit\\)$`, 'm'));
    assert.strictEqual(limited.hits.deployments, 2);
  }],
  ['CLI: a 4xx other than 429 or a rate-limit 403 is not retried', async () => {
    for (const answer of [[403, { message: 'forbidden' }], [403, { message: 'forbidden' }, { 'x-ratelimit-remaining': '4999' }], [404, { message: 'Not Found' }]]) {
      const r = await cli(freshRoutes({ deployments: answer }));
      assert.strictEqual(r.code, 2, r.out);
      assert.match(r.out, new RegExp(`${CANNOT}GET deployments\\?environment=github-pages&per_page=10 returned HTTP ${answer[0]}$`, 'm'));
      assert.strictEqual(r.hits.deployments, 1);
    }
  }],
  ['CLI: a request that never answers times out, and the run still exits 2 on its own', async () => {
    const r = await cli(freshRoutes({ 'commits/heads/main': 'hang' }), { DEPLOY_FRESHNESS_TIMEOUT_MS: '200' });
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, new RegExp(`${CANNOT}GET commits/heads/main failed after 2 attempts: network error \\(timeout\\)$`, 'm'));
    assert.strictEqual(r.hits['commits/heads/main'], 2);
  }],
  ['CLI: a network error is reported by code, never by the fetch error message', async () => {
    const closed = createServer();
    await new Promise((ok) => closed.listen(0, '127.0.0.1', ok));
    const { port } = closed.address();
    await new Promise((ok) => closed.close(ok));
    const r = await cli(freshRoutes(), { GITHUB_API_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, new RegExp(`${CANNOT}GET commits/heads/main failed after 2 attempts: network error \\(ECONNREFUSED\\)$`, 'm'));
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
  ['CLI: the token is masked even when an API value echoes it, whole or truncated', async () => {
    const long = `ghs_${'Q'.repeat(60)}TAILSECRET${'z'.repeat(19)}`;
    for (const token of ['fixture-token', long]) {
      const echo = { sha: HEAD, commit: { committer: { date: token } } };
      const r = await cli(freshRoutes({ 'commits/heads/main': [200, echo] }), { GITHUB_TOKEN: token });
      assert.strictEqual(r.code, 2, r.out);
      assert.match(r.out, /CANNOT EVALUATE - main head committer date is not a timestamp: "\*\*\*"$/m);
      assert.ok(!r.out.includes(token.slice(0, 8)), `no prefix of the ${token.length}-character token in: ${r.out}`);
    }
  }],
  ['CLI: a malformed GITHUB_REPOSITORY is refused before any request', async () => {
    for (const repo of ['o', 'o/r/../../x', 'o/r?x=1', '../o/r']) {
      const r = await cli(freshRoutes(), { GITHUB_REPOSITORY: repo });
      assert.strictEqual(r.code, 2, `${repo}: ${r.out}`);
      assert.match(r.out, new RegExp(`${CANNOT}GITHUB_REPOSITORY must be set to <owner>/<repo>$`, 'm'));
      assert.strictEqual(r.seen.length, 0, repo);
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
      ['commits/heads/main', '<html>not json'],
      ['commits/heads/main', { sha: '../../evil' }],
      ['actions/workflows/playwright-tests.yml/runs?queued', { workflow_runs: 'x' }],
      ['actions/workflows/playwright-tests.yml/runs?head_sha', { total_count: 2, workflow_runs: [] }],
      [`deployments/${D_HEAD.id}/statuses`, { message: 'not a list' }],
    ]) {
      const r = await cli(freshRoutes({ [key]: [200, body] }));
      assert.strictEqual(r.code, 2, `${key}: ${r.out}`);
      assert.match(r.out, /CANNOT EVALUATE/);
    }
  }],
  ['CLI: a malformed head sha is never put into a URL', async () => {
    const r = await cli(freshRoutes({ 'commits/heads/main': [200, { sha: '../../evil', commit: { committer: { date: ago(HOUR, now) } } }] }));
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, /main head sha is not a commit sha/);
    assert.strictEqual(r.seen.length, 1);
  }],
  ['CLI: a listed deployment with a malformed or missing field exits 2 before any scan', async () => {
    for (const bad of [{ ...D_OLD, created_at: 'garbage' }, { ...D_OLD, id: undefined }, { ...D_OLD, id: '1/../../x' }, { ...D_OLD, sha: 'x' }]) {
      const r = await cli(freshRoutes({ deployments: listed(D_HEAD, bad) }));
      assert.strictEqual(r.code, 2, r.out);
      assert.match(r.out, /CANNOT EVALUATE - deployment #1 /);
      assert.deepStrictEqual(statusCalls(r), [], 'no statuses fetched');
    }
  }],
  ['CLI: a full listing makes exactly MAX_CALLS calls, fresh or not; a longer listing exits 2', async () => {
    const ten = Array.from({ length: DEPLOYMENT_LIMIT }, (_, i) => deployment(OLD, (i + 1) * HOUR, ['failure'], now));
    const r = await cli(freshRoutes({ deployments: listed(...ten), ...statusesOf(...ten) }));
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /\(no-publication\): Main head aaaaaaa is not live 180 min .* none of the 10 github-pages deployments checked records a publication/);
    assert.strictEqual(r.seen.length, MAX_CALLS);
    // The newest deployment is the live head: every other one is fetched all the same.
    const fresh = [deployment(HEAD, 30 * MIN, ['success'], now), ...ten.slice(1)];
    const all = await cli(freshRoutes({ deployments: listed(...fresh), ...statusesOf(...fresh) }));
    assert.strictEqual(all.code, 0, all.out);
    assert.strictEqual(all.seen.length, MAX_CALLS);
    assert.deepStrictEqual(statusCalls(all), fresh.map((d) => d.id));
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
