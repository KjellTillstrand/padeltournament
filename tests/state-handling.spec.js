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

  // Like plantStorage, but only before the first navigation of this tab: a
  // reload then reads what the app itself stored, not the plant again.
  async function plantStorageOnce(page, entries) {
    await page.addInitScript((seed) => {
      if (sessionStorage.getItem('planted')) return;
      sessionStorage.setItem('planted', '1');
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

  // --- Started Mexicano tournaments (AB#59) ---
  // A genuine Mexicano state, taken from the app itself: a 9-player tournament
  // started, its round 1 completed and round 2 generated, so round 1 is locked.
  async function captureARealMexicanoState(context) {
    const donor = await context.newPage();
    // The context's storage may hold another donor's running tournament: clear it
    // before the app runs (a reload would write the running one back on unload).
    await donor.addInitScript(() => localStorage.clear());
    await donor.goto('/');
    await donor.selectOption('#formatSelect', 'mexicano');
    await donor.selectOption('#playerCountSelect', '9');
    await donor.fill('#tournamentName', 'Mexicano Base');
    await donor.click('#startTournamentBtn');
    const lefts = donor.locator('.matches-container .match .result-overlay-left input');
    await expect(lefts).toHaveCount(2);
    await lefts.nth(0).fill('20');
    await lefts.nth(1).fill('15');
    await donor.click('#generateNextRoundBtn');
    await expect(donor.locator('.round-header .left')).toHaveText('Round 2');
    const state = JSON.parse(await donor.evaluate(() => localStorage.getItem('tournamentState')));
    await donor.close();
    expect(state.tournamentStarted).toBe(true);
    expect(state.format).toBe('mexicano');
    expect(state.schedule.rounds).toHaveLength(2);
    return state;
  }

  async function expectRoundTwoOfAMexicano(page) {
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    await expect(page.locator('.court')).toHaveCount(2);
    await expect(page.locator('.result-overlay-left input').first()).toBeEnabled();
    await expect(page.locator('#generateNextRoundBtn')).toBeDisabled();
    // Round 1 stays viewable and locked.
    await page.getByRole('button', { name: 'PREVIOUS ROUND', exact: true }).click();
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.result-overlay-left input').first()).toBeDisabled();
    await expect(page.locator('.result-overlay-left input').first()).toHaveValue('20');
    await page.getByRole('button', { name: 'NEXT ROUND', exact: true }).click();
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
  }

  test('R-MEXICANO-ROUNDS, R-STATE-PERSIST: A sound Mexicano state with an out-of-range round index resumes at round 1, locks intact', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a running Mexicano tournament whose stored round index is out of range,
    const state = await captureARealMexicanoState(context);
    state.currentRoundIndex = 7;
    await plantStorage(page, { tournamentState: JSON.stringify(state) });

    // When the app loads,
    await page.goto('/');

    // Then it shows round 1, locked, and round 2 is still the one being played.
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.result-overlay-left input').first()).toBeDisabled();
    await expect(page.locator('#formatSelect')).toHaveValue('mexicano');
    await showTheSettings(page);
    await expect(page.locator('#playerCountSelect')).toHaveValue('9');
    await expect(page.locator('#playerCountSelect')).toBeDisabled();
    await expect(page.locator('[id^="playerInput_"]')).toHaveCount(9);
    await page.getByRole('button', { name: 'NEXT ROUND', exact: true }).click();
    await expectRoundTwoOfAMexicano(page);
    expect((await storedJson(page, 'tournamentState')).mexicanoSeed).toBe(state.mexicanoSeed);
    expect(errors).toEqual([]);
  });

  // Structure the next round cannot be generated from, or a draw without its
  // seed: the app never writes either, so the state is not trusted at all.
  const twoPlayersOnOneSeat = (s) => { s.schedule.rounds[0].matches[1].teams[0][0] = s.schedule.rounds[0].matches[0].teams[0][0]; };
  const HOSTILE_MEXICANO_STATES = [
    ['no rounds list', (s) => { delete s.schedule.rounds; }],
    ['an empty rounds list', (s) => { s.schedule.rounds = []; }],
    ['a rounds list that is not a list', (s) => { s.schedule.rounds = { 0: s.schedule.rounds[0], length: 1 }; }],
    ['rounds out of order', (s) => { s.schedule.rounds.reverse(); }],
    ['a skipped round number', (s) => { s.schedule.rounds[1].roundNumber = 3; }],
    ['a round missing a match', (s) => { s.schedule.rounds[1].matches.pop(); }],
    ['a round seating a player twice', twoPlayersOnOneSeat],
    ['two matches on one court', (s) => { s.schedule.rounds[0].matches[1].court = 1; }],
    ['a match naming an unknown player', (s) => { s.schedule.rounds[1].matches[0].teams[0][0] = 'Mallory'; }],
    ['fewer players than Mexicano pairs', (s) => {
      s.schedule.players = ['A', 'B', 'C', 'D'];
      s.schedule.rounds = [{ roundNumber: 1, matches: [{ court: 1, teams: [['A', 'B'], ['C', 'D']], result: null }] }];
    }],
    ['no seed', (s) => { delete s.mexicanoSeed; }],
    ['a null seed', (s) => { s.mexicanoSeed = null; }],
    ['a seed that is a string', (s) => { s.mexicanoSeed = String(s.mexicanoSeed); }],
    ['a fractional seed', (s) => { s.mexicanoSeed = 1.5; }],
    ['a negative seed', (s) => { s.mexicanoSeed = -1; }],
    ['a seed above 32 bits', (s) => { s.mexicanoSeed = 2 ** 32; }],
    ['a seed that is markup', (s) => { s.mexicanoSeed = '<img src=x onerror="window.pwned=1">'; }],
  ];
  for (const [description, corrupt] of HOSTILE_MEXICANO_STATES) {
    test(`R-MEXICANO-ROUNDS, R-STATE-PERSIST: A started Mexicano state with ${description} falls back to a fresh setup`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a running Mexicano tournament whose stored state has been tampered with,
      const state = await captureARealMexicanoState(context);
      corrupt(state);
      await plantStorage(page, { tournamentState: JSON.stringify(state) });

      // When the app loads,
      await page.goto('/');

      // Then it starts a fresh setup that works, rather than playing untrusted rounds.
      await expectAFreshSetup(page);
      expect(await page.evaluate(() => window.pwned)).toBeUndefined();
      await expectATournamentCanStart(page, 'Fresh Cup');
      expect(errors).toEqual([]);
    });
  }

  // The seed is any unsigned 32-bit integer: both ends are accepted.
  for (const seed of [0, 4294967295]) {
    test(`R-MEXICANO-ROUNDS, R-STATE-PERSIST: A started Mexicano state with the boundary seed ${seed} is restored and plays on`, async ({ page, context }) => {
      const errors = collectErrors(page);
      const state = await captureARealMexicanoState(context);
      state.mexicanoSeed = seed;
      await plantStorage(page, { tournamentState: JSON.stringify(state) });

      await page.goto('/');

      await expectRoundTwoOfAMexicano(page);
      expect((await storedJson(page, 'tournamentState')).mexicanoSeed).toBe(seed);
      expect(errors).toEqual([]);
    });
  }

  test('R-MEXICANO-ROUNDS: A started state claiming Mexicano for an Americano table without a seed falls back to a fresh setup', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a running Americano tournament whose stored format claims Mexicano (no seed).
    const state = await captureARealTournamentState(context);
    state.format = 'mexicano';
    state.mexicanoPlayerCount = 16;
    await plantStorage(page, { tournamentState: JSON.stringify(state) });

    // When the app loads.
    await page.goto('/');

    // Then it starts a fresh setup: no Mexicano round is generated from it.
    await expectAFreshSetup(page);
    await expect(page.locator('#formatSelect')).toHaveValue('americano');
    expect(errors).toEqual([]);
  });

  test('R-MEXICANO-ROUNDS: Hostile saved Mexicano tournaments are skipped while a sound one loads and plays on', async ({ page, context }) => {
    const errors = collectErrors(page);
    collectDialogs(page);
    // Given saved tournaments: one sound Mexicano save among tampered ones.
    // (The Americano donor runs first: it expects the context's storage empty.)
    const { schedule: americanoSchedule } = await captureARealTournamentState(context);
    const state = await captureARealMexicanoState(context);
    const save = (name, overrides) => ({
      tournamentName: name,
      schedule: JSON.parse(JSON.stringify(state.schedule)),
      currentRoundIndex: 1,
      format: 'mexicano',
      mexicanoSeed: state.mexicanoSeed,
      savedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    });
    const outOfOrder = JSON.parse(JSON.stringify(state.schedule));
    outOfOrder.rounds.reverse();
    const saved = [
      save('Bad Seed Cup', { mexicanoSeed: 'x' }),
      save('No Seed Cup', { mexicanoSeed: undefined }),
      save('Out Of Order Cup', { schedule: outOfOrder }),
      save('Americano Table Cup', { schedule: americanoSchedule, mexicanoSeed: undefined }),
      save('Sound Mexicano Cup', {}),
    ];
    await plantStorage(page, { tournamentState: null, savedTournaments: JSON.stringify(saved) });

    // When the app loads,
    await page.goto('/');

    // Then only the sound save is listed,
    await expectAFreshSetup(page);
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
    await expect(page.locator('#savedTournamentSelect option')).toContainText('Sound Mexicano Cup');

    // and it loads at its saved round, locks intact,
    await page.click('#loadTournamentBtn');
    await expect(page.locator('#tournamentTitle')).toHaveText('Sound Mexicano Cup');
    await expect(page.locator('#formatSelect')).toHaveValue('mexicano');
    await expectRoundTwoOfAMexicano(page);

    // and play goes on: round 2 completes and round 3 is generated.
    const lefts = page.locator('.matches-container .match .result-overlay-left input');
    await lefts.nth(0).fill('12');
    await lefts.nth(1).fill('12');
    await page.click('#generateNextRoundBtn');
    await expect(page.locator('.round-header .left')).toHaveText('Round 3');
    const stored = await storedJson(page, 'tournamentState');
    expect(stored.format).toBe('mexicano');
    expect(stored.mexicanoSeed).toBe(state.mexicanoSeed);
    expect(stored.schedule.rounds).toHaveLength(3);
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
        // And a Mexicano setup offers the restored count of players, and starts.
        await expect(page.locator('#playerCountSelect')).toBeVisible();
        await expect(page.locator('#scheduleSelect')).toBeHidden();
        await expect(page.locator('[id^="playerInput_"]')).toHaveCount(Number(restoredCount));
        await expect(page.locator('#startTournamentBtn')).toBeEnabled();
        await page.click('#startTournamentBtn');
        await expect(page.locator('.round-header .left')).toHaveText('Round 1');
        await expect(page.locator('.court')).toHaveCount(Math.floor(Number(restoredCount) / 4));
        const stored = await storedJson(page, 'tournamentState');
        expect(stored.format).toBe('mexicano');
        expect(stored.schedule.players).toHaveLength(Number(restoredCount));
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
    // with a score recorded on one match and an absurdly long one typed into
    // another's score box (shown with its error, but never recorded), then saved.
    const matches = page.locator('.result-overlay-container');
    await matches.first().locator('.result-overlay-left input').fill('15');
    await matches.last().locator('.result-overlay-left input').fill('1'.repeat(33));
    await expect(matches.last().locator('.error-message')).toContainText('whole number from 0 to 24');
    expect((await storedJson(page, 'tournamentState')).schedule.rounds[0].matches[2].result).toEqual({ left: '', right: '' });
    await page.click('#saveTournamentBtn');

    // When the app is reloaded.
    await page.reload();

    // Then all of it is restored as written.
    await expect(page.locator('#tournamentTitle')).toHaveText(longName);
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(matches.first().locator('.result-overlay-left input')).toHaveValue('15');
    await expect(matches.first().locator('.result-overlay-right input')).toHaveValue('9');
    await expect(matches.last().locator('.result-overlay-left input')).toHaveValue('');
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

  // --- AB#62: a stored points total that is not a real pool repairs to 24 ---
  // Complete a score on the first match and expect the pool's complement.
  async function expectComplementOnFirstMatch(page, entered, complement) {
    const match = page.locator('.result-overlay-container').first();
    await expect(match).toBeVisible();
    await match.locator('.result-overlay-left input').fill(String(entered));
    await expect(match.locator('.result-overlay-right input')).toHaveValue(String(complement));
    await expect(match.locator('.error-message')).toHaveText('');
  }

  const HOSTILE_TOTALS = [
    ['a numeric string', '21'],
    ['a value outside the pools', 25],
    ['zero', 0],
    ['a negative number', -24],
    ['null', null],
    ['an object', { a: 1 }],
    ['an array', [21]],
    ['missing (a legacy state)', undefined],
  ];

  for (const [description, totalPoints] of HOSTILE_TOTALS) {
    test(`R-STATE-PERSIST, R-POINT-POOLS: a stored tournament state with a points total that is ${description} resumes at 24`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a started tournament whose stored points total is not a valid pool.
      const state = await captureARealTournamentState(context);
      if (totalPoints === undefined) delete state.totalPoints;
      else state.totalPoints = totalPoints;
      await plantStorage(page, { tournamentState: JSON.stringify(state) });

      // When the app loads.
      await page.goto('/');

      // Then the tournament resumes with the default pool of 24,
      await expect(page.locator('.round')).toBeVisible();
      await expect(page.locator('#globalTotalPoints')).toHaveValue('24');
      // And a score entry completes against 24.
      await expectComplementOnFirstMatch(page, 15, 9);
      expect(errors).toEqual([]);
    });
  }

  for (const [description, totalPoints] of [['a value outside the pools', 25], ['a numeric string', '21'], ['an object', { a: 1 }], ['missing (a legacy save)', undefined]]) {
    test(`R-STATE-PERSIST, R-POINT-POOLS: a saved tournament with a points total that is ${description} loads at 24`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a saved tournament whose points total is not a valid pool.
      const { schedule } = await captureARealTournamentState(context);
      const entry = { tournamentName: 'Odd Cup', schedule, currentRoundIndex: 0, savedAt: '2026-01-01T00:00:00.000Z' };
      if (totalPoints !== undefined) entry.totalPoints = totalPoints;
      await plantStorage(page, { tournamentState: null, savedTournaments: JSON.stringify([entry]) });

      // When the app loads and the Organizer loads the save.
      await page.goto('/');
      await page.click('#loadTournamentBtn');

      // Then it plays to 24.
      await expect(page.locator('#tournamentTitle')).toHaveText('Odd Cup');
      await expect(page.locator('#globalTotalPoints')).toHaveValue('24');
      await expectComplementOnFirstMatch(page, 15, 9);
      expect(errors).toEqual([]);
    });
  }

  test('R-STATE-PERSIST, R-POINT-POOLS: a sound saved tournament at 21 still loads at 21', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given saved tournaments, one with a sound points total of 21 and one hostile.
    const { schedule } = await captureARealTournamentState(context);
    const base = { schedule, currentRoundIndex: 0, savedAt: '2026-01-01T00:00:00.000Z' };
    const saved = [
      { ...base, tournamentName: 'Hostile Cup', totalPoints: 'x' },
      { ...base, tournamentName: 'Odd Pool Cup', totalPoints: 21 },
    ];
    await plantStorage(page, { tournamentState: null, savedTournaments: JSON.stringify(saved) });

    // When the Organizer loads the 21-point save.
    await page.goto('/');
    await page.selectOption('#savedTournamentSelect', { label: await page.locator('#savedTournamentSelect option', { hasText: 'Odd Pool Cup' }).innerText() });
    await page.click('#loadTournamentBtn');

    // Then it plays to 21.
    await expect(page.locator('#tournamentTitle')).toHaveText('Odd Pool Cup');
    await expect(page.locator('#globalTotalPoints')).toHaveValue('21');
    await expectComplementOnFirstMatch(page, 13, 8);
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST, R-POINT-POOLS: a points total chosen in setup survives a reload before Start', async ({ page }) => {
    const errors = collectErrors(page);
    // Given the Organizer chooses 21 points in setup, without starting.
    await page.goto('/');
    await page.selectOption('#globalTotalPoints', '21');

    // When the page is reloaded before Start.
    await page.reload();

    // Then setup is still showing and the choice is still 21,
    await expect(page.locator('#startTournamentBtn')).toBeEnabled();
    await expect(page.locator('#globalTotalPoints')).toHaveValue('21');

    // And the started tournament completes scores to 21.
    await page.fill('#tournamentName', 'Setup Pool Cup');
    await page.click('#startTournamentBtn');
    await expectComplementOnFirstMatch(page, 13, 8);
    expect(errors).toEqual([]);
  });

  // --- AB#69: stored results are kept as stored; the score rule decides credit ---
  // A score is a whole number from 0 to the tournament's points total, and a
  // complete result sums to it. Restore type-checks results but never repairs
  // them: a stored pair of strings that breaks the rule (it may have been played
  // under another total) is kept byte-for-byte, shows its error, is not
  // credited, and can be scored again.
  const scoreboardPointsSorted = async (page) =>
    (await page.locator('.scoreboard-container tr td:nth-child(2)').allTextContents()).map(Number).sort((a, b) => b - a);
  const plantResults = (schedule, results) => {
    results.forEach((result, i) => { schedule.rounds[0].matches[i].result = result; });
  };
  async function expectScoresOnScreen(page, expected) {
    const matches = page.locator('.result-overlay-container');
    for (const [i, [left, right]] of expected.entries()) {
      await expect(matches.nth(i).locator('.result-overlay-left input')).toHaveValue(left);
      await expect(matches.nth(i).locator('.result-overlay-right input')).toHaveValue(right);
    }
  }
  // Each match's error: '' for none, else a substring it must contain.
  async function expectErrorsOnScreen(page, expected) {
    const matches = page.locator('.result-overlay-container');
    for (const [i, text] of expected.entries()) {
      const error = matches.nth(i).locator('.error-message');
      if (text === '') await expect(error).toHaveText('');
      else await expect(error).toContainText(text);
    }
  }
  const storedResults = async (page, key = 'tournamentState') =>
    (await storedJson(page, key)).schedule.rounds[0].matches.map((m) => m.result);

  const HOSTILE_RESULTS = [
    ['a score above the total and a negative complement', 24, { left: '30', right: '-6' }, 'whole number from 0 to 24'],
    ['fractional scores', 24, { left: '12.5', right: '11.5' }, 'whole number from 0 to 24'],
    ['a score in exponent notation', 24, { left: '1e1', right: '14' }, 'whole number from 0 to 24'],
    ['whole scores that do not sum to the total', 24, { left: '20', right: '20' }, 'Sum must equal 24'],
    ['one score only', 24, { left: '15', right: '' }, 'Please fill in both scores'],
    ['a draw at a total of 21', 21, { left: '12', right: '12' }, 'Sum must equal 21'],
  ];
  for (const [description, total, result, message] of HOSTILE_RESULTS) {
    test(`R-STATE-PERSIST, R-SCORE-ENTRY: a stored result with ${description} is kept as stored, flagged and not credited`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a started tournament whose first match holds a stored result that
      // breaks the score rule, and whose second match holds a sound one.
      const state = await captureARealTournamentState(context);
      const sound = { left: String(total - 9), right: '9' };
      state.totalPoints = total;
      plantResults(state.schedule, [result, sound]);
      await plantStorageOnce(page, { tournamentState: JSON.stringify(state) });

      // When the app loads (and reloads, saving on the way out),
      await page.goto('/');
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 1) await page.reload();
        // Then the result is shown as stored, with its error, and credited to nobody,
        await expect(page.locator('.round-header .left')).toHaveText('Round 1');
        await expect(page.locator('#globalTotalPoints')).toHaveValue(String(total));
        await expectScoresOnScreen(page, [[result.left, result.right], [sound.left, '9']]);
        // (the third match, stored blank, shows no error either)
        await expectErrorsOnScreen(page, [message, '', '']);
        expect(await scoreboardPointsSorted(page)).toEqual(
          [total - 9, total - 9, 9, 9].concat(Array(8).fill(0)));
      }
      // and it is stored back byte-for-byte.
      expect((await storedResults(page)).slice(0, 2)).toEqual([result, sound]);

      // And the match can be scored again.
      const first = page.locator('.result-overlay-container').first();
      await first.locator('.result-overlay-left input').fill('3');
      await expect(first.locator('.result-overlay-right input')).toHaveValue(String(total - 3));
      await expect(first.locator('.error-message')).toHaveText('');
      expect((await storedResults(page))[0]).toEqual({ left: '3', right: String(total - 3) });
      expect(errors).toEqual([]);
    });
  }

  test('R-STATE-PERSIST, R-SCORE-ENTRY: a saved tournament with an impossible result loads with it kept as stored, flagged and not credited', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a saved tournament played to 24 whose first match holds 30 / -6.
    const { schedule } = await captureARealTournamentState(context);
    schedule.rounds[0].matches[0].result = { left: '30', right: '-6' };
    const entry = { tournamentName: 'Bad Score Cup', schedule, currentRoundIndex: 0, totalPoints: 24, savedAt: '2026-01-01T00:00:00.000Z' };
    await plantStorage(page, { tournamentState: null, savedTournaments: JSON.stringify([entry]) });

    // When the Organizer loads it.
    await page.goto('/');
    await page.click('#loadTournamentBtn');

    // Then that match shows the stored score with its error, nobody is credited,
    await expect(page.locator('#tournamentTitle')).toHaveText('Bad Score Cup');
    await expectScoresOnScreen(page, [['30', '-6']]);
    await expectErrorsOnScreen(page, ['whole number from 0 to 24']);
    expect(await scoreboardPointsSorted(page)).toEqual(Array(12).fill(0));
    expect((await storedResults(page))[0]).toEqual({ left: '30', right: '-6' });
    // and it can be scored again.
    await expectComplementOnFirstMatch(page, 15, 9);
    expect(errors).toEqual([]);
  });

  // Stored scores are kept byte-for-byte, so hostile strings come back too: they
  // only ever reach an input's value (never markup), a number input cannot show
  // them, and the score rule credits nothing for them.
  test('R-STATE-PERSIST, R-SCORE-ENTRY: stored scores holding markup, prototype names or look-alike digits are inert, uncredited and kept', async ({ page, context }) => {
    const errors = collectErrors(page);
    const state = await captureARealTournamentState(context);
    const hostile = [
      { left: '<img src=x onerror=window.pwned=1>', right: '__proto__' },
      { left: '２４', right: ' 0' }, // fullwidth digits; a leading space
    ];
    plantResults(state.schedule, hostile);
    await plantStorageOnce(page, { tournamentState: JSON.stringify(state) });

    await page.goto('/');
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) await page.reload();
      await expect(page.locator('.round-header .left')).toHaveText('Round 1');
      // Nothing ran,
      expect(await page.evaluate(() => window.pwned)).toBeUndefined();
      // the number inputs cannot show either result, so each match asks for both scores,
      await expectScoresOnScreen(page, [['', ''], ['', '']]);
      await expectErrorsOnScreen(page, ['Please fill in both scores', 'Please fill in both scores', '']);
      // and nobody is credited.
      expect(await scoreboardPointsSorted(page)).toEqual(Array(12).fill(0));
    }
    // Both results are stored back byte-for-byte.
    expect((await storedResults(page)).slice(0, 2)).toEqual(hostile);
    expect(errors).toEqual([]);
  });

  // --- AB#69 review: the total of a legacy tournament (no stored total) ---
  // Before AB#62 the points total was not stored, so a tournament played to 16,
  // 21 or 32 comes back without one. Its total is inferred from its complete
  // stored results: the most common sum that is a pool (on a tie, the earliest
  // such result's), else 24. A total that IS stored, however hostile, is never
  // inferred over (AB#62). Results are kept as stored either way.
  const LEGACY_32_RESULTS = [{ left: '20', right: '12' }, { left: '18', right: '14' }];

  test('R-STATE-PERSIST, R-POINT-POOLS: a legacy state played to 32 (no stored total) restores at 32 with its results kept', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a running tournament stored before the total was, with two results summing to 32.
    const state = await captureARealTournamentState(context);
    delete state.totalPoints;
    plantResults(state.schedule, LEGACY_32_RESULTS);
    await plantStorage(page, { tournamentState: JSON.stringify(state) });

    // When the app loads.
    await page.goto('/');

    // Then it resumes at 32 with both results kept and credited,
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('#globalTotalPoints')).toHaveValue('32');
    await expectScoresOnScreen(page, [['20', '12'], ['18', '14']]);
    expect(await scoreboardPointsSorted(page)).toEqual([20, 20, 18, 18, 14, 14, 12, 12, 0, 0, 0, 0]);
    // and a new score completes to 32, which is now stored with the tournament.
    const third = page.locator('.result-overlay-container').nth(2);
    await third.locator('.result-overlay-left input').fill('3');
    await expect(third.locator('.result-overlay-right input')).toHaveValue('29');
    await expect(third.locator('.error-message')).toHaveText('');
    const stored = await storedJson(page, 'tournamentState');
    expect(stored.totalPoints).toBe(32);
    expect(stored.schedule.rounds[0].matches.slice(0, 2).map((m) => m.result)).toEqual(LEGACY_32_RESULTS);
    expect(errors).toEqual([]);
  });

  // A legacy tournament may mix sums: played to 32, reloaded (the setting fell
  // back to 24), then scored to 24. Every result is kept across reloads; those
  // off the inferred total show their error and are not credited.
  const MIXED_LEGACY = [
    {
      description: 'mostly played to 32',
      results: [{ left: '20', right: '12' }, { left: '18', right: '14' }, { left: '15', right: '9' }],
      total: 32,
      messages: ['', '', 'Sum must equal 32'],
      credited: [20, 20, 18, 18, 14, 14, 12, 12, 0, 0, 0, 0],
    },
    {
      description: 'mostly played to 24',
      results: [{ left: '20', right: '12' }, { left: '15', right: '9' }, { left: '14', right: '10' }],
      total: 24,
      messages: ['Sum must equal 24', '', ''],
      credited: [15, 15, 14, 14, 10, 10, 9, 9, 0, 0, 0, 0],
    },
  ];
  for (const { description, results, total, messages, credited } of MIXED_LEGACY) {
    test(`R-STATE-PERSIST, R-POINT-POOLS: a legacy state with mixed sums, ${description}, restores at ${total} keeping every result across reloads`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a legacy state (no stored total) with results summing to different pools.
      const state = await captureARealTournamentState(context);
      delete state.totalPoints;
      plantResults(state.schedule, results);
      await plantStorageOnce(page, { tournamentState: JSON.stringify(state) });

      // When the app loads, and is reloaded twice (saving on the way out each time),
      await page.goto('/');
      for (let pass = 0; pass < 3; pass++) {
        if (pass > 0) await page.reload();
        // Then it plays to the most common pool and shows every result as stored,
        await expect(page.locator('.round-header .left')).toHaveText('Round 1');
        await expect(page.locator('#globalTotalPoints')).toHaveValue(String(total));
        await expectScoresOnScreen(page, results.map((r) => [r.left, r.right]));
        await expectErrorsOnScreen(page, messages);
        // crediting only the results valid at that total.
        expect(await scoreboardPointsSorted(page)).toEqual(credited);
      }
      // And what the app stored keeps every result byte-for-byte, with the total.
      const stored = await storedJson(page, 'tournamentState');
      expect(stored.totalPoints).toBe(total);
      expect(stored.schedule.rounds[0].matches.map((m) => m.result)).toEqual(results);
      expect(errors).toEqual([]);
    });
  }

  // The reviewer's case: re-saved by AB#62 with totalPoints 24, so not legacy,
  // yet holding results played to 32. All of them are kept.
  const STORED_24_WITH_32_RESULTS = [{ left: '20', right: '12' }, { left: '18', right: '14' }, { left: '15', right: '9' }];

  test('R-STATE-PERSIST, R-POINT-POOLS: a state stored at 24 that holds results played to 32 keeps them all, crediting only the 24 one', async ({ page, context }) => {
    const errors = collectErrors(page);
    const state = await captureARealTournamentState(context);
    state.totalPoints = 24;
    plantResults(state.schedule, STORED_24_WITH_32_RESULTS);
    await plantStorageOnce(page, { tournamentState: JSON.stringify(state) });

    await page.goto('/');
    for (let pass = 0; pass < 3; pass++) {
      if (pass > 0) await page.reload();
      await expect(page.locator('.round-header .left')).toHaveText('Round 1');
      await expect(page.locator('#globalTotalPoints')).toHaveValue('24');
      await expectScoresOnScreen(page, [['20', '12'], ['18', '14'], ['15', '9']]);
      await expectErrorsOnScreen(page, ['Sum must equal 24', 'Sum must equal 24', '']);
      expect(await scoreboardPointsSorted(page)).toEqual([15, 15, 9, 9].concat(Array(8).fill(0)));
    }
    expect(await storedResults(page)).toEqual(STORED_24_WITH_32_RESULTS);
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST, R-POINT-POOLS: saved tournaments with off-total results keep them through load, save and delete', async ({ page, context }) => {
    const errors = collectErrors(page);
    collectDialogs(page);
    // Given two saved tournaments: a legacy one mostly played to 32, and one
    // stored at 24 that holds results played to 32.
    const legacy = await captureARealTournamentState(context);
    const other = JSON.parse(JSON.stringify(legacy));
    plantResults(legacy.schedule, MIXED_LEGACY[0].results);
    plantResults(other.schedule, STORED_24_WITH_32_RESULTS);
    const saved = [
      { tournamentName: 'Legacy Mixed Cup', schedule: legacy.schedule, currentRoundIndex: 0, savedAt: '2026-01-01T00:00:00.000Z' },
      { tournamentName: 'Other Cup', schedule: other.schedule, currentRoundIndex: 0, totalPoints: 24, savedAt: '2026-01-01T00:00:00.000Z' },
    ];
    await plantStorageOnce(page, { tournamentState: null, savedTournaments: JSON.stringify(saved) });
    await page.goto('/');
    const optionValue = async (name) =>
      page.locator('#savedTournamentSelect option', { hasText: name }).getAttribute('value');
    const savedEntry = async (name) =>
      (await storedJson(page, 'savedTournaments')).find((t) => t.tournamentName === name);

    // When the Organizer loads the legacy one, then it plays to 32 with every result,
    await page.selectOption('#savedTournamentSelect', await optionValue('Legacy Mixed Cup'));
    await page.click('#loadTournamentBtn');
    await expect(page.locator('#tournamentTitle')).toHaveText('Legacy Mixed Cup');
    await expect(page.locator('#globalTotalPoints')).toHaveValue('32');
    await expectScoresOnScreen(page, [['20', '12'], ['18', '14'], ['15', '9']]);
    await expectErrorsOnScreen(page, MIXED_LEGACY[0].messages);
    expect(await scoreboardPointsSorted(page)).toEqual(MIXED_LEGACY[0].credited);

    // and saving it (which rewrites the whole list) keeps both entries intact.
    await page.click('#saveTournamentBtn');
    expect((await savedEntry('Legacy Mixed Cup')).totalPoints).toBe(32);
    expect((await savedEntry('Legacy Mixed Cup')).schedule.rounds[0].matches.map((m) => m.result)).toEqual(MIXED_LEGACY[0].results);
    expect((await savedEntry('Other Cup')).totalPoints).toBe(24);
    expect((await savedEntry('Other Cup')).schedule.rounds[0].matches.map((m) => m.result)).toEqual(STORED_24_WITH_32_RESULTS);

    // When it is deleted (the list is rewritten again), the other entry is still intact,
    await page.click('#deleteTournamentBtn');
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
    expect((await savedEntry('Other Cup')).schedule.rounds[0].matches.map((m) => m.result)).toEqual(STORED_24_WITH_32_RESULTS);

    // and loads at 24 with all three results, crediting only the 24 one.
    await page.click('#loadTournamentBtn');
    await expect(page.locator('#tournamentTitle')).toHaveText('Other Cup');
    await expect(page.locator('#globalTotalPoints')).toHaveValue('24');
    await expectScoresOnScreen(page, [['20', '12'], ['18', '14'], ['15', '9']]);
    expect(await scoreboardPointsSorted(page)).toEqual([15, 15, 9, 9].concat(Array(8).fill(0)));
    expect(errors).toEqual([]);
  });

  // Equally common pool sums: the pool of the earliest such result (round order) wins.
  const TIES = [
    ['16 first', [[{ left: '10', right: '6' }, { left: '20', right: '12' }], [{ left: '18', right: '14' }, { left: '9', right: '7' }]], '16'],
    ['32 first', [[{ left: '20', right: '12' }, { left: '10', right: '6' }], [{ left: '9', right: '7' }, { left: '18', right: '14' }]], '32'],
  ];
  for (const [description, [round1, round2], total] of TIES) {
    test(`R-STATE-PERSIST, R-POINT-POOLS: a legacy state tied between 16 and 32 (${description}) restores at the earliest pool`, async ({ page, context }) => {
      const errors = collectErrors(page);
      const state = await captureARealTournamentState(context);
      delete state.totalPoints;
      plantResults(state.schedule, round1);
      round2.forEach((result, i) => { state.schedule.rounds[1].matches[i].result = result; });
      await plantStorage(page, { tournamentState: JSON.stringify(state) });

      await page.goto('/');

      await expect(page.locator('.round-header .left')).toHaveText('Round 1');
      await expect(page.locator('#globalTotalPoints')).toHaveValue(total);
      // Nothing is blanked; the result off the chosen pool shows its error.
      await expectScoresOnScreen(page, round1.map((r) => [r.left, r.right]));
      const matches = page.locator('.result-overlay-container');
      await expect(matches.nth(0).locator('.error-message')).toHaveText('');
      await expect(matches.nth(1).locator('.error-message')).not.toHaveText('');
      expect(errors).toEqual([]);
    });
  }

  test('R-STATE-PERSIST, R-POINT-POOLS: a legacy state with no result summing to a pool restores at 24 with nothing blanked', async ({ page, context }) => {
    const errors = collectErrors(page);
    const state = await captureARealTournamentState(context);
    delete state.totalPoints;
    const results = [{ left: '13', right: '12' }, { left: '20', right: '5' }, { left: '15', right: '' }];
    plantResults(state.schedule, results);
    await plantStorage(page, { tournamentState: JSON.stringify(state) });

    await page.goto('/');

    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('#globalTotalPoints')).toHaveValue('24');
    await expectScoresOnScreen(page, [['13', '12'], ['20', '5'], ['15', '']]);
    // None of them is valid at 24: each says why, and nobody is credited.
    await expectErrorsOnScreen(page, ['Sum must equal 24', 'Sum must equal 24', 'Please fill in both scores']);
    expect(await scoreboardPointsSorted(page)).toEqual(Array(12).fill(0));
    expect(errors).toEqual([]);
  });

  for (const [description, totalPoints] of [['a numeric string', '32'], ['a value outside the pools', 25], ['null', null]]) {
    test(`R-STATE-PERSIST, R-POINT-POOLS: a stored total that is ${description} is not inferred over, even with results summing to 32`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a stored, hostile total and results that all sum to 32,
      const state = await captureARealTournamentState(context);
      state.totalPoints = totalPoints;
      plantResults(state.schedule, LEGACY_32_RESULTS);
      await plantStorage(page, { tournamentState: JSON.stringify(state) });

      await page.goto('/');

      // Then the total is 24 (AB#62); the results are kept, but do not fit it.
      await expect(page.locator('.round-header .left')).toHaveText('Round 1');
      await expect(page.locator('#globalTotalPoints')).toHaveValue('24');
      await expectScoresOnScreen(page, [['20', '12'], ['18', '14']]);
      await expectErrorsOnScreen(page, ['Sum must equal 24', 'Sum must equal 24']);
      expect(await scoreboardPointsSorted(page)).toEqual(Array(12).fill(0));
      expect(errors).toEqual([]);
    });
  }

  test('R-STATE-PERSIST: a stale legacyResults key from an earlier build is ignored and not written back', async ({ page, context }) => {
    const errors = collectErrors(page);
    collectDialogs(page);
    // Given a stored state and a saved tournament that both carry legacyResults.
    const state = await captureARealTournamentState(context);
    state.legacyResults = true;
    plantResults(state.schedule, [{ left: '15', right: '9' }]);
    const entry = { tournamentName: 'Stale Cup', schedule: state.schedule, currentRoundIndex: 0, totalPoints: 24, legacyResults: true, savedAt: '2026-01-01T00:00:00.000Z' };
    await plantStorageOnce(page, { tournamentState: JSON.stringify(state), savedTournaments: JSON.stringify([entry]) });

    // When the app loads, reloads (saving the state) and saves the tournament (rewriting the list),
    await page.goto('/');
    await expectScoresOnScreen(page, [['15', '9']]);
    await page.reload();
    await expectScoresOnScreen(page, [['15', '9']]);
    await page.click('#saveTournamentBtn');

    // Then neither the state nor any saved tournament carries the key any more.
    expect(await storedJson(page, 'tournamentState')).not.toHaveProperty('legacyResults');
    const savedList = await storedJson(page, 'savedTournaments');
    expect(savedList.length).toBe(2);
    for (const saved of savedList) expect(saved).not.toHaveProperty('legacyResults');
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST, R-POINT-POOLS: a legacy saved tournament played to 32 (no stored total) loads at 32 with its results kept', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a saved tournament from before the total was stored, played to 32.
    const { schedule } = await captureARealTournamentState(context);
    plantResults(schedule, LEGACY_32_RESULTS);
    const entry = { tournamentName: 'Legacy 32 Cup', schedule, currentRoundIndex: 0, savedAt: '2026-01-01T00:00:00.000Z' };
    await plantStorage(page, { tournamentState: null, savedTournaments: JSON.stringify([entry]) });

    // When the Organizer loads it.
    await page.goto('/');
    await page.click('#loadTournamentBtn');

    // Then it plays to 32 with both results kept and credited, and the running
    // tournament now stores its total.
    await expect(page.locator('#tournamentTitle')).toHaveText('Legacy 32 Cup');
    await expect(page.locator('#globalTotalPoints')).toHaveValue('32');
    await expectScoresOnScreen(page, [['20', '12'], ['18', '14']]);
    expect(await scoreboardPointsSorted(page)).toEqual([20, 20, 18, 18, 14, 14, 12, 12, 0, 0, 0, 0]);
    const stored = await storedJson(page, 'tournamentState');
    expect(stored.totalPoints).toBe(32);
    expect(stored.schedule.rounds[0].matches.slice(0, 2).map((m) => m.result)).toEqual(LEGACY_32_RESULTS);
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST, R-SCHEDULE-SELECT: a restored or loaded schedule that matches no option leaves the schedule select alone', async ({ page, context }) => {
    const errors = collectErrors(page);
    collectDialogs(page);
    // Given a running tournament and a saved one, both 16 players over 5 rounds:
    // a shape no shipped schedule has (there is no 16p5r.js).
    const state = await captureARealTournamentState(context, { schedule: '16p15r.js' });
    state.schedule.rounds = state.schedule.rounds.slice(0, 5);
    const entry = { tournamentName: 'Odd Shape Cup', schedule: state.schedule, currentRoundIndex: 0 };
    await plantStorageOnce(page, { tournamentState: JSON.stringify(state), savedTournaments: JSON.stringify([entry]) });

    // When the app restores it (and again after a reload),
    await page.goto('/');
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) await page.reload();
      // Then the tournament runs, and the select keeps the option it had.
      await expect(page.locator('.round-header .left')).toHaveText('Round 1');
      await expect(page.locator('#tournamentContainer .court')).toHaveCount(4);
      await expect(page.locator('#scheduleSelect')).toHaveValue('12p11r.js');
    }

    // And loading the saved one leaves it alone too.
    await page.click('#loadTournamentBtn');
    await expect(page.locator('#tournamentTitle')).toHaveText('Odd Shape Cup');
    await expect(page.locator('#tournamentContainer .court')).toHaveCount(4);
    await expect(page.locator('#scheduleSelect')).toHaveValue('12p11r.js');
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

