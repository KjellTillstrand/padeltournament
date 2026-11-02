#!/usr/bin/env node
// Self-test for scripts/check-skip-markers.mjs (the CI-skip marker check,
// AB#128).
//
// Usage: node scripts/check-skip-markers.test.mjs
//
// Three layers:
//   - the matcher findMarkers(), against positive and negative texts,
//     including Unicode look-alikes built from code points;
//   - the CLI as a black box (a child node process, as CI runs it) against a
//     throwaway git repository in a private temp dir (removed afterwards),
//     proving it fails red on a marker in the title, the body, a commit
//     message, a commit author or committer identity, or a tracked file,
//     passes clean input, and fails closed (exit 2) when it cannot read its
//     input (an unreadable tracked file included);
//   - the wiring of .github/workflows/skip-markers.yml, read as text: the
//     triggers, title and body only through env, no expression inside run:,
//     both scan flags, read-only permissions, no persisted credentials, the
//     per-PR concurrency group. Each assertion is also run against a mutant
//     of the workflow, which must fail it.
// Every marker below is BUILT from its words at runtime (marker(), trailer()),
// never written out, so this file passes the tracked-file scan and a commit
// message quoting it cannot carry a marker.
// Plain assert, no dependencies, no network. Exits non-zero if any case fails.

import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findMarkers, InputError, MARKER_WORDS, markerPattern, TRAILER_KEY, TRAILER_RE, trackedFileSources,
} from './check-skip-markers.mjs';

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

