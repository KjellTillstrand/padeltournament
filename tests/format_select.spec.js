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
}

// The Mexicano setup: player count and point pool, no precomputed schedule,
// one name input per player and one court per four players, and Start enabled.
async function expectTheMexicanoSetup(page, playerCount) {
  await expect(page.locator('#playerCountSelect')).toBeVisible();
  await expect(page.locator('#playerCountSelect')).toHaveValue(String(playerCount));
  await expect(page.locator('#globalTotalPoints')).toBeVisible();
  await expect(page.locator('#scheduleSelect')).toBeHidden();
  await expect(page.locator('label[for="scheduleSelect"]')).toBeHidden();
  await expect(page.locator('[id^="playerInput_"]')).toHaveCount(playerCount);
  await expect(page.locator('#playerInput_0')).toBeVisible();
  await expect(page.locator('#playerInput_0')).toHaveValue('P1');
  await expect(page.locator('[id^="courtNameInput_"]')).toHaveCount(Math.floor(playerCount / 4));
  await expect(page.locator('#startTournamentBtn')).toBeEnabled();
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
      '9 Player, 9 Round Schedule',
      '10 Player, 10 Round Schedule',
      '11 Player, 11 Round Schedule',
      '12 Player, 11 Round Schedule',
      '13 Player, 13 Round Schedule',
      '14 Player, 14 Round Schedule',
      '15 Player, 15 Round Schedule',
      '16 Player, 15 Round Schedule',
      '17 Player, 17 Round Schedule',
      '18 Player, 18 Round Schedule',
      '19 Player, 19 Round Schedule',
      '20 Player, 19 Round Schedule',
      '21 Player, 21 Round Schedule',
      '22 Player, 22 Round Schedule',
      '23 Player, 23 Round Schedule',
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
    await expect(page.locator('#globalTotalPoints option')).toHaveText(['16', '21', '24', '32']);

    // And the active format shall read Mexicano.
    expect(await organizer.asksFor(ActiveFormat)).toBe('Mexicano');

    // And the choice is stored at once, not only when the page unloads.
    let stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tournamentState')));
    expect(stored.format).toBe('mexicano');
    expect(stored.mexicanoPlayerCount).toBe(12);
    await organizer.attemptsTo(ChooseThePlayerCount(9));
    stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tournamentState')));
    expect(stored.mexicanoPlayerCount).toBe(9);
    expect(errors).toEqual([]);
  });

  test('R-FORMAT-SELECT: A Mexicano tournament starts with the chosen player count', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given a Mexicano setup for 9 players with a tournament name,
    await organizer.attemptsTo(ChooseTheFormat('Mexicano'), ChooseThePlayerCount(9));
    await expectTheMexicanoSetup(page, 9);

    // When the Organizer starts it,
    await organizer.attemptsTo(StartTheTournament('Nine Cup'));

    // Then round 1 is played on two courts, with one player resting,
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.court')).toHaveCount(2);
    await expect(page.locator('.resting-players .resting-player')).toHaveCount(1);
    await expect(page.locator('.scoreboard-container table tr')).toHaveCount(10);
    // and the format is locked, and stored as a started Mexicano tournament.
    expect(await organizer.asksFor(ActiveFormat)).toBe('Mexicano');
    await expect(page.locator('#formatSelect')).toBeDisabled();
    await expect(page.locator('#playerCountSelect')).toBeDisabled();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tournamentState')));
    expect(stored.tournamentStarted).toBe(true);
    expect(stored.format).toBe('mexicano');
    expect(stored.schedule.players).toHaveLength(9);
    expect(stored.schedule.rounds).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('R-FORMAT-SELECT: Resetting the setup stores the kept format at once', async ({ page }) => {
    const errors = collectErrors(page);
    page.on('dialog', (dialog) => dialog.accept());
    const organizer = theOrganizer(page);

    // Given a Mexicano setup with a tournament name,
    await organizer.attemptsTo(ChooseTheFormat('Mexicano'), ChooseThePlayerCount(14));
    await page.fill('#tournamentName', 'Reset Cup');

    // When the Organizer deletes it (which resets the setup),
    await page.click('#deleteTournamentBtn');

    // Then the reset setup, still Mexicano, is stored at once.
    await expect(page.locator('#formatSelect')).toHaveValue('mexicano');
    await expectTheMexicanoSetup(page, 14);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tournamentState')));
    expect(stored).not.toBeNull();
    expect(stored.tournamentStarted).toBe(false);
    expect(stored.format).toBe('mexicano');
    expect(stored.mexicanoPlayerCount).toBe(14);
    expect(errors).toEqual([]);
  });

  test('R-FORMAT-SELECT: New Tournament stores the fresh Americano setup at once', async ({ page }) => {
    const errors = collectErrors(page);
    const dialogs = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      // Decline "save first?"; accept the notice.
      if (dialog.type() === 'confirm') dialog.dismiss(); else dialog.accept();
    });
    const organizer = theOrganizer(page);

    // Given a running Americano tournament,
    await organizer.attemptsTo(StartTheTournament('Old Cup'));
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');

    // When the Organizer starts a new one without saving,
    await page.click('#newTournamentBtn');
    await expect.poll(() => dialogs.length).toBe(2);

    // Then the fresh, nameless Americano setup is stored at once.
    await expect(page.locator('#startTournamentBtn')).toBeEnabled();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tournamentState')));
    expect(stored).not.toBeNull();
    expect(stored.tournamentStarted).toBe(false);
    expect(stored.tournamentName).toBe('');
    expect(stored.format).toBe('americano');
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

  // A started Mexicano tournament surviving a reload is covered in
  // tests/mexicano_rounds.spec.js; this is the format selected in the setup.
  test('R-FORMAT-SELECT: The format survives a reload (Mexicano, selected in setup)', async ({ page }) => {
    const errors = collectErrors(page);
    const organizer = theOrganizer(page);

    // Given a setup with Mexicano chosen for 10 players (stored at once),
    await organizer.attemptsTo(ChooseTheFormat('Mexicano'), ChooseThePlayerCount(10));
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('tournamentState')));
    expect(before.format).toBe('mexicano');
    expect(before.mexicanoPlayerCount).toBe(10);

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

  // Site assets a variant is known not to ship; their 404 is expected and
  // nothing else may fail to load.
  const MISSING_SITE_ASSETS = {
    default: [],
    libro: [],
    was: ['/sites/was/courts.css', '/sites/was/logo.png'],
  };
  const isExpectedMissing = (site, url) => {
    let path;
    try { path = new URL(url).pathname; } catch { return false; }
    return MISSING_SITE_ASSETS[site].includes(path);
  };

  for (const site of ['default', 'libro', 'was']) {
    test(`R-FORMAT-SELECT: The format choice renders on the ${site} site`, async ({ page }) => {
      // Script errors, and failed loads of anything but this site's known-missing assets.
      const errors = [];
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const url = message.location().url;
        if (message.text().includes('Failed to load resource') && isExpectedMissing(site, url)) return;
        errors.push(`console.error: ${message.text()} (${url})`);
      });
      page.on('response', (response) => {
        if (response.status() >= 400 && !isExpectedMissing(site, response.url())) {
          errors.push(`HTTP ${response.status()}: ${response.url()}`);
        }
      });
      page.on('requestfailed', (request) => {
        if (!isExpectedMissing(site, request.url())) errors.push(`request failed: ${request.url()}`);
      });
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
      expect(errors).toEqual([]);
    });
  }
});
