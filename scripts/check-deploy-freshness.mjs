#!/usr/bin/env node
// Deploy freshness monitor (AB#65).
//
// Usage: GITHUB_REPOSITORY=<owner>/<repo> GITHUB_TOKEN=<token> \
//          node scripts/check-deploy-freshness.mjs
//   GITHUB_API_URL is honoured (Actions sets it); it defaults to
//   https://api.github.com. Only https, or http to a loopback host (used by
//   the self-test), is accepted, so the token is never sent in clear text.
//
// Why: run 36765228696 sat in "waiting" on the github-pages environment from
// 2026-09-30 to 2026-10-03. It held the deploy-gh-pages concurrency group
// (cancel-in-progress: false), so later deploys were silently cancelled and
// merged work was not live for three days. Nothing went red. This check turns
// both symptoms into a red run within hours (.github/workflows/
// deploy-freshness.yml runs it hourly).
//
// It fails when either:
//   (a) the live Pages deployment is not the head of main, and that head commit
//       is more than STALE_AFTER_MS old. "Live" is the newest github-pages
//       deployment whose latest status is "success" (older deployments keep
//       their "success" status, they are not marked inactive, so newest wins).
//       No successful deployment at all is also a failure, with no grace
//       period. The head's age is its COMMITTER date: squash and merge commits
//       are committed at merge time, so it is when the commit reached main.
//   (b) a "Test and deploy" run (playwright-tests.yml) has been in a stalled
//       status (waiting, queued, pending or requested) for more than
//       STALE_AFTER_MS, measured from the run attempt's start (run_started_at,
//       falling back to created_at). A re-run attempt therefore gets a fresh
//       clock instead of being judged by the original run's age. The API does
//       not expose when a run entered its current status, so a run that ran
//       its tests for 30 min and then waited 31 min also trips (b); the test
//       job takes 20-35 min, well inside the hour.
// Boundary: both limits are strict ("more than"): an age of exactly one hour
// passes, one millisecond more fails.
//
// Detection only: it reads, never cancels, approves or re-runs anything.
//
// Exit codes:
//   0  live deployment is the head of main (or the head is still in its grace
//      hour) and no run is stalled
//   1  one or more of the failures above (each printed as an ::error:: line)
//   2  the monitor could not see: missing environment, an API call failed or
//      returned an unexpected shape, or a listing exceeded the bounds below.
//      A monitor that cannot see never reports green.
//
// Fetch bounds (each a single page, no further pagination):
//   - main head: one call.
//   - deployments: the DEPLOYMENT_LIMIT newest github-pages deployments; the
//     statuses of each are fetched newest-first only until the first one whose
//     latest status is "success". If none of those is live, that is reported
//     as "no successful deployment" (a live deployment older than 30 newer
//     unsuccessful ones would be stale anyway).
//   - runs: one page of RUN_PAGE runs per stalled status. If GitHub reports
//     more runs in a status than one page holds, the oldest (most likely
//     stalled) ones could be on a later page, so that exits 2 instead.
//
// The decision is the pure function evaluate(), exported for the fixture
// self-test (scripts/check-deploy-freshness.test.mjs); the CLI below it only
// fetches and prints. API data is treated as untrusted: every string echoed to
// the log goes through clean().

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STALE_AFTER_MS = 60 * 60 * 1000;
export const STALLED_STATUSES = ['waiting', 'queued', 'pending', 'requested'];
export const WORKFLOW_FILE = 'playwright-tests.yml';
export const ENVIRONMENT = 'github-pages';
const DEPLOYMENT_LIMIT = 30;
const RUN_PAGE = 100;
const REQUEST_TIMEOUT_MS = 30 * 1000;

const EXIT_STALE = 1;
const EXIT_CANNOT_SEE = 2;

const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Raised for any input the monitor cannot trust; the CLI maps it to exit 2.
export class InputError extends Error {}

