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
//   (a) the head of main is not what GitHub Pages serves, and the head reached
//       main more than STALE_AFTER_MS ago. One rule, one grace hour, whether
//       Pages serves another sha or no publication is found at all.
//       What Pages serves ("live") is the newest PUBLICATION: a github-pages
//       deployment whose latest status is "success" and carries a non-empty
//       environment_url, ordered by that success status's created_at (the
//       status id breaks a tie). Only the newest publication counts, so an
//       older record of the head sha does not make it live: after main is
//       rolled back to a sha that was published before, the newer sha Pages
//       still serves is the live one until the rollback itself is published.
//       COUPLING to .github/workflows/playwright-tests.yml: its deploy job sets
//       environment.url to exactly ${{ steps.deployment.outputs.page_url }},
//       the output of its actions/deploy-pages step (id: deployment), and that
//       step runs only if steps.freshness.outputs.current == 'true'. So a
//       success status carries an environment_url only when deploy-pages ran.
//       When the job's freshness guard skips publishing (main has moved on),
//       the job still succeeds and GitHub records "success" with an EMPTY
//       environment_url (live data 2026-10-26: skipped 32cafe6 = deployment
//       7245089193 and 5ffd3ea = 7248393700 empty; published 9c4159e =
//       7274264074, 684bb60 = 7265740918, d0917b3 = 7245103323 set). Removing
//       that url makes every success read as "no publication", and (a) goes
//       red after the grace hour: a false red. Replacing it with anything that
//       is non-empty on a skipped deploy (a literal, another step's output)
//       would make guard-skipped successes count as publications: a false
//       green. The self-test therefore pins all three: the url expression, and
//       the one step with id: deployment, line for line (it uses
//       actions/deploy-pages at a pinned sha, under the freshness condition).
//       It also pins two things the monitor cannot see in the API. First, the
//       deploy job is the only github-pages environment user: the monitor
//       counts every github-pages success with a url, whichever job or
//       workflow made it, so the self-test scans every file in
//       .github/workflows/ and requires the deploy job's environment name to
//       be the one non-comment mention of github-pages (case-insensitive; the
//       github-pages-<attempt> artifact name is another name). Second, the
//       deploy job has no continue-on-error, at job or step level: a
//       deploy-pages failure kept green could record "success" with a url.
//       Accepted residual: a deployment made outside this repo's workflows
//       (by hand, through the API) is not covered.
//       "inactive" statuses are passed over when finding the latest status.
//       GitHub may add one to a deployment a newer one superseded; none of the
//       30 newest github-pages deployments here carries one (2026-10-26). If
//       one appears, a skipped publish of an older sha must not un-publish the
//       head it "superseded"; ordering by publication time already decides
//       which publication is live. Accepted residual: "inactive" is ALWAYS
//       passed over, so a publication GitHub deactivates for another reason
//       (the site unpublished, say) still reads as live: a false green, until
//       a newer head of main is published or trips (a).
//       The time the head reached main is server-set: the created_at of the
//       push-event Test and deploy run on main for the head sha (the newest
//       one, should main have been pushed to that sha twice). The listing asks
//       for exactly those runs (branch=main, event=push, head_sha); a listed
//       run of another sha is refused (exit 2: the listing did not answer the
//       question asked), while a listed run whose event is not "push" or whose
//       head_branch is not "main" (a pull_request run at the same sha, a push
//       to another branch) is a real run, just not the head's push: it is
//       validated like any run (a malformed one exits 2), then passed over, so
//       it never sets the clock. Its event and head_branch must be strings (a
//       run without them exits 2, so a dropped field cannot silently demote
//       every run to a passed-over one). A
//       re-run of the push run keeps its created_at, so a re-run does not
//       restart the clock: the head has not been live for that long. The
//       message then says the run is being re-run rather than stuck. With no
//       such run (a [skip ci] push, CI never started, or the run not created
//       yet) the committer date is used instead.
//       (a) also fires when the run on main failed or never ran, which is not a
//       stalled publication; its error therefore says what is known about the
//       head's run (none, being re-run, still running/waiting, or completed
//       with which conclusion).
//       Accepted residual: the grace hour is per head. Pushes to main arriving
//       less than an hour apart that all fail to publish never trip (a), since
//       each new head restarts the clock; each failing run is red in CI itself,
//       and a run left waiting trips (b).
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
// Future times: every time a verdict rests on (the head's push run, the
// committer date when it is the age source, deployment status times, stalled
// run times) more than FUTURE_SKEW_MS in the future is not trusted and exits
// 2; a future time would otherwise hold a check silent until that date. A
// committer date that is NOT the age source (a push run exists) is not judged:
// a clock-skewed pusher must not blind the monitor. A deployment's created_at
// only orders the listing (its statuses decide what is live), so it is
// validated as a timestamp but not judged; its updated_at is not read.
// Accepted residual: "now" is read once, before the first call, and call k of
// the scan (below) can end up to k x 18 s after it: WORST_CASE_MS (306 s) for
// the last, more than FUTURE_SKEW_MS (300 s). The statuses calls are calls 4
// to 13 at most and end within 234 s, so no status can read as future; only
// the last runs listing can. In a pathological scan where every earlier call
// needed its retry and each retry answered just inside its timeout, a run
// started in the scan's last seconds can read as more than FUTURE_SKEW_MS in
// the future and exit 2: a false red only.
//
// Detection only: it reads, never cancels, approves or re-runs anything.
//
// Exit codes:
//   0  the head of main is live (or still in its grace hour) and no run is
//      stalled
//   1  one or more of the failures above (each printed as an ::error:: line)
//   2  the monitor could not see: bad environment, an API call failed (after
//      one retry) or returned an unexpected shape, a timestamp in the future,
//      or a listing exceeded the bounds below. A monitor that cannot see never
//      reports green.
//
// Fetch bounds (each a single page, no further pagination):
//   - main head: one call (commits/heads/main: the branch, so a tag named
//     main cannot stand in for it); its push-event runs: one call (RUN_PAGE).
//   - deployments: the DEPLOYMENT_LIMIT newest github-pages deployments,
//     validated and ordered newest first (orderDeployments(), shared with
//     evaluate()) before any statuses call, then the statuses (STATUS_PAGE)
//     of EVERY listed deployment; evaluate() picks the newest publication
//     among them. There is no early stop: no listing field (updated_at
//     included) is trusted to say which deployment holds the newest status,
//     so the scan is always 1 + (number listed) calls, at most
//     1 + DEPLOYMENT_LIMIT. A publication older than the DEPLOYMENT_LIMIT
//     newest records is not seen; that reads as "no publication" (a false
//     red, never a false green).
//   - runs: one page of RUN_PAGE runs per stalled status. If GitHub reports
//     more runs in a status than one page holds, the oldest (most likely
//     stalled) ones could be on a later page, so that exits 2 instead.
// Time budget: at most MAX_CALLS (17) calls, each tried at most ATTEMPTS (2)
// times with a REQUEST_TIMEOUT_MS (8 s) timeout that also covers reading the
// body, and one RETRY_DELAY_MS (2 s) pause before the retry: WORST_CASE_MS =
// 17 x (8 + 2 + 8) s = 5 min 6 s. The workflow's timeout-minutes (10) leaves
// room for checkout and setup-node, so the script always exits on its own,
// with its own CANNOT EVALUATE annotation; the self-test asserts the margin.
// A retry happens only on a network error or timeout, HTTP 5xx, HTTP 429, or
// an HTTP 403 that is a rate limit (x-ratelimit-remaining: 0 or a
// retry-after header); any other 403 is not retried. The pause stays the
// fixed RETRY_DELAY_MS whatever retry-after asks for (the budget above), so a
// rate limit that outlasts it still exits 2.
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

