// tests/court_names.spec.js
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

const NameACourt = (courtNumber, name) => async (actor) => {
  await actor.page.fill(`#courtNameInput_${courtNumber}`, name);
};

const ReopenTheApp = async (actor) => {
  await actor.page.reload();
};

// --- Questions ---
const CourtLabel = (courtNumber) => async (actor) =>
  (await actor.page.locator(`.court-${courtNumber} .court-label`).textContent()).trim();

test.describe('R-COURT-NAMES: Custom court names', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  // @verifies REQ-7
  test('R-COURT-NAMES: Courts carry default names', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given a schedule is loaded and no custom court names are set.
    await organizer.attemptsTo(StartTheTournament('Court Naming Test'));

    // Then the courts shall be named "Court 1", "Court 2", and so on.
    await expect(page.locator('.court-label')).toHaveCount(3);
    expect(await organizer.asksFor(CourtLabel(1))).toBe('Court 1');
    expect(await organizer.asksFor(CourtLabel(2))).toBe('Court 2');
    expect(await organizer.asksFor(CourtLabel(3))).toBe('Court 3');
  });

  // @verifies REQ-7
  test('R-COURT-NAMES: A custom court name is used in the matches', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given the Organizer has named a court "Center Court".
    await expect(page.locator('#courtNamesContainer input')).toHaveCount(3);
    await organizer.attemptsTo(NameACourt(1, 'Center Court'));

    // When the rounds are rendered.
    await organizer.attemptsTo(StartTheTournament('Court Naming Custom'));

    // Then that court's matches shall show "Center Court".
    expect(await organizer.asksFor(CourtLabel(1))).toBe('Center Court');
    // And the courts left unnamed keep their default names.
    expect(await organizer.asksFor(CourtLabel(2))).toBe('Court 2');
    expect(await organizer.asksFor(CourtLabel(3))).toBe('Court 3');
  });

  // @verifies REQ-7
  test('R-COURT-NAMES: Court names persist', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given the Organizer has named a court "Center Court".
    await organizer.attemptsTo(NameACourt(1, 'Center Court'));
    await organizer.attemptsTo(StartTheTournament('Court Naming Persist'));
    expect(await organizer.asksFor(CourtLabel(1))).toBe('Center Court');

    // When the returning Organizer reopens the app.
    await organizer.attemptsTo(ReopenTheApp);

    // Then the court shall still be named "Center Court".
    await expect(page.locator('.round')).toBeVisible();
    expect(await organizer.asksFor(CourtLabel(1))).toBe('Center Court');
    await expect(page.locator('#courtNameInput_1')).toHaveValue('Center Court');
  });
});