// A setup restored before Start (a reload, or a format switch after one) never
// loads its schedule module again, so the default names a blank player input
// falls back to must come with the restored schedule. Start must still work.
test.describe('Default player names in a setup restored before Start', () => {
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

  async function storedState(page) {
    return page.evaluate(() => JSON.parse(localStorage.getItem('tournamentState')));
  }

  // The names the started tournament should carry, sorted (Start shuffles
  // them): the typed ones, and the default name (P1, P2, ...) of every slot
  // left blank.
  function expectedNames(count, typed) {
    return Array.from({ length: count }, (_, i) => typed[i] || `P${i + 1}`).sort();
  }

  test('R-STATE-PERSIST, R-PLAYER-NAMES: a reloaded 16-player setup starts with blank names falling back to their defaults', async ({ page }) => {
    const errors = collectErrors(page);
    const dialogs = collectDialogs(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    // Given a 16-player schedule is loaded and named, but not started,
    await page.selectOption('#scheduleSelect', '16p15r.js');
    await page.fill('#tournamentName', 'Restored Cup');
    // and the page is reloaded, which restores that setup.
    await page.reload();
    await expect(page.locator('#tournamentTitle')).toHaveText('Restored Cup');
    await expect(page.locator('[id^="playerInput_"]')).toHaveCount(16);
    await expect(page.locator('.round')).toHaveCount(0);

    // When the Organizer names two players, empties two name fields and starts,
    const typed = { 0: 'Ada', 1: 'Bea' };
    await page.fill('#playerInput_0', 'Ada');
    await page.fill('#playerInput_1', 'Bea');
    await page.fill('#playerInput_3', '');
    await page.fill('#playerInput_9', '');
    await page.click('#startTournamentBtn');

    // Then the tournament starts,
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.court')).toHaveCount(4);
    // and each emptied slot carries its default name.
    expect([...(await storedState(page)).schedule.players].sort()).toEqual(expectedNames(16, typed));
    const cells = await page.locator('.scoreboard-container td').allTextContents();
    expect(cells).toEqual(expect.arrayContaining(['Ada', 'Bea', 'P4', 'P10']));
    expect(dialogs).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST, R-PLAYER-NAMES: a reloaded Mexicano setup switched to Americano starts with a blank name falling back to its default', async ({ page }) => {
    const errors = collectErrors(page);
    const dialogs = collectDialogs(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    // Given a named Mexicano setup that has not started,
    await page.fill('#tournamentName', 'Switch Cup');
    await page.selectOption('#formatSelect', 'mexicano');
    // restored by a reload,
    await page.reload();
    await expect(page.locator('#formatSelect')).toHaveValue('mexicano');
    await expect(page.locator('#tournamentTitle')).toHaveText('Switch Cup');

    // When the Organizer switches to Americano, names one player, empties
    // another name field and starts,
    await page.selectOption('#formatSelect', 'americano');
    await expect(page.locator('[id^="playerInput_"]')).toHaveCount(12);
    const typed = { 0: 'Ada' };
    await page.fill('#playerInput_0', 'Ada');
    await page.fill('#playerInput_5', '');
    await page.click('#startTournamentBtn');

    // Then the Americano tournament starts,
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.court')).toHaveCount(3);
    // and the emptied slot carries its default name.
    const state = await storedState(page);
    expect(state.format).toBe('americano');
    expect([...state.schedule.players].sort()).toEqual(expectedNames(12, typed));
    const cells = await page.locator('.scoreboard-container td').allTextContents();
    expect(cells).toEqual(expect.arrayContaining(['Ada', 'P6']));
    expect(dialogs).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// The schedule select is locked while a tournament runs, but it must still show
// the schedule that tournament plays, however it came back: a reload, a new tab
// or a load. Each option value <N>p<R>r.js names the schedule with N players
// over R rounds, so a restored schedule's own counts identify its option.
test.describe('Schedule select after a restore or a load', () => {
  function collectErrors(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
    });
    return errors;
  }

  // Accept every notice; decline "save first?" on New Tournament.
  function collectDialogs(page) {
    const messages = [];
    page.on('dialog', (dialog) => {
      messages.push(dialog.message());
      if (dialog.type() === 'confirm') dialog.dismiss(); else dialog.accept();
    });
    return messages;
  }

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  async function startTournament(page, moduleName, name) {
    await page.selectOption('#scheduleSelect', moduleName);
    await page.fill('#tournamentName', name);
    await page.click('#startTournamentBtn');
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
  }

  // The select shows the schedule, both after a reload and in a fresh tab
  // (which has no form state of its own to restore).
  async function expectTheSelectAfterReloadAndInANewTab(page, context, moduleName, { started = true } = {}) {
    await page.reload();
    await expect(page.locator('#scheduleSelect')).toHaveValue(moduleName);
    const fresh = await context.newPage();
    const errors = collectErrors(fresh);
    await fresh.goto('/');
    await expect(fresh.locator('#scheduleSelect')).toHaveValue(moduleName);
    if (started) await expect(fresh.locator('#scheduleSelect')).toBeDisabled();
    else await expect(fresh.locator('#scheduleSelect')).toBeEnabled();
    expect(errors).toEqual([]);
    await fresh.close();
  }

  test('R-STATE-PERSIST, R-SCHEDULE-SELECT: a started 16-player tournament still shows its schedule after a reload', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a 16-player tournament is running,
    await startTournament(page, '16p15r.js', 'Sixteen Cup');
    // When the page is reloaded (or opened in a new tab),
    // Then the locked select still shows the 16-player schedule.
    await expectTheSelectAfterReloadAndInANewTab(page, context, '16p15r.js');
    await expect(page.locator('#scheduleSelect')).toBeDisabled();
    await expect(page.locator('.scoreboard-container table tr')).toHaveCount(17);
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST, R-SCHEDULE-SELECT: a loaded 16-player tournament shows its schedule, not the one chosen for the new tournament', async ({ page, context }) => {
    const errors = collectErrors(page);
    const dialogs = collectDialogs(page);
    // Given a 16-player tournament is saved,
    await startTournament(page, '16p15r.js', 'Saved Sixteen');
    await page.click('#saveTournamentBtn');
    // and a new tournament is set up at the default size,
    await page.click('#newTournamentBtn');
    await expect.poll(() => dialogs.length).toBe(3);
    await expect(page.locator('#settingsContainer')).toBeVisible();
    await page.selectOption('#scheduleSelect', '12p11r.js');
    await expect(page.locator('[id^="playerInput_"]')).toHaveCount(12);

    // When the Organizer loads the saved one,
    await page.click('#loadTournamentBtn');

    // Then the select shows the 16-player schedule it plays,
    await expect(page.locator('#tournamentTitle')).toHaveText('Saved Sixteen');
    await expect(page.locator('.scoreboard-container table tr')).toHaveCount(17);
    await expect(page.locator('#scheduleSelect')).toHaveValue('16p15r.js');
    await expect(page.locator('#scheduleSelect')).toBeDisabled();
    // and still does once the loaded tournament is restored.
    await expectTheSelectAfterReloadAndInANewTab(page, context, '16p15r.js');
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST, R-SCHEDULE-SELECT: a started 13-player (sit-out) tournament still shows its schedule after a reload', async ({ page, context }) => {
    const errors = collectErrors(page);
    await startTournament(page, '13p13r.js', 'Thirteen Cup');
    await expectTheSelectAfterReloadAndInANewTab(page, context, '13p13r.js');
    await expect(page.locator('.resting-players .resting-player')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST, R-SCHEDULE-SELECT: a 16-player setup not yet started still shows its schedule after a reload', async ({ page, context }) => {
    const errors = collectErrors(page);
    await page.selectOption('#scheduleSelect', '16p15r.js');
    await page.fill('#tournamentName', 'Pending Sixteen');
    await expectTheSelectAfterReloadAndInANewTab(page, context, '16p15r.js', { started: false });
    await expect(page.locator('[id^="playerInput_"]')).toHaveCount(16);
    expect(errors).toEqual([]);
  });

  test('R-SCHEDULE-SELECT: every shipped option names a schedule with exactly its player and round counts', async ({ page }) => {
    // The select is set from a restored schedule's counts, so no two options may
    // share them, and each module must hold the counts its name claims.
    const options = await page.evaluate(() =>
      Array.from(document.getElementById('scheduleSelect').options, (option) => {
        const match = /^(\d+)p(\d+)r\.js$/.exec(option.value);
        const schedule = match ? window[`schedule${match[1]}p${match[2]}r`] : null;
        return {
          value: option.value,
          claimed: match ? [Number(match[1]), Number(match[2])] : null,
          actual: schedule ? [schedule.players.length, schedule.rounds.length] : null,
        };
      }));
    expect(options.length).toBe(17);
    for (const option of options) expect(option.actual, option.value).toEqual(option.claimed);
    expect(new Set(options.map((option) => option.claimed.join('/'))).size).toBe(options.length);
  });
});