// Make an untrusted string safe to echo into a CI log: no control characters
// (so no newline can start a "::command" line), no bidi overrides, and no
// legacy "##[command]" marker.
export function clean(value, max = 200) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ')
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

function sha(value, label) {
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    throw new InputError(`${label} is not a commit sha: ${JSON.stringify(clean(value, 60))}`);
  }
  return value;
}

function minutes(ms) {
  return `${Math.floor(ms / 60000)} min`;
}

// The newest status of one deployment, or undefined when it has none.
function latestState(deployment, label) {
  if (!Array.isArray(deployment.statuses)) throw new InputError(`${label} has no "statuses" array`);
  let latest;
  for (const [i, s] of deployment.statuses.entries()) {
    if (!isObject(s) || typeof s.state !== 'string') throw new InputError(`${label} status #${i} has no state`);
    const at = time(s.created_at, `${label} status #${i} created_at`);
    if (!latest || at > latest.at || (at === latest.at && s.id > latest.id)) latest = { at, id: s.id, state: s.state };
  }
  return latest?.state;
}

/**
 * Decide whether Pages publication is stalled. Pure: no I/O, no clock.
 *
 * @param {object} input
 * @param {number} input.now          current time, epoch ms
 * @param {object} input.head         GET repos/{repo}/commits/main (sha, commit.committer.date)
 * @param {object[]} input.deployments github-pages deployments (sha, created_at), each with a
 *                                    `statuses` array as returned by its statuses endpoint
 * @param {object[]} input.runs       "Test and deploy" workflow runs (id, status,
 *                                    run_started_at|created_at, html_url)
 * @returns {{code: string, reason: string}[]} failures; empty when fresh
 * @throws {InputError} when any input is missing or malformed (fail closed)
 */
export function evaluate({ now, head, deployments, runs } = {}) {
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new InputError('"now" is not a time');
  if (!isObject(head) || !isObject(head.commit) || !isObject(head.commit.committer)) {
    throw new InputError('main head has no commit.committer');
  }
  const headSha = sha(head.sha, 'main head sha');
  const headAge = now - time(head.commit.committer.date, 'main head committer date');
  if (!Array.isArray(deployments)) throw new InputError('deployments is not an array');
  if (!Array.isArray(runs)) throw new InputError('runs is not an array');

  const failures = [];

  // (a) Is the live deployment the head of main?
  const listed = deployments.map((d, i) => {
    const label = `deployment #${i}`;
    if (!isObject(d)) throw new InputError(`${label} is not an object`);
    return { sha: sha(d.sha, `${label} sha`), at: time(d.created_at, `${label} created_at`), state: latestState(d, label) };
  });
  // Newest first (a stable sort keeps the listing order for equal timestamps).
  listed.sort((x, y) => y.at - x.at);
  const live = listed.find((d) => d.state === 'success');
  if (!live) {
    failures.push({
      code: 'no-successful-deployment',
      reason:
        `No successful ${ENVIRONMENT} deployment among the ${deployments.length} listed: ` +
        `main head ${headSha.slice(0, 7)} is not live.`,
    });
  } else if (live.sha !== headSha && headAge > STALE_AFTER_MS) {
    failures.push({
      code: 'live-not-head',
      reason:
        `Live ${ENVIRONMENT} deployment is ${live.sha.slice(0, 7)}, but main head ` +
        `${headSha.slice(0, 7)} was committed ${minutes(headAge)} ago (limit ${minutes(STALE_AFTER_MS)}).`,
    });
  }

  // (b) Is any Test and deploy run stuck before or between its jobs?
  for (const [i, run] of runs.entries()) {
    const label = `run #${i}`;
    if (!isObject(run) || typeof run.status !== 'string') throw new InputError(`${label} has no status`);
    if (!STALLED_STATUSES.includes(run.status)) continue;
    const started = time(run.run_started_at ?? run.created_at, `${label} run_started_at`);
    const age = now - started;
    if (age > STALE_AFTER_MS) {
      failures.push({
        code: 'stalled-run',
        reason:
          `Test and deploy run ${clean(run.id, 30)} has been "${clean(run.status, 20)}" since an attempt ` +
          `started ${minutes(age)} ago (limit ${minutes(STALE_AFTER_MS)}): ${clean(run.html_url ?? '', 120)}`,
      });
    }
  }
  return failures;
}

