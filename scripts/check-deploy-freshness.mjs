#!/usr/bin/env node
// Deploy freshness monitor (AB#65).
//
// Usage: GITHUB_REPOSITORY=<owner>/<repo> GITHUB_TOKEN=<token> \
//          node scripts/check-deploy-freshness.mjs
//   GITHUB_API_URL is honoured (Actions sets it); it defaults to
//   https://api.github.com. Only https, or http to a loopback host (used by
//   the self-test), is accepted, so the token is never sent in clear text.
//   The token must be printable ASCII with no whitespace; it is never echoed.
//   DEPLOY_FRESHNESS_TIMEOUT_MS and DEPLOY_FRESHNESS_RETRY_DELAY_MS may only
//   SHORTEN the per-request timeout and the retry delay (the self-test uses
//   them); they cannot raise the time budget below.
//
// Why: run 36765228696 sat in "waiting" on the github-pages environment from
// 2026-09-30 to 2026-10-03. It held the deploy-gh-pages concurrency group
// (cancel-in-progress: false), so later deploys were silently cancelled and
// merged work was not live for three days. Nothing went red. This check turns
// both symptoms into a red run within hours (.github/workflows/
// deploy-freshness.yml runs it hourly).
//
// It fails when either:
//   (a) the head of main has no github-pages deployment whose latest status is
//       "success", and the head reached main more than STALE_AFTER_MS ago.
//       What counts is a deployment OF THE HEAD SHA, not the newest "success"
//       record: when the deploy job's freshness guard skips publishing (main
//       has moved on), the job still succeeds, so GitHub records a "success"
//       deployment for that older, unpublished sha, possibly after the newer
//       sha was published. No successful deployment at all among those fetched
//       is also a failure, with no grace period.
//       When the head reached main is server-set: the created_at of the
//       push-event Test and deploy run for the head sha (the newest one, should
//       main have been pushed to that sha twice). With no such run (a
//       [skip ci] push, CI never started, or the run not created yet) the
//       committer date is used instead. A committer date or run time more than
//       FUTURE_SKEW_MS in the future is not trusted and exits 2: a future date
//       would otherwise hold (a) silent until that date.
//       (a) also fires when the run on main failed or never ran, which is not a
//       stalled publication; its error therefore says what is known about the
//       head's run (none, still running/waiting, or completed with which
//       conclusion).
//   (b) a "Test and deploy" run (playwright-tests.yml) has been in a stalled
//       status (waiting, queued, pending or requested) for more than
//       STALE_AFTER_MS, measured from the run attempt's start (run_started_at,
//       falling back to created_at). A re-run attempt therefore gets a fresh
//       clock instead of being judged by the original run's age. The API does
//       not expose when a run entered its current status, so a run that ran
//       its tests for 30 min and then waited 31 min also trips (b); the test
//       job takes 20-35 min, well inside the hour.
//       "requested" is not named by the story but is included: it is the status
//       of a run GitHub has created and not yet queued, the API's status filter
//       accepts it, and a run stuck there blocks exactly like a queued one.
//       Any run counts (any branch, PR runs too): a zombie run left in one of
//       these statuses by a GitHub incident keeps the monitor red until it is
//       cancelled, by design. A run listed under two statuses (it moved between
//       the listing calls) is judged and reported once.
// Boundary: both limits are strict ("more than"): an age of exactly one hour
// passes, one millisecond more fails.
//
// Detection only: it reads, never cancels, approves or re-runs anything.
//
// Exit codes:
//   0  the head of main is deployed (or still in its grace hour) and no run is
//      stalled
//   1  one or more of the failures above (each printed as an ::error:: line)
//   2  the monitor could not see: bad environment, an API call failed (after
//      one retry) or returned an unexpected shape, a timestamp in the future,
//      or a listing exceeded the bounds below. A monitor that cannot see never
//      reports green.
//
// Fetch bounds (each a single page, no further pagination):
//   - main head: one call; its push-event runs: one call (RUN_PAGE).
//   - deployments: the DEPLOYMENT_LIMIT newest github-pages deployments, then
//     the statuses (STATUS_PAGE) of each, newest first, only until the head's
//     deployment is found live, or a successful one has been found and no
//     deployment of the head is left to check. The head's deployment is created
//     after every older commit's run started, so it is among the newest; if it
//     is not listed, (a) reports the head as not live (a false red, never a
//     false green).
//   - runs: one page of RUN_PAGE runs per stalled status. If GitHub reports
//     more runs in a status than one page holds, the oldest (most likely
//     stalled) ones could be on a later page, so that exits 2 instead.
// Time budget: at most MAX_CALLS (17) calls, each tried at most ATTEMPTS (2)
// times with a REQUEST_TIMEOUT_MS (8 s) timeout that also covers reading the
// body, and one RETRY_DELAY_MS (2 s) pause before the retry: WORST_CASE_MS =
// 17 x (8 + 2 + 8) s = 5 min 6 s. The workflow's timeout-minutes (10) leaves
// room for checkout and setup-node, so the script always exits on its own,
// with its own CANNOT EVALUATE annotation; the self-test asserts the margin.
// A retry happens only on a network error or timeout, HTTP 5xx or HTTP 429;
// if the retry fails too, it exits 2.
//
// The decision is the pure function evaluate(), exported for the fixture
// self-test (scripts/check-deploy-freshness.test.mjs); the CLI below it only
// fetches and prints what evaluate() decided. API data is treated as
// untrusted: every string echoed to the log goes through clean(), and no
// error message from fetch (which can quote request headers) is ever printed.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STALE_AFTER_MS = 60 * 60 * 1000;
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
export const STALLED_STATUSES = ['waiting', 'queued', 'pending', 'requested'];
export const WORKFLOW_FILE = 'playwright-tests.yml';
export const ENVIRONMENT = 'github-pages';
export const DEPLOYMENT_LIMIT = 10;
export const STATUS_PAGE = 100;
export const RUN_PAGE = 100;
export const REQUEST_TIMEOUT_MS = 8 * 1000;
export const RETRY_DELAY_MS = 2 * 1000;
export const ATTEMPTS = 2;
// main head + its push runs + the deployment listing + one statuses call per
// listed deployment + one runs page per stalled status.
export const MAX_CALLS = 3 + DEPLOYMENT_LIMIT + STALLED_STATUSES.length;
export const WORST_CASE_MS = MAX_CALLS * (ATTEMPTS * REQUEST_TIMEOUT_MS + (ATTEMPTS - 1) * RETRY_DELAY_MS);

