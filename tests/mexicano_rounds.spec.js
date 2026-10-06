// tests/mexicano_rounds.spec.js
//
// R-MEXICANO-ROUNDS (AB#59): a Mexicano tournament is played one round at a
// time. The next round is offered only when the current one is complete,
// generating it locks the current round's scores, and earlier rounds stay
// viewable. Americano is unaffected.
const { test, expect } = require('@playwright/test');

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
const ChooseMexicanoFor = (playerCount) => async (actor) => {
  await actor.page.selectOption('#formatSelect', 'mexicano');
  await actor.page.selectOption('#playerCountSelect', String(playerCount));
};
const NameThePlayers = (names) => async (actor) => {
  for (const [index, name] of names.entries()) {
    await actor.page.fill(`#playerInput_${index}`, name);
  }
};
const StartTheTournament = (tournamentName) => async (actor) => {
  await actor.page.fill('#tournamentName', tournamentName);
  await actor.page.click('#startTournamentBtn');
};
// The left score of match `index` on screen; the right one completes itself.
const EnterTheScore = (index, left) => async (actor) => {
  const match = actor.page.locator('.matches-container .match').nth(index);
  await match.locator('.result-overlay-left input').fill(String(left));
  await expect(match.locator('.error-message')).toHaveText('');
};
const CompleteTheRound = (lefts) => async (actor) => {
  for (const [index, left] of lefts.entries()) await actor.attemptsTo(EnterTheScore(index, left));
};
const GenerateTheNextRound = async (actor) => {
  await actor.page.click('#generateNextRoundBtn');
};
const GoToThePreviousRound = async (actor) => {
  await actor.page.getByRole('button', { name: 'PREVIOUS ROUND', exact: true }).click();
};
const GoToTheNextRound = async (actor) => {
  await actor.page.getByRole('button', { name: 'NEXT ROUND', exact: true }).click();
};

// --- Questions ---
const DisplayedRoundTitle = async (actor) =>
  (await actor.page.locator('.round-header .left').textContent()).trim();
// Each match on screen as [[left, left], [right, right]].
const TheMatchesOnScreen = async (actor) =>
  actor.page.locator('.matches-container .match').evaluateAll((matches) =>
    matches.map((m) => [m.dataset.teamLeft.split(','), m.dataset.teamRight.split(',')]));
const TheRestingPlayers = async (actor) =>
  actor.page.locator('.resting-players .resting-player').allTextContents();
// The scoreboard's players, best first: the ranking the next round pairs by.
const TheRanking = async (actor) =>
  actor.page.locator('.scoreboard-container tr td:first-child').allTextContents();
const TheScoresOnScreen = async (actor) =>
  actor.page.locator('.matches-container .match').evaluateAll((matches) =>
    matches.map((m) => [
      m.querySelector('.result-overlay-left input').value,
      m.querySelector('.result-overlay-right input').value,
    ]));
const TheStoredState = async (actor) =>
  actor.page.evaluate(() => JSON.parse(localStorage.getItem('tournamentState')));

// Uncaught exceptions and console errors: none may occur on any Mexicano path.
function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
  return errors;
}

async function expectTheScoresLocked(page) {
  const inputs = page.locator('.result-overlay-container input');
  const count = await inputs.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) await expect(inputs.nth(i)).toBeDisabled();
  await expect(page.locator('#generateNextRoundBtn')).toHaveCount(0);
}

async function expectTheScoresEditable(page) {
  const inputs = page.locator('.result-overlay-container input');
  const count = await inputs.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) await expect(inputs.nth(i)).toBeEnabled();
}

// The round Mexicano pairs from a ranking (best first) and the players who
// rested once already (everyone else has rested 0 times): the fewest rests sit
// out, lowest-placed first; then fours by rank, 1st & 4th against 2nd & 3rd.
function expectedNextRound(ranking, restedOnce) {
  const restingCount = ranking.length % 4;
  const restOrder = ranking
    .map((player, position) => ({ player, position, rests: restedOnce.includes(player) ? 1 : 0 }))
    .sort((a, b) => a.rests - b.rests || b.position - a.position);
  const resting = restOrder.slice(0, restingCount).map((entry) => entry.player);
  const fielded = ranking.filter((player) => !resting.includes(player));
  const matches = [];
  for (let i = 0; i < fielded.length; i += 4) {
    matches.push([[fielded[i], fielded[i + 3]], [fielded[i + 1], fielded[i + 2]]]);
  }
  return { matches, resting };
}

