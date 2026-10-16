const { test, expect } = require('@playwright/test');
const { STATE_KEY } = require('./storage-keys');

// R-SITOUT-PLAY: any player count from 8 to 24 is playable. Counts that are
// not a multiple of 4 rest the leftover players each round, and the rests
// (hence the games played) are spread fairly. Scenarios are written in the
// Screenplay vocabulary of the Requirement: actors the Organizer and the
// Player; tasks "Set up at any count" and "Review the round"; questions
// "the resting players shown" and "games played per Player".

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
  test('R-SITOUT-PLAY: walking all 11 rounds of a 12-player Americano, no round shows a resting Player', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given 12 players (the default setup), when the Organizer starts an Americano,
    await organizer.attemptsTo(StartAnAmericano('Even Cup'));

    // Then the stored rounds (a fresh start, not planted state) carry no byes,
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STATE_KEY);
    expect(stored.schedule.rounds).toHaveLength(11);
    expect(stored.schedule.rounds.every((round) => !('byes' in round))).toBe(true);

    // and no round rests any Player, nor even shows a resting-players box.
    for (let r = 1; r <= 11; r++) {
      const seen = await organizer.asksFor(ReviewTheRound);
      expect(seen.round).toBe(`Round ${r}`);
      expect(seen.courts).toBe(3);
      expect(seen.resting).toEqual([]);
      await expect(organizer.page.locator('.resting-players')).toHaveCount(0);
      expect(seen.seated).toHaveLength(12);
      if (r < 11) await organizer.attemptsTo(GoToTheNextRound);
    }
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// In the browser: every schedule the dropdown offers is defined as its global.
// (The node-only data checks are in tests/sitout_tables.spec.js.)
// ---------------------------------------------------------------------------
test.describe('R-SITOUT-PLAY: schedule globals in the browser', () => {
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
