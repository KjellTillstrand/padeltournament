const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// R-SITOUT-PLAY: any player count from 8 to 24 is playable. Counts that are
// not a multiple of 4 rest the leftover players each round, and the rests
// (hence the games played) are spread fairly. Scenarios are written in the
// Screenplay vocabulary of the Requirement: actors the Organizer and the
// Player; tasks "Set up at any count" and "Review the round"; questions
// "the resting players shown" and "games played per Player".

const WEB_DIR = path.join(__dirname, '..', 'web');
const SCHEDULE_DIR = path.join(WEB_DIR, 'schedules');
const ENGINE_DIR = path.join(__dirname, '..', 'scheduler', 'engine');

// --- Screenplay kernel (Actor / Task / Question) ---
class Actor {
  constructor(name, page) {
    this.name = name;
    this.page = page; // ability: drive the UI
  }
  async attemptsTo(...tasks) {
    for (const task of tasks) await task(this);
  }
  async asksFor(question) {
    return question(this);
  }
}
const theOrganizer = (page) => new Actor('the Organizer', page);

// --- Tasks ---
// Set up at any count: select the schedule for a count and name the players
// Name1..NameN so the questions can tell them apart.
const SetUpAtAnyCount = (players, rounds) => async (actor) => {
  const { page } = actor;
  await page.selectOption('#scheduleSelect', `${players}p${rounds}r.js`);
  await expect(page.locator('[id^="playerInput_"]')).toHaveCount(players);
  for (let i = 0; i < players; i++) await page.fill(`#playerInput_${i}`, `Name${i + 1}`);
};
const StartAnAmericano = (tournamentName) => async (actor) => {
  await actor.page.fill('#tournamentName', tournamentName);
  await actor.page.click('#startTournamentBtn');
};
const GoToTheNextRound = async (actor) => {
  await actor.page.getByRole('button', { name: 'NEXT ROUND' }).click();
};

// --- Questions ---
const TheRoundShown = async (actor) =>
  (await actor.page.locator('.round-header .left').textContent()).trim();
const TheCourtsShown = async (actor) => actor.page.locator('#tournamentContainer .court').count();
const TheRestingPlayersShown = async (actor) =>
  actor.page.locator('.resting-players .resting-player').allTextContents();
const ThePlayersSeated = async (actor) =>
  actor.page.locator('#tournamentContainer .match').evaluateAll((matches) =>
    matches.flatMap((m) => [...m.dataset.teamLeft.split(','), ...m.dataset.teamRight.split(',')]));

// Review the round: what the Organizer sees for the current round.
const ReviewTheRound = async (actor) => ({
  round: await actor.asksFor(TheRoundShown),
  courts: await actor.asksFor(TheCourtsShown),
  resting: await actor.asksFor(TheRestingPlayersShown),
  seated: await actor.asksFor(ThePlayersSeated),
});

// Review every round in turn, tallying games played (GamesPlayedPerPlayer) and
// rests (RestsPerPlayer) from what the screen shows.
async function reviewAllRounds(actor, names, totalRounds) {
  const games = Object.fromEntries(names.map((n) => [n, 0]));
  const rests = Object.fromEntries(names.map((n) => [n, 0]));
  const rounds = [];
  for (let r = 1; r <= totalRounds; r++) {
    const seen = await actor.asksFor(ReviewTheRound);
    expect(seen.round).toBe(`Round ${r}`);
    seen.seated.forEach((n) => { games[n]++; });
    seen.resting.forEach((n) => { rests[n]++; });
    rounds.push(seen);
    if (r < totalRounds) await actor.attemptsTo(GoToTheNextRound);
  }
  return { games, rests, rounds };
}

const spread = (counts) => {
  const values = Object.values(counts);
  return Math.max(...values) - Math.min(...values);
};

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
  return errors;
}

