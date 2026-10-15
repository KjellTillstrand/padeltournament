// tests/mexicano_rounds.spec.js
//
// R-MEXICANO-ROUNDS (AB#59): a Mexicano tournament is played one round at a
// time. The next round is offered only when the current one is complete,
// generating it locks the current round's scores, and earlier rounds stay
// viewable. Americano is unaffected.
const { test, expect } = require('@playwright/test');
const { STATE_KEY } = require('./storage-keys');

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
  actor.page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STATE_KEY);

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

// The generate control is never natively disabled (AB#70): while the next round
// is not offered it is aria-disabled, so it stays focusable and the status line
// that explains why (its aria-describedby) stays reachable by keyboard.
async function expectTheNextRoundNotOffered(page) {
  const generate = page.locator('#generateNextRoundBtn');
  await expect(generate).toHaveAttribute('aria-disabled', 'true');
  await expect(generate).not.toHaveAttribute('disabled');
}

async function expectTheNextRoundOffered(page) {
  await expect(page.locator('#generateNextRoundBtn')).toHaveAttribute('aria-disabled', 'false');
}

// Ways to activate the generate control as it is. Playwright's actionability
// check treats aria-disabled as disabled, so the click is forced: a real
// pointer is not stopped by aria-disabled either.
const ActivateTheGenerateControl = {
  byClick: async (actor) => {
    await actor.page.locator('#generateNextRoundBtn').click({ force: true });
  },
  byEnter: async (actor) => {
    await actor.page.locator('#generateNextRoundBtn').focus();
    await actor.page.keyboard.press('Enter');
  },
  bySpace: async (actor) => {
    await actor.page.locator('#generateNextRoundBtn').focus();
    await actor.page.keyboard.press('Space');
  },
};