const iso = (ms) => new Date(ms).toISOString();

// Newest first: by time, then by id (ids rise over time; a tie in the
// one-second timestamps is broken by the higher id).
const newer = (x, y) => y.at - x.at || y.id - x.id;

// The newer of two publications (either may be undefined).
function newest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return newer(b, a) < 0 ? b : a;
}

/**
 * Validate a list of github-pages deployments and order it newest first (by
 * created_at, then id). The ONE place deployments are validated and ordered:
 * the CLI validates the listing with it before any statuses call (an id goes
 * into a URL), and evaluate() uses it too. Labels name the position in the
 * list as given.
 *
 * @returns {{id: number, sha: string, at: number, label: string, raw: object}[]}
 */
export function orderDeployments(list) {
  if (!Array.isArray(list)) throw new InputError('deployments is not an array');
  return list
    .map((d, i) => {
      const label = `deployment #${i}`;
      if (!isObject(d)) throw new InputError(`${label} is not an object`);
      return {
        id: intId(d.id, label),
        sha: sha(d.sha, `${label} sha`),
        at: time(d.created_at, `${label} created_at`),
        label,
        raw: d,
      };
    })
    .sort(newer);
}

/**
 * The publication one deployment records, or undefined: its latest status
 * other than "inactive" must be "success" with a non-empty environment_url
 * (see the header: the url is set only when actions/deploy-pages ran). Every
 * status is validated, "inactive" ones too.
 *
 * @returns {{sha: string, deploymentId: number, at: number, id: number}|undefined}
 *          at/id are the success status's created_at and id
 */
