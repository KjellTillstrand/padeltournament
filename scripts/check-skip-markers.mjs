#!/usr/bin/env node
// CI-skip marker check (AB#128).
//
// Usage: node scripts/check-skip-markers.mjs [--pr] [--tracked-files]
//   --pr             scans the pull request: PR_TITLE (required, non-empty),
//                    PR_BODY (required, may be empty) and the message of every
//                    commit in BASE_SHA..HEAD_SHA (both required, full shas;
//                    read with git from the current checkout, which must hold
//                    both commits, so no token is needed).
//   --tracked-files  scans every file git tracks in the current checkout.
//   At least one flag is required. Exit 0: no marker found. Exit 1: a marker
//   was found (each one is named, by place and line, never quoted). Exit 2:
//   the input could not be read (a missing variable, a bad sha, git failing,
//   an empty commit range); the check fails closed rather than pass unseen.
//
// Why: GitHub skips every push and pull_request workflow run whose commit
// message carries a skip marker, wherever in the message it appears (inside
// backticks and in prose that only describes it, too). The squash merge of
// PR #71 (AB#65) built merge commit 00206a9 from the branch's commit messages;
// one of them described a marker literally, so main's Test and deploy run,
// and with it the Pages deploy, never started, and nothing went red.
// A squash merge composes its message from the PR title and the commit
// messages (and the PR body, if the repository's squash setting is changed to
// use it); a rebase merge keeps each commit message; a merge commit carries
// the title. Scanning all three covers every merge method.
// Tracked files are scanned so that no file in the repository holds a marker
// a later commit message could quote.
//
// What counts as a marker (fail-closed, so a little wider than GitHub's list):
//   - one of the five bracketed forms GitHub documents (the word pairs in
//     MARKER_WORDS, each inside square brackets), case-insensitive, with any
//     run of spaces or tabs (or none) around and between the two words. The
//     whole marker must sit on one line: a marker split across lines is not
//     one.
//   - the skip-checks trailer: a line that holds only the trailer key, a
//     colon and the word true (spaces or tabs around each part, an optional
//     leading list bullet, case-insensitive). GitHub honours it only at the
//     end of a commit message, but a squash merge may append one commit's
//     message after another, so any line of that shape is flagged. A mention
//     inside a sentence or backticks is not a trailer and is not flagged.
// The marker strings are built at runtime from their words: this file, its
// self-test and the workflow never spell one, so the tracked-file scan passes
// on them and a commit message quoting this code cannot carry one.
//
// Re-checking: the workflow (.github/workflows/skip-markers.yml) runs on
// opened, edited, reopened and synchronize, so editing the PR title or body,
// or pushing, re-runs it with the current text. Re-running a failed run from
// the Actions page reuses the old event payload, and with it the old title
// and body.
// Accepted residual: if the PR's HEAD commit carries a marker, GitHub skips
// every pull_request run of the PR, this one included. The PR then reports no
// checks at all, and the forge port's land_proposal already refuses a PR whose
// checks are absent.

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT_CLEAN = 0;
export const EXIT_FOUND = 1;
export const EXIT_CANNOT_READ = 2;

// The five bracketed forms, as word pairs. The brackets are added in
// markerPattern(), never written next to the words.
export const MARKER_WORDS = Object.freeze([
  ['skip', 'ci'],
  ['ci', 'skip'],
  ['no', 'ci'],
  ['skip', 'actions'],
  ['actions', 'skip'],
]);
export const TRAILER_KEY = ['skip', 'checks'].join('-');

const OPEN = '\\x5b'; // left square bracket, as a regex escape
const CLOSE = '\\x5d'; // right square bracket, as a regex escape
const GAP = '[ \\t]*';

// One regex per word pair, so a finding can name its form.
export const markerPattern = ([a, b]) => new RegExp(`${OPEN}${GAP}${a}${GAP}${b}${GAP}${CLOSE}`, 'gi');
export const TRAILER_RE = new RegExp(`^[ \\t]*(?:[-*+][ \\t]+)?${TRAILER_KEY}[ \\t]*:[ \\t]*true[ \\t]*$`, 'gim');

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

// Every marker in `text`, in order: { form, line } where form names the marker
// in words (never the marker itself) and line is 1-based.
export function findMarkers(text) {
  if (typeof text !== 'string') throw new TypeError('findMarkers needs a string');
  const t = text.replace(/\r\n?/g, '\n');
  const found = [];
  for (const words of MARKER_WORDS) {
    for (const m of t.matchAll(markerPattern(words))) {
      found.push({ index: m.index, form: `"${words.join(' ')}" in square brackets`, line: lineAt(t, m.index) });
    }
  }
  for (const m of t.matchAll(TRAILER_RE)) {
    found.push({ index: m.index, form: `the ${TRAILER_KEY} trailer`, line: lineAt(t, m.index) });
  }
  return found.sort((x, y) => x.index - y.index).map(({ form, line }) => ({ form, line }));
}

