// general-functionality.spec.js
const { test, expect } = require('@playwright/test');

test.describe('General Functionality of Tournament Manager', () => {

  test('R-STATE-PERSIST, R-SCHEDULE-SELECT: Default schedule is loaded when no state is saved', async ({ page }) => {
    // Given no tournament state is saved in localStorage.
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());

    // When the user loads the page.
    await page.reload();

    // Then the default schedule is loaded.
    const playerInputs = page.locator('[id^="playerInput_"]');
    await expect(playerInputs).toHaveCount(12);

    // And the settings container and player input fields are visible.
    await expect(page.locator('#settingsContainer')).toBeVisible();
    await expect(page.locator('#playerInputsContainer')).toBeVisible();
    await expect(page.locator('#tournamentTitle')).toHaveText('Tournament Title');
  });

  test('R-STATE-PERSIST: Tournament state persists across page reloads', async ({ page }) => {
    // Given a tournament has been started with a specific tournament name.
    await page.goto('/');
    await page.fill('#tournamentName', 'Test Tournament');
    await page.click('#startTournamentBtn');

    // And some scores have been entered for round 1.
    // For example, fill a score in the first match's left input.
    const leftInput = page.locator('.result-overlay-left input').first();
    await leftInput.fill('10');
    // Allow auto-calculation and saving.
    await page.waitForTimeout(500);

    // When the page is reloaded.
    await page.reload();

    // Then the tournament state is restored.
    await expect(page.locator('#tournamentTitle')).toHaveText('Test Tournament');
    // And the tournament is still in progress with round 1 displayed.
    await expect(page.locator('.round')).toBeVisible();
    // And the score entered is restored.
    const restoredScore = await page.locator('.result-overlay-left input').first().inputValue();
    expect(restoredScore).toBe('10');
  });

  test('R-STATE-PERSIST: Auto-save state before unload', async ({ page, context }) => {
    // Given a tournament is in progress.
    await page.goto('/');
    await page.fill('#tournamentName', 'AutoSave Test');
    await page.click('#startTournamentBtn');

    // When the user navigates away from the page (simulate by closing the page).
    await page.close();

    // Then create a new page and verify the state is saved.
    const newPage = await context.newPage();
    await newPage.goto('/');
    const savedState = await newPage.evaluate(() => localStorage.getItem('tournamentState'));
    expect(savedState).not.toBeNull();
    const state = JSON.parse(savedState);
    expect(state.tournamentName).toBe('AutoSave Test');
  });
});