const EXIT_STALE = 1;
const EXIT_CANNOT_SEE = 2;

const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOKEN_RE = /^[\x21-\x7e]{1,1024}$/;

// Raised for any input the monitor cannot trust; the CLI maps it to exit 2.
export class InputError extends Error {}

// Make an untrusted string safe to echo into a CI log: no C0/C1 control
// characters (so no newline can start a "::command" line), no invisible
// direction or line controls (bidi embeddings, overrides and isolates, the
// LRM/RLM/ALM marks, zero-width characters, LINE and PARAGRAPH SEPARATOR,
// BOM), and no legacy "##[command]" marker. Escapes only: no invisible
// character is written literally in this file.
const UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
export function clean(value, max = 200) {
  return String(value)
    .replace(UNSAFE_RE, ' ')
    .replace(/##\[/g, '# #[')
    .slice(0, max);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function time(value, label) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw new InputError(`${label} is not a timestamp: ${JSON.stringify(clean(value, 60))}`);
  return ms;
}

// A time that must already have happened (allowing for clock skew).
function past(ms, now, label) {
  if (ms - now > FUTURE_SKEW_MS) {
    throw new InputError(`${label} is ${minutes(ms - now)} in the future (more than ${minutes(FUTURE_SKEW_MS)}); not trusted`);
  }
  return ms;
}

function sha(value, label) {
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    throw new InputError(`${label} is not a commit sha: ${JSON.stringify(clean(value, 60))}`);
  }
  return value;
}

function intId(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new InputError(`${label} has no integer id`);
  return value;
}

function minutes(ms) {
  return `${Math.floor(ms / 60000)} min`;
}

// Newest first: by time, then by id (ids rise over time; a tie in the
// one-second timestamps is broken by the higher id).
const newer = (x, y) => y.at - x.at || y.id - x.id;

// The newest status of one deployment, or undefined when it has none.
export function latestState(deployment, label) {
  if (!Array.isArray(deployment.statuses)) throw new InputError(`${label} has no "statuses" array`);
  let latest;
  for (const [i, s] of deployment.statuses.entries()) {
    const sLabel = `${label} status #${i}`;
    if (!isObject(s) || typeof s.state !== 'string') throw new InputError(`${sLabel} has no state`);
    const candidate = { at: time(s.created_at, `${sLabel} created_at`), id: intId(s.id, sLabel), state: s.state };
    if (!latest || newer(candidate, latest) < 0) latest = candidate;
  }
  return latest?.state;
}