test.describe('R-MEXICANO-ROUNDS: One round at a time, locked once it seeds the next', () => {
  test.beforeEach(async ({ page }) => {
    // Reset state between tests to avoid the suite's known bleed-through failure mode.
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('R-MEXICANO-ROUNDS, R-FORMAT-SELECT: A 10-player Mexicano is started and played round by round, across a reload and a save/load', async ({ page }) => {
    const errors = collectErrors(page);
    const dialogs = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      // Decline "save first?" on New Tournament; accept every notice.
      if (dialog.type() === 'confirm') dialog.dismiss(); else dialog.accept();
    });
    const organizer = theOrganizer(page);
    // Names that are also Object.prototype keys must play like any other.
    const names = ['Ada', 'Bo', '__proto__', 'constructor', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'toString'];

    // Given a Mexicano setup for 10 players, each named.
    await organizer.attemptsTo(ChooseMexicanoFor(10));
    await expect(page.locator('[id^="playerInput_"]')).toHaveCount(10);
    await expect(page.locator('[id^="courtNameInput_"]')).toHaveCount(2);
    await organizer.attemptsTo(NameThePlayers(names));

    // When the Organizer starts it,
    await expect(page.locator('#startTournamentBtn')).toBeEnabled();
    await organizer.attemptsTo(StartTheTournament('Mexicano Night'));

    // Then round 1 is drawn: two courts, and two of the ten players rest.
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.court')).toHaveCount(2);
    const roundOneResting = await organizer.asksFor(TheRestingPlayers);
    expect(roundOneResting).toHaveLength(2);
    const roundOne = await organizer.asksFor(TheMatchesOnScreen);
    const seated = roundOne.flat(2);
    expect(new Set([...seated, ...roundOneResting])).toEqual(new Set(names));
    expect(seated).toHaveLength(8);
    // The format is locked and the draw is recorded with its seed.
    await expect(page.locator('#formatSelect')).toBeDisabled();
    let stored = await organizer.asksFor(TheStoredState);
    expect(stored.tournamentStarted).toBe(true);
    expect(stored.format).toBe('mexicano');
    expect(Number.isInteger(stored.mexicanoSeed)).toBe(true);
    expect(stored.schedule.rounds).toHaveLength(1);
    const seed = stored.mexicanoSeed;
    // No next round is offered until round 1 is complete.
    await expect(page.locator('#generateNextRoundBtn')).toBeDisabled();

    // When the Organizer completes round 1 and generates round 2,
    await organizer.attemptsTo(CompleteTheRound([20, 15]));
    await expect(page.locator('#generateNextRoundBtn')).toBeEnabled();
    const ranking = await organizer.asksFor(TheRanking);
    expect(new Set(ranking)).toEqual(new Set(names));
    await organizer.attemptsTo(GenerateTheNextRound);

    // Then round 2 pairs by the scoreboard's ranking, and round 1's resters play.
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');
    const expected = expectedNextRound(ranking, roundOneResting);
    expect(await organizer.asksFor(TheMatchesOnScreen)).toEqual(expected.matches);
    const roundTwoResting = await organizer.asksFor(TheRestingPlayers);
    expect(new Set(roundTwoResting)).toEqual(new Set(expected.resting));
    for (const player of roundOneResting) expect(roundTwoResting).not.toContain(player);
    await expectTheScoresEditable(page);

    // And round 1 stays viewable, with its scores locked.
    await organizer.attemptsTo(GoToThePreviousRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
    expect(await organizer.asksFor(TheMatchesOnScreen)).toEqual(roundOne);
    expect(await organizer.asksFor(TheScoresOnScreen)).toEqual([['20', '4'], ['15', '9']]);
    await expectTheScoresLocked(page);
    await organizer.attemptsTo(GoToTheNextRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');

    // When the page reloads mid-tournament (one score already entered in round 2),
    await organizer.attemptsTo(EnterTheScore(0, 13));
    await page.reload();

    // Then play resumes at round 2, still editable, with round 1 still locked.
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');
    expect(await organizer.asksFor(TheMatchesOnScreen)).toEqual(expected.matches);
    expect((await organizer.asksFor(TheScoresOnScreen))[0]).toEqual(['13', '11']);
    await expectTheScoresEditable(page);
    await expect(page.locator('#generateNextRoundBtn')).toBeDisabled();
    await organizer.attemptsTo(GoToThePreviousRound);
    await expectTheScoresLocked(page);
    expect(await organizer.asksFor(TheScoresOnScreen)).toEqual([['20', '4'], ['15', '9']]);
    await organizer.attemptsTo(GoToTheNextRound);

    // When the Organizer saves it, starts a new tournament, and loads the save,
    await page.click('#saveTournamentBtn');
    await page.click('#newTournamentBtn');
    await expect.poll(() => dialogs.length).toBe(3);
    await expect(page.locator('#settingsContainer')).toBeVisible();
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
    await page.click('#loadTournamentBtn');

    // Then the Mexicano tournament is back at round 2, with round 1 locked,
    await expect(page.locator('#tournamentTitle')).toHaveText('Mexicano Night');
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');
    expect(await organizer.asksFor(TheMatchesOnScreen)).toEqual(expected.matches);
    await expectTheScoresEditable(page);
    await expect(page.locator('#formatSelect')).toHaveValue('mexicano');
    await organizer.attemptsTo(GoToThePreviousRound);
    await expectTheScoresLocked(page);
    await organizer.attemptsTo(GoToTheNextRound);
    stored = await organizer.asksFor(TheStoredState);
    expect(stored.format).toBe('mexicano');
    expect(stored.mexicanoSeed).toBe(seed);
    expect(stored.schedule.rounds).toHaveLength(2);

    // And play goes on: round 2 completes and round 3 is generated, locking round 2.
    await organizer.attemptsTo(CompleteTheRound([13, 12]));
    await organizer.attemptsTo(GenerateTheNextRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 3');
    await expect(page.locator('.court')).toHaveCount(2);
    await expectTheScoresEditable(page);
    await organizer.attemptsTo(GoToThePreviousRound);
    await expectTheScoresLocked(page);
    await organizer.attemptsTo(GoToThePreviousRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
    await expectTheScoresLocked(page);
    expect(dialogs).toEqual([
      'Tournament saved!',
      'Do you want to save the current tournament before creating a new one?',
      'Ready for a new tournament!',
    ]);
    expect(errors).toEqual([]);
  });

  test('R-MEXICANO-ROUNDS: The next round is offered only when the current one is complete', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given a 12-player Mexicano round with a match missing its score
    // (court 1 is scored; courts 2 and 3 are not),
    await organizer.attemptsTo(ChooseMexicanoFor(12), StartTheTournament('Incomplete Cup'));
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.court')).toHaveCount(3);
    await organizer.attemptsTo(EnterTheScore(0, 14));

    // Then the next round is not offered,
    const generate = page.locator('#generateNextRoundBtn');
    await expect(generate).toBeDisabled();
    // and the missing scores are indicated: by court name, and on the matches.
    const status = page.locator('#nextRoundStatus');
    await expect(status).toBeVisible();
    await expect(status).toContainText('Court 2');
    await expect(status).toContainText('Court 3');
    await expect(status).not.toContainText('Court 1');
    await expect(page.locator('.matches-container .match.score-missing')).toHaveCount(2);
    await expect(page.locator('.matches-container .match').nth(0)).not.toHaveClass(/score-missing/);

    // When the Organizer asks for the next round anyway (the disabled control re-enabled, as with devtools),
    await page.evaluate(() => document.getElementById('generateNextRoundBtn').removeAttribute('disabled'));
    await organizer.attemptsTo(GenerateTheNextRound);

    // Then the next round shall not be generated,
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
    await expect(page.getByRole('button', { name: 'NEXT ROUND', exact: true })).toHaveCount(0);
    expect((await organizer.asksFor(TheStoredState)).schedule.rounds).toHaveLength(1);
    // and the missing scores are still indicated.
    await expect(status).toContainText('Court 2');
    await expect(page.locator('.matches-container .match.score-missing')).toHaveCount(2);
    await expect(generate).toBeDisabled();
    await expectTheScoresEditable(page);

    // When the remaining scores are entered, the next round is offered and nothing is flagged.
    await organizer.attemptsTo(EnterTheScore(1, 12), EnterTheScore(2, 24));
    await expect(generate).toBeEnabled();
    await expect(status).not.toContainText('Court 2');
    await expect(page.locator('.matches-container .match.score-missing')).toHaveCount(0);

    // And clearing one again takes the offer back.
    await page.locator('.matches-container .match').nth(1).locator('.result-overlay-left input').fill('');
    await expect(generate).toBeDisabled();
    await expect(status).toContainText('Court 2');
    expect(errors).toEqual([]);
  });

  test('R-MEXICANO-ROUNDS: Generating the next round locks the current one', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given a completed 8-player Mexicano round,
    await organizer.attemptsTo(ChooseMexicanoFor(8), StartTheTournament('Lock Cup'));
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.resting-players')).toHaveCount(0);
    await organizer.attemptsTo(CompleteTheRound([18, 7]));

    // When the Organizer generates the next round,
    await organizer.attemptsTo(GenerateTheNextRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');
    await expectTheScoresEditable(page);

    // Then the completed round's scores shall no longer be editable,
    await organizer.attemptsTo(GoToThePreviousRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
    await expectTheScoresLocked(page);
    // and earlier rounds shall remain viewable, scores and all.
    expect(await organizer.asksFor(TheScoresOnScreen)).toEqual([['18', '6'], ['7', '17']]);
    await expect(page.locator('.scoreboard-container tr')).toHaveCount(9);

    // A locked score cannot be changed, not even through a re-enabled input.
    await page.evaluate(() => {
      const input = document.querySelector('.result-overlay-left input');
      input.disabled = false;
      input.value = '1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const stored = await organizer.asksFor(TheStoredState);
    expect(stored.schedule.rounds[0].matches[0].result).toEqual({ left: '18', right: '6' });

    // And after another round, both earlier rounds are locked and only the latest is editable.
    await organizer.attemptsTo(GoToTheNextRound, CompleteTheRound([12, 12]), GenerateTheNextRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 3');
    await expectTheScoresEditable(page);
    await organizer.attemptsTo(GoToThePreviousRound);
    await expectTheScoresLocked(page);
    expect(await organizer.asksFor(TheScoresOnScreen)).toEqual([['12', '12'], ['12', '12']]);
    await organizer.attemptsTo(GoToThePreviousRound);
    await expectTheScoresLocked(page);
    expect(errors).toEqual([]);
  });

  test('R-MEXICANO-ROUNDS: A locked round cannot be edited even through a re-enabled input', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given round 1 completed and round 2 generated, so round 1 is locked.
    await organizer.attemptsTo(ChooseMexicanoFor(8), StartTheTournament('Tamper Cup'));
    await organizer.attemptsTo(CompleteTheRound([18, 7]), GenerateTheNextRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');
    await organizer.attemptsTo(GoToThePreviousRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
    await expectTheScoresLocked(page);
    const original = [['18', '6'], ['7', '17']];
    expect(await organizer.asksFor(TheScoresOnScreen)).toEqual(original);

    // When the Organizer removes the disabled attribute in devtools and types a new score,
    const input = page.locator('.matches-container .match').nth(0).locator('.result-overlay-left input');
    await page.evaluate(() => {
      document.querySelectorAll('.result-overlay-container input').forEach((el) => el.removeAttribute('disabled'));
    });
    await expect(input).toBeEnabled();
    await input.fill('3');
    await input.dispatchEvent('input');
    await input.dispatchEvent('change');

    // Then the displayed score is unchanged (the opposite side was not recomputed either),
    // by the app's own state ...
    const stored = await organizer.asksFor(TheStoredState);
    expect(stored.schedule.rounds[0].matches[0].result).toEqual({ left: '18', right: '6' });
    expect(stored.schedule.rounds[1].matches.map((m) => m.result)).not.toContainEqual({ left: '3', right: '21' });

    // ... and after a reload the persisted round-1 scores are still the originals,
    await page.reload();
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
    expect(await organizer.asksFor(TheScoresOnScreen)).toEqual(original);
    // and the round stays locked.
    await expectTheScoresLocked(page);
    expect(errors).toEqual([]);
  });

  test('R-MEXICANO-ROUNDS: Generation stops at the round cap and says so', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);
    const CAP = 128;

    // Given a started 8-player Mexicano tournament, planted at the cap: 127 scored
    // rounds and a 128th still to be scored. (Playing 128 rounds through the UI is
    // too slow, so the state a real run persists is rewritten: round 1's draw
    // repeated and renumbered, which is a sound Mexicano schedule to the app.)
    await organizer.attemptsTo(ChooseMexicanoFor(8), StartTheTournament('Cap Cup'));
    const planted = await page.evaluate((cap) => {
      const state = JSON.parse(localStorage.getItem('tournamentState'));
      const first = state.schedule.rounds[0];
      state.schedule.rounds = Array.from({ length: cap }, (_, i) => {
        const round = JSON.parse(JSON.stringify(first));
        round.roundNumber = i + 1;
        round.matches.forEach((m) => { m.result = i < cap - 1 ? { left: '12', right: '12' } : { left: '', right: '' }; });
        return round;
      });
      state.currentRoundIndex = cap - 1;
      return JSON.stringify(state);
    }, CAP);
    // The app saves its own state on unload, so the plant goes in before the app
    // loads (once: later reloads must keep what the app itself persisted).
    await page.addInitScript((json) => {
      if (!sessionStorage.getItem('planted')) {
        sessionStorage.setItem('planted', '1');
        localStorage.setItem('tournamentState', json);
      }
    }, planted);
    await page.reload();
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round ' + CAP);
    const generate = page.locator('#generateNextRoundBtn');
    const status = page.locator('#nextRoundStatus');
    await expect(generate).toBeDisabled();
    await expect(status).toContainText('Waiting for a valid score');

    // When the last round's scores are completed,
    await organizer.attemptsTo(CompleteTheRound([14, 9]));

    // Then no next round is offered and the status line explains the cap,
    await expect(generate).toBeDisabled();
    await expect(status).toContainText('maximum of ' + CAP + ' rounds');
    // and asking anyway (the control re-enabled, as with devtools) adds no round 129.
    await page.evaluate(() => document.getElementById('generateNextRoundBtn').removeAttribute('disabled'));
    await organizer.attemptsTo(GenerateTheNextRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round ' + CAP);
    await expect(page.getByRole('button', { name: 'NEXT ROUND', exact: true })).toHaveCount(0);
    await expect(status).toContainText('maximum of ' + CAP + ' rounds');
    expect((await organizer.asksFor(TheStoredState)).schedule.rounds).toHaveLength(CAP);
    await page.reload();
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round ' + CAP);
    expect((await organizer.asksFor(TheStoredState)).schedule.rounds).toHaveLength(CAP);
    expect(errors).toEqual([]);
  });

  test('R-MEXICANO-ROUNDS: An Americano tournament is unaffected', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given an Americano tournament,
    await organizer.attemptsTo(StartTheTournament('Americano Cup'));
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await organizer.attemptsTo(EnterTheScore(0, 10));
    // with no generate control: its rounds come from the schedule.
    await expect(page.locator('#generateNextRoundBtn')).toHaveCount(0);
    await expect(page.locator('#nextRoundStatus')).toHaveCount(0);

    // When the Organizer navigates rounds,
    await organizer.attemptsTo(GoToTheNextRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');
    await expectTheScoresEditable(page);
    await organizer.attemptsTo(EnterTheScore(0, 5));
    await organizer.attemptsTo(GoToTheNextRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 3');

    // Then scores shall remain editable as today, in every round, earlier ones included.
    await organizer.attemptsTo(GoToThePreviousRound, GoToThePreviousRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
    await expectTheScoresEditable(page);
    await organizer.attemptsTo(EnterTheScore(0, 16));
    expect((await organizer.asksFor(TheScoresOnScreen))[0]).toEqual(['16', '8']);
    await organizer.attemptsTo(GoToTheNextRound);
    await expectTheScoresEditable(page);
    expect((await organizer.asksFor(TheScoresOnScreen))[0]).toEqual(['5', '19']);
    await expect(page.locator('.matches-container .match.score-missing')).toHaveCount(0);
    const stored = await organizer.asksFor(TheStoredState);
    expect(stored.format).toBe('americano');
    expect(stored.schedule.rounds).toHaveLength(11);
    expect(stored.schedule.rounds[0].matches[0].result).toEqual({ left: '16', right: '8' });
    expect(errors).toEqual([]);
  });
});