export class InputError extends Error {}

const SHA_RE = /^[0-9a-f]{40}$/;

// Values from the repository (file paths) are escaped before they reach a
// workflow command, so none can end the annotation or start a new command.
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

const git = (args) => execFileSync('git', args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

// [{ place, text }] for the pull request: title, body, each commit message.
export function prSources(env) {
  const { PR_TITLE: title, PR_BODY: body, BASE_SHA: base, HEAD_SHA: head } = env;
  if (typeof title !== 'string' || title.trim() === '') throw new InputError('PR_TITLE is missing or empty');
  if (typeof body !== 'string') throw new InputError('PR_BODY is missing (set it, empty if the PR has no body)');
  if (!SHA_RE.test(base ?? '')) throw new InputError('BASE_SHA is not a full commit sha');
  if (!SHA_RE.test(head ?? '')) throw new InputError('HEAD_SHA is not a full commit sha');
  let out;
  try {
    out = git(['log', '-z', '--format=%H%n%B', `${base}..${head}`]).toString('utf8');
  } catch (err) {
    const why = err.stderr ? err.stderr.toString('utf8').trim().split('\n')[0] : err.message;
    throw new InputError(`git log ${base.slice(0, 12)}..${head.slice(0, 12)} failed: ${why}`);
  }
  const commits = out.split('\0').filter((r) => r !== '').map((r) => {
    const nl = r.indexOf('\n');
    const sha = nl === -1 ? r : r.slice(0, nl);
    if (!SHA_RE.test(sha)) throw new InputError('git log returned a record without a commit sha');
    return { place: `commit ${sha.slice(0, 12)} message`, text: nl === -1 ? '' : r.slice(nl + 1) };
  });
  // A pull request always has at least one commit; none means the range was
  // not the PR's (wrong shas, or history not fetched), so nothing was seen.
  if (commits.length === 0) throw new InputError(`no commits in ${base.slice(0, 12)}..${head.slice(0, 12)}`);
  return [{ place: 'PR title', text: title }, { place: 'PR body', text: body }, ...commits];
}

// [{ place, text }] for every tracked regular file that is text (no NUL byte).
export function trackedFileSources(root = process.cwd()) {
  let out;
  try {
    out = git(['-C', root, 'ls-files', '-z']).toString('utf8');
  } catch (err) {
    throw new InputError(`git ls-files failed: ${err.message.split('\n')[0]}`);
  }
  const paths = out.split('\0').filter((p) => p !== '');
  if (paths.length === 0) throw new InputError('git ls-files listed no files');
  const sources = [];
  for (const path of paths) {
    const full = resolve(root, path);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue; // tracked but deleted in the working tree: nothing to read
    }
    if (!st.isFile()) continue; // symlinks, submodules
    const buf = readFileSync(full);
    if (buf.includes(0)) continue; // binary
    sources.push({ place: path, text: buf.toString('utf8') });
  }
  return sources;
}

// Findings across sources: [{ place, line, form }].
export function scan(sources) {
  return sources.flatMap(({ place, text }) => findMarkers(text).map((f) => ({ place, ...f })));
}

function main(argv, env) {
  const flags = new Set(argv);
  const known = new Set(['--pr', '--tracked-files']);
  const unknown = [...flags].filter((f) => !known.has(f));
  if (unknown.length > 0 || flags.size === 0) {
    console.error('::error::usage: node scripts/check-skip-markers.mjs [--pr] [--tracked-files] (at least one)');
    return EXIT_CANNOT_READ;
  }
  let sources = [];
  try {
    if (flags.has('--pr')) sources = sources.concat(prSources(env));
    if (flags.has('--tracked-files')) sources = sources.concat(trackedFileSources());
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    console.error(`::error::Skip marker check could not read its input: ${escapeData(err.message)}`);
    return EXIT_CANNOT_READ;
  }
  const findings = scan(sources);
  for (const f of findings) {
    console.error(`::error::${escapeData(f.place)}, line ${f.line}: CI-skip marker (${f.form}). ` +
      'A merge carrying it would skip the Test and deploy run on main, and with it the Pages deploy. ' +
      'Describe the marker in words instead.');
  }
  if (findings.length > 0) {
    console.error(`${findings.length} CI-skip marker(s) found in ${sources.length} scanned text(s).`);
    return EXIT_FOUND;
  }
  console.log(`No CI-skip marker in ${sources.length} scanned text(s).`);
  return EXIT_CLEAN;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2), process.env));
}