// One deployment as listed, validated: everything the sort and the decision use.
export function listedDeployment(d, label) {
  if (!isObject(d)) throw new InputError(`${label} is not an object`);
  return { id: intId(d.id, label), sha: sha(d.sha, `${label} sha`), at: time(d.created_at, `${label} created_at`) };
}

// What is known about the head's push run, for the (a) message.
function describeHeadRun(run, now) {
  if (!run) {
    return 'No push-event Test and deploy run exists for it (a [skip ci] commit, or CI never started), ' +
      'so nothing will publish it before the next push to main.';
  }
  const ref = `Its Test and deploy run ${run.id}`;
  const url = run.url ? ` ${clean(run.url, 120)}` : '';
  if (run.status !== 'completed') {
    return `${ref} is still "${clean(run.status, 20)}" ${minutes(now - run.at)} after it was created: ` +
      `the run or its publication is stuck.${url}`;
  }
  if (run.conclusion === 'success') {
    return `${ref} completed with conclusion "success", yet no deployment of the head is live: ` +
      `the publication was skipped or not recorded.${url}`;
  }
  return `${ref} completed with conclusion "${clean(run.conclusion ?? 'none', 20)}": the run failed ` +
    `(tests, a gate or the deploy job; see the run), not necessarily the publication.${url}`;
}

/**
 * Decide whether Pages publication is stalled. Pure: no I/O, no clock.
 *
 * @param {object} input
 * @param {number} input.now          current time, epoch ms
 * @param {object} input.head         GET repos/{repo}/commits/main (sha, commit.committer.date)
 * @param {object[]} input.headRuns   push-event "Test and deploy" runs for the head sha
 *                                    (id, head_sha, status, conclusion, created_at, html_url)
 * @param {object[]} input.deployments github-pages deployments (id, sha, created_at), each with a
 *                                    `statuses` array as returned by its statuses endpoint
 * @param {object[]} input.runs       "Test and deploy" workflow runs in a stalled status (id,
 *                                    status, run_started_at|created_at, html_url)
 * @returns {{failures: {code: string, reason: string}[], headSha: string, headLive: boolean,
 *            headSince: number, headSinceSource: string, newestSuccess: string|undefined,
 *            runsListed: number}} failures is empty when fresh; the rest is what was judged
 * @throws {InputError} when any input is missing or malformed (fail closed)
 */