function publicationOf(deployment, statuses, now) {
  const { label } = deployment;
  if (!Array.isArray(statuses)) throw new InputError(`${label} has no "statuses" array`);
  let latest;
  for (const [i, s] of statuses.entries()) {
    const sLabel = `${label} status #${i}`;
    if (!isObject(s) || typeof s.state !== 'string') throw new InputError(`${sLabel} has no state`);
    const url = s.environment_url ?? '';
    if (typeof url !== 'string') throw new InputError(`${sLabel} has a malformed environment_url`);
    const candidate = {
      at: past(time(s.created_at, `${sLabel} created_at`), now, `${sLabel} created_at`),
      id: intId(s.id, sLabel),
      state: s.state,
      url,
    };
    if (candidate.state === 'inactive') continue;
    if (!latest || newer(candidate, latest) < 0) latest = candidate;
  }
  if (latest?.state !== 'success' || latest.url.trim() === '') return undefined;
  return { sha: deployment.sha, deploymentId: deployment.id, at: latest.at, id: latest.id };
}

// How a completed, unsuccessful head run ended, by conclusion. A Map, so an
// API-supplied conclusion can never select an inherited object property.
const OUTCOME = new Map([
  ['failure', 'the run failed (tests, a gate or the deploy job; see the run)'],
  ['cancelled', 'the run was cancelled (by hand, or replaced while it waited for the deploy-gh-pages concurrency group)'],
  ['timed_out', 'a job of the run timed out'],
  ['skipped', 'the run was skipped'],
  ['startup_failure', 'the run failed to start'],
]);

// What is known about the head's push run, for the (a) message.
function describeHeadRun(run, now) {
  if (!run) {
    return 'No push-event Test and deploy run exists for it (a [skip ci] commit, or CI never started), ' +
      'so nothing will publish it before the next push to main.';
  }
  const ref = `Its Test and deploy run ${run.id}`;
  const url = run.url ? ` ${clean(run.url, 120)}` : '';
  if (run.status !== 'completed') {
    if (run.attempt > 1) {
      return `${ref} is being re-run (attempt ${run.attempt}, now "${clean(run.status, 20)}"); the run was first ` +
        `created ${minutes(now - run.at)} ago, and a re-run does not restart the head's clock.${url}`;
    }
    return `${ref} is still "${clean(run.status, 20)}" ${minutes(now - run.at)} after it was created: ` +
      `the run or its publication is stuck.${url}`;
  }
  if (run.conclusion === 'success') {
    return `${ref} completed with conclusion "success", yet it is not the live publication: ` +
      `the publication was skipped or not recorded.${url}`;
  }
  const conclusion = run.conclusion ?? 'none';
  const outcome = OUTCOME.get(conclusion) ?? 'the run did not succeed';
  return `${ref} completed with conclusion "${clean(conclusion, 20)}": ${outcome}.${url}`;
}

