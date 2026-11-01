#!/usr/bin/env node
// Self-test for scripts/check-skip-markers.mjs (the CI-skip marker check,
// AB#128).
//
// Usage: node scripts/check-skip-markers.test.mjs
//
// Two layers:
//   - the matcher findMarkers(), against positive and negative texts;
//   - the CLI as a black box (a child node process, as CI runs it) against a
//     throwaway git repository in a private temp dir (removed afterwards),
//     proving it fails red on a marker in the title, the body, a commit or a
//     tracked file, passes clean input, and fails closed (exit 2) when it
//     cannot read its input.
// Every marker below is BUILT from its words at runtime (marker(), trailer()),
// never written out, so this file passes the tracked-file scan and a commit
// message quoting it cannot carry a marker.
// Plain assert, no dependencies, no network. Exits non-zero if any case fails.

import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findMarkers, MARKER_WORDS, TRAILER_KEY } from './check-skip-markers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, 'check-skip-markers.mjs');
const REPO = resolve(HERE, '..');
const WORKFLOW = resolve(REPO, '.github/workflows/skip-markers.yml');

const L = String.fromCharCode(0x5b); // left square bracket
const R = String.fromCharCode(0x5d); // right square bracket
const marker = (a, b, sep = ' ') => L + a + sep + b + R;
const trailer = (sep = ': ') => TRAILER_KEY + sep + 'true';
const FORMS = MARKER_WORDS.map(([a, b]) => marker(a, b));
const forms = (text) => findMarkers(text).map((f) => f.form);
const lines = (text) => findMarkers(text).map((f) => f.line);