export function evaluate({ now, head, headRuns, deployments, runs } = {}) {
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new InputError('"now" is not a time');
  if (!isObject(head) || !isObject(head.commit) || !isObject(head.commit.committer)) {
    throw new InputError('main head has no commit.committer');
  }
  const headSha = sha(head.sha, 'main head sha');
  const committed = past(time(head.commit.committer.date, 'main head committer date'), now, 'main head committer date');
  if (!Array.isArray(headRuns)) throw new InputError('head runs is not an array');
  if (!Array.isArray(deployments)) throw new InputError('deployments is not an array');
  if (!Array.isArray(runs)) throw new InputError('runs is not an array');

  // When did the head reach main? The newest push run for it, else its committer date.
  let headRun;
  for (const [i, r] of headRuns.entries()) {
    const label = `head run #${i}`;
    if (!isObject(r)) throw new InputError(`${label} is not an object`);
    if (r.head_sha !== headSha) throw new InputError(`${label} is not a run of the main head`);
    if (typeof r.status !== 'string') throw new InputError(`${label} has no status`);
    if (r.conclusion != null && typeof r.conclusion !== 'string') throw new InputError(`${label} has a malformed conclusion`);
    const candidate = {
      id: intId(r.id, label),
      at: past(time(r.created_at, `${label} created_at`), now, `${label} created_at`),
      status: r.status,
      conclusion: r.conclusion ?? null,
      url: r.html_url,
    };
    if (!headRun || newer(candidate, headRun) < 0) headRun = candidate;
  }
  const headSince = headRun ? headRun.at : committed;
  const headSinceSource = headRun ? `push run ${headRun.id} created` : 'committer date (no push run)';
  const headAge = now - headSince;

  const failures = [];

  // (a) Is the head of main itself deployed?
  const listed = deployments.map((d, i) => {
    const label = `deployment #${i}`;
    return { ...listedDeployment(d, label), state: latestState(d, label) };
  });
  listed.sort(newer);
  const headLive = listed.some((d) => d.sha === headSha && d.state === 'success');
  const newestSuccess = listed.find((d) => d.state === 'success');
  if (!newestSuccess) {
    failures.push({
      code: 'no-successful-deployment',
      reason:
        `No successful ${ENVIRONMENT} deployment among the ${deployments.length} listed: ` +
        `main head ${headSha.slice(0, 7)} is not live.`,
    });
  } else if (!headLive && headAge > STALE_AFTER_MS) {
    failures.push({
      code: 'head-not-live',
      reason:
        `Main head ${headSha.slice(0, 7)} has no successful ${ENVIRONMENT} deployment ${minutes(headAge)} after its ` +
        `${headRun ? 'push run was created' : 'committer date'} (limit ${minutes(STALE_AFTER_MS)}); the newest ` +
        `successful deployment record is ${newestSuccess.sha.slice(0, 7)}. ${describeHeadRun(headRun, now)}`,
    });
  }

  // (b) Is any Test and deploy run stuck before or between its jobs?
  const seen = new Set();
  for (const [i, run] of runs.entries()) {
    const label = `run #${i}`;
    if (!isObject(run) || typeof run.status !== 'string') throw new InputError(`${label} has no status`);
    const id = intId(run.id, label);
    if (seen.has(id)) continue;
    seen.add(id);
    if (!STALLED_STATUSES.includes(run.status)) continue;
    const started = time(run.run_started_at ?? run.created_at, `${label} run_started_at`);
    const age = now - started;
    if (age > STALE_AFTER_MS) {
      failures.push({
        code: 'stalled-run',
        reason:
          `Test and deploy run ${id} has been "${clean(run.status, 20)}" since an attempt ` +
          `started ${minutes(age)} ago (limit ${minutes(STALE_AFTER_MS)}): ${clean(run.html_url ?? '', 120)}`,
      });
    }
  }
  return { failures, headSha, headLive, headSince, headSinceSource, newestSuccess: newestSuccess?.sha, runsListed: seen.size };
}

// ---------------------------------------------------------------- CLI ----

function cannotSee(message) {
  let text = String(message);
  // Belt and braces: no message is built from the token, but never print it.
  const token = process.env.GITHUB_TOKEN;
  if (token && token.length >= 4) text = text.replaceAll(token, '***');
  console.log(`::error::DEPLOY FRESHNESS: CANNOT EVALUATE - ${clean(text, 400)}`);
  console.error('A monitor that cannot see never reports green.');
  process.exit(EXIT_CANNOT_SEE);
}

// A short, token-free name for a thrown error. err.message is never used: a
// fetch error can quote the Authorization header.
function errorCode(err) {
  if (err?.name === 'TimeoutError') return 'timeout';
  const code = err?.cause?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,40}$/.test(code)) return code;
  const name = err?.name;
  return typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'unknown';
}

function apiBase(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new InputError('GITHUB_API_URL is not a URL');
  }
  if (url.username || url.password) throw new InputError('GITHUB_API_URL must not carry credentials');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new InputError('GITHUB_API_URL must be https (or http to a loopback host)');
  }
  return url.href.replace(/\/+$/, '');
}

// An optional env override that may only shorten a default duration.
function shorterThan(name, max, min) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return max;
  const ms = /^[0-9]{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!(ms >= min && ms <= max)) throw new InputError(`${name} must be an integer from ${min} to ${max}`);
  return ms;
}

