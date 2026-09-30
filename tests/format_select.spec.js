// tests/format_select.spec.js
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
const ChooseTheFormat = (format) => async (actor) => {
  await actor.page.selectOption('#formatSelect', { label: format });
};
const ChooseThePlayerCount = (count) => async (actor) => {
  await actor.page.selectOption('#playerCountSelect', String(count));
};
const StartTheTournament = (tournamentName) => async (actor) => {
  await actor.page.fill('#tournamentName', tournamentName);
  await actor.page.click('#startTournamentBtn');
};
const ReloadThePage = async (actor) => {
  await actor.page.reload();
};

// --- Questions ---
// The active format, as the format control reads it (it stays in the settings,
// locked, while a tournament runs).
const ActiveFormat = async (actor) =>
  (await actor.page.locator('#formatSelect option:checked').textContent()).trim();
const OfferedSchedules = async (actor) =>
  actor.page.locator('#scheduleSelect option').allTextContents();

// Uncaught exceptions and console errors: none may occur on any format path.
function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
  return errors;
}

// The Americano setup exactly as it was before formats existed.
async function expectTheAmericanoSetup(page) {
  await expect(page.locator('#scheduleSelect')).toBeVisible();
  await expect(page.locator('#scheduleSelect')).toHaveValue('12p11r.js');
  await expect(page.locator('#globalTotalPoints')).toBeVisible();
  await expect(page.locator('#playerCountSelect')).toBeHidden();
  await expect(page.locator('[id^="playerInput_"]')).toHaveCount(12);
  await expect(page.locator('#playerInput_0')).toBeVisible();
  await expect(page.locator('[id^="courtNameInput_"]')).toHaveCount(3);
  await expect(page.locator('#courtNameInput_1')).toBeVisible();
  await expect(page.locator('#startTournamentBtn')).toBeEnabled();
  await expect(page.locator('#mexicanoComingSoon')).toBeHidden();
}

// The Mexicano scaffold: player count and point pool, no precomputed schedule,
// and Start disabled until Mexicano rounds can be generated.
async function expectTheMexicanoSetup(page, playerCount) {
  await expect(page.locator('#playerCountSelect')).toBeVisible();
  await expect(page.locator('#playerCountSelect')).toHaveValue(String(playerCount));
  await expect(page.locator('#globalTotalPoints')).toBeVisible();
  await expect(page.locator('#scheduleSelect')).toBeHidden();
  await expect(page.locator('label[for="scheduleSelect"]')).toBeHidden();
  await expect(page.locator('#startTournamentBtn')).toBeDisabled();
  await expect(page.locator('#mexicanoComingSoon')).toBeVisible();
  await expect(page.locator('#mexicanoComingSoon')).toContainText('coming soon');
}