/**
 * Decide whether Pages publication is stalled. Pure: no I/O, no clock.
 *
 * @param {object} input
 * @param {number} input.now          current time, epoch ms
 * @param {object} input.head         GET repos/{repo}/commits/heads/main (sha, commit.committer.date)
 * @param {object[]} input.headRuns   push-event "Test and deploy" runs on main for the head sha
 *                                    (id, head_sha, event, head_branch, status, conclusion,
 *                                    run_attempt, created_at, html_url); a run whose event is not
 *                                    "push" or head_branch not "main" is passed over
 * @param {object[]} input.deployments github-pages deployments (id, sha, created_at),
 *                                    each with a `statuses` array as returned by its statuses
 *                                    endpoint (state, id, created_at, environment_url)
 * @param {object[]} input.runs       "Test and deploy" workflow runs in a stalled status (id,
 *                                    status, run_started_at|created_at, html_url)
 * @returns {{failures: {code: string, reason: string}[], headSha: string, headLive: boolean,
 *            headSince: number, headSinceSource: string,
 *            live: {sha: string, deploymentId: number, at: number, id: number}|undefined,
 *            deploymentsChecked: number, runsListed: number}}
 *          failures is empty when fresh; the rest is what was judged
 * @throws {InputError} when any input is missing or malformed (fail closed)
 */
