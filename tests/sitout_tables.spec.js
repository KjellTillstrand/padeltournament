const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { LINE_SEPARATOR, PARAGRAPH_SEPARATOR, parseScheduleSource, readScheduleSource, loadScheduleSource, loadScheduleData } = require('./schedule-data.js');

// R-SITOUT-PLAY, data side: the shipped sit-out tables, the loader that reads
// them, the dropdown-to-script wiring and the engine round limit. Node-only
// (no page): listed in NODE_ONLY_SPECS so it runs once, in the "unit" project.
// The in-browser scenarios live in tests/sitout_fair.spec.js.

const WEB_DIR = path.join(__dirname, '..', 'web');
const ENGINE_DIR = path.join(__dirname, '..', 'web', 'engine');

// ---------------------------------------------------------------------------
// The shipped sit-out tables, re-verified in CI. Data only: the table files
// are read as text and parsed as JSON, never executed.
// ---------------------------------------------------------------------------

const SITOUT_COUNTS = [9, 10, 11, 13, 14, 15, 17, 18, 19, 21, 22, 23];

test.describe('R-SITOUT-PLAY: shipped sit-out tables', () => {
  for (const n of SITOUT_COUNTS) {
    test(`R-SITOUT-PLAY: the ${n}-player table rests and plays everyone fairly`, () => {
      const schedule = loadScheduleData(`${n}p${n}r`);
      const courts = Math.floor(n / 4);
      const resting = n % 4;

      expect(schedule.playerCount).toBe(n);
      expect(schedule.totalRounds).toBe(n);
      expect([...schedule.players].sort()).toEqual(
        Array.from({ length: n }, (_, i) => `P${i + 1}`).sort());
      expect(schedule.rounds).toHaveLength(n);

      const idx = new Map(schedule.players.map((p, i) => [p, i]));
      const games = new Array(n).fill(0);
      const rests = new Array(n).fill(0);
      const partner = Array.from({ length: n }, () => new Array(n).fill(0));
      const opponent = Array.from({ length: n }, () => new Array(n).fill(0));

      schedule.rounds.forEach((round, r) => {
        expect(round.roundNumber).toBe(r + 1);
        expect(round.matches.map((m) => m.court)).toEqual(
          Array.from({ length: courts }, (_, i) => i + 1));
        const seated = round.matches.flatMap((m) => m.teams.flat());
        expect(new Set(seated).size, `round ${r + 1} seats nobody twice`).toBe(seated.length);
        expect(seated).toHaveLength(courts * 4);
        // The byes are exactly the unseated players.
        const unseated = schedule.players.filter((p) => !seated.includes(p));
        expect(unseated).toHaveLength(resting);
        expect([...round.byes].sort(), `round ${r + 1} byes`).toEqual([...unseated].sort());
        seated.forEach((p) => { games[idx.get(p)]++; });
        unseated.forEach((p) => { rests[idx.get(p)]++; });
        for (const { teams } of round.matches) {
          const [[a, b], [c, d]] = teams.map((t) => t.map((p) => idx.get(p)));
          partner[a][b]++; partner[b][a]++; partner[c][d]++; partner[d][c]++;
          for (const x of [a, b]) for (const y of [c, d]) { opponent[x][y]++; opponent[y][x]++; }
        }
      });

      // Rests and games differ by at most one (the generator guarantees exactly equal).
      expect(Math.max(...rests) - Math.min(...rests), `rests ${rests}`).toBeLessThanOrEqual(1);
      expect(Math.max(...games) - Math.min(...games), `games ${games}`).toBeLessThanOrEqual(1);
      expect(rests.every((x) => x === resting), `every Player rests ${resting}x`).toBe(true);
      expect(games.every((x) => x === n - resting), `every Player plays ${n - resting} games`).toBe(true);

      // No pair partners twice; opponent counts are within one of each other.
      let maxPartner = 0;
      let minOpp = Infinity;
      let maxOpp = -Infinity;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          maxPartner = Math.max(maxPartner, partner[i][j]);
          minOpp = Math.min(minOpp, opponent[i][j]);
          maxOpp = Math.max(maxOpp, opponent[i][j]);
        }
      }
      expect(maxPartner, 'most times any pair partners').toBeLessThanOrEqual(1);
      expect(maxOpp - minOpp, `opponent counts ${minOpp}..${maxOpp}`).toBeLessThanOrEqual(1);
    });
  }

  test('the loader accepts only a plain object payload', () => {
    expect(loadScheduleSource('window.scheduleX = {"a":1}\n', 'X')).toEqual({ a: 1 });
    for (const [label, payload] of [['null', 'null'], ['scalar', '7'], ['string', '"s"'], ['array', '[1]']]) {
      expect(() => loadScheduleSource(`window.scheduleX = ${payload}\n`, 'X'), `${label} payload rejected`).toThrow();
    }
    expect(() => loadScheduleSource('alert(1)\n', 'X'), 'missing assignment rejected').toThrow();
  });

  // Provenance: these twelve are written by scheduler/engine/sitout-generate.mjs,
  // which stamps its header; the whist tables (tests/perfect_mix.spec.js) have none.
  for (const n of SITOUT_COUNTS) {
    test(`the ${n}-player table starts with the sitout-generate header`, () => {
      expect(readScheduleSource(`${n}p${n}r`).startsWith('// Generated by scheduler/engine/sitout-generate.mjs'),
        `${n}p${n}r.js header`).toBe(true);
    });
  }

  test('the data loader accepts a // header but never code', () => {
    expect(parseScheduleSource('// Generated by x\nwindow.scheduleX = {"a":1}\n', 'X')).toEqual({ a: 1 });
    expect(parseScheduleSource('alert(1);\nwindow.scheduleX = {"a":1}\n', 'X')).toBeUndefined();
    expect(() => parseScheduleSource('window.scheduleX = {"a":1}; alert(1)', 'X')).toThrow();
    // A JS line comment also ends at CR, U+2028 and U+2029, so code can hide
    // after a "// header" on what this loader would still see as one line.
    const accepted = [];
    for (const [label, separator] of [['CR', '\r'], ['U+2028', LINE_SEPARATOR], ['U+2029', PARAGRAPH_SEPARATOR]]) {
      const smuggled = `// h${separator}globalThis.zz = 7\nwindow.scheduleX = {"a":1}\n`;
      try {
        parseScheduleSource(smuggled, 'X');
        accepted.push(label);
      } catch (err) {
        // rejected, as required
      }
    }
    expect(accepted, 'separators after a header comment that the loader accepted').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Wiring: every schedule the dropdown offers has its script tag, and that
// script file assigns the global the app looks up.
// ---------------------------------------------------------------------------
test.describe('R-SITOUT-PLAY: schedule option to script to global wiring', () => {
  const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
  const select = /<select id="scheduleSelect">([\s\S]*?)<\/select>/.exec(html);
  const optionValues = select ? [...select[1].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]) : [];
  const scriptSrcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);

  test('R-SITOUT-PLAY: the dropdown offers exactly the 17 counts 8 to 24', () => {
    expect(select, '#scheduleSelect found in index.html').not.toBeNull();
    expect(optionValues).toHaveLength(17);
    const counts = optionValues.map((v) => Number(/^(\d+)p/.exec(v)[1]));
    expect(counts).toEqual(Array.from({ length: 17 }, (_, i) => i + 8));
  });

  test('R-SITOUT-PLAY: every option has a script tag and the script sets the matching global', () => {
    expect(optionValues).toHaveLength(17);
    for (const value of optionValues) {
      const m = /^(\d+)p(\d+)r\.js$/.exec(value);
      expect(m, `option value ${value} is <N>p<R>r.js`).not.toBeNull();
      const [, n, r] = m;
      const global = `schedule${n}p${r}r`;
      expect(scriptSrcs, `a <script> tag loads schedules/${value}`).toContain(`schedules/${value}`);
      const source = readScheduleSource(`${n}p${r}r`);
      const assigned = [...source.matchAll(/^window\.(schedule\w+) = /gm)].map((x) => x[1]);
      expect(assigned, `${value} assigns window.${global}`).toEqual([global]);
      const data = loadScheduleSource(source, `${n}p${r}r`);
      expect(data.playerCount, `${value} playerCount`).toBe(Number(n));
      expect(data.totalRounds, `${value} totalRounds`).toBe(Number(r));
    }
    // And no script tag is left over for a schedule the dropdown does not offer.
    const tagged = scriptSrcs.filter((s) => s.startsWith('schedules/')).map((s) => s.slice('schedules/'.length));
    expect(tagged.sort()).toEqual([...optionValues].sort());
  });
});

// ---------------------------------------------------------------------------
// Engine boundary for counts that are not a multiple of 4: N rounds is the
// full rest cycle; one more is rejected. (The multiple-of-4 limit is pinned
// in tests/equitable_mix.spec.js.)
// ---------------------------------------------------------------------------
test.describe('Engine round limit for counts that are not a multiple of 4', () => {
  let generateSchedule;
  let maxRounds;
  test.beforeAll(async () => {
    ({ generateSchedule, maxRounds } = await import(pathToFileURL(path.join(ENGINE_DIR, 'index.mjs')).href));
  });

  for (const n of [9, 10, 11]) {
    test(`${n} players accept ${n} rounds and reject ${n + 1}`, () => {
      expect(maxRounds(n)).toBe(n);
      const schedule = generateSchedule({ players: n, rounds: n });
      expect(schedule.rounds).toHaveLength(n);
      expect(() => generateSchedule({ players: n, rounds: n + 1 }))
        .toThrow(new RegExp(`^rounds must be between 1 and ${n} for ${n} players, got ${n + 1}$`));
    });
  }
});