// Activating the control while the next round is not offered generates nothing:
// the same round stays on screen, no round is added (on screen or stored), and
// the round stays editable (nothing was locked).
async function expectActivatingItGeneratesNothing(page, activate = ActivateTheGenerateControl.byClick) {
  const title = (await page.locator('.round-header .left').textContent()).trim();
  const storedRounds = async () => page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)).schedule.rounds.length, STATE_KEY);
  const before = await storedRounds();
  await activate(theOrganizer(page));
  await expect(page.locator('.round-header .left')).toHaveText(title);
  await expect(page.getByRole('button', { name: 'NEXT ROUND', exact: true })).toHaveCount(0);
  expect(await storedRounds()).toBe(before);
  await expectTheScoresEditable(page);
  await expectTheNextRoundNotOffered(page);
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
    // No next round is offered until round 1 is complete, and asking anyway generates none.
    await expectTheNextRoundNotOffered(page);
    await expectActivatingItGeneratesNothing(page);

    // When the Organizer completes round 1 and generates round 2,
    await organizer.attemptsTo(CompleteTheRound([20, 15]));
    await expectTheNextRoundOffered(page);
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
    await expectTheNextRoundNotOffered(page);
    await expectActivatingItGeneratesNothing(page);
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
    // Rests accumulate: round 3's resters sat out neither round 1 nor round 2.
    const roundThreeResting = await organizer.asksFor(TheRestingPlayers);
    expect(roundThreeResting).toHaveLength(2);
    for (const player of roundThreeResting) {
      expect(roundOneResting).not.toContain(player);
      expect(roundTwoResting).not.toContain(player);
    }
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
    await expectTheNextRoundNotOffered(page);
    // and the missing scores are indicated: by court name, and on the matches.
    const status = page.locator('#nextRoundStatus');
    await expect(status).toBeVisible();
    await expect(status).toContainText('Court 2');
    await expect(status).toContainText('Court 3');
    await expect(status).not.toContainText('Court 1');
    await expect(page.locator('.matches-container .match.score-missing')).toHaveCount(2);
    await expect(page.locator('.matches-container .match').nth(0)).not.toHaveClass(/score-missing/);

    // When the Organizer asks for the next round anyway (the control activated as it is),
    await organizer.attemptsTo(ActivateTheGenerateControl.byClick);

    // Then the next round shall not be generated,
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
    await expect(page.getByRole('button', { name: 'NEXT ROUND', exact: true })).toHaveCount(0);
    expect((await organizer.asksFor(TheStoredState)).schedule.rounds).toHaveLength(1);
    // and the missing scores are still indicated.
    await expect(status).toContainText('Court 2');
    await expect(page.locator('.matches-container .match.score-missing')).toHaveCount(2);
    await expectTheNextRoundNotOffered(page);
    await expectTheScoresEditable(page);

    // When the remaining scores are entered, the next round is offered and nothing is flagged.
    await organizer.attemptsTo(EnterTheScore(1, 12), EnterTheScore(2, 24));
    await expectTheNextRoundOffered(page);
    await expect(status).not.toContainText('Court 2');
    await expect(page.locator('.matches-container .match.score-missing')).toHaveCount(0);

    // And clearing one again takes the offer back.
    await page.locator('.matches-container .match').nth(1).locator('.result-overlay-left input').fill('');
    await expectTheNextRoundNotOffered(page);
    await expect(status).toContainText('Court 2');
    await expectActivatingItGeneratesNothing(page);
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
    const planted = await page.evaluate(({ key, cap }) => {
      const state = JSON.parse(localStorage.getItem(key));
      const first = state.schedule.rounds[0];
      state.schedule.rounds = Array.from({ length: cap }, (_, i) => {
        const round = JSON.parse(JSON.stringify(first));
        round.roundNumber = i + 1;
        round.matches.forEach((m) => { m.result = i < cap - 1 ? { left: '12', right: '12' } : { left: '', right: '' }; });
        return round;
      });
      state.currentRoundIndex = cap - 1;
      return JSON.stringify(state);
    }, { key: STATE_KEY, cap: CAP });
    // The app saves its own state on unload, so the plant goes in before the app
    // loads (once: later reloads must keep what the app itself persisted).
    await page.addInitScript(({ key, json }) => {
      if (!sessionStorage.getItem('planted')) {
        sessionStorage.setItem('planted', '1');
        localStorage.setItem(key, json);
      }
    }, { key: STATE_KEY, json: planted });
    await page.reload();
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round ' + CAP);
    const status = page.locator('#nextRoundStatus');
    await expectTheNextRoundNotOffered(page);
    await expect(status).toContainText('Waiting for a valid score');
    await expectActivatingItGeneratesNothing(page);

    // When the last round's scores are completed,
    await organizer.attemptsTo(CompleteTheRound([14, 9]));

    // Then no next round is offered and the status line explains the cap,
    await expectTheNextRoundNotOffered(page);
    await expect(status).toContainText('maximum of ' + CAP + ' rounds');
    // and asking anyway (the control activated as it is) adds no round 129.
    await expectActivatingItGeneratesNothing(page);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round ' + CAP);
    await expect(page.getByRole('button', { name: 'NEXT ROUND', exact: true })).toHaveCount(0);
    await expect(status).toContainText('maximum of ' + CAP + ' rounds');
    expect((await organizer.asksFor(TheStoredState)).schedule.rounds).toHaveLength(CAP);
    await page.reload();
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round ' + CAP);
    expect((await organizer.asksFor(TheStoredState)).schedule.rounds).toHaveLength(CAP);
    expect(errors).toEqual([]);
  });

  for (const [label, left] of [['fractional', '12.5'], ['negative', '-3']]) {
    test(`R-MEXICANO-ROUNDS: A ${label} score keeps the next round unavailable and flags the court`, async ({ page }) => {
      const errors = collectErrors(page);
      const organizer = theOrganizer(page);

      // Given an 8-player round whose first court is scored validly,
      await organizer.attemptsTo(ChooseMexicanoFor(8), StartTheTournament('Invalid Cup'));
      await organizer.attemptsTo(EnterTheScore(0, 14));

      // When the second court gets a non-empty but invalid score (it completes
      // nothing: the other side stays empty, and the court says why),
      const second = page.locator('.matches-container .match').nth(1);
      await second.locator('.result-overlay-left input').fill(left);
      await expect(second.locator('.result-overlay-right input')).toHaveValue('');
      await expect(second.locator('.error-message')).toContainText('whole number from 0 to 24');

      // Then the next round shall not be offered, and that court is flagged.
      await expectTheNextRoundNotOffered(page);
      await expect(second).toHaveClass(/score-missing/);
      await expect(page.locator('#nextRoundStatus')).toContainText('Court 2');
      await expect(page.locator('.matches-container .match').nth(0)).not.toHaveClass(/score-missing/);

      // And asking anyway generates nothing.
      await expectActivatingItGeneratesNothing(page);
      expect((await organizer.asksFor(TheStoredState)).schedule.rounds).toHaveLength(1);
      expect(errors).toEqual([]);
    });
  }

  for (const pool of [16, 32]) {
    test(`R-MEXICANO-ROUNDS, R-POINT-POOLS: With a pool of ${pool}, only scores summing to ${pool} offer the next round`, async ({ page }) => {
      const errors = collectErrors(page);
      const organizer = theOrganizer(page);

      // Given an 8-player Mexicano tournament played to a pool other than 24,
      await organizer.attemptsTo(ChooseMexicanoFor(8));
      await page.selectOption('#globalTotalPoints', String(pool));
      await organizer.attemptsTo(StartTheTournament('Pool Cup'));
      const matches = page.locator('.matches-container .match');

      // When the first court holds a score summing to the pool and the second one
      // summing to 24 instead (the input auto-completes to the pool, so both are
      // planted in the stored state before the page loads),
      const valid = { left: String(pool / 2 + 2), right: String(pool / 2 - 2) };
      const planted = await page.evaluate(({ key, first }) => {
        const state = JSON.parse(localStorage.getItem(key));
        state.schedule.rounds[0].matches[0].result = first;
        state.schedule.rounds[0].matches[1].result = { left: '12', right: '12' };
        return JSON.stringify(state);
      }, { key: STATE_KEY, first: valid });
      await page.addInitScript(({ key, json }) => {
        if (!sessionStorage.getItem('planted')) {
          sessionStorage.setItem('planted', '1');
          localStorage.setItem(key, json);
        }
      }, { key: STATE_KEY, json: planted });
      await page.reload();
      // Then the plant loaded: both scores are kept as stored (AB#69: restore
      // never blanks a result). The valid one is credited; 12/12 shows its
      // error and is credited to nobody. The next round shall not be offered,
      // and only the second court is flagged.
      await expect(matches.nth(0).locator('.result-overlay-left input')).toHaveValue(valid.left);
      await expect(matches.nth(0).locator('.result-overlay-right input')).toHaveValue(valid.right);
      await expect(matches.nth(0).locator('.error-message')).toHaveText('');
      await expect(matches.nth(1).locator('.result-overlay-left input')).toHaveValue('12');
      await expect(matches.nth(1).locator('.result-overlay-right input')).toHaveValue('12');
      await expect(matches.nth(1).locator('.error-message')).toContainText('Sum must equal ' + pool);
      const points = (await page.locator('.scoreboard-container tr td:nth-child(2)').allTextContents())
        .map(Number).sort((a, b) => b - a);
      expect(points).toEqual([pool / 2 + 2, pool / 2 + 2, pool / 2 - 2, pool / 2 - 2, 0, 0, 0, 0]);
      await expectTheNextRoundNotOffered(page);
      await expectActivatingItGeneratesNothing(page);
      await expect(page.locator('.matches-container .match.score-missing')).toHaveCount(1);
      await expect(matches.nth(1)).toHaveClass(/score-missing/);

      // When the second court's score sums to the pool too,
      await organizer.attemptsTo(EnterTheScore(1, pool / 2 - 2));
      // Then the next round is offered, and generating it works.
      await expect(page.locator('.matches-container .match.score-missing')).toHaveCount(0);
      await expectTheNextRoundOffered(page);
      await organizer.attemptsTo(GenerateTheNextRound);
      expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');
      expect(errors).toEqual([]);
    });
  }

  test('R-MEXICANO-ROUNDS: Start on a running Mexicano tournament, even re-enabled, changes nothing', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given a running Mexicano tournament with round 1 locked and round 2 in play,
    await organizer.attemptsTo(ChooseMexicanoFor(8), StartTheTournament('Running Cup'));
    await organizer.attemptsTo(CompleteTheRound([18, 7]), GenerateTheNextRound);
    await organizer.attemptsTo(EnterTheScore(0, 11));
    const before = await organizer.asksFor(TheStoredState);
    expect(before.schedule.rounds).toHaveLength(2);

    // When Start is re-enabled (as with devtools) and pressed,
    await page.evaluate(() => {
      const start = document.getElementById('startTournamentBtn');
      start.removeAttribute('disabled');
      start.click();
    });

    // Then nothing changes: same state, same seed, locked history intact.
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');
    expect(await organizer.asksFor(TheStoredState)).toEqual(before);
    await page.reload();
    expect(await organizer.asksFor(TheStoredState)).toEqual(before);
    await organizer.attemptsTo(GoToThePreviousRound);
    await expectTheScoresLocked(page);
    expect(await organizer.asksFor(TheScoresOnScreen)).toEqual([['18', '6'], ['7', '17']]);
    expect(errors).toEqual([]);
  });

  // Integer-like names are enumerated first by a plain object; the scoreboard must
  // keep tied players in player-list order regardless.
  for (const format of ['Americano', 'Mexicano']) {
    test(`R-SCOREBOARD, R-MEXICANO-ROUNDS: Integer-like names tied on points keep player-list order (${format})`, async ({ page }) => {
      const errors = collectErrors(page);
      const organizer = theOrganizer(page);

      // Given players named Bea, "10", Al and "0" first in the list, nobody having scored,
      if (format === 'Mexicano') await organizer.attemptsTo(ChooseMexicanoFor(8));
      const names = ['Bea', '10', 'Al', '0'];
      await organizer.attemptsTo(NameThePlayers(names));
      await organizer.attemptsTo(StartTheTournament('Tie Cup'));
      await expect(page.locator('.round-header .left')).toHaveText('Round 1');

      // Then the scoreboard lists them in player-list order (all tied).
      const stored = await organizer.asksFor(TheStoredState);
      for (const name of names) expect(stored.schedule.players).toContain(name);
      const ranking = await organizer.asksFor(TheRanking);
      expect(ranking).toEqual(stored.schedule.players);
      expect(errors).toEqual([]);
    });
  }

  // --- By keyboard and screen reader (AB#70) ---

  // Count the writes to the status line on screen (a live region: each write is
  // announced). One textContent write is one childList record.
  async function watchTheStatusLine(page) {
    await page.evaluate(() => {
      const status = document.getElementById('nextRoundStatus');
      const watch = { status, writes: 0 };
      watch.observer = new MutationObserver((records) => { watch.writes += records.length; });
      watch.observer.observe(status, { childList: true, characterData: true, subtree: true });
      window.statusLineWatch = watch;
    });
  }
  async function writesToTheStatusLine(page) {
    return page.evaluate(() => {
      const watch = window.statusLineWatch;
      watch.writes += watch.observer.takeRecords().length;
      // A count of a status line no longer on screen would prove nothing.
      if (document.getElementById('nextRoundStatus') !== watch.status) throw new Error('the watched status line was replaced');
      return watch.writes;
    });
  }

  test('R-MEXICANO-ROUNDS: Generating the next round by keyboard moves focus to the new round heading', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given a completed 8-player Mexicano round,
    await organizer.attemptsTo(ChooseMexicanoFor(8), StartTheTournament('Keyboard Cup'));
    await organizer.attemptsTo(CompleteTheRound([18, 7]));
    await expectTheNextRoundOffered(page);

    // When the Organizer generates the next round by keyboard (focus the control, Enter),
    await page.locator('#generateNextRoundBtn').focus();
    await page.keyboard.press('Enter');

    // Then round 2 is shown and focus is on its heading, not lost with the replaced button,
    const heading = page.getByRole('heading', { name: 'Round 2', level: 2, exact: true });
    await expect(heading).toBeFocused();
    expect(await page.evaluate(() => document.activeElement.matches('#tournamentContainer .round-header .left'))).toBe(true);
    // and the heading is focusable from script only: Tab does not stop on it.
    await expect(heading).toHaveAttribute('tabindex', '-1');
    // And the completed round's scores shall no longer be editable.
    await organizer.attemptsTo(GoToThePreviousRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
    await expectTheScoresLocked(page);
    expect(errors).toEqual([]);
  });

  test('The status line is written only when the set of courts it waits for changes', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);
    const status = page.locator('#nextRoundStatus');
    const matches = page.locator('.matches-container .match');

    // Given a 12-player round waiting for courts 2 and 3 (court 1 is scored),
    await organizer.attemptsTo(ChooseMexicanoFor(12), StartTheTournament('Status Cup'));
    await expect(page.locator('.court')).toHaveCount(3);
    await organizer.attemptsTo(EnterTheScore(0, 14));
    await expect(status).toHaveText(/Waiting for a valid score on: Court 2, Court 3\./);
    await watchTheStatusLine(page);

    // When scores are typed that leave the waited-for courts unchanged (court 1
    // re-scored keystroke by keystroke, valid throughout; court 2 given an
    // invalid score and cleared again),
    const courtOne = matches.nth(0).locator('.result-overlay-left input');
    await courtOne.fill('1');
    await courtOne.pressSequentially('5');
    await expect(matches.nth(0).locator('.result-overlay-right input')).toHaveValue('9');
    const courtTwo = matches.nth(1).locator('.result-overlay-left input');
    await courtTwo.fill('12.5');
    await expect(matches.nth(1).locator('.error-message')).toContainText('whole number from 0 to 24');
    await courtTwo.fill('');
    // Then nothing is written (nothing re-announced), and the line still says what is missing.
    expect(await writesToTheStatusLine(page)).toBe(0);
    await expect(status).toHaveText(/Waiting for a valid score on: Court 2, Court 3\./);

    // When a court is renamed while its score is missing,
    if (!(await page.locator('#settingsContainer').isVisible())) await page.click('#toggleSettingsBtn');
    await page.locator('#courtNameInput_2').pressSequentially('Centre');
    await expect(matches.nth(1).locator('.court-label')).toHaveText('Centre');
    // Then nothing is written either: the line names courts by number, so it is not stale.
    expect(await writesToTheStatusLine(page)).toBe(0);
    await expect(status).toHaveText(/Waiting for a valid score on: Court 2, Court 3\./);

    // When court 2 is completed, the line is written once, for the one court left;
    await organizer.attemptsTo(EnterTheScore(1, 12));
    expect(await writesToTheStatusLine(page)).toBe(1);
    await expect(status).toHaveText(/Waiting for a valid score on: Court 3\./);
    // and completing the last missing court writes it exactly once more.
    await organizer.attemptsTo(EnterTheScore(2, 24));
    expect(await writesToTheStatusLine(page)).toBe(2);
    await expect(status).toHaveText('All scores are in: the next round can be generated.');
    expect(errors).toEqual([]);
  });

  test('R-MEXICANO-ROUNDS: The unavailable control stays focusable and explained, and click, Enter or Space generate nothing', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given an 8-player Mexicano round with a match missing its score,
    await organizer.attemptsTo(ChooseMexicanoFor(8), StartTheTournament('Reach Cup'));
    await organizer.attemptsTo(EnterTheScore(0, 14));
    const generate = page.locator('#generateNextRoundBtn');
    await expectTheNextRoundNotOffered(page);

    // Then the control is reachable by keyboard (Tab from the round heading),
    await page.locator('.round-header .left').focus();
    await page.keyboard.press('Tab');
    await expect(generate).toBeFocused();
    // and its description says which score is missing.
    await expect(generate).toHaveAccessibleDescription(
      'Waiting for a valid score on: Court 2. The next round can be generated once every match has one.');

    // When the Organizer asks for the next round by Enter, by Space and by click,
    // Then the next round shall not be generated (and nothing is locked) each time,
    for (const activate of [ActivateTheGenerateControl.byEnter, ActivateTheGenerateControl.bySpace]) {
      await expectActivatingItGeneratesNothing(page, activate);
      await expect(generate).toBeFocused();
    }
    await expectActivatingItGeneratesNothing(page, ActivateTheGenerateControl.byClick);
    // and the missing score shall be indicated.
    await expect(page.locator('#nextRoundStatus')).toContainText('Court 2');
    await expect(page.locator('.matches-container .match').nth(1)).toHaveClass(/score-missing/);
    const stored = await organizer.asksFor(TheStoredState);
    expect(stored.schedule.rounds).toHaveLength(1);
    expect(stored.schedule.rounds[0].matches[0].result).toEqual({ left: '14', right: '10' });
    expect(errors).toEqual([]);
  });

  test('A next round that fails to generate keeps focus on the control', async ({ page }) => {
    const errors = collectErrors(page);
    const dialogs = [];
    page.on('dialog', (dialog) => { dialogs.push(dialog.message()); dialog.accept(); });
    const organizer = theOrganizer(page);

    // Given a completed 8-player Mexicano round whose pairing then fails,
    await organizer.attemptsTo(ChooseMexicanoFor(8), StartTheTournament('Failure Cup'));
    await organizer.attemptsTo(CompleteTheRound([18, 7]));
    await page.evaluate(() => {
      window.Mexicano.nextRound = () => { throw new Error('planted pairing failure'); };
    });

    // When the Organizer generates the next round by keyboard,
    const generate = page.locator('#generateNextRoundBtn');
    await generate.focus();
    await page.keyboard.press('Enter');

    // Then the failure is reported, round 1 stays as it was, and focus is still on the control.
    await expect.poll(() => dialogs).toEqual(['The next round could not be generated.']);
    await expect(generate).toBeFocused();
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
    expect((await organizer.asksFor(TheStoredState)).schedule.rounds).toHaveLength(1);
    await expectTheScoresEditable(page);
    expect(errors).toEqual([]);
  });

  test('R-MEXICANO-ROUNDS: Americano round navigation by keyboard moves no focus and writes no status line', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given an Americano tournament, its round container watched for status lines,
    await organizer.attemptsTo(StartTheTournament('Americano Keys'));
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await page.evaluate(() => {
      const watch = { rounds: 0, statusLines: 0 };
      const count = (node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.matches('.round')) watch.rounds += 1;
        watch.statusLines += node.querySelectorAll('[role="status"], .round-status').length +
          (node.matches('[role="status"], .round-status') ? 1 : 0);
      };
      watch.record = (records) => records.forEach((r) => r.addedNodes.forEach(count));
      watch.observer = new MutationObserver(watch.record);
      watch.observer.observe(document.getElementById('tournamentContainer'), { childList: true, subtree: true });
      window.americanoWatch = watch;
    });

    // When the Organizer navigates rounds by keyboard,
    await page.getByRole('button', { name: 'NEXT ROUND', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    // Then focus does not jump to the round heading,
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.getByRole('button', { name: 'PREVIOUS ROUND', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);

    // and scores shall remain editable as today, with no status line written.
    await expectTheScoresEditable(page);
    await organizer.attemptsTo(EnterTheScore(0, 16));
    const watched = await page.evaluate(() => {
      const watch = window.americanoWatch;
      watch.record(watch.observer.takeRecords());
      return { rounds: watch.rounds, statusLines: watch.statusLines };
    });
    // Both re-renders were seen (the watch is not vacuous), and neither added a status line.
    expect(watched).toEqual({ rounds: 2, statusLines: 0 });
    await expect(page.locator('#nextRoundStatus')).toHaveCount(0);
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
