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
  // `schedule` picks another schedule than the default 12-player one.
  async function captureARealTournamentState(context, { started = true, schedule } = {}) {
    const donor = await context.newPage();
    await donor.goto('/');
    if (schedule) await donor.selectOption('#scheduleSelect', schedule);
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
    // Any count of at least one court is playable (the rest sit out), up to a limit.
    ['more players than the limit', (s) => { for (let i = 0; i < 53; i++) s.players.push(`Extra${i}`); }],
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

  // --- Byes (who rests) in a schedule with a count that is not a multiple of four ---
  // Byes are derived data: whatever is stored, the round shows (and the app
  // stores back) exactly the players its matches do not seat.
  const seatedIn = (round) => round.matches.flatMap((match) => match.teams.flat());
  const restingIn = (schedule, round) => schedule.players.filter((p) => !seatedIn(round).includes(p));

  async function restingOnScreen(page) {
    return page.locator('.resting-players .resting-player').allTextContents();
  }

  const HOSTILE_BYES = [
    ['byes naming an unknown player', (s) => { s.rounds[0].byes = ['Nobody', s.rounds[0].byes[1]]; }],
    ['byes naming a seated player', (s) => { s.rounds[0].byes = [seatedIn(s.rounds[0])[0], s.rounds[0].byes[0]]; }],
    ['an overlong bye list', (s) => { s.rounds[0].byes = Array.from({ length: 5000 }, () => s.players[0]); }],
    ['byes that are not a list', (s) => { s.rounds[0].byes = s.players[0]; }],
    ['byes that are markup', (s) => { s.rounds[0].byes = ['<img src=x onerror="window.pwned=1">']; }],
    ['byes that cannot be printed', (s) => { s.rounds[0].byes = [UNPRINTABLE, UNPRINTABLE]; }],
    ['no byes at all', (s) => { s.rounds.forEach((round) => { delete round.byes; }); }],
    ['null byes', (s) => { s.rounds.forEach((round) => { round.byes = null; }); }],
    ['byes that are an object', (s) => { s.rounds[0].byes = { 0: s.players[0], length: 2 }; }],
    ['byes of out-of-range indices', (s) => { s.rounds[0].byes = [-1, 99, 1e308, NaN]; }],
    ['byes of the wrong length', (s) => { s.rounds[0].byes = [s.players[0]]; }],
    ['byes of prototype-ish names', (s) => { s.rounds[0].byes = ['__proto__', 'constructor']; }],
    ['a prototype-ish byes key on the schedule and rounds', (s) => {
      s.byes = ['__proto__'];
      s.rounds.forEach((round) => { round.rest = ['constructor']; round.sitOuts = JSON.parse('{"__proto__":{"x":1}}'); });
    }],
    ['byes listing every player', (s) => { s.rounds.forEach((round) => { round.byes = s.players.slice(); }); }],
  ];
  for (const [description, corrupt] of HOSTILE_BYES) {
    test(`A 10-player tournament state with ${description} restores with the true resting players`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a running 10-player tournament whose stored byes have been tampered with.
      const state = await captureARealTournamentState(context, { schedule: '10p10r.js' });
      const expected = restingIn(state.schedule, state.schedule.rounds[0]);
      expect(expected).toHaveLength(2);
      expect(state.schedule.rounds[0].byes).toEqual(expect.arrayContaining(expected));
      corrupt(state.schedule);
      await plantStorage(page, { tournamentState: JSON.stringify(state) });

      // When the app loads.
      await page.goto('/');

      // Then the tournament is restored, showing as resting exactly the players
      // round 1 does not seat,
      await expect(page.locator('#tournamentTitle')).toHaveText('Base Cup');
      await expect(page.locator('.round-header .left')).toHaveText('Round 1');
      await expect(page.locator('.court')).toHaveCount(2);
      expect(await restingOnScreen(page)).toEqual(expected);
      await expect(page.locator('.scoreboard-container table tr')).toHaveCount(11);
      // and what it stores back holds those byes, not the planted ones.
      const stored = await storedJson(page, 'tournamentState');
      expect(stored.schedule.rounds[0].byes).toEqual(expected);
      expect(await page.evaluate(() => window.pwned)).toBeUndefined();
      expect(errors).toEqual([]);
    });
  }

  test('A 12-player tournament state with planted byes rests nobody', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a running 12-player tournament whose stored rounds claim byes.
    const state = await captureARealTournamentState(context);
    state.schedule.rounds.forEach((round) => { round.byes = [state.schedule.players[0]]; });
    await plantStorage(page, { tournamentState: JSON.stringify(state) });

    // When the app loads.
    await page.goto('/');

    // Then the round shows nobody resting, and the stored rounds carry no byes.
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.court')).toHaveCount(3);
    await expect(page.locator('.resting-players')).toHaveCount(0);
    const stored = await storedJson(page, 'tournamentState');
    expect(stored.schedule.rounds.every((round) => !('byes' in round))).toBe(true);
    expect(errors).toEqual([]);
  });

  test('A saved 13-player tournament with hostile byes loads with the true resting players', async ({ page, context }) => {
    const errors = collectErrors(page);
    collectDialogs(page);
    // Given a saved 13-player tournament whose byes have been tampered with.
    const { schedule } = await captureARealTournamentState(context, { schedule: '13p13r.js' });
    const expected = restingIn(schedule, schedule.rounds[1]);
    expect(expected).toHaveLength(1);
    schedule.rounds[1].byes = ['Nobody', ...schedule.players];
    const saved = [{ tournamentName: 'Odd Cup', schedule, currentRoundIndex: 1, savedAt: '2026-01-01T00:00:00.000Z' }];
    await plantStorage(page, { tournamentState: null, savedTournaments: JSON.stringify(saved) });

    // When the app loads and the Organizer loads the save.
    await page.goto('/');
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
    await page.click('#loadTournamentBtn');

    // Then it plays at its saved round with the true resting player.
    await expect(page.locator('#tournamentTitle')).toHaveText('Odd Cup');
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    await expect(page.locator('.court')).toHaveCount(3);
    expect(await restingOnScreen(page)).toEqual(expected);
    expect((await storedJson(page, 'tournamentState')).schedule.rounds[1].byes).toEqual(expected);
    expect(errors).toEqual([]);
  });

  test('A 9-player state with a player no match seats restores with that player resting', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a not-started 9-player setup whose round 1 has lost a match: its
    // four players are no longer seated.
    const state = await captureARealTournamentState(context, { started: false, schedule: '9p9r.js' });
    state.schedule.rounds[0].matches = state.schedule.rounds[0].matches.slice(0, 1);
    const expected = restingIn(state.schedule, state.schedule.rounds[0]);
    expect(expected).toHaveLength(5);
    await plantStorage(page, { tournamentState: JSON.stringify(state) });

    // When the app loads and the tournament is started.
    await page.goto('/');
    await expect(page.locator('[id^="playerInput_"]')).toHaveCount(9);
    await expect(page.locator('[id^="courtNameInput_"]')).toHaveCount(2);
    await expect(page.locator('#courtNameInput_1')).toHaveValue('Centre');
    await page.click('#startTournamentBtn');

    // Then round 1 plays its one match and shows the other five players resting
    // (under the names drawn at the start).
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.court')).toHaveCount(1);
    const started = (await storedJson(page, 'tournamentState')).schedule;
    expect(await restingOnScreen(page)).toEqual(restingIn(started, started.rounds[0]));
    expect(await restingOnScreen(page)).toHaveLength(5);
    expect(errors).toEqual([]);
  });

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

