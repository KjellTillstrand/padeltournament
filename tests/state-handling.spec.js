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
// setup, on every path that reads persisted state. And the validation must
// never be stricter than the app's own writers: the app's data always survives.
test.describe('Malformed or hostile persisted state', () => {
  // An object whose conversion to a string throws: JSON cannot carry
  // functions, but it can shadow toString/valueOf with non-callable values.
  const UNPRINTABLE = { toString: 'x', valueOf: 'y' };

  // Nesting deep enough that JSON.stringify overflows in Firefox (~20k levels)
  // and WebKit (~100k) while JSON.parse still accepts it. Spliced into the seed
  // as raw text: building it as an object would overflow here too.
  const DEEP = '__DEEP__';
  const DEEP_JSON = '['.repeat(150000) + ']'.repeat(150000);
  const toSeedWithDeepValues = (value) => JSON.stringify(value).split(`"${DEEP}"`).join(DEEP_JSON);

  // A genuine tournament state, taken from the app itself so the seed tracks
  // the real state shape. Read from a throwaway page so the page under test
  // has never run the app before its planted state is in place. A not-started
  // state is captured by naming a court (which saves) before starting.
  async function captureARealTournamentState(context, { started = true } = {}) {
    const donor = await context.newPage();
    await donor.goto('/');
    await donor.fill('#tournamentName', 'Base Cup');
    if (started) await donor.click('#startTournamentBtn');
    else await donor.fill('#courtNameInput_1', 'Centre');
    const state = JSON.parse(await donor.evaluate(() => localStorage.getItem('tournamentState')));
    await donor.close();
    expect(state.tournamentStarted).toBe(started);
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

  // Uncaught exceptions AND console errors. The load handler's last-resort
  // catch logs a console error, while rejecting bad data only warns, so this
  // tells "validated" apart from "crashed and was rescued".
  function collectErrors(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
    });
    return errors;
  }

  function collectDialogs(page) {
    const messages = [];
    page.on('dialog', (dialog) => {
      messages.push(dialog.message());
      dialog.accept();
    });
    return messages;
  }

  async function storedJson(page, key) {
    return page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
  }

  async function scoreboardCells(page) {
    return page.locator('.scoreboard-container td').allTextContents();
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
      const errors = collectErrors(page);
      // Given the stored tournament state is unreadable.
      await plantStorage(page, { tournamentState: raw });

      // When the app loads.
      await page.goto('/');

      // Then it shows a fresh setup that works.
      await expectAFreshSetup(page);
      await expectATournamentCanStart(page, 'Recovered Cup');
      expect(errors).toEqual([]);
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
    ['duplicate player names', (s) => { s.players[1] = s.players[0]; }],
    ['a team naming an unknown player', (s) => { s.rounds[0].matches[0].teams[0][0] = 'Nobody'; }],
    ['a player count that is not a multiple of four', (s) => { s.players.push('Extra'); }],
    ['matches that are not a list', (s) => { s.rounds[0].matches = 'x'; }],
    ['no rounds', (s) => { s.rounds = []; }],
    ['a round number that cannot be printed', (s) => { s.rounds[0].roundNumber = UNPRINTABLE; }],
  ];
  for (const [description, corrupt] of HOSTILE_SCHEDULES) {
    test(`A tournament state with ${description} falls back to a fresh setup`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a running tournament whose stored schedule has been tampered with.
      const state = await captureARealTournamentState(context);
      corrupt(state.schedule);
      await plantStorage(page, { tournamentState: JSON.stringify(state) });

      // When the app loads.
      await page.goto('/');

      // Then it shows a fresh setup that works.
      await expectAFreshSetup(page);
      await expectATournamentCanStart(page, 'Recovered Cup');
      expect(errors).toEqual([]);
    });
  }

  // --- tournamentState with a sound structure but bad fields: sane restore ---
  const REPAIRABLE_FIELDS = [
    {
      description: 'an out-of-range round index',
      corrupt: (st) => { st.currentRoundIndex = 9999; },
      title: 'Base Cup',
    },
    {
      description: 'a round index that is not an integer',
      corrupt: (st) => { st.currentRoundIndex = '2'; },
      title: 'Base Cup',
    },
    {
      description: 'a tournament name that cannot be printed',
      corrupt: (st) => { st.tournamentName = UNPRINTABLE; },
      title: 'Tournament Title',
    },
    {
      description: 'hostile court names',
      corrupt: (st) => { st.courtNames = [UNPRINTABLE, 'Y'.repeat(5000), 42]; },
      title: 'Base Cup',
      courts: ['Court 1', 'Y'.repeat(30), 'Court 3'],
    },
    {
      description: 'a score that is not a string',
      corrupt: (st) => { st.schedule.rounds[0].matches[0].result = { left: 10, right: 14 }; },
      title: 'Base Cup',
    },
    {
      description: 'a format that is markup',
      corrupt: (st) => { st.format = '<script>alert(1)</script>'; },
      title: 'Base Cup',
    },
    {
      description: 'a format that is not a string',
      corrupt: (st) => { st.format = 42; },
      title: 'Base Cup',
    },
    {
      description: 'a format that cannot be printed',
      corrupt: (st) => { st.format = UNPRINTABLE; },
      title: 'Base Cup',
    },
    {
      // State saved before formats existed.
      description: 'no format (legacy state)',
      corrupt: (st) => { delete st.format; delete st.mexicanoPlayerCount; },
      title: 'Base Cup',
    },
  ];
  for (const { description, corrupt, title, courts = ['Court 1', 'Court 2', 'Court 3'] } of REPAIRABLE_FIELDS) {
    test(`A tournament state with ${description} restores the tournament sanely`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a running tournament whose stored fields have been tampered with.
      const state = await captureARealTournamentState(context);
      corrupt(state);
      await plantStorage(page, { tournamentState: JSON.stringify(state) });

      // When the app loads.
      await page.goto('/');

      // Then the tournament is restored with the bad fields reset to defaults.
      await expect(page.locator('#tournamentTitle')).toHaveText(title);
      await expect(page.locator('.round-header .left')).toHaveText('Round 1');
      expect(await page.locator('.court-label').allTextContents()).toEqual(courts);
      await expect(page.locator('.scoreboard-container table tr')).toHaveCount(13);
      await expect(page.locator('.result-overlay-left input').first()).toHaveValue('');
      // Every repaired or legacy state is an Americano tournament.
      await expect(page.locator('#formatSelect')).toHaveValue('americano');
      expect(errors).toEqual([]);
    });
  }

  // The settings panel of a running tournament: open it unless it already is.
  async function showTheSettings(page) {
    if (!(await page.locator('#settingsContainer').isVisible())) await page.click('#toggleSettingsBtn');
    await expect(page.locator('#settingsContainer')).toBeVisible();
  }

  // --- A started tournament in a format that cannot be started yet ---
  // The app only ever starts (and saves) Americano, so a started Mexicano state
  // can only have been planted: it is restored, and loaded, as Americano.
  test('A started state claiming Mexicano restores as a normal Americano tournament', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a running tournament whose stored format claims Mexicano.
    const state = await captureARealTournamentState(context);
    state.format = 'mexicano';
    state.mexicanoPlayerCount = 16;
    await plantStorage(page, { tournamentState: JSON.stringify(state) });

    // When the app loads.
    await page.goto('/');

    // Then it runs as an Americano tournament,
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('#formatSelect')).toHaveValue('americano');
    // with the Americano settings (locked, as for any running tournament),
    await showTheSettings(page);
    await expect(page.locator('#scheduleSelect')).toBeVisible();
    await expect(page.locator('#scheduleSelect')).toBeDisabled();
    await expect(page.locator('#playerCountSelect')).toBeHidden();
    await expect(page.locator('#playerInput_0')).toBeVisible();
    await expect(page.locator('#courtNameInput_1')).toBeVisible();
    await expect(page.locator('#mexicanoComingSoon')).toBeHidden();
    // and the state it saves reads Americano, as does a save of it.
    expect((await storedJson(page, 'tournamentState')).format).toBe('americano');
    collectDialogs(page);
    await page.click('#saveTournamentBtn');
    expect((await storedJson(page, 'savedTournaments'))[0].format).toBe('americano');
    expect(errors).toEqual([]);
  });

  test('A saved tournament claiming Mexicano loads as a normal Americano tournament', async ({ page, context }) => {
    const errors = collectErrors(page);
    collectDialogs(page);
    // Given a saved tournament whose format claims Mexicano.
    const { schedule } = await captureARealTournamentState(context);
    const saved = [{ tournamentName: 'Winter Cup', schedule, currentRoundIndex: 1, format: 'mexicano', savedAt: '2026-01-01T00:00:00.000Z' }];
    await plantStorage(page, { tournamentState: null, savedTournaments: JSON.stringify(saved) });

    // When the app loads and the Organizer loads the save.
    await page.goto('/');
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
    await page.click('#loadTournamentBtn');

    // Then it runs as an Americano tournament at its saved round,
    await expect(page.locator('#tournamentTitle')).toHaveText('Winter Cup');
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    await expect(page.locator('#formatSelect')).toHaveValue('americano');
    // with the Americano settings,
    await showTheSettings(page);
    await expect(page.locator('#scheduleSelect')).toBeVisible();
    await expect(page.locator('#playerCountSelect')).toBeHidden();
    await expect(page.locator('#courtNameInput_1')).toBeVisible();
    await expect(page.locator('#mexicanoComingSoon')).toBeHidden();
    // and what it stores and re-saves reads Americano.
    expect((await storedJson(page, 'tournamentState')).format).toBe('americano');
    await page.click('#saveTournamentBtn');
    expect((await storedJson(page, 'savedTournaments'))[0].format).toBe('americano');
    expect(errors).toEqual([]);
  });

  // --- The tournament format in a not-started state ---
  const NOT_STARTED_FORMATS = [
    // [description, stored format, stored player count, restored format, restored count]
    ['no format (legacy state)', undefined, undefined, 'americano', '12'],
    ['a format that is markup', '<script>alert(1)</script>', 16, 'americano', '16'],
    ['a format that is not a string', 42, 16, 'americano', '16'],
    ['a format in the wrong case', 'Mexicano', 16, 'americano', '16'],
    ['Mexicano with a player count below the range', 'mexicano', 7, 'mexicano', '12'],
    ['Mexicano with a player count above the range', 'mexicano', 25, 'mexicano', '12'],
    ['Mexicano with a fractional player count', 'mexicano', 12.5, 'mexicano', '12'],
    ['Mexicano with a player count that is a string', 'mexicano', '12', 'mexicano', '12'],
    ['Mexicano with a player count that is markup', 'mexicano', '<b>9</b>', 'mexicano', '12'],
  ];
  for (const [description, format, count, restoredFormat, restoredCount] of NOT_STARTED_FORMATS) {
    test(`A not-started state with ${description} restores the setup sanely`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a not-started tournament whose stored format fields are legacy or tampered.
      const state = await captureARealTournamentState(context, { started: false });
      if (format === undefined) delete state.format; else state.format = format;
      if (count === undefined) delete state.mexicanoPlayerCount; else state.mexicanoPlayerCount = count;
      await plantStorage(page, { tournamentState: JSON.stringify(state) });

      // When the app loads.
      await page.goto('/');

      // Then the setup is restored with a known format and an in-range player count.
      await expect(page.locator('#settingsContainer')).toBeVisible();
      await expect(page.locator('#tournamentTitle')).toHaveText('Base Cup');
      await expect(page.locator('#formatSelect')).toHaveValue(restoredFormat);
      await expect(page.locator('#playerCountSelect')).toHaveValue(restoredCount);
      if (restoredFormat === 'americano') {
        // And an Americano setup is unchanged and still starts.
        await expect(page.locator('#courtNameInput_1')).toHaveValue('Centre');
        await expect(page.locator('#startTournamentBtn')).toBeEnabled();
        await page.click('#startTournamentBtn');
        await expect(page.locator('.round-header .left')).toHaveText('Round 1');
        expect((await storedJson(page, 'tournamentState')).format).toBe('americano');
      } else {
        await expect(page.locator('#playerCountSelect')).toBeVisible();
        await expect(page.locator('#scheduleSelect')).toBeHidden();
        await expect(page.locator('#startTournamentBtn')).toBeDisabled();
      }
      expect(errors).toEqual([]);
    });
  }

  test('An unchecked, deeply nested extra property in a not-started state is dropped, so the tournament still starts', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a not-started tournament whose stored schedule carries extra,
    // deeply nested properties that the app itself cannot re-serialize.
    const state = await captureARealTournamentState(context, { started: false });
    state.schedule.x = DEEP;
    state.schedule.rounds[0].matches[0].y = DEEP;
    await plantStorage(page, { tournamentState: toSeedWithDeepValues(state) });

    // When the app loads.
    await page.goto('/');

    // Then the not-started tournament is restored.
    await expect(page.locator('#settingsContainer')).toBeVisible();
    await expect(page.locator('#tournamentTitle')).toHaveText('Base Cup');
    await expect(page.locator('#courtNameInput_1')).toHaveValue('Centre');
    await expect(page.locator('.round')).toHaveCount(0);

    // And it can be started, which saves a state without the extra properties.
    await page.click('#startTournamentBtn');
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    const saved = await storedJson(page, 'tournamentState');
    expect(saved.tournamentStarted).toBe(true);
    expect(saved.schedule).not.toHaveProperty('x');
    expect(saved.schedule.rounds[0].matches[0]).not.toHaveProperty('y');
    expect(errors).toEqual([]);
  });

  // --- savedTournaments ---
  for (const [description, raw] of [['invalid JSON', '[{"tournamentName": '], ['a non-list', '{"0": {}}']]) {
    test(`Saved tournaments holding ${description} leave an empty, working saved-tournament list`, async ({ page }) => {
      const errors = collectErrors(page);
      const dialogs = collectDialogs(page);
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
      expect(dialogs).toEqual(['Tournament saved!']);
      expect(errors).toEqual([]);
    });
  }

  test('Hostile saved tournaments are skipped while a sound one still lists, names and loads', async ({ page, context }) => {
    const errors = collectErrors(page);
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
    // And, saved before formats existed, it loads as Americano.
    await expect(page.locator('#formatSelect')).toHaveValue('americano');
    expect(errors).toEqual([]);
  });

  for (const [description, format] of [['a format that is markup', '<script>'], ['a format that is not a string', 42]]) {
    test(`A saved tournament with ${description} loads as Americano`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a saved tournament whose format has been tampered with.
      const { schedule } = await captureARealTournamentState(context);
      const saved = [{ tournamentName: 'Autumn Cup', schedule, currentRoundIndex: 0, format, savedAt: '2026-01-01T00:00:00.000Z' }];
      await plantStorage(page, { tournamentState: null, savedTournaments: JSON.stringify(saved) });

      // When the app loads and the Organizer loads the save.
      await page.goto('/');
      await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
      await page.click('#loadTournamentBtn');

      // Then it plays as an Americano tournament, and that is what is stored.
      await expect(page.locator('#tournamentTitle')).toHaveText('Autumn Cup');
      await expect(page.locator('.round-header .left')).toHaveText('Round 1');
      await expect(page.locator('#formatSelect')).toHaveValue('americano');
      expect((await storedJson(page, 'tournamentState')).format).toBe('americano');
      expect(errors).toEqual([]);
    });
  }

  test('An unchecked, deeply nested extra property in a saved tournament is dropped, so saving still works', async ({ page, context }) => {
    const errors = collectErrors(page);
    const dialogs = collectDialogs(page);
    // Given a saved tournament carrying extra, deeply nested properties that
    // the app itself cannot re-serialize.
    const { schedule } = await captureARealTournamentState(context);
    const saved = [{
      tournamentName: 'Spring Cup',
      schedule: { ...schedule, x: DEEP },
      currentRoundIndex: 0,
      savedAt: '2026-01-01T00:00:00.000Z',
      y: DEEP,
    }];
    await plantStorage(page, { tournamentState: null, savedTournaments: toSeedWithDeepValues(saved) });

    // When the app loads, the save is listed.
    await page.goto('/');
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);

    // Then another tournament can be started and saved alongside it,
    await expectATournamentCanStart(page, 'Summer Cup');
    await page.click('#saveTournamentBtn');
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(2);
    const stored = await storedJson(page, 'savedTournaments');
    expect(stored.map((t) => t.tournamentName)).toEqual(['Spring Cup', 'Summer Cup']);
    expect(stored[0]).not.toHaveProperty('y');
    expect(stored[0].schedule).not.toHaveProperty('x');

    // and "save first?" on New Tournament goes through to a fresh setup.
    await page.click('#newTournamentBtn');
    await expectAFreshSetup(page);
    expect(dialogs).toEqual([
      'Tournament saved!',
      'Do you want to save the current tournament before creating a new one?',
      'Tournament saved!',
      'Ready for a new tournament!',
    ]);
    expect(errors).toEqual([]);
  });

  test('When saving fails, "save first?" on New Tournament keeps the running tournament', async ({ page }) => {
    const errors = collectErrors(page);
    const dialogs = collectDialogs(page);
    // Given storage that refuses the saved-tournament list, as when it is full
    // (the live tournament state still saves, so the tournament runs normally).
    await page.addInitScript(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'savedTournaments') throw new DOMException('Storage is full', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
    });
    await page.goto('/');
    await expectATournamentCanStart(page, 'Kept Cup');
    await page.locator('.result-overlay-left input').first().fill('10');

    // When the Organizer starts a new tournament and asks to save the current one first.
    await page.click('#newTournamentBtn');

    // Then the save failure is reported and the running tournament is kept.
    await expect.poll(() => dialogs.length).toBe(3);
    expect(dialogs).toEqual([
      'Do you want to save the current tournament before creating a new one?',
      'The tournament could not be saved.',
      'The current tournament was kept, because it could not be saved.',
    ]);
    await expect(page.locator('#tournamentTitle')).toHaveText('Kept Cup');
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.result-overlay-left input').first()).toHaveValue('10');
    const live = await storedJson(page, 'tournamentState');
    expect(live.tournamentStarted).toBe(true);
    expect(live.tournamentName).toBe('Kept Cup');
    expect(errors).toEqual([]);
  });

  // --- Round trip: the checks are never stricter than the app's own writers ---
  test('Anything the app itself can write survives a reload', async ({ page }) => {
    const errors = collectErrors(page);
    collectDialogs(page);
    const longName = 'T'.repeat(200);
    await page.goto('/');
    // The tournament name input is capped, so the name the app writes is bounded.
    await expect(page.locator('#tournamentName')).toHaveAttribute('maxlength', '200');

    // Given a tournament started with the longest name the input takes, a pasted
    // control character in a player name and a court name, and a player named
    // "__proto__",
    await page.fill('#tournamentName', longName);
    await page.fill('#playerInput_0', 'Ada\u0085');
    await page.fill('#playerInput_1', '__proto__');
    await page.fill('#courtNameInput_1', 'Centre\u0085');
    await page.click('#startTournamentBtn');
    expect(await scoreboardCells(page)).toEqual(expect.arrayContaining(['Ada\u0085', '__proto__']));
    await expect(page.locator('.scoreboard-container table tr')).toHaveCount(13);
    // with an absurdly long score typed into a score box, then saved.
    await page.locator('.result-overlay-left input').first().fill('1'.repeat(33));
    await page.waitForTimeout(300);
    await page.click('#saveTournamentBtn');

    // When the app is reloaded.
    await page.reload();

    // Then all of it is restored as written.
    await expect(page.locator('#tournamentTitle')).toHaveText(longName);
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.result-overlay-left input').first()).toHaveValue('1'.repeat(33));
    expect(await page.locator('.court-1 .court-label').textContent()).toBe('Centre\u0085');
    await expect(page.locator('.scoreboard-container table tr')).toHaveCount(13);
    expect(await scoreboardCells(page)).toEqual(expect.arrayContaining(['Ada\u0085', '__proto__']));
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
    // And its format is kept, in the live state and in the save.
    await expect(page.locator('#formatSelect')).toHaveValue('americano');
    expect((await storedJson(page, 'tournamentState')).format).toBe('americano');
    expect((await storedJson(page, 'savedTournaments'))[0].format).toBe('americano');

    // And a second tournament of the same name, whose unique-name suffix takes
    // it past the input cap, is saved and restored too.
    await page.click('#newTournamentBtn');
    await page.fill('#tournamentName', longName);
    await page.click('#startTournamentBtn');
    await expect(page.locator('#tournamentName')).toHaveValue(`${longName}-1`);
    await page.click('#saveTournamentBtn');
    await page.reload();
    await expect(page.locator('#tournamentTitle')).toHaveText(`${longName}-1`);
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test('Every Mexicano setup the app can write survives a reload', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    // Given each end of the offered player-count range, chosen for Mexicano,
    for (const count of ['8', '24']) {
      await page.selectOption('#formatSelect', 'mexicano');
      await page.selectOption('#playerCountSelect', count);

      // When the app is reloaded,
      await page.reload();

      // Then the Mexicano setup is restored as written.
      await expect(page.locator('#formatSelect')).toHaveValue('mexicano');
      await expect(page.locator('#playerCountSelect')).toHaveValue(count);
      const stored = await storedJson(page, 'tournamentState');
      expect(stored.format).toBe('mexicano');
      expect(stored.mexicanoPlayerCount).toBe(Number(count));
    }
    expect(errors).toEqual([]);
  });
});