// A runs listing page, validated; refuses a partial list.
function runsOf(page, what) {
  if (!isObject(page) || !Array.isArray(page.workflow_runs) || !Number.isSafeInteger(page.total_count)) {
    throw new InputError(`runs listing for ${what} has an unexpected shape`);
  }
  if (page.total_count > page.workflow_runs.length) {
    throw new InputError(
      `${page.total_count} runs are ${what}, more than one page (${RUN_PAGE}) holds; not judging a partial list`,
    );
  }
  return page.workflow_runs;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const token = process.env.GITHUB_TOKEN ?? '';
  if (!REPO_RE.test(repo)) throw new InputError('GITHUB_REPOSITORY must be set to <owner>/<repo>');
  if (!token) throw new InputError('GITHUB_TOKEN is not set');
  if (!TOKEN_RE.test(token)) throw new InputError('GITHUB_TOKEN is malformed (expected printable ASCII, no whitespace)');
  const base = apiBase(process.env.GITHUB_API_URL || 'https://api.github.com');
  const timeoutMs = shorterThan('DEPLOY_FRESHNESS_TIMEOUT_MS', REQUEST_TIMEOUT_MS, 1);
  const retryDelayMs = shorterThan('DEPLOY_FRESHNESS_RETRY_DELAY_MS', RETRY_DELAY_MS, 0);

  const get = async (path) => {
    let why;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      if (attempt > 1) await new Promise((ok) => setTimeout(ok, retryDelayMs));
      let res;
      try {
        res = await fetch(`${base}/repos/${repo}/${path}`, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'check-deploy-freshness',
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        why = `network error (${errorCode(err)})`;
        continue;
      }
      if (res.status >= 500 || res.status === 429) {
        why = `HTTP ${res.status}`;
        await res.body?.cancel().catch(() => {});
        continue;
      }
      if (!res.ok) throw new InputError(`GET ${path} returned HTTP ${res.status}`);
      let text;
      try {
        text = await res.text();
      } catch (err) {
        why = `network error (${errorCode(err)})`;
        continue;
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new InputError(`GET ${path} did not return JSON`);
      }
    }
    throw new InputError(`GET ${path} failed after ${ATTEMPTS} attempts: ${why}`);
  };

  const head = await get('commits/main');
  // Validated before it is put into a URL.
  const headSha = sha(isObject(head) ? head.sha : undefined, 'main head sha');

  const headRuns = runsOf(
    await get(`actions/workflows/${WORKFLOW_FILE}/runs?branch=main&event=push&head_sha=${headSha}&per_page=${RUN_PAGE}`),
    `push runs of ${headSha.slice(0, 7)}`,
  );

  const listing = await get(`deployments?environment=${ENVIRONMENT}&per_page=${DEPLOYMENT_LIMIT}`);
  if (!Array.isArray(listing)) throw new InputError('deployments listing is not an array');
  if (listing.length > DEPLOYMENT_LIMIT) throw new InputError(`deployments listing holds more than ${DEPLOYMENT_LIMIT}`);
  // Validate before sorting: a missing or malformed field must not scramble
  // the order the scan below stops on.
  const byAge = listing.map((d, i) => ({ d, ...listedDeployment(d, `deployment #${i}`) })).sort(newer);
  // Fetch statuses newest first, only as far as the decision needs (see the
  // header); evaluate() makes the decision on what was fetched.
  const deployments = [];
  let anySuccess = false;
  for (const [i, entry] of byAge.entries()) {
    const statuses = await get(`deployments/${entry.id}/statuses?per_page=${STATUS_PAGE}`);
    deployments.push({ ...entry.d, statuses });
    const success = latestState({ statuses }, `deployment ${entry.id}`) === 'success';
    if (success && entry.sha === headSha) break;
    anySuccess ||= success;
    if (anySuccess && !byAge.slice(i + 1).some((later) => later.sha === headSha)) break;
  }

  const runs = [];
  for (const status of STALLED_STATUSES) {
    runs.push(...runsOf(await get(`actions/workflows/${WORKFLOW_FILE}/runs?status=${status}&per_page=${RUN_PAGE}`), `"${status}"`));
  }

  const result = evaluate({ now: Date.now(), head, headRuns, deployments, runs });
  console.log(`main head:          ${result.headSha}`);
  console.log(`head reached main:  ${new Date(result.headSince).toISOString()} (${result.headSinceSource})`);
  console.log(`head deployed:      ${result.headLive ? 'yes' : 'no'}`);
  console.log(`newest successful deployment record: ${result.newestSuccess ?? '(none)'}`);
  console.log(`stalled-status runs listed: ${result.runsListed}`);
  if (result.failures.length > 0) {
    for (const f of result.failures) console.log(`::error::DEPLOY FRESHNESS (${f.code}): ${f.reason}`);
    console.error(`DEPLOY FRESHNESS FAILED: ${result.failures.length} problem(s); see the errors above.`);
    process.exit(EXIT_STALE);
  }
  console.log('DEPLOY FRESHNESS OK: the head of main is deployed (or in its grace hour) and no Test and deploy run is stalled.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => cannotSee(err instanceof InputError ? err.message : `unexpected error (${errorCode(err)})`));
}
