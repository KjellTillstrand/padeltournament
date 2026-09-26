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

const RevealTournamentSettings = async (actor) => {
  await actor.page.click('#toggleSettingsBtn');
};

const SaveTheTournament = async (actor) => {
  await actor.page.click('#saveTournamentBtn');
};

// Drop the live (auto-saved) tournament state but keep the saved tournaments,
// then reopen the app. The app re-saves tournamentState from memory on
// beforeunload, so the key is removed from a same-origin page that is not the
// app (after the app has already unloaded), not from the app page itself.
const DiscardTheLiveTournamentState = async (actor) => {
  await actor.page.goto('/favicon.ico');
  await actor.page.evaluate(() => localStorage.removeItem('tournamentState'));
  await actor.page.goto('/');
};

const LoadTheSavedTournament = (tournamentName) => async (actor) => {
  const option = actor.page.locator('#savedTournamentSelect option', { hasText: tournamentName });
  const value = await option.getAttribute('value');
  await actor.page.selectOption('#savedTournamentSelect', value);
  await actor.page.click('#loadTournamentBtn');
};

// --- Questions ---
const CourtLabel = (courtNumber) => async (actor) =>
  (await actor.page.locator(`.court-${courtNumber} .court-label`).textContent()).trim();

const CourtNameInputPlaceholder = (courtNumber) => async (actor) =>
  actor.page.locator(`#courtNameInput_${courtNumber}`).getAttribute('placeholder');

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

  // @verifies REQ-7
  test('R-COURT-NAMES: A saved tournament round-trips its custom court name', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given the Organizer has named a court and started the tournament.
    await organizer.attemptsTo(NameACourt(1, 'Center Court'));
    await organizer.attemptsTo(StartTheTournament('Round Trip Tournament'));
    expect(await organizer.asksFor(CourtLabel(1))).toBe('Center Court');

    // When the Organizer saves it, the live state is lost, and the Organizer loads it back.
    await organizer.attemptsTo(SaveTheTournament);
    await organizer.attemptsTo(DiscardTheLiveTournamentState);
    // (The custom name is really gone: only the saved tournament can restore it.)
    expect(await page.evaluate(() => localStorage.getItem('tournamentState'))).toBeNull();
    await expect(page.locator('#courtNameInput_1')).toHaveValue('');
    await expect(page.locator('.round')).toHaveCount(0);
    await organizer.attemptsTo(LoadTheSavedTournament('Round Trip Tournament'));

    // Then the court shall still be named "Center Court".
    expect(await organizer.asksFor(CourtLabel(1))).toBe('Center Court');
  });

  // @verifies REQ-7
  test('R-COURT-NAMES: Renaming a court mid-tournament updates its label live', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given the tournament has started with the default court names.
    await organizer.attemptsTo(StartTheTournament('Live Rename Test'));
    expect(await organizer.asksFor(CourtLabel(2))).toBe('Court 2');

    // When the Organizer renames a court from the (reopened) settings panel.
    await organizer.attemptsTo(RevealTournamentSettings);
    await organizer.attemptsTo(NameACourt(2, 'Live Court'));

    // Then the on-screen label updates immediately, without a reload.
    expect(await organizer.asksFor(CourtLabel(2))).toBe('Live Court');
  });

  // @verifies REQ-7
  test('R-COURT-NAMES: A court name containing markup renders as literal text', async ({ page }) => {
    const organizer = theOrganizer(page);
    // Kept within the 30-character court name field limit.
    const payload = '<img src=x onerror=top.p=1>';

    // Given the Organizer names a court with an XSS payload.
    await organizer.attemptsTo(NameACourt(1, payload));
    await organizer.attemptsTo(StartTheTournament('XSS Regression'));

    // Then the label shall render the payload as literal text, not markup.
    expect(await organizer.asksFor(CourtLabel(1))).toBe(payload);
    await expect(page.locator('.court-1 img')).toHaveCount(0);
    expect(await page.evaluate(() => window.p)).toBeUndefined();
  });

  // @verifies REQ-7
  test('R-COURT-NAMES: The Libro site shows its branded default court names', async ({ page }) => {
    // Given the app is loaded for the Libro site with no custom court names set.
    await page.goto('/?site=libro');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    const organizer = theOrganizer(page);

    // Then the court name inputs shall be placeholder-hinted with Libro's names.
    await expect(page.locator('#courtNamesContainer input')).toHaveCount(3);
    expect(await organizer.asksFor(CourtNameInputPlaceholder(1))).toBe('1. Centro kakel');
    expect(await organizer.asksFor(CourtNameInputPlaceholder(2))).toBe('2. Recover');
    expect(await organizer.asksFor(CourtNameInputPlaceholder(3))).toBe('3. Evolvit');

    // And the courts shall be labeled with Libro's branded names in the matches.
    await organizer.attemptsTo(StartTheTournament('Libro Defaults'));
    expect(await organizer.asksFor(CourtLabel(1))).toBe('1. Centro kakel');
    expect(await organizer.asksFor(CourtLabel(2))).toBe('2. Recover');
    expect(await organizer.asksFor(CourtLabel(3))).toBe('3. Evolvit');
  });

  // The ?site= value builds the sites/<site>/courts.js script path, so anything
  // that is not a known site folder must fall back to the default site.
  for (const [description, query] of [
    ['a path-traversal', '..%2F..%2Fevil'],
    ['a markup', '%3Cscript%3E'],
    // Well-formed folder name that is not a shipped site: exercises the allowlist.
    ['an unknown', 'evil'],
  ]) {
    // @verifies REQ-7
    test(`R-COURT-NAMES: ${description} site parameter falls back to the default court names`, async ({ page }) => {
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      const siteRequests = [];
      page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (pathname.includes('/sites/')) siteRequests.push(pathname);
      });

      // Given the app is opened with an invalid site parameter.
      await page.goto(`/?site=${query}`);
      const organizer = theOrganizer(page);

      // When the rounds are rendered.
      await organizer.attemptsTo(StartTheTournament('Site Guard Test'));

      // Then the courts shall carry the default names, without any script error.
      await expect(page.locator('.court-label')).toHaveCount(3);
      expect(await organizer.asksFor(CourtLabel(1))).toBe('Court 1');
      expect(await organizer.asksFor(CourtLabel(2))).toBe('Court 2');
      expect(await organizer.asksFor(CourtLabel(3))).toBe('Court 3');
      expect(pageErrors).toEqual([]);
      // And only the default site's assets shall have been requested.
      expect(siteRequests).toContain('/sites/default/courts.js');
      expect(siteRequests.every((path) => path.startsWith('/sites/default/'))).toBe(true);
    });
  }
});