const unitCases = [
  ['there are exactly the five bracketed forms GitHub documents', () => {
    assert.deepStrictEqual(MARKER_WORDS.map((w) => w.join(' ')),
      ['skip ci', 'ci skip', 'no ci', 'skip actions', 'actions skip']);
  }],
  ['each bracketed form is found, alone, and named in words', () => {
    for (const [a, b] of MARKER_WORDS) {
      assert.deepStrictEqual(findMarkers(marker(a, b)), [{ form: `"${a} ${b}" in square brackets`, line: 1 }], `${a} ${b}`);
    }
  }],
  ['the form names never contain a marker themselves', () => {
    for (const m of FORMS) for (const f of findMarkers(m)) assert.deepStrictEqual(findMarkers(f.form), [], f.form);
  }],
  ['case variants are found', () => {
    for (const [a, b] of MARKER_WORDS) {
      for (const v of [marker(a.toUpperCase(), b.toUpperCase()), marker(a[0].toUpperCase() + a.slice(1), b),
        marker(a, b.toUpperCase())]) {
        assert.strictEqual(findMarkers(v).length, 1, v);
      }
    }
  }],
  ['a marker inside backticks or a code block is found (GitHub still honours it)', () => {
    for (const m of FORMS) {
      assert.strictEqual(findMarkers('see `' + m + '` here').length, 1, m);
      assert.strictEqual(findMarkers('```\n' + m + '\n```').length, 1, m);
    }
  }],
  ['a marker inside a longer sentence, glued to words or punctuation, is found', () => {
    for (const m of FORMS) {
      assert.strictEqual(findMarkers(`fix: describe the case (a ${m} push) in the monitor`).length, 1, m);
      assert.strictEqual(findMarkers(`word${m}word.`).length, 1, m);
    }
  }],
  ['spaces or tabs around and between the words still count (fail-closed)', () => {
    assert.strictEqual(findMarkers(L + ' skip\tci ' + R).length, 1);
    assert.strictEqual(findMarkers(marker('skip', 'ci', '   ')).length, 1);
    assert.strictEqual(findMarkers(marker('skip', 'ci', '')).length, 1);
  }],
  ['every marker in a text is found, with its line, in order', () => {
    const text = `title\n\n${FORMS[1]} and ${FORMS[0]}\r\nmore\r\n${FORMS[4]}`;
    assert.deepStrictEqual(forms(text), ['"ci skip" in square brackets', '"skip ci" in square brackets', '"actions skip" in square brackets']);
    assert.deepStrictEqual(lines(text), [3, 3, 5]);
  }],
  ['the trailer at the end of a message is found, with and without the space', () => {
    for (const t of [trailer(), trailer(':'), trailer(' : ')]) {
      assert.deepStrictEqual(findMarkers(`fix: x\n\nbody\n\n\n${t}`), [{ form: `the ${TRAILER_KEY} trailer`, line: 6 }], t);
      assert.strictEqual(findMarkers(`fix: x\n\n\n${t}\n`).length, 1, t);
      assert.strictEqual(findMarkers(`fix: x\r\n\r\n\r\n${t}\r\n`).length, 1, t);
    }
  }],
  ['the trailer in another case, indented, or as a list item is found', () => {
    assert.strictEqual(findMarkers(`x\n\n${trailer().toUpperCase()}`).length, 1);
    assert.strictEqual(findMarkers(`x\n\n  ${trailer()}  `).length, 1);
    assert.strictEqual(findMarkers(`* x\n\n* ${trailer()}`).length, 1);
    assert.strictEqual(findMarkers(`- ${trailer()}`).length, 1);
  }],
  ['the trailer on its own line mid-message is found (a squash may append more after it)', () => {
    assert.strictEqual(findMarkers(`one\n\n${trailer()}\n\n* two\n\nCo-Authored-By: someone`).length, 1);
  }],
  ['the words without brackets are not a marker', () => {
    for (const [a, b] of MARKER_WORDS) assert.deepStrictEqual(findMarkers(`please ${a} ${b} here, ${a}-${b}`), [], `${a} ${b}`);
    assert.deepStrictEqual(findMarkers('a CI-skip marker, skip ci, no CI run'), []);
  }],
  ['a marker split across lines is not one', () => {
    for (const [a, b] of MARKER_WORDS) {
      assert.deepStrictEqual(findMarkers(L + a + '\n' + b + R), [], `${a} ${b}`);
      assert.deepStrictEqual(findMarkers(L + a + '\r\n' + b + R), [], `${a} ${b}`);
      assert.deepStrictEqual(findMarkers(L + a + ' ' + b + '\n' + R), [], `${a} ${b}`);
    }
  }],
  ['similar words in brackets are not a marker', () => {
    for (const s of [marker('skipping', 'ci'), marker('skip', 'cis'), marker('skip', 'action'), marker('no', 'cid'),
      marker('ci', 'skipped'), marker('skip', 'checks'), marker('skip', 'tests'), L + 'skip' + R, L + 'ci' + R,
      marker('skip', 'ci', '-'), marker('ci', 'skip', '_'), '(' + 'skip ci' + ')', '{' + 'ci skip' + '}']) {
      assert.deepStrictEqual(findMarkers(s), [], s);
    }
  }],
  ['the trailer key mentioned inside a sentence or backticks is not a trailer', () => {
    for (const s of [`never end with a \`${trailer()}\` trailer`, `\`${trailer()}\``, `x ${trailer()}`,
      `${trailer()} is a trailer`, `${TRAILER_KEY}: false`, `${TRAILER_KEY}: yes`, `${TRAILER_KEY}\n: true`]) {
      assert.deepStrictEqual(findMarkers(s), [], s);
    }
  }],
  ['an empty text has no marker; a non-string is refused', () => {
    assert.deepStrictEqual(findMarkers(''), []);
    assert.throws(() => findMarkers(undefined), TypeError);
    assert.throws(() => findMarkers(null), TypeError);
  }],
];

// ---- CLI black box against a throwaway git repository ----------------------

// git with no global or system config (no hooks, no signing, no user identity
// from this machine), so the fixture repository is the same everywhere.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-10-28T12:00:00Z',
  GIT_COMMITTER_DATE: '2026-10-28T12:00:00Z',
};
const gitIn = (dir, args, input) => execFileSync('git', ['-C', dir, ...args], { env: GIT_ENV, input, encoding: 'utf8' }).trim();