test.describe('R-FORMAT-SELECT: Choose the tournament format', () => {
  test.beforeEach(async ({ page }) => {
    // Reset state between tests to avoid the suite's known bleed-through failure mode.
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('R-FORMAT-SELECT: Americano is the default and preserves today\'s behavior', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given the Organizer starts a fresh setup,
    // When the Organizer reviews the format choice,
    // Then Americano shall be selected.
    expect(await organizer.asksFor(ActiveFormat)).toBe('Americano');
    await expect(page.locator('#formatSelect option')).toHaveText(['Americano', 'Mexicano']);

    // And the preconfigured Americano schedules shall be offered.
    expect(await organizer.asksFor(OfferedSchedules)).toEqual([
      '8 Player, 7 Round Schedule',
      '12 Player, 11 Round Schedule',
      '16 Player, 15 Round Schedule',
      '20 Player, 19 Round Schedule',
      '24 Player, 23 Round Schedule',
    ]);
    await expectTheAmericanoSetup(page);

    // And an Americano tournament starts as it always has, with the format locked.
    await organizer.attemptsTo(StartTheTournament('Default Cup'));
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.court')).toHaveCount(3);
    await expect(page.locator('#formatSelect')).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test('R-FORMAT-SELECT: Choosing Mexicano switches the setup', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given a fresh setup,
    // When the Organizer chooses Mexicano,
    await organizer.attemptsTo(ChooseTheFormat('Mexicano'));

    // Then the setup shall offer player count and point pool without a
    // precomputed schedule choice,
    await expectTheMexicanoSetup(page, 12);
    const counts = await page.locator('#playerCountSelect option').allTextContents();
    expect(counts).toEqual(Array.from({ length: 17 }, (_, i) => String(i + 8)));
    await expect(page.locator('#globalTotalPoints option')).toHaveText(['24', '32']);

    // And the active format shall read Mexicano.
    expect(await organizer.asksFor(ActiveFormat)).toBe('Mexicano');

    // And nothing can be started yet: no round is shown.
    await page.locator('#startTournamentBtn').click({ force: true });
    await expect(page.locator('.round')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('R-FORMAT-SELECT: Switching back to Americano restores the Americano setup unchanged', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given the Organizer chose Mexicano with a player count.
    await organizer.attemptsTo(ChooseTheFormat('Mexicano'), ChooseThePlayerCount(20));

    // When the Organizer chooses Americano again.
    await organizer.attemptsTo(ChooseTheFormat('Americano'));

    // Then the Americano setup is back exactly as before, and it starts.
    expect(await organizer.asksFor(ActiveFormat)).toBe('Americano');
    await expectTheAmericanoSetup(page);
    await organizer.attemptsTo(StartTheTournament('Back Cup'));
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    expect(errors).toEqual([]);
  });

  test('R-FORMAT-SELECT: The format survives a reload (Americano, started)', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given a tournament started as Americano,
    await organizer.attemptsTo(StartTheTournament('Reload Americano'));
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');

    // When the page reloads,
    await organizer.attemptsTo(ReloadThePage);

    // Then the active format shall still read Americano, and the tournament runs on.
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    expect(await organizer.asksFor(ActiveFormat)).toBe('Americano');
    await expect(page.locator('#formatSelect')).toBeDisabled();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tournamentState')));
    expect(stored.format).toBe('americano');
    expect(errors).toEqual([]);
  });

  // Mexicano cannot be started yet (round generation is a later story), so the
  // Mexicano example applies to the format selected in the setup.
  test('R-FORMAT-SELECT: The format survives a reload (Mexicano, selected in setup)', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given a setup with Mexicano chosen for 10 players,
    await organizer.attemptsTo(ChooseTheFormat('Mexicano'), ChooseThePlayerCount(10));

    // When the page reloads,
    await organizer.attemptsTo(ReloadThePage);

    // Then the active format shall still read Mexicano, with its setup intact.
    expect(await organizer.asksFor(ActiveFormat)).toBe('Mexicano');
    await expectTheMexicanoSetup(page, 10);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tournamentState')));
    expect(stored.format).toBe('mexicano');
    expect(stored.mexicanoPlayerCount).toBe(10);
    expect(errors).toEqual([]);
  });

  for (const site of ['default', 'libro', 'was']) {
    test(`R-FORMAT-SELECT: The format choice renders on the ${site} site`, async ({ page }) => {
      const errors = collectErrors(page);
      const organizer = theOrganizer(page);

      // Given the app is opened for a site variant.
      await page.goto(`/?site=${site}`);

      // Then the format choice is offered, Americano first.
      await expect(page.locator('#formatSelect')).toBeVisible();
      expect(await organizer.asksFor(ActiveFormat)).toBe('Americano');
      await expectTheAmericanoSetup(page);

      // And Mexicano switches the setup there too.
      await organizer.attemptsTo(ChooseTheFormat('Mexicano'));
      await expectTheMexicanoSetup(page, 12);
      // A missing site asset (the was site ships no courts.css) is a network
      // 404, not a script error; only script errors count here.
      expect(errors.filter((e) => !e.includes('Failed to load resource'))).toEqual([]);
    });
  }
});