// Look-alikes, from code points only (this file holds none of them).
const cp = (...codes) => String.fromCodePoint(...codes);
const LONG_S = cp(0x17f); // folds (and NFKC-normalises) to s
const KELVIN = cp(0x212a); // the Kelvin sign: folds to k, NFKC gives K
// Fullwidth forms of printable ASCII (U+FF01..U+FF5E); NFKC maps them back.
const fullwidth = (s) => [...s].map((c) => cp(c.codePointAt(0) + 0xfee0)).join('');
const FW_L = fullwidth(L);
const FW_R = fullwidth(R);
// A fresh copy of a pattern with other flags, to show what the u flag adds.
const withFlags = (re, flags) => new RegExp(re.source, flags);

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
  ['look-alike letters count: the long s and the Kelvin sign, in every bracketed form and the trailer', () => {
    for (const [a, b] of MARKER_WORDS) {
      const longS = (w) => w.replace('s', LONG_S);
      const kelvin = (w) => w.replace('k', KELVIN);
      for (const v of [marker(longS(a), longS(b)), marker(kelvin(a), kelvin(b))]) {
        if (v === marker(a, b)) continue; // the pair has neither letter
        assert.strictEqual(findMarkers(v).length, 1, `${a} ${b}`);
      }
    }
    assert.strictEqual(findMarkers(marker(LONG_S + 'kip', 'ci')).length, 1);
    assert.strictEqual(findMarkers(marker('s' + KELVIN + 'ip', 'ci')).length, 1);
    assert.strictEqual(findMarkers(`x\n\n${TRAILER_KEY.replace('k', KELVIN)}: true`).length, 1);
    assert.strictEqual(findMarkers(`x\n\n${TRAILER_KEY.replace('s', LONG_S)}: true`).length, 1);
  }],
  ['the u flag alone folds the long s and the Kelvin sign (without it, they slip through)', () => {
    const longS = marker(LONG_S + 'kip', 'ci');
    const kelvin = marker('s' + KELVIN + 'ip', 'ci');
    const p = markerPattern(['skip', 'ci']);
    assert.ok(p.flags.includes('u') && TRAILER_RE.flags.includes('u'), 'both patterns carry the u flag');
    for (const v of [longS, kelvin]) {
      assert.strictEqual(withFlags(p, p.flags).test(v), true, 'with u');
      assert.strictEqual(withFlags(p, p.flags.replace('u', '')).test(v), false, 'without u (the gap this closes)');
    }
    const t = TRAILER_KEY.replace('k', KELVIN) + ': true';
    assert.strictEqual(withFlags(TRAILER_RE, TRAILER_RE.flags).test(t), true);
    assert.strictEqual(withFlags(TRAILER_RE, TRAILER_RE.flags.replace('u', '')).test(t), false);
  }],
  ['fullwidth letters and brackets count (NFKC), with the original line numbers', () => {
    assert.strictEqual(findMarkers(marker(fullwidth('skip'), fullwidth('ci'))).length, 1);
    assert.strictEqual(findMarkers(marker(fullwidth('NO'), 'ci')).length, 1);
    assert.strictEqual(findMarkers(FW_L + 'ci skip' + FW_R).length, 1);
    assert.strictEqual(findMarkers(FW_L + fullwidth('skip') + cp(0x3000) + fullwidth('actions') + FW_R).length, 1);
    assert.strictEqual(findMarkers(`x\n\n${fullwidth(TRAILER_KEY)}${fullwidth(':')} ${fullwidth('true')}`).length, 1);
    const text = `one\n${marker(fullwidth('skip'), 'ci')}\r\nthree\n${FW_L}actions skip${FW_R} and ${marker(LONG_S + 'kip', 'ci')}`;
    assert.deepStrictEqual(lines(text), [2, 4, 4]);
  }],
  ['look-alikes of a non-marker stay non-markers', () => {
    for (const s of [marker(fullwidth('skipping'), 'ci'), marker(LONG_S + 'kip', 'tests'), FW_L + 'skip' + FW_R,
      `${fullwidth(TRAILER_KEY)}: false`, `a ${TRAILER_KEY.replace('k', KELVIN)}: true here`]) {
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
const gitIn = (dir, args, input, env = {}) =>
  execFileSync('git', ['-C', dir, ...args], { env: { ...GIT_ENV, ...env }, input, encoding: 'utf8' }).trim();

// A fixture repository: files (name -> content, a name may hold one
// directory) committed in a base commit, then one commit per message on top,
// each built with plumbing (commit-tree, which runs no hooks). A message is a
// string, or { message, env } to set the commit's identity (GIT_AUTHOR_NAME
// and the like). Returns { dir, base, head }.
function fixtureRepo(messages, files = { 'README.md': 'clean\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'skip-markers-'));
  gitIn(dir, ['init', '-q']);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  gitIn(dir, ['add', '-A']);
  const tree = gitIn(dir, ['write-tree']);
  const base = gitIn(dir, ['commit-tree', tree], 'chore: base\n');
  let head = base;
  for (const m of messages) {
    const { message, env } = typeof m === 'string' ? { message: m, env: {} } : m;
    head = gitIn(dir, ['commit-tree', tree, '-p', head], message, env);
  }
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
    // Title, body, and per commit its message, author and committer.
    assert.match(r.out, /No CI-skip marker in 8 scanned text\(s\)\./);
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
    assert.match(r.out, /3 CI-skip marker\(s\) found in 5 scanned text\(s\)\./);
  }],
  ['CLI --pr: a marker in a commit author name fails red, naming the commit and the author, not quoting it', () => {
    for (const m of FORMS) {
      const fx = repo([{ message: 'feat: clean message\n', env: { GIT_AUTHOR_NAME: `Some ${m} One` } }, ...CLEAN_MESSAGES]);
      const sha = gitIn(fx.dir, ['rev-parse', `${fx.head}~2`]);
      const r = cliPr(fx);
      assert.strictEqual(r.code, 1, r.out);
      assert.match(r.out, new RegExp(`::error::commit ${sha.slice(0, 12)} author, line 1: CI-skip marker \\("[a-z]+ [a-z]+" in square brackets\\)`));
      assert.strictEqual(r.out.match(/::error::/g).length, 1, r.out);
      assert.strictEqual(r.out.includes(m), false, 'the output must not quote the marker');
    }
  }],
  ['CLI --pr: a marker in a committer name, or in an author email, fails red', () => {
    const committer = repo([...CLEAN_MESSAGES, { message: 'fix: clean\n', env: { GIT_COMMITTER_NAME: `Bot ${FORMS[1]}` } }]);
    let r = cliPr(committer);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`::error::commit ${committer.head.slice(0, 12)} committer, line 1: CI-skip marker \\("ci skip" in square brackets\\)`));
    const email = repo([{ message: 'fix: clean\n', env: { GIT_AUTHOR_EMAIL: `x${marker('skip', 'actions', '')}@example.invalid` } }]);
    r = cliPr(email);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`::error::commit ${email.head.slice(0, 12)} author, line 1: CI-skip marker \\("skip actions" in square brackets\\)`));
  }],
  ['CLI --pr: a look-alike marker (long s) in an author name fails red', () => {
    const fx = repo([{ message: 'feat: clean\n', env: { GIT_AUTHOR_NAME: `A ${marker(LONG_S + 'kip', 'ci')} B` } }]);
    const r = cliPr(fx);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /author, line 1: CI-skip marker \("skip ci" in square brackets\)/);
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
  ['trackedFileSources: a tracked file that cannot be read is an InputError, not a pass or a finding', () => {
    const fx = repo(CLEAN_MESSAGES, { 'README.md': 'clean\n', 'notes.md': 'clean too\n' });
    const denied = (path) => {
      if (path.endsWith('notes.md')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return readFileSync(path);
    };
    assert.throws(() => trackedFileSources(fx.dir, { readFile: denied }),
      (err) => err instanceof InputError && /cannot read tracked file notes\.md: EACCES/.test(err.message));
    assert.strictEqual(trackedFileSources(fx.dir).length, 2);
  }],
  ['CLI --tracked-files: an unreadable tracked file, or one in an unsearchable directory, exits 2 (never 1)', () => {
    const fx = repo(CLEAN_MESSAGES, { 'README.md': 'clean\n', 'locked.md': 'clean\n', 'sub/inner.md': 'clean\n' });
    const locked = join(fx.dir, 'locked.md');
    const sub = join(fx.dir, 'sub');
    // Mode bits do not stop root; then the CLI cannot be made to fail a read
    // this way, and the in-process case above is the evidence.
    chmodSync(locked, 0o000);
    let readable = true;
    try {
      readFileSync(locked);
    } catch {
      readable = false;
    }
    try {
      if (readable) return 'skip: file modes do not stop this user (root?)';
      let r = cliPr(fx, {}, ['--tracked-files']);
      assert.strictEqual(r.code, 2, r.out);
      assert.match(r.out, /::error::Skip marker check could not read its input: cannot read tracked file locked\.md: EACCES/);
      chmodSync(locked, 0o644);
      chmodSync(sub, 0o600); // no search bit: lstat of sub/inner.md fails with EACCES
      r = cliPr(fx, {}, ['--tracked-files']);
      assert.strictEqual(r.code, 2, r.out);
      assert.match(r.out, /cannot stat tracked file sub\/inner\.md: EACCES/);
      return undefined;
    } finally {
      chmodSync(locked, 0o644);
      chmodSync(sub, 0o755);
    }
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

// ---- workflow wiring, read as text ------------------------------------------

// The run: commands of a workflow, one string each: a one-line run: value, or
// the lines of a block scalar (run: | or run: >) indented below its key.
function runBlocks(lines) {
  const blocks = [];
  lines.forEach((line, i) => {
    const m = /^( *)(- )?run:[ \t]*(.*)$/.exec(line);
    if (!m) return;
    const keyIndent = m[1].length + (m[2] ? 2 : 0);
    if (!/^[|>]/.test(m[3])) {
      blocks.push({ at: i, text: m[3] });
      return;
    }
    const body = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > keyIndent); j += 1) body.push(lines[j]);
    blocks.push({ at: i, text: body.join('\n') });
  });
  return blocks;
}

// What is wrong with the wiring of skip-markers.yml, as messages; [] = right.
function workflowWiringProblems(text) {
  const problems = [];
  const t = text.replace(/\r\n?/g, '\n');
  const lines = t.split('\n');
  const need = (ok, why) => { if (!ok) problems.push(why); };

  const types = /^on:\n {2}pull_request:\n {4}types:[ \t]*\[([^\]\n]*)\][ \t]*$/m.exec(t);
  need(types, 'on: pull_request: types: is not a one-line list right under on:');
  const listed = types ? types[1].split(',').map((s) => s.trim()) : [];
  for (const type of ['opened', 'edited', 'reopened', 'synchronize']) {
    need(listed.includes(type), `pull_request types do not include ${type}`);
  }
  need(!/pull_request_target/.test(t), 'the workflow must not run on pull_request_target');

  // Title and body: each named exactly once, as an env value.
  for (const [name, field] of [['PR_TITLE', 'title'], ['PR_BODY', 'body']]) {
    const uses = lines.map((l, i) => [l, i]).filter(([l]) => l.includes(`github.event.pull_request.${field}`));
    need(uses.length === 1, `github.event.pull_request.${field} must appear exactly once (found ${uses.length})`);
    if (uses.length !== 1) continue;
    const [line, at] = uses[0];
    const m = new RegExp(`^( +)${name}: \\$\\{\\{ github\\.event\\.pull_request\\.${field} \\}\\}$`).exec(line);
    need(m, `the ${field} must reach the script as ${name} in env`);
    if (!m) continue;
    let k = at - 1;
    while (k >= 0 && (lines[k].trim() === '' || lines[k].search(/\S/) >= m[1].length)) k -= 1;
    need(k >= 0 && /^ *env:[ \t]*$/.test(lines[k]), `${name} is not inside an env: block`);
  }

  const runs = runBlocks(lines);
  for (const r of runs) need(!r.text.includes('${{'), `an expression inside run: (line ${r.at + 1})`);
  need(runs.some((r) => /^node scripts\/check-skip-markers\.test\.mjs$/m.test(r.text)), 'the self-test is not run');
  const scanRun = runs.find((r) => /node scripts\/check-skip-markers\.mjs\b/.test(r.text));
  need(scanRun, 'scripts/check-skip-markers.mjs is not run');
  if (scanRun) {
    const args = /node scripts\/check-skip-markers\.mjs\b([^\n]*)/.exec(scanRun.text)[1].trim().split(/\s+/);
    need(args.includes('--pr') && args.includes('--tracked-files'), 'the check is not run with both --pr and --tracked-files');
    // Its step (from the step's "- name:" to its run:) feeds it the PR variables.
    let s = scanRun.at;
    while (s >= 0 && !/^ *- name:/.test(lines[s])) s -= 1;
    const step = lines.slice(Math.max(s, 0), scanRun.at).join('\n');
    for (const v of ['PR_TITLE', 'PR_BODY', 'BASE_SHA', 'HEAD_SHA']) need(new RegExp(`^ +${v}: `, 'm').test(step), `the check step does not set ${v}`);
  }

  need(/^permissions:\n {2}contents: read[ \t]*\n(?! )/m.test(t), 'top-level permissions are not exactly contents: read');
  need((t.match(/^ *permissions:/gm) ?? []).length === 1, 'permissions are declared more than once (a job-level grant)');
  need(/^ +persist-credentials: false[ \t]*$/m.test(t), 'checkout does not set persist-credentials: false');
  need(/^concurrency:\n {2}group: [^\n]*\$\{\{ github\.event\.pull_request\.number \}\}[^\n]*\n {2}cancel-in-progress: true[ \t]*$/m.test(t),
    'no top-level concurrency group keyed on the PR number with cancel-in-progress: true');
  need(/^jobs:\n {2}scan:\n(?: *#[^\n]*\n)* {4}name: CI-skip marker check[ \t]*$/m.test(t), 'job scan is not named CI-skip marker check');
  return problems;
}

const workflowText = () => readFileSync(WORKFLOW, 'utf8');
// A mutant of the workflow: `from` must occur (so the mutant really differs).
const mutant = (from, to) => {
  const text = workflowText();
  assert.ok(text.includes(from), `mutant source text not found: ${from}`);
  return text.replace(from, to);
};

const wiringCases = [
  ['the workflow is wired right: triggers, env-only title and body, flags, permissions, concurrency, name', () => {
    assert.deepStrictEqual(workflowWiringProblems(workflowText()), []);
  }],
  ['each wiring mutant fails the wiring check', () => {
    const mutants = [
      ['edited dropped from the triggers', mutant('opened, edited, reopened', 'opened, reopened'), /do not include edited/],
      ['synchronize dropped', mutant(', synchronize]', ']'), /do not include synchronize/],
      ['the title read inside run:', mutant('run: node scripts/check-skip-markers.mjs --pr --tracked-files',
        'run: node scripts/check-skip-markers.mjs --pr --tracked-files "${{ github.event.pull_request.title }}"'), /expression inside run:|exactly once/],
      ['an expression inside a block run:', mutant('run: node scripts/check-skip-markers.test.mjs',
        'run: |\n          echo "${{ github.sha }}"\n          node scripts/check-skip-markers.test.mjs'), /expression inside run:/],
      ['--tracked-files dropped', mutant('check-skip-markers.mjs --pr --tracked-files', 'check-skip-markers.mjs --pr'), /both --pr and --tracked-files/],
      ['--pr dropped', mutant('check-skip-markers.mjs --pr --tracked-files', 'check-skip-markers.mjs --tracked-files'), /both --pr and --tracked-files/],
      ['PR_BODY moved out of env', mutant('          PR_BODY: ${{ github.event.pull_request.body }}\n', '')
        .replace('    steps:\n', '    steps:\n      # PR_BODY: ${{ github.event.pull_request.body }}\n'), /PR_BODY|body/],
      ['write permission', mutant('  contents: read', '  contents: write'), /contents: read/],
      ['a second permission', mutant('  contents: read\n', '  contents: read\n  pull-requests: write\n'), /contents: read/],
      ['credentials persisted', mutant('persist-credentials: false', 'persist-credentials: true'), /persist-credentials/],
      ['no cancel-in-progress', mutant('cancel-in-progress: true', 'cancel-in-progress: false'), /concurrency/],
      ['concurrency group not per PR', mutant('${{ github.event.pull_request.number }}', '${{ github.workflow }}'), /concurrency/],
      ['pull_request_target', mutant('  pull_request:\n', '  pull_request_target:\n'), /pull_request/],
      ['job name generic', mutant('name: CI-skip marker check', 'name: scan'), /named CI-skip marker check/],
    ];
    for (const [what, text, re] of mutants) {
      const problems = workflowWiringProblems(text);
      assert.ok(problems.some((p) => re.test(p)), `${what}: expected a problem matching ${re}, got ${JSON.stringify(problems)}`);
    }
  }],
];

let failed = 0;
let skipped = 0;
const all = [...unitCases, ...cliCases, ...wiringCases];
try {
  for (const [name, fn] of all) {
    try {
      const result = await fn();
      if (typeof result === 'string' && result.startsWith('skip')) {
        skipped += 1;
        console.log(`skip  ${name} (${result.slice(5).trim()})`);
        continue;
      }
      console.log(`ok    ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${name}\n${err.message}`);
    }
  }
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${all.length - failed - skipped}/${all.length} skip marker self-test cases passed` +
  (skipped > 0 ? `, ${skipped} skipped` : ''));
process.exit(failed === 0 ? 0 : 1);