// A fixture repository: files (name -> content) committed in a base commit,
// then one commit per message on top, each built with plumbing (commit-tree,
// which runs no hooks). Returns { dir, base, head }.
function fixtureRepo(messages, files = { 'README.md': 'clean\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'skip-markers-'));
  gitIn(dir, ['init', '-q']);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  gitIn(dir, ['add', '-A']);
  const tree = gitIn(dir, ['write-tree']);
  const base = gitIn(dir, ['commit-tree', tree], 'chore: base\n');
  let head = base;
  for (const m of messages) head = gitIn(dir, ['commit-tree', tree, '-p', head], m);
  gitIn(dir, ['update-ref', 'HEAD', head]);
  return { dir, base, head };
}

const temps = [];
const repo = (...args) => {
  const r = fixtureRepo(...args);
  temps.push(r.dir);
  return r;
};

// Runs the CLI in `cwd` with `env` on top of GIT_ENV minus the PR variables;
// an undefined value in `env` leaves that variable unset.
function cli(args, { cwd = REPO, env = {} } = {}) {
  const base = { ...GIT_ENV };
  for (const k of ['PR_TITLE', 'PR_BODY', 'BASE_SHA', 'HEAD_SHA']) delete base[k];
  const merged = Object.fromEntries(Object.entries({ ...base, ...env }).filter(([, v]) => v !== undefined));
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: merged, encoding: 'utf8', timeout: 30 * 1000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
// The CLI inside fixture repository `fx`, with a clean PR unless `extra` says otherwise.
const cliPr = (fx, extra = {}, args = ['--pr']) => cli(args, {
  cwd: fx.dir,
  env: { PR_TITLE: 'ci: a clean title (AB#1)', PR_BODY: 'A clean body.', BASE_SHA: fx.base, HEAD_SHA: fx.head, ...extra },
});

const CLEAN_MESSAGES = ['feat: one\n\nDescribes a CI-skip marker in words only.\n', 'fix: two\n\nCo-Authored-By: x <x@example.invalid>\n'];

const cliCases = [
  ['CLI --pr: clean title, body and commits pass (exit 0)', () => {
    const r = cliPr(repo(CLEAN_MESSAGES));
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /No CI-skip marker in 4 scanned text\(s\)\./);
  }],
  ['CLI --pr: an empty body is allowed', () => {
    const r = cliPr(repo(CLEAN_MESSAGES), { PR_BODY: '' });
    assert.strictEqual(r.code, 0, r.out);
  }],
  ['CLI --pr: a marker in the title fails red, naming the place and form, not quoting it', () => {
    for (const m of FORMS) {
      const r = cliPr(repo(CLEAN_MESSAGES), { PR_TITLE: `ci: guard the deploy ${m} (AB#1)` });
      assert.strictEqual(r.code, 1, r.out);
      assert.match(r.out, /::error::PR title, line 1: CI-skip marker \("[a-z]+ [a-z]+" in square brackets\)/);
      assert.strictEqual(r.out.includes(m), false, 'the output must not quote the marker');
    }
  }],
  ['CLI --pr: a marker in backticks in the body fails red, with its line', () => {
    const r = cliPr(repo(CLEAN_MESSAGES), { PR_BODY: `Summary\r\n\r\nThe merge must never carry \`${FORMS[0]}\`.` });
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /::error::PR body, line 3: CI-skip marker \("skip ci" in square brackets\)/);
  }],
  ['CLI --pr: a marker in an earlier (not head) commit message fails red, naming the commit', () => {
    const fx = repo([`docs: describe the case (a ${FORMS[2]} push)\n`, ...CLEAN_MESSAGES]);
    const sha = gitIn(fx.dir, ['rev-parse', `${fx.head}~2`]);
    const r = cliPr(fx);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`::error::commit ${sha.slice(0, 12)} message, line 1: CI-skip marker \\("no ci" in square brackets\\)`));
  }],
  ['CLI --pr: the trailer ending a commit message fails red', () => {
    const r = cliPr(repo([...CLEAN_MESSAGES, `fix: three\n\nbody\n\n\n${trailer()}\n`]));
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`line 6: CI-skip marker \\(the ${TRAILER_KEY} trailer\\)`));
  }],
  ['CLI --pr: every finding is reported, then the count', () => {
    const r = cliPr(repo([`a ${FORMS[3]}\n`]), { PR_TITLE: FORMS[1], PR_BODY: FORMS[4] });
    assert.strictEqual(r.code, 1, r.out);
    assert.strictEqual(r.out.match(/::error::/g).length, 3, r.out);
    assert.match(r.out, /3 CI-skip marker\(s\) found in 3 scanned text\(s\)\./);
  }],
  ['CLI --pr: commits outside base..head are not scanned', () => {
    const fx = repo([`chore: old ${FORMS[0]}\n`, ...CLEAN_MESSAGES]);
    const base = gitIn(fx.dir, ['rev-parse', `${fx.head}~2`]);
    const r = cliPr(fx, { BASE_SHA: base });
    assert.strictEqual(r.code, 0, r.out);
  }],
  ['CLI --pr: fails closed (exit 2) on a missing or empty title, a missing body, or bad shas', () => {
    const fx = repo(CLEAN_MESSAGES);
    const cases = [
      [{ PR_TITLE: undefined }, /PR_TITLE is missing or empty/],
      [{ PR_TITLE: '  ' }, /PR_TITLE is missing or empty/],
      [{ PR_BODY: undefined }, /PR_BODY is missing/],
      [{ BASE_SHA: undefined }, /BASE_SHA is not a full commit sha/],
      [{ BASE_SHA: 'main' }, /BASE_SHA is not a full commit sha/],
      [{ HEAD_SHA: fx.head.slice(0, 12) }, /HEAD_SHA is not a full commit sha/],
      [{ HEAD_SHA: 'f'.repeat(40) }, /git log .* failed/],
      [{ BASE_SHA: fx.head }, /no commits in /],
    ];
    for (const [extra, re] of cases) {
      const r = cliPr(fx, extra);
      assert.strictEqual(r.code, 2, `${JSON.stringify(extra)}: ${r.out}`);
      assert.match(r.out, re);
    }
  }],
  ['CLI --tracked-files: a marker in a tracked file fails red, naming file and line; binary files are skipped', () => {
    const fx = repo(CLEAN_MESSAGES, {
      'README.md': 'clean\n',
      'notes.md': `one\ntwo (a ${FORMS[0]} push)\n`,
      'blob.bin': Buffer.from([0, 1, 2, ...Buffer.from(FORMS[1])]),
    });
    const r = cliPr(fx, {}, ['--tracked-files']);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /::error::notes\.md, line 2: CI-skip marker \("skip ci" in square brackets\)/);
    assert.strictEqual(r.out.match(/::error::/g).length, 1, r.out);
  }],
  ['CLI --tracked-files: untracked files are not scanned', () => {
    const fx = repo(CLEAN_MESSAGES);
    writeFileSync(join(fx.dir, 'untracked.md'), FORMS[0]);
    const r = cliPr(fx, {}, ['--tracked-files']);
    assert.strictEqual(r.code, 0, r.out);
  }],
  ['CLI: --pr and --tracked-files together scan both', () => {
    const fx = repo(CLEAN_MESSAGES, { 'README.md': FORMS[2] });
    const r = cliPr(fx, { PR_TITLE: FORMS[3] }, ['--pr', '--tracked-files']);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /PR title, line 1/);
    assert.match(r.out, /README\.md, line 1/);
  }],
  ['CLI: no flag, or an unknown flag, is a usage error (exit 2)', () => {
    assert.strictEqual(cli([]).code, 2);
    assert.strictEqual(cli(['--prs']).code, 2);
    assert.strictEqual(cli(['--pr', '--all']).code, 2);
  }],
  ['CLI: a file path is escaped before it reaches a workflow command', () => {
    const fx = repo(CLEAN_MESSAGES, { 'a%0Ab.md': FORMS[0] });
    const r = cliPr(fx, {}, ['--tracked-files']);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /::error::a%250Ab\.md, line 1/);
  }],
  // Read directly, not through git, so the check holds before the files are
  // tracked too. The workflow's own --tracked-files step covers the rest of
  // the repository.
  ['the check, this self-test and the workflow hold no marker', () => {
    for (const file of [CLI, fileURLToPath(import.meta.url), WORKFLOW]) {
      assert.deepStrictEqual(findMarkers(readFileSync(file, 'utf8')), [], file);
    }
  }],
];

let failed = 0;
const all = [...unitCases, ...cliCases];
try {
  for (const [name, fn] of all) {
    try {
      await fn();
      console.log(`ok    ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${name}\n${err.message}`);
    }
  }
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${all.length - failed}/${all.length} skip marker self-test cases passed`);
process.exit(failed === 0 ? 0 : 1);