export function evaluate({ now, head, headRuns, deployments, runs } = {}) {
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new InputError('"now" is not a time');
  if (!isObject(head) || !isObject(head.commit) || !isObject(head.commit.committer)) {
    throw new InputError('main head has no commit.committer');
  }
  const headSha = sha(head.sha, 'main head sha');
  const committed = time(head.commit.committer.date, 'main head committer date');
  if (!Array.isArray(headRuns)) throw new InputError('head runs is not an array');
  if (!Array.isArray(deployments)) throw new InputError('deployments is not an array');
  if (!Array.isArray(runs)) throw new InputError('runs is not an array');

  // When did the head reach main? The newest push run on main for it, else its
  // committer date.
  let headRun;
  for (const [i, r] of headRuns.entries()) {
    const label = `head run #${i}`;
    if (!isObject(r)) throw new InputError(`${label} is not an object`);
    if (r.head_sha !== headSha) throw new InputError(`${label} is not a run of the main head`);
    if (typeof r.event !== 'string') throw new InputError(`${label} has no event`);
    if (typeof r.head_branch !== 'string') throw new InputError(`${label} has no head_branch`);
    if (typeof r.status !== 'string') throw new InputError(`${label} has no status`);
    if (r.conclusion != null && typeof r.conclusion !== 'string') throw new InputError(`${label} has a malformed conclusion`);
    const attempt = r.run_attempt ?? 1;
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new InputError(`${label} has a malformed run_attempt`);
    const candidate = {
      id: intId(r.id, label),
      at: past(time(r.created_at, `${label} created_at`), now, `${label} created_at`),
      status: r.status,
      conclusion: r.conclusion ?? null,
      attempt,
      url: r.html_url,
    };
    // Validated, then passed over: not the head's push to main (see the header).
    if (r.event !== 'push' || r.head_branch !== 'main') continue;
    if (!headRun || newer(candidate, headRun) < 0) headRun = candidate;
  }
  // The committer date is judged against the future only when it is the age source.
  const headSince = headRun ? headRun.at : past(committed, now, 'main head committer date');
  const headSinceSource = headRun ? `push run ${headRun.id} created` : 'committer date (no push run)';
  const headAge = now - headSince;

  const failures = [];

  // (a) Is the head of main what Pages serves?
  const ordered = orderDeployments(deployments);
  let live;
  for (const entry of ordered) live = newest(live, publicationOf(entry, entry.raw.statuses, now));
  const headLive = live?.sha === headSha;
  if (!headLive && headAge > STALE_AFTER_MS) {
    const since =
      `${minutes(headAge)} after its ${headRun ? 'push run was created' : 'committer date'} ` +
      `(limit ${minutes(STALE_AFTER_MS)})`;
    failures.push(
      live
        ? {
          code: 'head-not-live',
          reason:
            `Main head ${headSha.slice(0, 7)} is not live ${since}: ${ENVIRONMENT} serves ` +
            `${live.sha.slice(0, 7)} (deployment ${live.deploymentId}, published ${iso(live.at)}). ` +
            describeHeadRun(headRun, now),
        }
        : {
          code: 'no-publication',
          reason:
            `Main head ${headSha.slice(0, 7)} is not live ${since}: none of the ${ordered.length} ` +
            `${ENVIRONMENT} deployments checked records a publication (a latest "success" status ` +
            `with an environment_url). ${describeHeadRun(headRun, now)}`,
        },
    );
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
    const startLabel = `${label} run_started_at`;
    const started = past(time(run.run_started_at ?? run.created_at, startLabel), now, startLabel);
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
  return {
    failures, headSha, headLive, headSince, headSinceSource, live, deploymentsChecked: ordered.length, runsListed: seen.size,
  };
}

// ---------------------------------------------------------------- CLI ----

function cannotSee(message) {
  let text = String(message);
  // Belt and braces: no message is built from the token, but never print it.
  // Echoed API values are truncated before they get here, so a prefix of the
  // token (8 characters or more, longest first) is masked too.
  const token = process.env.GITHUB_TOKEN;
  if (token && token.length >= 4) {
    for (let n = token.length; n >= Math.min(token.length, 8); n -= 1) text = text.replaceAll(token.slice(0, n), '***');
  }
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

// Worth one retry: a server error, or a rate limit (429, or a 403 that says so).
function transient(res) {
  if (res.status >= 500 || res.status === 429) return `HTTP ${res.status}`;
  if (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'))) {
    return 'HTTP 403 (rate limit)';
  }
  return undefined;
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
      const retryable = transient(res);
      if (retryable) {
        why = retryable;
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

  // One clock for the scan and the decision.
  const now = Date.now();

  const head = await get('commits/heads/main');
  // Validated before it is put into a URL.
  const headSha = sha(isObject(head) ? head.sha : undefined, 'main head sha');

  const headRuns = runsOf(
    await get(`actions/workflows/${WORKFLOW_FILE}/runs?branch=main&event=push&head_sha=${headSha}&per_page=${RUN_PAGE}`),
    `push runs of ${headSha.slice(0, 7)}`,
  );

  const listing = await get(`deployments?environment=${ENVIRONMENT}&per_page=${DEPLOYMENT_LIMIT}`);
  if (!Array.isArray(listing)) throw new InputError('deployments listing is not an array');
  if (listing.length > DEPLOYMENT_LIMIT) throw new InputError(`deployments listing holds more than ${DEPLOYMENT_LIMIT}`);
  // Validated and ordered before any statuses call (a malformed id must never
  // reach a URL), by the same function evaluate() uses. Every listed
  // deployment's statuses are fetched; evaluate() picks the newest publication.
  const deployments = [];
  for (const entry of orderDeployments(listing)) {
    deployments.push({ ...entry.raw, statuses: await get(`deployments/${entry.id}/statuses?per_page=${STATUS_PAGE}`) });
  }

  const runs = [];
  for (const status of STALLED_STATUSES) {
    runs.push(...runsOf(await get(`actions/workflows/${WORKFLOW_FILE}/runs?status=${status}&per_page=${RUN_PAGE}`), `"${status}"`));
  }

  const result = evaluate({ now, head, headRuns, deployments, runs });
  console.log(`main head:          ${result.headSha}`);
  console.log(`head reached main:  ${iso(result.headSince)} (${result.headSinceSource})`);
  console.log(
    `live publication:   ${result.live
      ? `${result.live.sha} (deployment ${result.live.deploymentId}, published ${iso(result.live.at)})`
      : `(none among ${result.deploymentsChecked} checked)`}`,
  );
  console.log(`head is live:       ${result.headLive ? 'yes' : 'no'}`);
  console.log(`deployments checked: ${result.deploymentsChecked} (every one listed)`);
  console.log(`stalled-status runs listed: ${result.runsListed}`);
  if (result.failures.length > 0) {
    for (const f of result.failures) console.log(`::error::DEPLOY FRESHNESS (${f.code}): ${f.reason}`);
    console.error(`DEPLOY FRESHNESS FAILED: ${result.failures.length} problem(s); see the errors above.`);
    process.exit(EXIT_STALE);
  }
  console.log('DEPLOY FRESHNESS OK: the head of main is live (or in its grace hour) and no Test and deploy run is stalled.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => cannotSee(err instanceof InputError ? err.message : `unexpected error (${errorCode(err)})`));
}
