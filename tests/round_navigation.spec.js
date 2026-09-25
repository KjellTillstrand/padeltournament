// tests/round_navigation.spec.js
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
const StartTheTournament = (tournamentName) => async (actor) => {
  await actor.page.fill('#tournamentName', tournamentName);
  await actor.page.click('#startTournamentBtn');
};

const GoToTheNextRound = async (actor) => {
  await actor.page.getByRole('button', { name: 'NEXT ROUND' }).click();
};

const GoToThePreviousRound = async (actor) => {
  // The app only renders a "previous" affordance when a previous round exists;
  // attempting to go back from round 1 is a no-op because there is nothing to click.
  const previousButton = actor.page.getByRole('button', { name: 'PREVIOUS ROUND' });
  if (await previousButton.count() > 0) {
    await previousButton.click();
  }
};

// --- Questions ---
const DisplayedRoundTitle = async (actor) =>
  (await actor.page.locator('.round-header .left').textContent()).trim();

test.describe('R-ROUND-NAV: Round navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  // @verifies REQ-9
  test('R-ROUND-NAV: The Organizer advances a round', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given a tournament in progress at round 1.
    await organizer.attemptsTo(StartTheTournament('Nav Test Forward'));
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');

    // When the Organizer goes to the next round.
    await organizer.attemptsTo(GoToTheNextRound);

    // Then round 2 and its matches shall be displayed, and the title identifies round 2.
    await expect(page.locator('.round[data-round="2"]')).toBeVisible();
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');
  });

  // @verifies REQ-9
  test('R-ROUND-NAV: The Organizer steps back a round', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given a tournament in progress at round 2.
    await organizer.attemptsTo(StartTheTournament('Nav Test Backward'));
    await organizer.attemptsTo(GoToTheNextRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');

    // When the Organizer goes to the previous round.
    await organizer.attemptsTo(GoToThePreviousRound);

    // Then round 1 and its matches shall be displayed.
    await expect(page.locator('.round[data-round="1"]')).toBeVisible();
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
  });

  // @verifies REQ-9
  test('R-ROUND-NAV: There is no round before the first', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given a tournament in progress at round 1.
    await organizer.attemptsTo(StartTheTournament('Nav Test Floor'));
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
    await expect(page.getByRole('button', { name: 'PREVIOUS ROUND' })).toHaveCount(0);

    // When the Organizer goes to the previous round.
    await organizer.attemptsTo(GoToThePreviousRound);

    // Then round 1 shall remain displayed.
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
  });
});