test.describe('R-SITOUT-PLAY: playing at any count', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  // Scenario Outline: Any count from 8 to 24 is playable
  for (const players of [9, 10, 13, 22]) {
    test(`R-SITOUT-PLAY: ${players} players are offered a full tournament showing who rests each round`, async ({ page }) => {
      const errors = collectErrors(page);
      const organizer = theOrganizer(page);
      const courts = Math.floor(players / 4);
      const resting = players % 4;
      const names = Array.from({ length: players }, (_, i) => `Name${i + 1}`);

      // Given N players, when the Organizer starts an Americano,
      await organizer.attemptsTo(SetUpAtAnyCount(players, players), StartAnAmericano(`Any Count ${players}`));

      // Then a full tournament is offered: N rounds, then no further round,
      const { rounds } = await reviewAllRounds(organizer, names, players);
      expect(rounds).toHaveLength(players);
      await expect(page.getByRole('button', { name: 'NEXT ROUND' })).toHaveCount(0);

      // and each round shows which Players rest, exactly those not seated.
      for (const seen of rounds) {
        expect(seen.courts).toBe(courts);
        expect(seen.resting).toHaveLength(resting);
        expect([...seen.seated, ...seen.resting].sort()).toEqual([...names].sort());
      }
      expect(errors).toEqual([]);
    });
  }

  // Scenario: Rests are spread fairly
  test('R-SITOUT-PLAY: a 10-player Americano over its full length spreads rests and games within one', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);
    const names = Array.from({ length: 10 }, (_, i) => `Name${i + 1}`);

    // Given a 10-player Americano over its full length,
    await organizer.attemptsTo(SetUpAtAnyCount(10, 10), StartAnAmericano('Fair Cup'));

    // When the tournament completes,
    const { games, rests, rounds } = await reviewAllRounds(organizer, names, 10);
    expect(rounds).toHaveLength(10);

    // Then sit-out counts across Players differ by at most one,
    expect(spread(rests), `rests per Player ${JSON.stringify(rests)}`).toBeLessThanOrEqual(1);
    // and games played across Players differ by at most one.
    expect(spread(games), `games per Player ${JSON.stringify(games)}`).toBeLessThanOrEqual(1);
    // Everyone is accounted for in every round: plays or rests, never both.
    expect(Object.values(rests).reduce((a, b) => a + b, 0)).toBe(10 * 2);
    expect(Object.values(games).reduce((a, b) => a + b, 0)).toBe(10 * 8);
    expect(errors).toEqual([]);
  });

  // Scenario: A multiple-of-4 count rests nobody
  test('R-SITOUT-PLAY: a 12-player Americano rests nobody in any round', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given 12 players (the default setup), when the Organizer starts an Americano,
    await organizer.attemptsTo(StartAnAmericano('Even Cup'));

    // Then no round rests any Player.
    for (let r = 1; r <= 11; r++) {
      const seen = await organizer.asksFor(ReviewTheRound);
      expect(seen.round).toBe(`Round ${r}`);
      expect(seen.courts).toBe(3);
      expect(seen.resting).toEqual([]);
      expect(seen.seated).toHaveLength(12);
      if (r < 11) await organizer.attemptsTo(GoToTheNextRound);
    }
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The shipped sit-out tables, re-verified in CI. Data only: the table files
// are read as text and parsed as JSON, never executed.
// ---------------------------------------------------------------------------

// Split a schedule module into its JSON document, as pure data: optional
// leading `//` comment lines (the generated tables carry a "Generated by"
// header), then exactly `window.schedule<name> = ` and a JSON document.
// Returns undefined when the text does not have that shape; JSON.parse throws
// on embedded or trailing code.
function parseScheduleSource(source, name) {
  const lines = source.split('\n');
  let first = 0;
  while (first < lines.length && lines[first].startsWith('//')) first++;
  const body = lines.slice(first).join('\n');
  const prefix = `window.schedule${name} = `;
  if (!body.startsWith(prefix)) return undefined;
  return JSON.parse(body.slice(prefix.length));
}

function loadScheduleData(name) {
  const source = fs.readFileSync(path.join(SCHEDULE_DIR, `${name}.js`), 'utf8');
  const data = parseScheduleSource(source, name);
  expect(data, `${name}.js is "window.schedule${name} = <JSON>" after any // header`).toBeDefined();
  return data;
}

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

  test('R-SITOUT-PLAY: the data loader accepts a // header but never code', () => {
    expect(parseScheduleSource('// Generated by x\nwindow.scheduleX = {"a":1}\n', 'X')).toEqual({ a: 1 });
    expect(parseScheduleSource('alert(1);\nwindow.scheduleX = {"a":1}\n', 'X')).toBeUndefined();
    expect(() => parseScheduleSource('window.scheduleX = {"a":1}; alert(1)', 'X')).toThrow();
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
      const source = fs.readFileSync(path.join(SCHEDULE_DIR, value), 'utf8');
      const assigned = [...source.matchAll(/^window\.(schedule\w+) = /gm)].map((x) => x[1]);
      expect(assigned, `${value} assigns window.${global}`).toEqual([global]);
      const data = loadScheduleData(`${n}p${r}r`);
      expect(data.playerCount, `${value} playerCount`).toBe(Number(n));
      expect(data.totalRounds, `${value} totalRounds`).toBe(Number(r));
    }
    // And no script tag is left over for a schedule the dropdown does not offer.
    const tagged = scriptSrcs.filter((s) => s.startsWith('schedules/')).map((s) => s.slice('schedules/'.length));
    expect(tagged.sort()).toEqual([...optionValues].sort());
  });

  test('R-SITOUT-PLAY: in the browser every offered schedule is defined as its global', async ({ page }) => {
    await page.goto('/');
    const missing = await page.evaluate(() =>
      [...document.querySelectorAll('#scheduleSelect option')]
        .map((o) => /^(\d+p\d+r)\.js$/.exec(o.value)[1])
        .filter((id) => {
          const s = window['schedule' + id];
          return !(s && Array.isArray(s.players) && Array.isArray(s.rounds));
        }));
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Engine boundary for counts that are not a multiple of 4: N rounds is the
// full rest cycle; one more is rejected. (The multiple-of-4 limit is pinned
// in tests/equitable_mix.spec.js.)
// ---------------------------------------------------------------------------
test.describe('R-SITOUT-PLAY: engine round limit', () => {
  let generateSchedule;
  let maxRounds;
  test.beforeAll(async () => {
    ({ generateSchedule, maxRounds } = await import(path.join(ENGINE_DIR, 'index.mjs')));
  });

  for (const n of [9, 10, 11]) {
    test(`R-SITOUT-PLAY: ${n} players accept ${n} rounds and reject ${n + 1}`, () => {
      expect(maxRounds(n)).toBe(n);
      const schedule = generateSchedule({ players: n, rounds: n });
      expect(schedule.rounds).toHaveLength(n);
      expect(() => generateSchedule({ players: n, rounds: n + 1 }))
        .toThrow(new RegExp(`rounds must be between 1 and ${n}`));
    });
  }
});