// ---------------------------------------------------------------- CLI ----

function cannotSee(message) {
  console.log(`::error::DEPLOY FRESHNESS: CANNOT EVALUATE - ${clean(message, 400)}`);
  console.error('A monitor that cannot see never reports green.');
  process.exit(EXIT_CANNOT_SEE);
}

function apiBase(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new InputError(`GITHUB_API_URL is not a URL: ${JSON.stringify(clean(raw, 80))}`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new InputError('GITHUB_API_URL must be https (or http to a loopback host)');
  }
  return url.href.replace(/\/+$/, '');
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const token = process.env.GITHUB_TOKEN ?? '';
  if (!REPO_RE.test(repo)) throw new InputError('GITHUB_REPOSITORY must be set to <owner>/<repo>');
  if (!token) throw new InputError('GITHUB_TOKEN is not set');
  const base = apiBase(process.env.GITHUB_API_URL || 'https://api.github.com');

  const get = async (path) => {
    let res;
    try {
      res = await fetch(`${base}/repos/${repo}/${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'check-deploy-freshness',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new InputError(`GET ${path} failed: ${err.message}`);
    }
    if (!res.ok) throw new InputError(`GET ${path} returned HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new InputError(`GET ${path} did not return JSON`);
    }
  };

  const head = await get('commits/main');

  const listing = await get(`deployments?environment=${ENVIRONMENT}&per_page=${DEPLOYMENT_LIMIT}`);
  if (!Array.isArray(listing)) throw new InputError('deployments listing is not an array');
  // Newest first; stop at the first live one (evaluate() re-sorts and re-checks).
  const byAge = [...listing].sort((x, y) => Date.parse(y?.created_at) - Date.parse(x?.created_at));
  const deployments = [];
  for (const d of byAge) {
    if (!isObject(d) || !Number.isSafeInteger(d.id)) throw new InputError('deployment without a numeric id');
    const statuses = await get(`deployments/${d.id}/statuses?per_page=100`);
    deployments.push({ ...d, statuses });
    if (Array.isArray(statuses) && latestState({ statuses }, `deployment ${d.id}`) === 'success') break;
  }

  const runs = [];
  for (const status of STALLED_STATUSES) {
    const page = await get(`actions/workflows/${WORKFLOW_FILE}/runs?status=${status}&per_page=${RUN_PAGE}`);
    if (!isObject(page) || !Array.isArray(page.workflow_runs) || !Number.isSafeInteger(page.total_count)) {
      throw new InputError(`runs listing for status ${status} has an unexpected shape`);
    }
    if (page.total_count > page.workflow_runs.length) {
      throw new InputError(
        `${page.total_count} runs are "${status}", more than one page (${RUN_PAGE}) holds; not judging a partial list`,
      );
    }
    runs.push(...page.workflow_runs);
  }

  const failures = evaluate({ now: Date.now(), head, deployments, runs });
  const live = deployments.find((d) => latestState(d, 'deployment') === 'success');
  console.log(`main head:        ${head.sha}`);
  console.log(`live deployment:  ${live ? clean(live.sha, 40) : '(none)'}`);
  console.log(`stalled-status runs listed: ${runs.length}`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`::error::DEPLOY FRESHNESS (${f.code}): ${f.reason}`);
    console.error(`DEPLOY FRESHNESS FAILED: ${failures.length} problem(s); see the errors above.`);
    process.exit(EXIT_STALE);
  }
  console.log('DEPLOY FRESHNESS OK: the live deployment is current and no Test and deploy run is stalled.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => cannotSee(err instanceof InputError ? err.message : `unexpected error: ${err.message}`));
}