// Counts that are not a multiple of four: floor(N/4) courts play and the others
// rest. Selecting such a schedule, playing it and reloading it must round-trip
// like any other: the rests survive and always name exactly the unseated players.
test.describe('Rest rounds survive selection, play and reload', () => {
  function collectErrors(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
    });
    return errors;
  }

  // Who the current round seats (read from the match containers) and who it
  // shows resting.
  async function theRoundOnScreen(page) {
    const seated = await page.locator('#tournamentContainer .match').evaluateAll((matches) =>
      matches.flatMap((m) => [...m.dataset.teamLeft.split(','), ...m.dataset.teamRight.split(',')]));
    const resting = await page.locator('.resting-players .resting-player').allTextContents();
    return { seated, resting };
  }

  for (const players of [9, 10, 13, 22]) {
    const rounds = players;
    const courts = Math.floor(players / 4);
    const resting = players % 4;
    test(`R-SITOUT-PLAY, R-SCHEDULE-SELECT, R-STATE-PERSIST: ${players} players play with ${resting} resting per round, across a reload`, async ({ page }) => {
      const errors = collectErrors(page);
      const names = Array.from({ length: players }, (_, i) => `Name${i + 1}`);
      await page.goto('/');

      // Given the Organizer selects the schedule for this count,
      await page.selectOption('#scheduleSelect', `${players}p${rounds}r.js`);
      await expect(page.locator('#scheduleSelect option:checked')).toHaveText(
        `${players} Player, ${rounds} Round Schedule`);
      await expect(page.locator('[id^="playerInput_"]')).toHaveCount(players);
      await expect(page.locator('[id^="courtNameInput_"]')).toHaveCount(courts);
      for (let i = 0; i < players; i++) await page.fill(`#playerInput_${i}`, names[i]);

      // When the Americano starts,
      await page.fill('#tournamentName', `Rest Cup ${players}`);
      await page.click('#startTournamentBtn');

      // Then round 1 seats every court and shows the rest of the players resting,
      await expect(page.locator('.round-header .left')).toHaveText('Round 1');
      await expect(page.locator('#tournamentContainer .court')).toHaveCount(courts);
      let round = await theRoundOnScreen(page);
      expect(round.resting).toHaveLength(resting);
      expect([...round.seated, ...round.resting].sort()).toEqual([...names].sort());
      await expect(page.locator('.scoreboard-container table tr')).toHaveCount(players + 1);

      // and the full tournament is offered: every round, everyone rests equally.
      const schedule = (await page.evaluate(() => JSON.parse(localStorage.getItem('tournamentState')))).schedule;
      expect(schedule.rounds).toHaveLength(rounds);
      const rests = Object.fromEntries(names.map((n) => [n, 0]));
      for (const r of schedule.rounds) {
        expect(r.matches).toHaveLength(courts);
        r.byes.forEach((n) => { rests[n]++; });
      }
      expect(new Set(Object.values(rests))).toEqual(new Set([resting]));

      // When a score is entered, play moves to round 2 and the page is reloaded,
      await page.locator('.result-overlay-left input').first().fill('10');
      await page.getByRole('button', { name: 'NEXT ROUND' }).click();
      await expect(page.locator('.round-header .left')).toHaveText('Round 2');
      const beforeReload = await theRoundOnScreen(page);
      await page.reload();

      // Then round 2 is restored with the same courts and the same resting players.
      await expect(page.locator('#tournamentTitle')).toHaveText(`Rest Cup ${players}`);
      await expect(page.locator('.round-header .left')).toHaveText('Round 2');
      round = await theRoundOnScreen(page);
      expect(round).toEqual(beforeReload);
      expect(round.resting).toEqual(schedule.rounds[1].byes);
      await page.getByRole('button', { name: 'PREVIOUS ROUND' }).click();
      await expect(page.locator('.result-overlay-left input').first()).toHaveValue('10');
      expect(errors).toEqual([]);
    });
  }

  test('R-SITOUT-PLAY: a 12-player Americano rests nobody in any round', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    // Given 12 players (the default schedule), when the Americano starts,
    await page.fill('#tournamentName', 'Even Cup');
    await page.click('#startTournamentBtn');

    // Then no round rests anyone.
    for (let r = 1; r <= 11; r++) {
      await expect(page.locator('.round-header .left')).toHaveText(`Round ${r}`);
      await expect(page.locator('#tournamentContainer .court')).toHaveCount(3);
      await expect(page.locator('.resting-players')).toHaveCount(0);
      if (r < 11) await page.getByRole('button', { name: 'NEXT ROUND' }).click();
    }
    const schedule = (await page.evaluate(() => JSON.parse(localStorage.getItem('tournamentState')))).schedule;
    expect(schedule.rounds.every((round) => !('byes' in round))).toBe(true);
    expect(errors).toEqual([]);
  });
});