// The app is served from a shared GitHub Pages origin, so any sibling project
// can write this origin's localStorage. Whatever is planted there must never
// leave the app blank or broken: it either restores sanely or starts a fresh
// setup, on every path that reads persisted state.
test.describe('Malformed or hostile persisted state', () => {
  // An object whose conversion to a string throws: JSON cannot carry
  // functions, but it can shadow toString/valueOf with non-callable values.
  const UNPRINTABLE = { toString: 'x', valueOf: 'y' };

  // A genuine started-tournament state, taken from the app itself so the seed
  // tracks the real state shape. Read from a throwaway page so the page under
  // test has never run the app before its planted state is in place.
  async function captureARealTournamentState(context) {
    const donor = await context.newPage();
    await donor.goto('/');
    await donor.fill('#tournamentName', 'Base Cup');
    await donor.click('#startTournamentBtn');
    const state = JSON.parse(await donor.evaluate(() => localStorage.getItem('tournamentState')));
    await donor.close();
    return state;
  }

  // Plant raw localStorage values (null removes the key) before any app script
  // runs on the next navigation.
  async function plantStorage(page, entries) {
    await page.addInitScript((seed) => {
      for (const [key, value] of Object.entries(seed)) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    }, entries);
  }

  function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    return errors;
  }

  async function expectAFreshSetup(page) {
    await expect(page.locator('#settingsContainer')).toBeVisible();
    await expect(page.locator('[id^="playerInput_"]')).toHaveCount(12);
    await expect(page.locator('[id^="courtNameInput_"]')).toHaveCount(3);
    await expect(page.locator('#startTournamentBtn')).toBeEnabled();
    await expect(page.locator('#tournamentTitle')).toHaveText('Tournament Title');
    await expect(page.locator('.round')).toHaveCount(0);
  }

  async function expectATournamentCanStart(page, name) {
    await page.fill('#tournamentName', name);
    await page.click('#startTournamentBtn');
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.court')).toHaveCount(3);
    await expect(page.locator('.scoreboard-container table tr')).toHaveCount(13);
  }

  // --- tournamentState that cannot be restored: fresh setup ---
  const UNREADABLE_STATES = [
    ['invalid JSON', '{"schedule": '],
    ['a JSON string', '"hello"'],
    ['JSON null', 'null'],
    ['a JSON array', '[1, 2]'],
    ['a schedule of the wrong type', JSON.stringify({ schedule: 'P1', tournamentStarted: true, currentRoundIndex: 0 })],
  ];
  for (const [description, raw] of UNREADABLE_STATES) {
    test(`A tournament state holding ${description} falls back to a fresh setup`, async ({ page }) => {
      const pageErrors = collectPageErrors(page);
      // Given the stored tournament state is unreadable.
      await plantStorage(page, { tournamentState: raw });

      // When the app loads.
      await page.goto('/');

      // Then it shows a fresh setup that works.
      await expectAFreshSetup(page);
      await expectATournamentCanStart(page, 'Recovered Cup');
      expect(pageErrors).toEqual([]);
    });
  }

  const renamePlayer = (schedule, from, to) => {
    schedule.players = schedule.players.map((p) => (p === from ? to : p));
    schedule.rounds.forEach((round) => round.matches.forEach((match) => {
      match.teams = match.teams.map((team) => team.map((p) => (p === from ? to : p)));
    }));
  };

  const HOSTILE_SCHEDULES = [
    // classList.add("court-1 2") throws on the whitespace.
    ['a court number containing whitespace', (s) => { s.rounds[0].matches[0].court = '1 2'; }],
    ['an out-of-bounds court number', (s) => { s.rounds[0].matches[0].court = 99; }],
    ['an oversized player name', (s) => { renamePlayer(s, s.players[0], 'X'.repeat(5000)); }],
    ['a player name with control characters', (s) => { renamePlayer(s, s.players[0], 'Ada\u0000\u001b[2J'); }],
    ['a team naming an unknown player', (s) => { s.rounds[0].matches[0].teams[0][0] = 'Nobody'; }],
    ['a player count that is not a multiple of four', (s) => { s.players.push('Extra'); }],
    ['a score that is not a string', (s) => { s.rounds[0].matches[0].result = { left: 10, right: 14 }; }],
    ['matches that are not a list', (s) => { s.rounds[0].matches = 'x'; }],
    ['no rounds', (s) => { s.rounds = []; }],
    ['a round number that cannot be printed', (s) => { s.rounds[0].roundNumber = UNPRINTABLE; }],
  ];
  for (const [description, corrupt] of HOSTILE_SCHEDULES) {
    test(`A tournament state with ${description} falls back to a fresh setup`, async ({ page, context }) => {
      const pageErrors = collectPageErrors(page);
      // Given a running tournament whose stored schedule has been tampered with.
      const state = await captureARealTournamentState(context);
      corrupt(state.schedule);
      await plantStorage(page, { tournamentState: JSON.stringify(state) });

      // When the app loads.
      await page.goto('/');

      // Then it shows a fresh setup that works.
      await expectAFreshSetup(page);
      await expectATournamentCanStart(page, 'Recovered Cup');
      expect(pageErrors).toEqual([]);
    });
  }

  // --- tournamentState with a sound schedule but bad side fields: sane restore ---
  const REPAIRABLE_FIELDS = [
    ['an out-of-range round index', (st) => { st.currentRoundIndex = 9999; }],
    ['a round index that is not an integer', (st) => { st.currentRoundIndex = '2'; }],
    ['a tournament name that cannot be printed', (st) => { st.tournamentName = UNPRINTABLE; }],
    ['hostile court names', (st) => { st.courtNames = [UNPRINTABLE, 'Y'.repeat(5000), 'Centre\u0000Court']; }],
  ];
  for (const [description, corrupt] of REPAIRABLE_FIELDS) {
    test(`A tournament state with ${description} restores the tournament sanely`, async ({ page, context }) => {
      const pageErrors = collectPageErrors(page);
      // Given a running tournament whose stored side fields have been tampered with.
      const state = await captureARealTournamentState(context);
      corrupt(state);
      await plantStorage(page, { tournamentState: JSON.stringify(state) });

      // When the app loads.
      await page.goto('/');

      // Then the tournament is restored with the bad fields replaced by defaults.
      await expect(page.locator('.round-header .left')).toHaveText('Round 1');
      await expect(page.locator('.court-label')).toHaveText(['Court 1', 'Court 2', 'Court 3']);
      await expect(page.locator('.scoreboard-container table tr')).toHaveCount(13);
      const title = await page.locator('#tournamentTitle').textContent();
      expect(['Base Cup', 'Tournament Title']).toContain(title);
      expect(pageErrors).toEqual([]);
    });
  }

  // --- savedTournaments ---
  for (const [description, raw] of [['invalid JSON', '[{"tournamentName": '], ['a non-list', '{"0": {}}']]) {
    test(`Saved tournaments holding ${description} leave an empty, working saved-tournament list`, async ({ page }) => {
      const pageErrors = collectPageErrors(page);
      page.on('dialog', (dialog) => dialog.accept());
      // Given the stored saved-tournament list is unreadable.
      await plantStorage(page, { tournamentState: null, savedTournaments: raw });

      // When the app loads.
      await page.goto('/');

      // Then the setup is fresh and the saved-tournament list is empty.
      await expectAFreshSetup(page);
      await expect(page.locator('#savedTournamentSelect option')).toHaveCount(0);
      // And a tournament can still be started (unique-name check) and saved.
      await expectATournamentCanStart(page, 'Recovered Cup');
      await page.click('#saveTournamentBtn');
      await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
      await expect(page.locator('#savedTournamentSelect option')).toContainText('Recovered Cup');
      expect(pageErrors).toEqual([]);
    });
  }

  test('Hostile saved tournaments are skipped while a sound one still lists, names and loads', async ({ page, context }) => {
    const pageErrors = collectPageErrors(page);
    // Given the saved-tournament list mixes one sound save with hostile entries.
    const { schedule } = await captureARealTournamentState(context);
    const withBadCourt = JSON.parse(JSON.stringify(schedule));
    withBadCourt.rounds[0].matches[0].court = '1 2';
    const saved = [
      null,
      42,
      'Spring Cup',
      { tournamentName: UNPRINTABLE, schedule, currentRoundIndex: 0, savedAt: '2026-01-01T00:00:00.000Z' },
      { tournamentName: 'Bad Court Cup', schedule: withBadCourt, currentRoundIndex: 0, savedAt: '2026-01-01T00:00:00.000Z' },
      { tournamentName: 'Z'.repeat(5000), schedule, currentRoundIndex: 0, savedAt: '2026-01-01T00:00:00.000Z' },
      { tournamentName: 'No Schedule Cup', currentRoundIndex: 0, savedAt: '2026-01-01T00:00:00.000Z' },
      // Sound, apart from a timestamp that cannot be printed.
      { tournamentName: 'Spring Cup', schedule, currentRoundIndex: 1, courtNames: ['Centre'], savedAt: UNPRINTABLE },
    ];
    await plantStorage(page, { tournamentState: null, savedTournaments: JSON.stringify(saved) });

    // When the app loads.
    await page.goto('/');

    // Then only the sound save is listed.
    await expectAFreshSetup(page);
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
    await expect(page.locator('#savedTournamentSelect option')).toContainText('Spring Cup');

    // And starting a tournament with the same name still gets a unique name.
    await page.fill('#tournamentName', 'Spring Cup');
    await page.click('#startTournamentBtn');
    await expect(page.locator('#tournamentName')).toHaveValue('Spring Cup-1');

    // And the sound save loads at its saved round.
    await page.click('#toggleSettingsBtn');
    await page.click('#loadTournamentBtn');
    await expect(page.locator('#tournamentTitle')).toHaveText('Spring Cup');
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    await expect(page.locator('.court-label').first()).toHaveText('Centre');
    expect(pageErrors).toEqual([]);
  });
});
