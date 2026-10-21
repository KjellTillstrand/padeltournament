// general-functionality.spec.js
const { test, expect } = require('@playwright/test');
const {
  STATE_KEY, SAVED_TOURNAMENTS_KEY, STATE_BACKUP_KEY, LEGACY_STATE_KEY, LEGACY_SAVED_TOURNAMENTS_KEY,
  STATE_MIGRATED_KEY, SAVED_TOURNAMENTS_MIGRATED_KEY,
} = require('./storage-keys');

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
    const savedState = await newPage.evaluate((key) => localStorage.getItem(key), STATE_KEY);
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
    const state = JSON.parse(await donor.evaluate((key) => localStorage.getItem(key), STATE_KEY));
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

  // --- a tournament state that cannot be restored: fresh setup ---
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
      await plantStorage(page, { [STATE_KEY]: raw });

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
      await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

      // When the app loads.
      await page.goto('/');

      // Then it shows a fresh setup that works.
      await expectAFreshSetup(page);
      await expectATournamentCanStart(page, 'Recovered Cup');
      expect(errors).toEqual([]);
    });
  }

  // --- a tournament state with a sound structure but bad fields: sane restore ---
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
      await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

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
      await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

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
      const stored = await storedJson(page, STATE_KEY);
      expect(stored.schedule.rounds[0].byes).toEqual(expected);
      expect(await page.evaluate(() => window.pwned)).toBeUndefined();
      expect(errors).toEqual([]);
    });
  }

  // The copy layer is an allowlist: only the fields it checks survive a restore.
  // The planted text puts an own "__proto__" key (carrying a "byes" payload),
  // plus sitOuts/rest/extra, on the schedule and on every round. Object spread
  // is used to plant them because it keeps "__proto__" as an own key, whereas
  // Object.assign would invoke the __proto__ setter and JSON.stringify would
  // then drop it. A copy that spread `...round` would keep sitOuts/rest/extra,
  // and the key allowlist check below catches that; the raw stored text is
  // checked too, as reading it back through the page cannot show an own
  // "__proto__". At 10 players setByes writes an own byes, so an inherited one
  // could never show; at 12 nobody rests and no byes is written, so a round
  // that inherited the planted one would show "Nobody" resting.
  const UNKNOWN_KEYS = [
    // schedule, players, players resting in round 1, the keys of a stored round
    ['10p10r.js', 10, 2, ['byes', 'matches', 'roundNumber']],
    ['12p11r.js', 12, 0, ['matches', 'roundNumber']],
  ];
  for (const [schedule, players, resting, roundKeys] of UNKNOWN_KEYS) {
    test(`A ${players}-player tournament state with unknown keys restores with the true resting players and stores none of the keys`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a sound running tournament whose schedule and rounds carry unknown keys.
      const state = await captureARealTournamentState(context, { schedule });
      expect(state.schedule.players).toHaveLength(players);
      const expected = restingIn(state.schedule, state.schedule.rounds[0]);
      expect(expected).toHaveLength(resting);
      const HOSTILE = '{"__proto__":{"byes":["Nobody"],"x":1},"sitOuts":{"__proto__":{"x":1}},"rest":["constructor"],"extra":1}';
      state.schedule = { ...state.schedule, ...JSON.parse(HOSTILE) };
      state.schedule.rounds = state.schedule.rounds.map((r) => ({ ...r, ...JSON.parse(HOSTILE) }));
      const raw = JSON.stringify(state);
      // the planted text really has an own "__proto__" on the schedule and on every round
      const reparsed = JSON.parse(raw);
      expect(Object.getOwnPropertyNames(reparsed.schedule)).toContain('__proto__');
      expect(reparsed.schedule.rounds.every((r) => Object.getOwnPropertyNames(r).includes('__proto__'))).toBe(true);
      await plantStorage(page, { [STATE_KEY]: raw });

      // When the app loads.
      await page.goto('/');

      // Then the tournament is restored showing the true resting players,
      await expect(page.locator('#tournamentTitle')).toHaveText('Base Cup');
      await expect(page.locator('.round-header .left')).toHaveText('Round 1');
      await expect(page.locator('.scoreboard-container table tr')).toHaveCount(players + 1);
      expect(await restingOnScreen(page)).toEqual(expected);
      await expect(page.locator('body')).not.toContainText('Nobody');
      // what it stores back carries none of the unknown keys,
      const stored = await storedJson(page, STATE_KEY);
      const keysOf = (o) => Object.getOwnPropertyNames(o).sort();
      expect(keysOf(stored.schedule)).toEqual(['players', 'rounds']);
      for (const round of stored.schedule.rounds) expect(keysOf(round)).toEqual(roundKeys);
      // not even in the raw stored text,
      const storedText = await page.evaluate((key) => localStorage.getItem(key), STATE_KEY);
      for (const planted of ['"__proto__":', '"sitOuts":', '"rest":', '"extra":', '"x":', 'Nobody']) {
        expect(storedText).not.toContain(planted);
      }
      // and nothing leaked onto the page's object prototype.
      expect(await page.evaluate(() => ({}).x)).toBeUndefined();
      expect(errors).toEqual([]);
    });
  }

  test('A 12-player tournament state with planted byes rests nobody', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a running 12-player tournament whose stored rounds claim byes.
    const state = await captureARealTournamentState(context);
    state.schedule.rounds.forEach((round) => { round.byes = [state.schedule.players[0]]; });
    await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

    // When the app loads.
    await page.goto('/');

    // Then the round shows nobody resting, and the stored rounds carry no byes.
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.court')).toHaveCount(3);
    await expect(page.locator('.resting-players')).toHaveCount(0);
    const stored = await storedJson(page, STATE_KEY);
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
    await plantStorage(page, { [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: JSON.stringify(saved) });

    // When the app loads and the Organizer loads the save.
    await page.goto('/');
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
    await page.click('#loadTournamentBtn');

    // Then it plays at its saved round with the true resting player.
    await expect(page.locator('#tournamentTitle')).toHaveText('Odd Cup');
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    await expect(page.locator('.court')).toHaveCount(3);
    expect(await restingOnScreen(page)).toEqual(expected);
    expect((await storedJson(page, STATE_KEY)).schedule.rounds[1].byes).toEqual(expected);
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
    await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

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
    const started = (await storedJson(page, STATE_KEY)).schedule;
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
    const state = JSON.parse(await donor.evaluate((key) => localStorage.getItem(key), STATE_KEY));
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
    // The next round is not offered (aria-disabled, AB#70), and a click generates nothing.
    await expect(page.locator('#generateNextRoundBtn')).toHaveAttribute('aria-disabled', 'true');
    await page.locator('#generateNextRoundBtn').click({ force: true });
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    await expect(page.getByRole('button', { name: 'NEXT ROUND', exact: true })).toHaveCount(0);
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
    await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

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
    expect((await storedJson(page, STATE_KEY)).mexicanoSeed).toBe(state.mexicanoSeed);
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
      await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

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
      await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

      await page.goto('/');

      await expectRoundTwoOfAMexicano(page);
      expect((await storedJson(page, STATE_KEY)).mexicanoSeed).toBe(seed);
      expect(errors).toEqual([]);
    });
  }

  test('R-MEXICANO-ROUNDS: A started state claiming Mexicano for an Americano table without a seed falls back to a fresh setup', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a running Americano tournament whose stored format claims Mexicano (no seed).
    const state = await captureARealTournamentState(context);
    state.format = 'mexicano';
    state.mexicanoPlayerCount = 16;
    await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

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
    await plantStorage(page, { [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: JSON.stringify(saved) });

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
    const stored = await storedJson(page, STATE_KEY);
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
      await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

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
        expect((await storedJson(page, STATE_KEY)).format).toBe('americano');
      } else {
        // And a Mexicano setup offers the restored count of players, and starts.
        await expect(page.locator('#playerCountSelect')).toBeVisible();
        await expect(page.locator('#scheduleSelect')).toBeHidden();
        await expect(page.locator('[id^="playerInput_"]')).toHaveCount(Number(restoredCount));
        await expect(page.locator('#startTournamentBtn')).toBeEnabled();
        await page.click('#startTournamentBtn');
        await expect(page.locator('.round-header .left')).toHaveText('Round 1');
        await expect(page.locator('.court')).toHaveCount(Math.floor(Number(restoredCount) / 4));
        const stored = await storedJson(page, STATE_KEY);
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
    await plantStorage(page, { [STATE_KEY]: toSeedWithDeepValues(state) });

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
    const saved = await storedJson(page, STATE_KEY);
    expect(saved.tournamentStarted).toBe(true);
    expect(saved.schedule).not.toHaveProperty('x');
    expect(saved.schedule.rounds[0].matches[0]).not.toHaveProperty('y');
    expect(errors).toEqual([]);
  });

  // --- saved tournaments ---
  for (const [description, raw] of [['invalid JSON', '[{"tournamentName": '], ['a non-list', '{"0": {}}']]) {
    test(`Saved tournaments holding ${description} leave an empty, working saved-tournament list`, async ({ page }) => {
      const errors = collectErrors(page);
      const dialogs = collectDialogs(page);
      // Given the stored saved-tournament list is unreadable.
      await plantStorage(page, { [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: raw });

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
    await plantStorage(page, { [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: JSON.stringify(saved) });

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
      await plantStorage(page, { [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: JSON.stringify(saved) });

      // When the app loads and the Organizer loads the save.
      await page.goto('/');
      await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
      await page.click('#loadTournamentBtn');

      // Then it plays as an Americano tournament, and that is what is stored.
      await expect(page.locator('#tournamentTitle')).toHaveText('Autumn Cup');
      await expect(page.locator('.round-header .left')).toHaveText('Round 1');
      await expect(page.locator('#formatSelect')).toHaveValue('americano');
      expect((await storedJson(page, STATE_KEY)).format).toBe('americano');
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
    await plantStorage(page, { [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: toSeedWithDeepValues(saved) });

    // When the app loads, the save is listed.
    await page.goto('/');
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);

    // Then another tournament can be started and saved alongside it,
    await expectATournamentCanStart(page, 'Summer Cup');
    await page.click('#saveTournamentBtn');
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(2);
    const stored = await storedJson(page, SAVED_TOURNAMENTS_KEY);
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
    await page.addInitScript((savedKey) => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === savedKey) throw new DOMException('Storage is full', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
    }, SAVED_TOURNAMENTS_KEY);
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
    const live = await storedJson(page, STATE_KEY);
    expect(live.tournamentStarted).toBe(true);
    expect(live.tournamentName).toBe('Kept Cup');
    expect(errors).toEqual([]);
  });

  // --- Round trip: the checks are never stricter than the app's own writers ---
  test('R-STATE-PERSIST: Anything the app itself can write survives a reload', async ({ page }) => {
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
    // another's score box (shown with its error, but never recorded),
    const matches = page.locator('.result-overlay-container');
    await matches.first().locator('.result-overlay-left input').fill('15');
    await matches.last().locator('.result-overlay-left input').fill('1'.repeat(33));
    await expect(matches.last().locator('.error-message')).toContainText('whole number from 0 to 24');
    expect((await storedJson(page, STATE_KEY)).schedule.rounds[0].matches[2].result).toEqual({ left: '', right: '' });
    // and 15 zero-padded to 1001 characters typed into the third: a stored
    // string that long would be cut on reading, so it is no score either (shown
    // with its error, never recorded, never credited), then saved.
    const padded = '0'.repeat(999) + '15';
    await matches.nth(1).locator('.result-overlay-left input').fill(padded);
    await expect(matches.nth(1).locator('.error-message')).toContainText('whole number from 0 to 24');
    await expect(matches.nth(1).locator('.result-overlay-right input')).toHaveValue('');
    expect((await storedJson(page, STATE_KEY)).schedule.rounds[0].matches[1].result).toEqual({ left: '', right: '' });
    expect(await scoreboardPointsSorted(page)).toEqual([15, 15, 9, 9].concat(Array(8).fill(0)));
    await page.click('#saveTournamentBtn');

    // When the app is reloaded.
    await page.reload();

    // Then all of it is restored as written.
    await expect(page.locator('#tournamentTitle')).toHaveText(longName);
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(matches.first().locator('.result-overlay-left input')).toHaveValue('15');
    await expect(matches.first().locator('.result-overlay-right input')).toHaveValue('9');
    await expect(matches.last().locator('.result-overlay-left input')).toHaveValue('');
    await expect(matches.nth(1).locator('.result-overlay-left input')).toHaveValue('');
    const stored = await storedJson(page, STATE_KEY);
    expect(stored.schedule.rounds[0].matches.map((m) => m.result)).toEqual(
      [{ left: '15', right: '9' }, { left: '', right: '' }, { left: '', right: '' }]);
    expect(await scoreboardPointsSorted(page)).toEqual([15, 15, 9, 9].concat(Array(8).fill(0)));
    expect(await page.locator('.court-1 .court-label').textContent()).toBe('Centre\u0085');
    await expect(page.locator('.scoreboard-container table tr')).toHaveCount(13);
    expect(await scoreboardCells(page)).toEqual(expect.arrayContaining(['Ada\u0085', '__proto__']));
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
    // And its format is kept, in the live state and in the save.
    await expect(page.locator('#formatSelect')).toHaveValue('americano');
    expect((await storedJson(page, STATE_KEY)).format).toBe('americano');
    expect((await storedJson(page, SAVED_TOURNAMENTS_KEY))[0].format).toBe('americano');

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
      const stored = await storedJson(page, STATE_KEY);
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
      await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

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
      await plantStorage(page, { [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: JSON.stringify([entry]) });

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
    await plantStorage(page, { [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: JSON.stringify(saved) });

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
  // under another total) is kept byte-for-byte (unless overlong: see AB#41
  // below), shows its error, is not credited, and can be scored again.
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
  const storedResults = async (page, key = STATE_KEY) =>
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
      await plantStorageOnce(page, { [STATE_KEY]: JSON.stringify(state) });

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
    await plantStorage(page, { [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: JSON.stringify([entry]) });

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
    await plantStorageOnce(page, { [STATE_KEY]: JSON.stringify(state) });

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
    await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

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
    const stored = await storedJson(page, STATE_KEY);
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
      await plantStorageOnce(page, { [STATE_KEY]: JSON.stringify(state) });

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
      const stored = await storedJson(page, STATE_KEY);
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
    await plantStorageOnce(page, { [STATE_KEY]: JSON.stringify(state) });

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
    await plantStorageOnce(page, { [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: JSON.stringify(saved) });
    await page.goto('/');
    const optionValue = async (name) =>
      page.locator('#savedTournamentSelect option', { hasText: name }).getAttribute('value');
    const savedEntry = async (name) =>
      (await storedJson(page, SAVED_TOURNAMENTS_KEY)).find((t) => t.tournamentName === name);

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
      await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

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
    await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

    await page.goto('/');

    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('#globalTotalPoints')).toHaveValue('24');
    await expectScoresOnScreen(page, [['13', '12'], ['20', '5'], ['15', '']]);
    // None of them is valid at 24: each says why, and nobody is credited.
    await expectErrorsOnScreen(page, ['Sum must equal 24', 'Sum must equal 24', 'Please fill in both scores']);
    expect(await scoreboardPointsSorted(page)).toEqual(Array(12).fill(0));
    expect(errors).toEqual([]);
  });

  // The inference counts only pairs the score rule can read (isScoreDigits): a
  // side of 1000 characters is never a score, however its digits add up. Here
  // the only pair is 20 and 12 zero-padded to 1000 characters each, which as
  // numbers would sum to 32.
  test('R-STATE-PERSIST, R-POINT-POOLS: a legacy state whose only pair summing to 32 is zero-padded to 1000 characters restores at 24', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a legacy state (no stored total) whose only result is that pair,
    const state = await captureARealTournamentState(context);
    delete state.totalPoints;
    const padded = { left: '0'.repeat(998) + '20', right: '0'.repeat(998) + '12' };
    expect([padded.left.length, padded.right.length]).toEqual([1000, 1000]);
    plantResults(state.schedule, [padded]);
    await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

    // When the app loads.
    await page.goto('/');

    // Then it resumes at 24, not 32,
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('#globalTotalPoints')).toHaveValue('24');
    // the pair is shown with its error and credited to nobody,
    await expectErrorsOnScreen(page, ['whole number from 0 to 24', '', '']);
    expect(await scoreboardPointsSorted(page)).toEqual(Array(12).fill(0));
    // and is stored back byte-for-byte, with the total of 24.
    const stored = await storedJson(page, STATE_KEY);
    expect(stored.totalPoints).toBe(24);
    expect(stored.schedule.rounds[0].matches[0].result).toEqual(padded);

    // And a score on another match completes to 24.
    const second = page.locator('.result-overlay-container').nth(1);
    await second.locator('.result-overlay-left input').fill('15');
    await expect(second.locator('.result-overlay-right input')).toHaveValue('9');
    await expect(second.locator('.error-message')).toHaveText('');
    expect(errors).toEqual([]);
  });

  for (const [description, totalPoints] of [['a numeric string', '32'], ['a value outside the pools', 25], ['null', null]]) {
    test(`R-STATE-PERSIST, R-POINT-POOLS: a stored total that is ${description} is not inferred over, even with results summing to 32`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a stored, hostile total and results that all sum to 32,
      const state = await captureARealTournamentState(context);
      state.totalPoints = totalPoints;
      plantResults(state.schedule, LEGACY_32_RESULTS);
      await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

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
    await plantStorageOnce(page, { [STATE_KEY]: JSON.stringify(state), [SAVED_TOURNAMENTS_KEY]: JSON.stringify([entry]) });

    // When the app loads, reloads (saving the state) and saves the tournament (rewriting the list),
    await page.goto('/');
    await expectScoresOnScreen(page, [['15', '9']]);
    await page.reload();
    await expectScoresOnScreen(page, [['15', '9']]);
    await page.click('#saveTournamentBtn');

    // Then neither the state nor any saved tournament carries the key any more.
    expect(await storedJson(page, STATE_KEY)).not.toHaveProperty('legacyResults');
    const savedList = await storedJson(page, SAVED_TOURNAMENTS_KEY);
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
    await plantStorage(page, { [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: JSON.stringify([entry]) });

    // When the Organizer loads it.
    await page.goto('/');
    await page.click('#loadTournamentBtn');

    // Then it plays to 32 with both results kept and credited, and the running
    // tournament now stores its total.
    await expect(page.locator('#tournamentTitle')).toHaveText('Legacy 32 Cup');
    await expect(page.locator('#globalTotalPoints')).toHaveValue('32');
    await expectScoresOnScreen(page, [['20', '12'], ['18', '14']]);
    expect(await scoreboardPointsSorted(page)).toEqual([20, 20, 18, 18, 14, 14, 12, 12, 0, 0, 0, 0]);
    const stored = await storedJson(page, STATE_KEY);
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
    await plantStorageOnce(page, { [STATE_KEY]: JSON.stringify(state), [SAVED_TOURNAMENTS_KEY]: JSON.stringify([entry]) });

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

  // --- legacy (unprefixed) keys: migrated once (a marker records it) while the
  // prefixed key is absent, and removed only when the migrated copy is lossless ---
  async function storedRaw(page, key) {
    return page.evaluate((k) => localStorage.getItem(k), key);
  }

  test('The specs use the same localStorage keys as the app', async ({ page }) => {
    await page.goto('/');
    const appKeys = await page.evaluate(() => ({
      STATE_KEY, SAVED_TOURNAMENTS_KEY, STATE_BACKUP_KEY, LEGACY_STATE_KEY, LEGACY_SAVED_TOURNAMENTS_KEY,
      STATE_MIGRATED_KEY, SAVED_TOURNAMENTS_MIGRATED_KEY,
    }));
    expect(appKeys).toEqual({
      STATE_KEY, SAVED_TOURNAMENTS_KEY, STATE_BACKUP_KEY, LEGACY_STATE_KEY, LEGACY_SAVED_TOURNAMENTS_KEY,
      STATE_MIGRATED_KEY, SAVED_TOURNAMENTS_MIGRATED_KEY,
    });
  });

  // A tournament in progress at round 3, with scores and custom tournament,
  // player and court names, as the app stored it before its keys were prefixed,
  // once restored: the copy layer keeps only the fields it checks, so the
  // schedule module's own playerCount and totalRounds (present until the first
  // restore) are gone, and the stored value is exactly what a copy rebuilds.
  async function captureALegacyTournamentInProgress(context) {
    const state = await captureARealTournamentState(context);
    delete state.schedule.playerCount;
    delete state.schedule.totalRounds;
    state.tournamentName = 'Legacy Cup';
    renamePlayer(state.schedule, state.schedule.players[0], 'Ada');
    state.courtNames = ['Centre'];
    state.currentRoundIndex = 2;
    state.schedule.rounds.slice(0, 2).forEach((round) => round.matches.forEach((match) => {
      match.result = { left: '14', right: '10' };
    }));
    state.schedule.rounds[2].matches[0].result = { left: '15', right: '9' };
    return state;
  }

  test('R-STATE-PERSIST: a tournament stored under the legacy key resumes, migrated to the prefixed key', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a tournament in progress stored under the legacy key only.
    const state = await captureALegacyTournamentInProgress(context);
    await plantStorageOnce(page, { [STATE_KEY]: null, [LEGACY_STATE_KEY]: JSON.stringify(state) });

    // When the returning Organizer reopens the app (and once more).
    await page.goto('/');
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) await page.reload();
      // Then the tournament resumes at round 3 with its scores and names.
      await expect(page.locator('.round-header .left')).toHaveText('Round 3');
      await expect(page.locator('#tournamentTitle')).toHaveText('Legacy Cup');
      await expect(page.locator('.result-overlay-left input').first()).toHaveValue('15');
      await expect(page.locator('.result-overlay-right input').first()).toHaveValue('9');
      await expect(page.locator('#courtNameInput_1')).toHaveValue('Centre');
      await expect(page.locator('.scoreboard-container')).toContainText('Ada');
      // And it lives under the prefixed key only: the legacy key is gone. (What
      // was stored is the app's own state by now: showing a round fills in its
      // blank results, so the stored value is checked field by field.)
      const stored = await storedJson(page, STATE_KEY);
      expect(stored.tournamentName).toBe('Legacy Cup');
      expect(stored.currentRoundIndex).toBe(2);
      expect(stored.courtNames).toEqual(['Centre']);
      expect(stored.schedule.rounds[0].matches[0].result).toEqual({ left: '14', right: '10' });
      expect(await storedRaw(page, LEGACY_STATE_KEY)).toBeNull();
    }
    expect(errors).toEqual([]);
  });

  test('R-TOURNAMENT-STORE: saved tournaments stored under the legacy key are migrated and still load', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a saved tournament list under the legacy key only, its entry holding
    // every field a save writes.
    const state = await captureALegacyTournamentInProgress(context);
    const entry = {
      tournamentName: 'Legacy Save', schedule: state.schedule, currentRoundIndex: 2,
      courtNames: ['Centre'], format: 'americano', mexicanoSeed: null, totalPoints: 24,
      savedAt: '2026-01-01T00:00:00.000Z',
    };
    await plantStorageOnce(page, {
      [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: null, [LEGACY_SAVED_TOURNAMENTS_KEY]: JSON.stringify([entry]),
    });

    // When the app loads.
    await page.goto('/');

    // Then the whole list moved to the prefixed key, and the legacy key is gone.
    expect(await storedJson(page, SAVED_TOURNAMENTS_KEY)).toEqual([entry]);
    expect(await storedRaw(page, LEGACY_SAVED_TOURNAMENTS_KEY)).toBeNull();
    // And the save is offered and loads where it was left.
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
    await expect(page.locator('#savedTournamentSelect option')).toContainText('Legacy Save');
    await page.click('#loadTournamentBtn');
    await expect(page.locator('#tournamentTitle')).toHaveText('Legacy Save');
    await expect(page.locator('.round-header .left')).toHaveText('Round 3');
    await expect(page.locator('.result-overlay-left input').first()).toHaveValue('15');
    await expect(page.locator('#courtNameInput_1')).toHaveValue('Centre');
    await expect(page.locator('.scoreboard-container')).toContainText('Ada');
    expect(errors).toEqual([]);
  });

  // Data under the legacy keys may be another page's on this shared origin, so
  // whatever the copy layer rejects is never deleted (nor carried over).
  const UNUSABLE_LEGACY_VALUES = [
    ["another page's data", () => '{"theme":"dark"}', () => '[{"id":7,"title":"note"}]'],
    ['invalid JSON', () => '{"schedule": ', () => 'not json'],
    ['a tampered tournament', (state) => {
      state.schedule.rounds[0].matches[0].court = '1 2';
      return JSON.stringify(state);
    }, (state) => JSON.stringify({ tournamentName: 'Tampered', schedule: { players: state.schedule.players } })],
  ];
  for (const [description, legacyState, legacySaved] of UNUSABLE_LEGACY_VALUES) {
    test(`R-STATE-PERSIST: legacy keys holding ${description} are left in place and the app starts fresh`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given unusable values under both legacy keys, and nothing under the prefixed keys.
      const state = await captureARealTournamentState(context);
      const rawState = legacyState(state);
      const rawSaved = legacySaved(state);
      await plantStorageOnce(page, {
        [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: null,
        [LEGACY_STATE_KEY]: rawState, [LEGACY_SAVED_TOURNAMENTS_KEY]: rawSaved,
      });
      // Leaving a page saves its fresh setup under the prefixed state key, which
      // would stop the reload from migrating the legacy state at all: drop it before
      // every load, so the reload attempts both migrations again.
      await plantStorage(page, { [STATE_KEY]: null });

      // When the app loads, and attempts the migration again after a reload.
      await page.goto('/');
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 1) await page.reload();
        // Then it shows a fresh setup with no saved tournaments,
        await expectAFreshSetup(page);
        await expect(page.locator('#savedTournamentSelect option')).toHaveCount(0);
        // and both legacy values are untouched, byte for byte, with nothing migrated.
        expect(await storedRaw(page, LEGACY_STATE_KEY)).toBe(rawState);
        expect(await storedRaw(page, LEGACY_SAVED_TOURNAMENTS_KEY)).toBe(rawSaved);
        expect(await storedRaw(page, STATE_KEY)).toBeNull();
        expect(await storedRaw(page, SAVED_TOURNAMENTS_KEY)).toBeNull();
        expect(await storedRaw(page, STATE_MIGRATED_KEY)).toBeNull();
        expect(await storedRaw(page, SAVED_TOURNAMENTS_MIGRATED_KEY)).toBeNull();
      }
      expect(errors).toEqual([]);
    });
  }

  // A saved tournament holding every field a save writes, exactly as the copy
  // layer rebuilds it: on its own, its migrated copy is lossless.
  function aLosslessLegacySave(name, schedule) {
    return {
      tournamentName: name, schedule, currentRoundIndex: 0, courtNames: [],
      format: 'americano', mexicanoSeed: null, totalPoints: 24, savedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  // The same sound save, alone and next to a foreign entry: only the foreign
  // entry (which the copy skips) decides whether the legacy list is kept.
  for (const [description, withForeignEntry, legacyKept] of [
    ['A legacy saved list of one sound save is migrated and removed', false, false],
    ['A partly usable legacy saved list migrates its usable entries and is kept whole', true, true],
  ]) {
    test(description, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a legacy saved list of one sound (lossless) save, and maybe a foreign entry.
      const { schedule } = await captureALegacyTournamentInProgress(context);
      const sound = aLosslessLegacySave('Sound Save', schedule);
      const rawSaved = JSON.stringify(withForeignEntry ? [sound, { id: 7, title: 'note' }] : [sound]);
      await plantStorageOnce(page, { [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: null, [LEGACY_SAVED_TOURNAMENTS_KEY]: rawSaved });

      // When the app loads.
      await page.goto('/');

      // Then the sound save is migrated, as it was, and offered,
      await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
      await expect(page.locator('#savedTournamentSelect option')).toContainText('Sound Save');
      expect(await storedJson(page, SAVED_TOURNAMENTS_KEY)).toEqual([sound]);
      expect(await storedRaw(page, SAVED_TOURNAMENTS_MIGRATED_KEY)).not.toBeNull();
      // and the legacy list is removed only when nothing in it was left out: one
      // holding data the copy layer rejected is kept as it was.
      expect(await storedRaw(page, LEGACY_SAVED_TOURNAMENTS_KEY)).toBe(legacyKept ? rawSaved : null);
      expect(errors).toEqual([]);
    });
  }

  test('R-STATE-PERSIST: legacy keys are not migrated again once the prefixed keys exist', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given current data under the prefixed keys AND older data under the legacy keys.
    const state = await captureARealTournamentState(context);
    const current = { ...state, tournamentName: 'Current Cup' };
    const old = { ...state, tournamentName: 'Old Cup' };
    const save = (name) => ({ tournamentName: name, schedule: state.schedule, currentRoundIndex: 0, savedAt: '2026-01-01T00:00:00.000Z' });
    const rawOldState = JSON.stringify(old);
    const rawOldSaved = JSON.stringify([save('Old Save')]);
    await plantStorageOnce(page, {
      [STATE_KEY]: JSON.stringify(current), [SAVED_TOURNAMENTS_KEY]: JSON.stringify([save('Current Save')]),
      [LEGACY_STATE_KEY]: rawOldState, [LEGACY_SAVED_TOURNAMENTS_KEY]: rawOldSaved,
    });

    // When the app loads.
    await page.goto('/');

    // Then the prefixed data is what is restored and offered,
    await expect(page.locator('#tournamentTitle')).toHaveText('Current Cup');
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
    await expect(page.locator('#savedTournamentSelect option')).toContainText('Current Save');
    // and the legacy keys are neither copied over nor removed.
    expect((await storedJson(page, STATE_KEY)).tournamentName).toBe('Current Cup');
    expect((await storedJson(page, SAVED_TOURNAMENTS_KEY)).map((t) => t.tournamentName)).toEqual(['Current Save']);
    expect(await storedRaw(page, LEGACY_STATE_KEY)).toBe(rawOldState);
    expect(await storedRaw(page, LEGACY_SAVED_TOURNAMENTS_KEY)).toBe(rawOldSaved);
    expect(errors).toEqual([]);
  });

  test('A legacy saved list is kept when its migrated copy cannot be written', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a sound legacy saved list, and storage that refuses the prefixed list.
    const { schedule } = await captureARealTournamentState(context);
    const rawSaved = JSON.stringify([{ tournamentName: 'Kept Save', schedule, currentRoundIndex: 0 }]);
    await plantStorageOnce(page, { [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: null, [LEGACY_SAVED_TOURNAMENTS_KEY]: rawSaved });
    await page.addInitScript((savedKey) => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === savedKey) throw new DOMException('Storage is full', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
    }, SAVED_TOURNAMENTS_KEY);

    // When the app loads.
    await page.goto('/');

    // Then the app still runs, and the legacy list is left for a later load: no
    // migrated marker is written, so the migration can be tried again.
    await expectAFreshSetup(page);
    expect(await storedRaw(page, SAVED_TOURNAMENTS_KEY)).toBeNull();
    expect(await storedRaw(page, SAVED_TOURNAMENTS_MIGRATED_KEY)).toBeNull();
    expect(await storedRaw(page, LEGACY_SAVED_TOURNAMENTS_KEY)).toBe(rawSaved);
    // And the failed write is reported as an error (not just a warning), and only it.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('console.error: Could not write the migrated copy of a legacy localStorage value');
    expect(errors[0]).toContain(LEGACY_SAVED_TOURNAMENTS_KEY);
  });

  test('R-STATE-PERSIST: a legacy state is kept when its migrated copy cannot be written, and migrates on the next load', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a sound legacy state, and storage that refuses the prefixed state for
    // the first page only (including its save on leaving).
    const state = await captureALegacyTournamentInProgress(context);
    const rawState = JSON.stringify(state);
    await plantStorageOnce(page, { [STATE_KEY]: null, [LEGACY_STATE_KEY]: rawState });
    await page.addInitScript((stateKey) => {
      if (sessionStorage.getItem('storageFullOnce')) return;
      sessionStorage.setItem('storageFullOnce', '1');
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === stateKey) throw new DOMException('Storage is full', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
    }, STATE_KEY);

    // When the app loads.
    await page.goto('/');

    // Then the tournament resumes at round 3 from the copy held in memory, its
    // scores intact and its tournament, player and court names restored, but
    // nothing is stored: the legacy state is left in place, no migrated marker is written,
    await expectTheTournamentInProgress(page, 'Legacy Cup');
    expect(await storedRaw(page, STATE_KEY)).toBeNull();
    expect(await storedRaw(page, STATE_MIGRATED_KEY)).toBeNull();
    expect(await storedRaw(page, LEGACY_STATE_KEY)).toBe(rawState);
    // and the failed write is reported as an error (not just a warning), and only it.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('console.error: Could not write the migrated copy of a legacy localStorage value');
    expect(errors[0]).toContain(LEGACY_STATE_KEY);

    // When it loads again, with storage working.
    await page.reload();

    // Then the migration is tried again: the tournament resumes from it at round
    // 3 with its scores and names, now marked as migrated, with no further error.
    await expectTheTournamentInProgress(page, 'Legacy Cup');
    expect((await storedJson(page, STATE_KEY)).tournamentName).toBe('Legacy Cup');
    expect(await storedRaw(page, STATE_MIGRATED_KEY)).not.toBeNull();
    expect(await storedRaw(page, LEGACY_STATE_KEY)).toBeNull();
    expect(errors).toHaveLength(1);
  });

  test('R-STATE-PERSIST: a legacy state kept after a lossy migration is not migrated again when the stored state is later removed', async ({ page, context }) => {
    const errors = collectErrors(page);
    const dialogs = [];
    // Given a legacy state exactly as the app stored it before its keys were
    // prefixed (right after Start: with the schedule module's own fields, which
    // the copy leaves out, so the legacy value is kept).
    const state = await captureALegacyTournamentInProgress(context);
    state.schedule.playerCount = state.schedule.players.length;
    state.schedule.totalRounds = state.schedule.rounds.length;
    const rawState = JSON.stringify(state);
    await plantStorageOnce(page, { [STATE_KEY]: null, [LEGACY_STATE_KEY]: rawState });

    // When the app loads, it migrates: the tournament resumes, the legacy value
    // is kept and the migration is marked as done.
    await page.goto('/');
    await expect(page.locator('#tournamentTitle')).toHaveText('Legacy Cup');
    expect(await storedRaw(page, LEGACY_STATE_KEY)).toBe(rawState);
    expect(await storedRaw(page, STATE_MIGRATED_KEY)).not.toBeNull();

    // And the Organizer starts a new tournament without saving the old one, then
    // chooses another schedule, which removes the stored state,
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      if (dialog.type() === 'confirm') dialog.dismiss(); else dialog.accept();
    });
    await page.click('#newTournamentBtn');
    await expect(page.locator('.round')).toHaveCount(0);
    await page.selectOption('#scheduleSelect', '16p15r.js');
    expect(await storedRaw(page, STATE_KEY)).toBeNull();
    // and the page is closed without its save on leaving (as a killed tab is).
    await page.close({ runBeforeUnload: false });

    // When the app is opened again.
    const next = await context.newPage();
    const nextErrors = collectErrors(next);
    await next.goto('/');

    // Then it shows a fresh setup, not the old tournament: the kept legacy value
    // is not migrated again.
    await expectAFreshSetup(next);
    expect(await storedRaw(next, STATE_KEY)).toBeNull();
    expect(await storedRaw(next, STATE_MIGRATED_KEY)).not.toBeNull();
    expect(await storedRaw(next, LEGACY_STATE_KEY)).toBe(rawState);
    expect(dialogs).toEqual(['Do you want to save the current tournament before creating a new one?', 'Ready for a new tournament!']);
    expect(errors).toEqual([]);
    expect(nextErrors).toEqual([]);
  });

  // An empty list is nothing to migrate, and may be another page's.
  for (const rawSaved of ['[]', ' [ ] ']) {
    test(`An empty legacy saved list (${JSON.stringify(rawSaved)}) is left in place and nothing is written`, async ({ page }) => {
      const errors = collectErrors(page);
      // Given an empty list under the legacy saved-list key, and nothing under the prefixed one.
      await plantStorageOnce(page, { [SAVED_TOURNAMENTS_KEY]: null, [LEGACY_SAVED_TOURNAMENTS_KEY]: rawSaved });

      // When the app loads.
      await page.goto('/');

      // Then no saved tournament is offered, nothing is written under the
      // prefixed key (nor a migrated marker), and the legacy value is untouched,
      // byte for byte.
      await expect(page.locator('#savedTournamentSelect option')).toHaveCount(0);
      expect(await storedRaw(page, SAVED_TOURNAMENTS_KEY)).toBeNull();
      expect(await storedRaw(page, SAVED_TOURNAMENTS_MIGRATED_KEY)).toBeNull();
      expect(await storedRaw(page, LEGACY_SAVED_TOURNAMENTS_KEY)).toBe(rawSaved);
      expect(errors).toEqual([]);
    });
  }

  // A legacy value the copy layer accepts only by repairing it, dropping part of
  // it, or both, may hold data that is not the app's: it is migrated (the app
  // uses the repaired copy), but the legacy value itself is kept as it was.
  const LEGACY_STATES_NEEDING_REPAIR = [
    ['an out-of-range round index', (s) => { s.currentRoundIndex = 99; }, 'Round 1', ['Centre']],
    ["an extra field (another page's data)", (s) => { s.siblingSecretData = { token: 'keep-me' }; }, 'Round 3', ['Centre']],
    ['an invalid court name entry', (s) => { s.courtNames = [42]; }, 'Round 3', ['']],
    ['17 court names (the copy keeps the first 16)', (s) => {
      s.courtNames = Array.from({ length: 17 }, (_, i) => `Court ${i + 1}`);
    }, 'Round 3', Array.from({ length: 16 }, (_, i) => `Court ${i + 1}`)],
    ["the schedule module's own fields, as stored right after Start", (s) => {
      s.schedule.playerCount = s.schedule.players.length;
      s.schedule.totalRounds = s.schedule.rounds.length;
    }, 'Round 3', ['Centre']],
  ];
  for (const [description, tamper, round, keptCourtNames] of LEGACY_STATES_NEEDING_REPAIR) {
    test(`R-STATE-PERSIST: a legacy state with ${description} is migrated as repaired, and the legacy value is kept`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a legacy tournament state the copy layer must repair.
      const state = await captureALegacyTournamentInProgress(context);
      tamper(state);
      const rawState = JSON.stringify(state);
      await plantStorageOnce(page, { [STATE_KEY]: null, [LEGACY_STATE_KEY]: rawState });

      // When the app loads (and again after a reload).
      await page.goto('/');
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 1) await page.reload();
        // Then the tournament resumes from the repaired copy,
        await expect(page.locator('.round-header .left')).toHaveText(round);
        await expect(page.locator('#tournamentTitle')).toHaveText('Legacy Cup');
        const stored = await storedJson(page, STATE_KEY);
        expect(stored.tournamentName).toBe('Legacy Cup');
        expect(stored).not.toHaveProperty('siblingSecretData');
        expect(stored.schedule).not.toHaveProperty('playerCount');
        // (every row names the court names it keeps; the 17-court row pins the
        // cut: exactly the first 16)
        expect(stored.courtNames).toEqual(keptCourtNames);
        // and the legacy value is kept, byte for byte.
        expect(await storedRaw(page, LEGACY_STATE_KEY)).toBe(rawState);
      }
      expect(errors).toEqual([]);
    });
  }

  // AB#41: every stored string the copy layer keeps without a tighter limit of
  // its own (tournament names, scores, savedAt) is cut to 1000 characters:
  // repaired, not dropped. 10,000 characters whose first 1000 are recognizable.
  const MAX_STORED_STRING_LENGTH = 1000;
  const OVERLONG = '0123456789'.repeat(1000);
  const CUT = OVERLONG.slice(0, MAX_STORED_STRING_LENGTH);

  test('R-STATE-PERSIST: a legacy state with a 10,000-character name is migrated as repaired, the name cut to 1000, and the legacy value is kept', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a legacy tournament state whose name is 10,000 characters.
    const state = await captureALegacyTournamentInProgress(context);
    state.tournamentName = OVERLONG;
    const rawState = JSON.stringify(state);
    await plantStorageOnce(page, { [STATE_KEY]: null, [STATE_MIGRATED_KEY]: null, [LEGACY_STATE_KEY]: rawState });

    // When the app loads (and again after a reload).
    await page.goto('/');
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) await page.reload();
      // Then the tournament resumes from the repaired copy, its name cut,
      await expect(page.locator('.round-header .left')).toHaveText('Round 3');
      expect(await page.locator('#tournamentTitle').textContent()).toBe(CUT);
      expect((await storedJson(page, STATE_KEY)).tournamentName).toBe(CUT);
      // the migration is recorded by its marker,
      expect(await storedRaw(page, STATE_MIGRATED_KEY)).not.toBeNull();
      // and the legacy value is kept, byte for byte.
      expect(await storedRaw(page, LEGACY_STATE_KEY)).toBe(rawState);
    }
    expect(errors).toEqual([]);
  });

  const LEGACY_SAVES_NEEDING_REPAIR = [
    ['an out-of-range round index', (e) => { e.currentRoundIndex = 99; }],
    ["an extra field (another page's data)", (e) => { e.siblingSecretData = { token: 'keep-me' }; }],
    ['no stored format, seed or total (saved before they existed)', (e) => {
      delete e.format; delete e.mexicanoSeed; delete e.totalPoints;
    }],
  ];
  for (const [description, tamper] of LEGACY_SAVES_NEEDING_REPAIR) {
    test(`A legacy saved tournament with ${description} is migrated and offered, and the legacy list is kept`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a legacy saved list whose only entry the copy layer must repair.
      const { schedule } = await captureALegacyTournamentInProgress(context);
      const entry = {
        tournamentName: 'Repaired Save', schedule, currentRoundIndex: 0, courtNames: [],
        format: 'americano', mexicanoSeed: null, totalPoints: 24, savedAt: '2026-01-01T00:00:00.000Z',
      };
      tamper(entry);
      const rawSaved = JSON.stringify([entry]);
      await plantStorageOnce(page, { [SAVED_TOURNAMENTS_KEY]: null, [LEGACY_SAVED_TOURNAMENTS_KEY]: rawSaved });

      // When the app loads.
      await page.goto('/');

      // Then the repaired save is migrated and offered,
      await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
      await expect(page.locator('#savedTournamentSelect option')).toContainText('Repaired Save');
      const stored = await storedJson(page, SAVED_TOURNAMENTS_KEY);
      expect(stored.map((t) => t.tournamentName)).toEqual(['Repaired Save']);
      expect(stored[0]).not.toHaveProperty('siblingSecretData');
      // and the legacy list is kept, byte for byte.
      expect(await storedRaw(page, LEGACY_SAVED_TOURNAMENTS_KEY)).toBe(rawSaved);
      expect(errors).toEqual([]);
    });
  }

  test('R-STATE-PERSIST: hostile values under the prefixed keys are handled as ever, and the legacy keys are left alone', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given unusable values under the prefixed keys, and sound data under the legacy keys.
    const state = await captureALegacyTournamentInProgress(context);
    const rawState = JSON.stringify(state);
    const rawSaved = JSON.stringify([{
      tournamentName: 'Legacy Save', schedule: state.schedule, currentRoundIndex: 0, courtNames: [],
      format: 'americano', mexicanoSeed: null, totalPoints: 24,
    }]);
    await plantStorageOnce(page, {
      [STATE_KEY]: '{"schedule": ', [SAVED_TOURNAMENTS_KEY]: '"hello"',
      [LEGACY_STATE_KEY]: rawState, [LEGACY_SAVED_TOURNAMENTS_KEY]: rawSaved,
    });

    // When the app loads.
    await page.goto('/');

    // Then the prefixed values are treated as they always were: the unusable state
    // gives a fresh setup and is dropped, the unusable list offers nothing,
    await expectAFreshSetup(page);
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(0);
    expect(await storedRaw(page, STATE_KEY)).toBeNull();
    expect(await storedRaw(page, SAVED_TOURNAMENTS_KEY)).toBe('"hello"');
    // and the legacy values are neither migrated nor removed.
    expect(await storedRaw(page, LEGACY_STATE_KEY)).toBe(rawState);
    expect(await storedRaw(page, LEGACY_SAVED_TOURNAMENTS_KEY)).toBe(rawSaved);
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST: legacy keys are migrated before the page finishes loading, before any handler can write', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a tournament and a saved list under the legacy keys only.
    const state = await captureALegacyTournamentInProgress(context);
    const saved = [{
      tournamentName: 'Legacy Save', schedule: state.schedule, currentRoundIndex: 0, courtNames: [],
      format: 'americano', mexicanoSeed: null, totalPoints: 24,
    }];
    await plantStorageOnce(page, {
      [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: null,
      [LEGACY_STATE_KEY]: JSON.stringify(state), [LEGACY_SAVED_TOURNAMENTS_KEY]: JSON.stringify(saved),
    });
    // DOMContentLoaded fires once the app script has run (so its handlers are
    // registered) and always before 'load': record storage at that moment.
    await page.addInitScript((keys) => {
      document.addEventListener('DOMContentLoaded', () => {
        window.storageAtDomContentLoaded = {
          readyState: document.readyState,
          values: keys.map((key) => localStorage.getItem(key)),
        };
      });
    }, [STATE_KEY, SAVED_TOURNAMENTS_KEY, LEGACY_STATE_KEY, LEGACY_SAVED_TOURNAMENTS_KEY]);

    // When the app loads.
    await page.goto('/');

    // Then both keys were already migrated before 'load' fired.
    const snapshot = await page.evaluate(() => window.storageAtDomContentLoaded);
    expect(snapshot.readyState).toBe('interactive');
    const [stateValue, savedValue, legacyState, legacySaved] = snapshot.values;
    expect(JSON.parse(stateValue)).toEqual(state);
    expect(JSON.parse(savedValue)).toEqual(saved);
    expect(legacyState).toBeNull();
    expect(legacySaved).toBeNull();
    await expect(page.locator('#tournamentTitle')).toHaveText('Legacy Cup');
    expect(errors).toEqual([]);
  });

  test('An error migrating the legacy state is logged as an error and does not stop the saved list migrating', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given sound data under both legacy keys, and storage that throws when the
    // legacy state key is removed (after its copy was written).
    const state = await captureALegacyTournamentInProgress(context);
    const rawState = JSON.stringify(state);
    const saved = [{
      tournamentName: 'Legacy Save', schedule: state.schedule, currentRoundIndex: 0, courtNames: [],
      format: 'americano', mexicanoSeed: null, totalPoints: 24,
    }];
    await plantStorageOnce(page, {
      [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: null,
      [LEGACY_STATE_KEY]: rawState, [LEGACY_SAVED_TOURNAMENTS_KEY]: JSON.stringify(saved),
    });
    await page.addInitScript((legacyStateKey) => {
      const removeItem = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key) {
        if (key === legacyStateKey) throw new Error('removeItem refused');
        return removeItem.call(this, key);
      };
    }, LEGACY_STATE_KEY);

    // When the app loads.
    await page.goto('/');

    // Then the legacy state is still in place, the copy written before the failure is used,
    await expect(page.locator('#tournamentTitle')).toHaveText('Legacy Cup');
    expect(await storedRaw(page, LEGACY_STATE_KEY)).toBe(rawState);
    // the saved list was still migrated,
    expect(await storedJson(page, SAVED_TOURNAMENTS_KEY)).toEqual(saved);
    expect(await storedRaw(page, LEGACY_SAVED_TOURNAMENTS_KEY)).toBeNull();
    await expect(page.locator('#savedTournamentSelect option')).toContainText('Legacy Save');
    // and the failure is reported as an error (not just a warning), and only it.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('console.error: Could not migrate a legacy localStorage value');
    expect(errors[0]).toContain(LEGACY_STATE_KEY);
  });

  // --- AB#41: reading stored state is bounded and recoverable ---
  // Overlong stored strings are cut to MAX_STORED_STRING_LENGTH (OVERLONG and
  // CUT: see the legacy migration above). The cut never changes what counts:
  // a score of that length or more is never credited, and an overlong name is
  // trimmed around the cut, so it is never blank unless it was.

  test('R-STATE-PERSIST: a tournament in progress with a 10,000-character name resumes at round 3, the name cut to 1000', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a tournament in progress at round 3 whose stored name is 10,000 characters.
    const state = await captureALegacyTournamentInProgress(context);
    state.tournamentName = OVERLONG;
    await plantStorageOnce(page, { [STATE_KEY]: JSON.stringify(state) });

    // When the returning Organizer reopens the app (and once more).
    await page.goto('/');
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) await page.reload();
      // Then the tournament resumes at round 3 with its scores and names,
      await expect(page.locator('.round-header .left')).toHaveText('Round 3');
      await expect(page.locator('.result-overlay-left input').first()).toHaveValue('15');
      await expect(page.locator('.result-overlay-right input').first()).toHaveValue('9');
      await expect(page.locator('#courtNameInput_1')).toHaveValue('Centre');
      await expect(page.locator('.scoreboard-container')).toContainText('Ada');
      // its name cut to exactly the first 1000 characters, on screen and stored.
      expect(await page.locator('#tournamentTitle').textContent()).toBe(CUT);
      await expect(page.locator('#tournamentName')).toHaveValue(CUT);
      expect((await storedJson(page, STATE_KEY)).tournamentName).toBe(CUT);
    }
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST: 10,000-character stored scores are cut to 1000, the other scores intact', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a tournament in progress at round 3 whose second match there holds
    // a stored result of two 10,000-character strings.
    const state = await captureALegacyTournamentInProgress(context);
    state.schedule.rounds[2].matches[1].result = { left: OVERLONG, right: 'R'.repeat(10000) };
    await plantStorageOnce(page, { [STATE_KEY]: JSON.stringify(state) });

    // When the app loads (and reloads).
    await page.goto('/');
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) await page.reload();
      // Then the tournament resumes at round 3 with its recorded scores intact,
      await expect(page.locator('.round-header .left')).toHaveText('Round 3');
      await expectScoresOnScreen(page, [['15', '9']]);
      const results = (await storedJson(page, STATE_KEY)).schedule.rounds.map((r) => r.matches.map((m) => m.result));
      expect(results[0]).toEqual(Array(3).fill({ left: '14', right: '10' }));
      expect(results[2][0]).toEqual({ left: '15', right: '9' });
      // and the overlong result is kept, each side cut to exactly 1000 characters.
      expect(results[2][1]).toEqual({ left: CUT, right: 'R'.repeat(MAX_STORED_STRING_LENGTH) });
    }
    expect(errors).toEqual([]);
  });

  test('R-TOURNAMENT-STORE: a saved tournament with a 10,000-character name and timestamp is listed and loads, both cut to 1000', async ({ page, context }) => {
    const errors = collectErrors(page);
    collectDialogs(page);
    // Given a saved tournament whose name and savedAt are 10,000 characters,
    // next to a sound one.
    const { schedule } = await captureALegacyTournamentInProgress(context);
    const fields = { schedule, currentRoundIndex: 2, courtNames: ['Centre'], format: 'americano', mexicanoSeed: null, totalPoints: 24 };
    const saved = [
      { tournamentName: OVERLONG, ...fields, savedAt: 'S'.repeat(10000) },
      { tournamentName: 'Other Cup', ...fields, savedAt: '2026-01-01T00:00:00.000Z' },
    ];
    await plantStorage(page, { [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: JSON.stringify(saved) });

    // When the app loads, it is listed under its cut name,
    await page.goto('/');
    const options = page.locator('#savedTournamentSelect option');
    await expect(options).toHaveCount(2);
    expect(await options.first().textContent()).toBe(`${CUT} (Saved: unknown)`);

    // and the Organizer loads it at round 3 with its scores, under that name.
    await page.selectOption('#savedTournamentSelect', '0');
    await page.click('#loadTournamentBtn');
    await expect(page.locator('.round-header .left')).toHaveText('Round 3');
    expect(await page.locator('#tournamentTitle').textContent()).toBe(CUT);
    await expectScoresOnScreen(page, [['15', '9']]);

    // When the other save is deleted, the list is rewritten holding the cut
    // name and timestamp, exactly 1000 characters each.
    await page.selectOption('#savedTournamentSelect', '1');
    await page.click('#loadTournamentBtn');
    await expect(page.locator('#tournamentTitle')).toHaveText('Other Cup');
    await page.click('#deleteTournamentBtn');
    await expect(options).toHaveCount(1);
    const stored = await storedJson(page, SAVED_TOURNAMENTS_KEY);
    expect(stored.map((t) => [t.tournamentName, t.savedAt])).toEqual([[CUT, 'S'.repeat(MAX_STORED_STRING_LENGTH)]]);
    expect(errors).toEqual([]);
  });

  // A stored score that is cut, or is as long as the cut, is never credited:
  // cutting "0...0120" (1001 characters, an invalid 120) would otherwise leave
  // "0...012", a valid 12. One character shorter, a zero-padded score is a score.
  const ZEROS = (n) => '0'.repeat(n);
  const PADDED_SCORES = [
    // description, stored left side (right: '12'), credited, error, stored back
    ['an invalid score whose cut looks valid', ZEROS(998) + '120', false, 'whole number from 0 to 24', ZEROS(998) + '12'],
    ['a score of exactly 1000 characters', ZEROS(998) + '12', false, 'whole number from 0 to 24', ZEROS(998) + '12'],
    // The cut lands inside the emoji's surrogate pair: a score is cut there all
    // the same, so it keeps exactly 1000 characters (a number input shows none).
    ['a score whose cut splits an emoji', ZEROS(997) + '12\u{1F600}x', false, 'Please fill in both scores', null],
    ['a zero-padded score of 999 characters', ZEROS(997) + '12', true, '', ZEROS(997) + '12'],
  ];
  for (const [description, left, credited, message, storedBack] of PADDED_SCORES) {
    test(`R-STATE-PERSIST, R-SCORE-ENTRY: a stored result with ${description} is ${credited ? '' : 'not '}credited`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a started tournament whose first match holds that left score and a
      // right score of 12, and whose second match holds a sound 15 / 9.
      const state = await captureARealTournamentState(context);
      plantResults(state.schedule, [{ left, right: '12' }, { left: '15', right: '9' }]);
      await plantStorageOnce(page, { [STATE_KEY]: JSON.stringify(state) });

      // When the app loads (and reloads, saving on the way out),
      await page.goto('/');
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 1) await page.reload();
        await expect(page.locator('.round-header .left')).toHaveText('Round 1');
        // Then the first match is credited only when its score is one,
        await expectErrorsOnScreen(page, [message, '', '']);
        expect(await scoreboardPointsSorted(page)).toEqual(credited
          ? [15, 15, 12, 12, 12, 12, 9, 9].concat(Array(4).fill(0))
          : [15, 15, 9, 9].concat(Array(8).fill(0)));
        // and it is stored back cut to exactly 1000 characters, or as it was.
        const [stored] = await storedResults(page);
        if (storedBack === null) {
          // A lone surrogate is compared in the page, where it is not re-encoded.
          expect(await page.evaluate(({ key, expected }) => {
            const side = JSON.parse(localStorage.getItem(key)).schedule.rounds[0].matches[0].result.left;
            return side === expected;
          }, { key: STATE_KEY, expected: left.slice(0, MAX_STORED_STRING_LENGTH) })).toBe(true);
          expect(stored.right).toBe('12');
        } else {
          expect(stored).toEqual({ left: storedBack, right: '12' });
        }
      }

      // And the match can be scored again.
      const first = page.locator('.result-overlay-container').first();
      await first.locator('.result-overlay-left input').fill('3');
      await expect(first.locator('.result-overlay-right input')).toHaveValue('21');
      await expect(first.locator('.error-message')).toHaveText('');
      expect((await storedResults(page))[0]).toEqual({ left: '3', right: '21' });
      expect(errors).toEqual([]);
    });
  }

  test('R-MEXICANO-ROUNDS, R-STATE-PERSIST: a stored score cut to look valid does not complete a Mexicano round', async ({ page, context }) => {
    const errors = collectErrors(page);
    collectDialogs(page);
    // Given a running Mexicano tournament whose current round 2 holds, on its
    // first court, a 1001-character invalid score that cut reads as 12 / 12, and
    // on its second a sound 15 / 9.
    const state = await captureARealMexicanoState(context);
    state.schedule.rounds[1].matches[0].result = { left: ZEROS(998) + '120', right: '12' };
    state.schedule.rounds[1].matches[1].result = { left: '15', right: '9' };
    await plantStorage(page, { [STATE_KEY]: JSON.stringify(state) });

    // When the app loads,
    await page.goto('/');

    // Then round 2 is not complete: the next round is not offered,
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    await expectErrorsOnScreen(page, ['whole number from 0 to 24', '']);
    await expect(page.locator('#generateNextRoundBtn')).toHaveAttribute('aria-disabled', 'true');
    await page.locator('#generateNextRoundBtn').click({ force: true });
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    await expect(page.getByRole('button', { name: 'NEXT ROUND', exact: true })).toHaveCount(0);
    // until the Organizer enters a real score on that court.
    await page.locator('.result-overlay-left input').first().fill('12');
    await expect(page.locator('#generateNextRoundBtn')).toHaveAttribute('aria-disabled', 'false');
    await expect(page.locator('#generateNextRoundBtn')).not.toHaveAttribute('disabled');
    expect(errors).toEqual([]);
  });

  // A name is cut without splitting a character outside the Basic Multilingual
  // Plane (an emoji is a surrogate pair): with the pair across the cut, the
  // emoji is left out whole; with it inside, it is kept.
  for (const [description, name, expected] of [
    ['an emoji across the cut', 'T'.repeat(999) + '\u{1F600}' + 'x'.repeat(100), 'T'.repeat(999)],
    ['an emoji just inside the cut', 'T'.repeat(998) + '\u{1F600}' + 'x'.repeat(100), 'T'.repeat(998) + '\u{1F600}'],
  ]) {
    test(`R-STATE-PERSIST: an overlong tournament name with ${description} is cut without splitting it`, async ({ page, context }) => {
      const errors = collectErrors(page);
      const state = await captureALegacyTournamentInProgress(context);
      state.tournamentName = name;
      await plantStorageOnce(page, { [STATE_KEY]: JSON.stringify(state) });

      await page.goto('/');

      await expect(page.locator('.round-header .left')).toHaveText('Round 3');
      expect(await page.locator('#tournamentTitle').textContent()).toBe(expected);
      expect((await storedJson(page, STATE_KEY)).tournamentName).toBe(expected);
      expect(errors).toEqual([]);
    });
  }

  test('R-TOURNAMENT-STORE: overlong saved names padded with whitespace are kept, trimmed around the cut, and can be saved over and deleted', async ({ page, context }) => {
    const errors = collectErrors(page);
    collectDialogs(page);
    // Given two saved tournaments with overlong names: 1000 spaces then "Cup"
    // (blank once cut, were it not trimmed first), and one whose cut ends in spaces.
    const { schedule } = await captureALegacyTournamentInProgress(context);
    const fields = { schedule, currentRoundIndex: 2, courtNames: [], format: 'americano', mexicanoSeed: null, totalPoints: 24, savedAt: '2026-01-01T00:00:00.000Z' };
    const spacedOut = ' '.repeat(1000) + 'Cup';
    const endsInSpaces = 'Y'.repeat(997) + ' '.repeat(5) + 'Z'.repeat(10);
    await plantStorage(page, {
      [STATE_KEY]: null,
      [SAVED_TOURNAMENTS_KEY]: JSON.stringify([{ tournamentName: spacedOut, ...fields }, { tournamentName: endsInSpaces, ...fields }]),
    });

    // When the app loads, both are listed under their trimmed, cut names.
    await page.goto('/');
    const options = page.locator('#savedTournamentSelect option');
    await expect(options).toHaveCount(2);
    // (The saved date that follows is locale-formatted.)
    const listed = await options.allTextContents();
    expect(listed[0].startsWith('Cup (Saved: ')).toBe(true);
    expect(listed[1].startsWith(`${'Y'.repeat(997)} (Saved: `)).toBe(true);

    // The second loads under its name, and saving it replaces it in place,
    await page.selectOption('#savedTournamentSelect', '1');
    await page.click('#loadTournamentBtn');
    expect(await page.locator('#tournamentTitle').textContent()).toBe('Y'.repeat(997));
    await page.click('#saveTournamentBtn');
    await expect(options).toHaveCount(2);
    // and the first can be loaded and deleted.
    await page.selectOption('#savedTournamentSelect', '0');
    await page.click('#loadTournamentBtn');
    await expect(page.locator('#tournamentTitle')).toHaveText('Cup');
    await page.click('#deleteTournamentBtn');
    await expect(options).toHaveCount(1);
    expect((await storedJson(page, SAVED_TOURNAMENTS_KEY)).map((t) => t.tournamentName)).toEqual(['Y'.repeat(997)]);
    expect(errors).toEqual([]);
  });

  // The stored state the app drops because it is unusable, or fails to restore,
  // is first copied, raw, to STATE_BACKUP_KEY (one generation; nothing over the
  // backup limit, see below). Planted as
  // indented JSON, which the app itself never writes, so a raw copy is told
  // apart from a re-serialized one.
  const PREVIOUS_BACKUP = 'an older backup';

  test('R-STATE-PERSIST: an unusable stored state falls back to a fresh setup, its raw value kept as the one backup', async ({ page }) => {
    const errors = collectErrors(page);
    // Given an unusable stored state, and a backup from earlier.
    const raw = '{\n  "schedule": "P1",\n  "tournamentStarted": true\n}';
    await plantStorageOnce(page, { [STATE_KEY]: raw, [STATE_BACKUP_KEY]: PREVIOUS_BACKUP });

    // When the app loads.
    await page.goto('/');

    // Then the tournament setup is presented,
    await expectAFreshSetup(page);
    // the unusable value is dropped,
    expect(await storedRaw(page, STATE_KEY)).toBeNull();
    // and the backup holds it byte-for-byte, in place of the older one.
    expect(await storedRaw(page, STATE_BACKUP_KEY)).toBe(raw);
    await expectATournamentCanStart(page, 'Recovered Cup');
    expect(errors).toEqual([]);
  });

  // A fault the validation cannot catch: showing this name throws, as a bug in
  // restoring would. Only the restore ever shows it, so the fresh setup works.
  async function failToShowName(page, name) {
    await page.addInitScript((poison) => {
      const textContent = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
      Object.defineProperty(Node.prototype, 'textContent', {
        ...textContent,
        set(value) {
          if (value === poison) throw new Error('could not show the name');
          textContent.set.call(this, value);
        },
      });
    }, name);
  }

  test('R-STATE-PERSIST: a stored tournament whose restore throws falls back to a fresh setup, its raw value kept as the backup', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a sound tournament in progress whose restore throws.
    const state = await captureALegacyTournamentInProgress(context);
    state.tournamentName = 'Crash Cup';
    const raw = JSON.stringify(state, null, 2);
    await failToShowName(page, 'Crash Cup');
    await plantStorageOnce(page, { [STATE_KEY]: raw, [STATE_BACKUP_KEY]: PREVIOUS_BACKUP });

    // When the app loads.
    await page.goto('/');

    // Then the tournament setup is presented,
    await expectAFreshSetup(page);
    expect((await storedJson(page, STATE_KEY)).tournamentStarted).toBe(false);
    // the tournament is not lost: the backup holds its stored value byte-for-byte,
    expect(await storedRaw(page, STATE_BACKUP_KEY)).toBe(raw);
    // and the rescue is logged as the one error.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('console.error: Could not restore the saved tournament');
  });

  // Migration safety, not a Requirement's scenario: untagged.
  test('A legacy tournament not yet migrated whose restore throws is left unmigrated, tried again later, and the earlier backup is kept', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a tournament in progress under the legacy key only, whose restore
    // throws, an earlier backup, and storage that refuses the first write of the
    // tournament state (the migrated copy), so the migration is pending.
    const state = await captureALegacyTournamentInProgress(context);
    state.tournamentName = 'Crash Cup';
    const rawState = JSON.stringify(state);
    await failToShowName(page, 'Crash Cup');
    await plantStorageOnce(page, {
      [STATE_KEY]: null, [STATE_MIGRATED_KEY]: null, [LEGACY_STATE_KEY]: rawState, [STATE_BACKUP_KEY]: PREVIOUS_BACKUP,
    });
    await page.addInitScript((stateKey) => {
      let stateWrites = 0;
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === stateKey && stateWrites++ === 0) throw new DOMException('Storage is full', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
    }, STATE_KEY);

    // When the app loads, restoring the tournament from its copy, which throws,
    await page.goto('/');

    // then the tournament setup is presented and stored, but the legacy value is
    // not marked as migrated,
    await expectAFreshSetup(page);
    expect((await storedJson(page, STATE_KEY)).tournamentStarted).toBe(false);
    expect(await storedRaw(page, STATE_MIGRATED_KEY)).toBeNull();
    // the tournament is not lost: its legacy value is kept byte for byte, and the
    // earlier backup is not overwritten (the copy was never stored data),
    expect(await storedRaw(page, LEGACY_STATE_KEY)).toBe(rawState);
    expect(await storedRaw(page, STATE_BACKUP_KEY)).toBe(PREVIOUS_BACKUP);
    // and the refused migration write and the rescue are the errors logged.
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('console.error: Could not write the migrated copy of a legacy localStorage value');
    expect(errors[1]).toContain('console.error: Could not restore the saved tournament');

    // When the stored state is removed (choosing another schedule) and the page is
    // closed without its save on leaving,
    await page.selectOption('#scheduleSelect', '16p15r.js');
    expect(await storedRaw(page, STATE_KEY)).toBeNull();
    await page.close({ runBeforeUnload: false });

    // then the next load tries the migration again: with nothing in the way of the
    // restore now, the tournament resumes at round 3 with its scores and names.
    const next = await context.newPage();
    const nextErrors = collectErrors(next);
    await next.goto('/');
    await expectTheTournamentInProgress(next, 'Crash Cup');
    expect(await storedRaw(next, STATE_MIGRATED_KEY)).not.toBeNull();
    expect(nextErrors).toEqual([]);
  });

  // Untagged: a fallback detail, not a Requirement's scenario.
  test('A stored tournament whose restore throws after its schedule is shown falls back to the default schedule', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a sound 16-player tournament in progress whose restore throws late:
    // after the schedule select shows its schedule, while its round is drawn.
    const state = await captureARealTournamentState(context, { schedule: '16p15r.js' });
    await failToShowName(page, 'Round 1');
    await plantStorageOnce(page, { [STATE_KEY]: JSON.stringify(state), [LEGACY_STATE_KEY]: null });

    // When the app loads,
    await page.goto('/');

    // then the fresh setup is the default one: 12 players, the default schedule
    // selected, not the restored tournament's.
    await expectAFreshSetup(page);
    await expect(page.locator('#scheduleSelect')).toHaveValue('12p11r.js');
    expect((await storedJson(page, STATE_KEY)).schedule.players).toHaveLength(12);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('console.error: Could not restore the saved tournament');
  });

  for (const [description, crash] of [['is unusable', false], ['cannot be restored', true]]) {
    test(`R-STATE-PERSIST: when a stored state that ${description} cannot be backed up, the fresh setup still follows`, async ({ page, context }) => {
      const errors = collectErrors(page);
      const warnings = [];
      page.on('console', (message) => { if (message.type() === 'warning') warnings.push(message.text()); });
      // Given a stored state to fall back from, and storage that refuses the backup.
      let raw = '{"schedule": ';
      if (crash) {
        const state = await captureALegacyTournamentInProgress(context);
        state.tournamentName = 'Crash Cup';
        raw = JSON.stringify(state);
        await failToShowName(page, 'Crash Cup');
      }
      await plantStorageOnce(page, { [STATE_KEY]: raw });
      await page.addInitScript((backupKey) => {
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === backupKey) throw new Error('setItem refused');
          return setItem.call(this, key, value);
        };
      }, STATE_BACKUP_KEY);

      // When the app loads.
      await page.goto('/');

      // Then the tournament setup is presented and works,
      await expectAFreshSetup(page);
      await expectATournamentCanStart(page, 'Recovered Cup');
      // with no backup, the failed write logged as a warning,
      expect(await storedRaw(page, STATE_BACKUP_KEY)).toBeNull();
      expect(warnings.some((w) => w.includes('Could not back up the stored tournament state'))).toBe(true);
      // and nothing logged as an error but a restore that threw.
      expect(errors.map((e) => e.includes('Could not restore the saved tournament'))).toEqual(crash ? [true] : []);
    });
  }

  test('R-STATE-PERSIST: a fresh visit, New Tournament and choosing another schedule back nothing up', async ({ page }) => {
    const errors = collectErrors(page);
    collectDialogs(page);
    // Given no tournament state exists in the browser.
    await plantStorageOnce(page, { [STATE_KEY]: null, [STATE_BACKUP_KEY]: null });

    // When the Organizer opens the app, the tournament setup is presented and nothing is backed up.
    await page.goto('/');
    await expectAFreshSetup(page);
    expect(await storedRaw(page, STATE_BACKUP_KEY)).toBeNull();

    // Nor when the Organizer resets on purpose: New Tournament on a running one,
    await expectATournamentCanStart(page, 'Reset Cup');
    await page.click('#newTournamentBtn');
    await expectAFreshSetup(page);
    // or choosing another schedule.
    await page.selectOption('#scheduleSelect', '16p15r.js');
    await expect(page.locator('[id^="playerInput_"]')).toHaveCount(16);
    expect(await storedRaw(page, STATE_BACKUP_KEY)).toBeNull();
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST: a fresh visit whose initial view throws falls back to a fresh setup and keeps the earlier backup', async ({ page }) => {
    const errors = collectErrors(page);
    // Given no tournament state, a backup from earlier, and a fault that makes
    // the first page lookup after load throw, once: the initial view fails.
    await plantStorageOnce(page, { [STATE_KEY]: null, [STATE_BACKUP_KEY]: PREVIOUS_BACKUP });
    await page.addInitScript(() => {
      let armed = false;
      window.addEventListener('load', () => { armed = true; }); // before the app's own handler
      const getElementById = Document.prototype.getElementById;
      Document.prototype.getElementById = function (id) {
        if (armed) {
          armed = false;
          throw new Error('the initial view failed');
        }
        return getElementById.call(this, id);
      };
    });

    // When the app loads.
    await page.goto('/');

    // Then the tournament setup is presented,
    await expectAFreshSetup(page);
    // nothing stored is no backup: the earlier one is kept,
    expect(await storedRaw(page, STATE_BACKUP_KEY)).toBe(PREVIOUS_BACKUP);
    // and the rescue is logged as the one error.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('console.error: Could not restore the saved tournament');
  });

  test('R-STATE-PERSIST: an empty stored state falls back to a fresh setup and keeps the earlier backup', async ({ page }) => {
    const errors = collectErrors(page);
    // Given a stored state that is an empty string, and a backup from earlier.
    await plantStorageOnce(page, { [STATE_KEY]: '', [STATE_BACKUP_KEY]: PREVIOUS_BACKUP });

    // When the app loads.
    await page.goto('/');

    // Then the tournament setup is presented and the empty value is dropped,
    await expectAFreshSetup(page);
    expect(await storedRaw(page, STATE_KEY)).toBeNull();
    // and, an empty value holding nothing to recover, the earlier backup is kept.
    expect(await storedRaw(page, STATE_BACKUP_KEY)).toBe(PREVIOUS_BACKUP);
    await expectATournamentCanStart(page, 'Recovered Cup');
    expect(errors).toEqual([]);
  });

  // A stored state longer than the backup limit is dropped without a backup;
  // one of exactly that length is still backed up. MAX_BACKUP_LENGTH in the app.
  const MAX_BACKUP_LENGTH = 1000000;
  for (const [description, length, backedUp] of [
    ['exactly at the backup limit is backed up', MAX_BACKUP_LENGTH, true],
    ['over the backup limit is dropped without a backup', MAX_BACKUP_LENGTH + 1, false],
  ]) {
    test(`R-STATE-PERSIST: an unusable stored state ${description}`, async ({ page }) => {
      const errors = collectErrors(page);
      const warnings = [];
      page.on('console', (message) => { if (message.type() === 'warning') warnings.push(message.text()); });
      // Given an unusable stored state of that length (unparsable), built in
      // the page, and a backup from earlier.
      await page.addInitScript(({ stateKey, backupKey, size, previous }) => {
        if (sessionStorage.getItem('planted')) return;
        sessionStorage.setItem('planted', '1');
        localStorage.setItem(stateKey, '[' + 'x'.repeat(size - 1));
        localStorage.setItem(backupKey, previous);
      }, { stateKey: STATE_KEY, backupKey: STATE_BACKUP_KEY, size: length, previous: PREVIOUS_BACKUP });

      // When the app loads.
      await page.goto('/');

      // Then the tournament setup is presented and the unusable value is dropped,
      await expectAFreshSetup(page);
      expect(await storedRaw(page, STATE_KEY)).toBeNull();
      const backup = await page.evaluate(({ backupKey, size }) => {
        const value = localStorage.getItem(backupKey);
        return value === '[' + 'x'.repeat(size - 1) ? 'the dropped value' : value;
      }, { backupKey: STATE_BACKUP_KEY, size: length });
      const capWarnings = warnings.filter((w) => w.includes('Not backing up a stored tournament state longer than 1000000 characters'));
      if (backedUp) {
        // backed up in place of the older one,
        expect(backup).toBe('the dropped value');
        expect(capWarnings).toEqual([]);
      } else {
        // or, over the limit, not backed up (the older backup is kept), with a warning.
        expect(backup).toBe(PREVIOUS_BACKUP);
        expect(capWarnings).toHaveLength(1);
      }
      expect(errors).toEqual([]);
    });
  }

  test('R-STATE-PERSIST: storage that cannot read or remove the stored state still opens a fresh setup and lists the saved tournaments', async ({ page, context }) => {
    const errors = collectErrors(page);
    const warnings = [];
    page.on('console', (message) => { if (message.type() === 'warning') warnings.push(message.text()); });
    collectDialogs(page);
    // Given a stored tournament and a saved one, in storage that refuses to
    // read or remove the stored state (as blocked site data does).
    const state = await captureALegacyTournamentInProgress(context);
    const entry = { tournamentName: 'Kept Cup', schedule: state.schedule, currentRoundIndex: 2, courtNames: [], format: 'americano', mexicanoSeed: null, totalPoints: 24, savedAt: '2026-01-01T00:00:00.000Z' };
    await plantStorageOnce(page, { [STATE_KEY]: JSON.stringify(state), [SAVED_TOURNAMENTS_KEY]: JSON.stringify([entry]) });
    await page.addInitScript((stateKey) => {
      for (const method of ['getItem', 'removeItem']) {
        const original = Storage.prototype[method];
        Storage.prototype[method] = function (key, ...rest) {
          if (key === stateKey) throw new DOMException(`${method} refused`, 'SecurityError');
          return original.call(this, key, ...rest);
        };
      }
    }, STATE_KEY);

    // When the app loads.
    await page.goto('/');

    // Then the tournament setup is presented,
    await expectAFreshSetup(page);
    // the saved tournament is listed and loads,
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
    await expect(page.locator('#savedTournamentSelect option')).toContainText('Kept Cup');
    await page.click('#loadTournamentBtn');
    await expect(page.locator('#tournamentTitle')).toHaveText('Kept Cup');
    await expect(page.locator('.round-header .left')).toHaveText('Round 3');
    // and exactly this is logged: the failed read and removal as warnings, and as
    // the one error the legacy migration, which cannot check the stored state's key.
    expect(warnings).toEqual([
      expect.stringContaining('Could not read the stored tournament state:'),
      expect.stringContaining('Could not remove localStorage value:'),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('console.error: Could not migrate a legacy localStorage value');
    expect(errors[0]).toContain(LEGACY_STATE_KEY);
  });

  // --- AB#88: nothing takes effect before the initial restore ---
  // The app restores the stored state on 'load', which waits for the site's
  // sub-resources (background, court styles and names). Until then what is in
  // memory is the not-yet-restored default, so nothing the Organizer or the
  // browser triggers meanwhile may write it over the stored tournament, and no
  // control may take effect. The setup choices below are dispatched by script
  // (Playwright's selectOption included), which the controls being inert does
  // not stop: the app's own guard must.

  // Hold back the page's 'load' event: the site's court-names script, which the
  // app inserts on DOMContentLoaded, is not answered until the returned release
  // is called. The app script has then run and registered its handlers, but the
  // load handler (the initial restore) has not. Only the first request is held.
  async function holdBackLoad(page) {
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    let held = false;
    await page.route('**/sites/default/courts.js', async (route) => {
      if (held) return route.continue();
      held = true;
      await released;
      // The page may have navigated away meanwhile, which cancels the request.
      await route.continue().catch(() => {});
    });
    return release;
  }

  // The tournament of captureALegacyTournamentInProgress, as the app shows it
  // once restored: at round 3, its scores intact, its names restored.
  async function expectTheTournamentInProgress(page, name) {
    await expect(page.locator('.round-header .left')).toHaveText('Round 3');
    await expect(page.locator('#tournamentTitle')).toHaveText(name);
    await expect(page.locator('.result-overlay-left input').first()).toHaveValue('15');
    await expect(page.locator('.result-overlay-right input').first()).toHaveValue('9');
    await expect(page.locator('#courtNameInput_1')).toHaveValue('Centre');
    await expect(page.locator('.scoreboard-container')).toContainText('Ada');
  }

  // Everything that can write the state from the moment the app script has run:
  // leaving the page, and the setup choices whose handlers save or remove it
  // right away. The player count select is hidden in an Americano setup, so its
  // change is dispatched; leaving is the event the browser fires (see the reload
  // test below).
  const EARLY_WRITES = [
    ['the page is left', (page) => page.evaluate(() => window.dispatchEvent(new Event('beforeunload')))],
    ['the format is changed', (page) => page.selectOption('#formatSelect', 'mexicano')],
    ['the player count is changed', (page) => page.evaluate(() => {
      const select = document.getElementById('playerCountSelect');
      select.value = '16';
      select.dispatchEvent(new Event('change'));
    })],
    // With no schedule in memory yet, this saved a state with no schedule, which
    // the restore then dropped as unusable, backing it up over the real backup.
    ['the points total is changed', (page) => page.selectOption('#globalTotalPoints', '32')],
    // Choosing a schedule removes the stored state (a new setup is not saved until its next change).
    ['another schedule is chosen', (page) => page.selectOption('#scheduleSelect', '16p15r.js')],
  ];
  for (const [description, write] of EARLY_WRITES) {
    test(`R-STATE-PERSIST: a stored tournament is restored when ${description} before the app has finished opening`, async ({ page, context }) => {
      const errors = collectErrors(page);
      // Given a tournament in progress at round 3 is stored, with an earlier backup.
      const state = await captureALegacyTournamentInProgress(context);
      state.tournamentName = 'Stored Cup';
      const rawState = JSON.stringify(state);
      await plantStorageOnce(page, {
        [STATE_KEY]: rawState, [STATE_BACKUP_KEY]: 'an earlier backup', [LEGACY_STATE_KEY]: null,
      });
      const release = await holdBackLoad(page);

      // When the app script has run but the tournament is not yet restored,
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      expect(await page.evaluate(() => document.readyState)).toBe('interactive');
      // and the state would be written,
      await write(page);

      // then nothing was written over the stored tournament (still before 'load'),
      expect(await page.evaluate(() => document.readyState)).toBe('interactive');
      expect(await storedRaw(page, STATE_KEY)).toBe(rawState);

      // and once the app has opened, the tournament resumes at round 3 with its
      // scores and names, as it does when the Organizer reopens the app.
      release();
      await page.waitForLoadState('load');
      await expectTheTournamentInProgress(page, 'Stored Cup');
      await page.reload();
      await expectTheTournamentInProgress(page, 'Stored Cup');
      // Nothing was dropped as unusable either: the earlier backup is untouched.
      expect(await storedRaw(page, STATE_BACKUP_KEY)).toBe('an earlier backup');
      expect(errors).toEqual([]);
    });
  }

  test('R-STATE-PERSIST: a stored tournament is restored when the Organizer reloads before the app has finished opening', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a tournament in progress at round 3 is stored, with an earlier backup.
    const state = await captureALegacyTournamentInProgress(context);
    state.tournamentName = 'Stored Cup';
    await plantStorageOnce(page, {
      [STATE_KEY]: JSON.stringify(state), [STATE_BACKUP_KEY]: 'an earlier backup', [LEGACY_STATE_KEY]: null,
    });
    const release = await holdBackLoad(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(await page.evaluate(() => document.readyState)).toBe('interactive');

    // When the Organizer reloads the app before it has finished opening (leaving
    // the page, which saves on leaving),
    await page.reload();
    release();

    // Then the reopened app restores the stored tournament,
    await expectTheTournamentInProgress(page, 'Stored Cup');
    // and nothing was dropped as unusable: the earlier backup is untouched.
    expect(await storedRaw(page, STATE_BACKUP_KEY)).toBe('an earlier backup');
    expect(errors).toEqual([]);
  });

  // The elements that hold every control of the app.
  const CONTROL_REGIONS = ['#settingsContainer', '#toggleSettingsBtn', '#tournamentContainer'];
  const isInert = (page, selector) => page.locator(selector).evaluate((el) => el.inert);

  test('R-STATE-PERSIST: a tournament set up and started before the app has finished opening takes no effect, and the app opens a fresh setup', async ({ page }) => {
    const errors = collectErrors(page);
    const dialogs = collectDialogs(page);
    // Given nothing is stored, and the app has run its script but not yet opened,
    await plantStorageOnce(page, {
      [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: null, [LEGACY_STATE_KEY]: null, [LEGACY_SAVED_TOURNAMENTS_KEY]: null,
    });
    const release = await holdBackLoad(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(await page.evaluate(() => document.readyState)).toBe('interactive');

    // when a Mexicano tournament is set up, named and started by script (which
    // inert does not stop),
    await page.evaluate(() => {
      const format = document.getElementById('formatSelect');
      format.value = 'mexicano';
      format.dispatchEvent(new Event('change', { bubbles: true }));
      const name = document.getElementById('tournamentName');
      name.value = 'Early Cup';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('startTournamentBtn').click();
    });

    // then none of it took effect (still before 'load'): no round, no title, no
    // player inputs, nothing stored,
    expect(await page.evaluate(() => document.readyState)).toBe('interactive');
    await expect(page.locator('.round')).toHaveCount(0);
    await expect(page.locator('#tournamentTitle')).toHaveText('Tournament Title');
    await expect(page.locator('[id^="playerInput_"]')).toHaveCount(0);
    expect(await storedRaw(page, STATE_KEY)).toBeNull();
    // and every control is inert while the app opens, so a click on Start by the
    // Organizer (a real click, forced past Playwright's checks) does nothing either.
    for (const selector of CONTROL_REGIONS) expect(await isInert(page, selector)).toBe(true);
    await page.click('#startTournamentBtn', { force: true });
    await expect(page.locator('.round')).toHaveCount(0);
    expect(await storedRaw(page, STATE_KEY)).toBeNull();

    // And once open, the app shows a fresh Americano setup with nothing of it
    // half-applied (not the name typed into the field either),
    release();
    await page.waitForLoadState('load');
    await expectAFreshSetup(page);
    await expect(page.locator('#formatSelect')).toHaveValue('americano');
    await expect(page.locator('#scheduleSelect')).toHaveValue('12p11r.js');
    await expect(page.locator('#tournamentName')).toHaveValue('');
    expect(await storedRaw(page, STATE_KEY)).toBeNull();
    // whose controls work.
    for (const selector of CONTROL_REGIONS) expect(await isInert(page, selector)).toBe(false);
    await expectATournamentCanStart(page, 'Real Cup');
    expect(dialogs).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST: a Delete clicked before the app has finished opening takes no effect, so the stored tournament and its save are kept', async ({ page, context }) => {
    const errors = collectErrors(page);
    const dialogs = collectDialogs(page);
    // Given a tournament in progress at round 3 is stored, and saved under its name,
    const state = await captureALegacyTournamentInProgress(context);
    state.tournamentName = 'Stored Cup';
    const rawSaved = JSON.stringify([aLosslessLegacySave('Stored Cup', state.schedule)]);
    await plantStorageOnce(page, {
      [STATE_KEY]: JSON.stringify(state), [SAVED_TOURNAMENTS_KEY]: rawSaved,
      [LEGACY_STATE_KEY]: null, [LEGACY_SAVED_TOURNAMENTS_KEY]: null,
    });
    const release = await holdBackLoad(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // when its name is entered and Delete Tournament is clicked before the app has
    // finished opening, by script and by the Organizer,
    await page.evaluate(() => {
      document.getElementById('tournamentName').value = 'Stored Cup';
      document.getElementById('deleteTournamentBtn').click();
    });
    await page.click('#deleteTournamentBtn', { force: true });

    // then nothing was asked or deleted (still before 'load'),
    expect(await page.evaluate(() => document.readyState)).toBe('interactive');
    expect(dialogs).toEqual([]);
    expect(await storedRaw(page, SAVED_TOURNAMENTS_KEY)).toBe(rawSaved);

    // and once open, the tournament resumes at round 3 with its scores and names,
    // and its save is still offered.
    release();
    await page.waitForLoadState('load');
    await expectTheTournamentInProgress(page, 'Stored Cup');
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
    await expect(page.locator('#savedTournamentSelect option')).toContainText('Stored Cup');
    expect(await storedRaw(page, SAVED_TOURNAMENTS_KEY)).toBe(rawSaved);
    expect(dialogs).toEqual([]);
    expect(errors).toEqual([]);
  });

  // Storage that refuses writes of one key, as when it is full, from the first
  // page of the tab until the test sets window.refuseWrites to false.
  async function refuseWritesOfOnFirstPage(page, refusedKey) {
    await page.addInitScript((key) => {
      window.refuseWrites = !sessionStorage.getItem('writesRefused');
      sessionStorage.setItem('writesRefused', '1');
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, value) {
        if (k === key && window.refuseWrites) throw new DOMException('Storage is full', 'QuotaExceededError');
        return setItem.call(this, k, value);
      };
    }, refusedKey);
  }
  const allowWrites = (page) => page.evaluate(() => { window.refuseWrites = false; });

  test('R-STATE-PERSIST: a legacy tournament whose migrated copy cannot be written still resumes, and the next save that works migrates it', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a tournament in progress at round 3 under the legacy key only, and
    // storage that refuses the tournament state.
    const state = await captureALegacyTournamentInProgress(context);
    const rawState = JSON.stringify(state);
    await plantStorageOnce(page, { [STATE_KEY]: null, [STATE_MIGRATED_KEY]: null, [LEGACY_STATE_KEY]: rawState });
    await refuseWritesOfOnFirstPage(page, STATE_KEY);

    // When the returning Organizer opens the app,
    await page.goto('/');

    // Then the tournament resumes at round 3 with its scores and names, although
    // nothing could be stored (the Organizer is warned): the legacy value is kept
    // and the migration is not marked as done.
    await expectTheTournamentInProgress(page, 'Legacy Cup');
    await expect(page.locator('#autoSaveWarning')).not.toHaveText('');
    expect(await storedRaw(page, STATE_KEY)).toBeNull();
    expect(await storedRaw(page, STATE_MIGRATED_KEY)).toBeNull();
    expect(await storedRaw(page, LEGACY_STATE_KEY)).toBe(rawState);

    // When storage works again and the Organizer enters a score,
    await allowWrites(page);
    await page.locator('.result-overlay-left input').nth(1).fill('20');

    // then that save carries the legacy tournament: it is migrated, marked as
    // migrated, and the legacy value (copied losslessly) is removed,
    await expect(page.locator('#autoSaveWarning')).toHaveText('');
    const stored = await storedJson(page, STATE_KEY);
    expect(stored.tournamentName).toBe('Legacy Cup');
    expect(stored.currentRoundIndex).toBe(2);
    expect(stored.schedule.rounds[0].matches[0].result).toEqual({ left: '14', right: '10' });
    expect(stored.schedule.rounds[2].matches[1].result).toEqual({ left: '20', right: '4' });
    expect(await storedRaw(page, STATE_MIGRATED_KEY)).not.toBeNull();
    expect(await storedRaw(page, LEGACY_STATE_KEY)).toBeNull();

    // and reopening the app resumes the tournament, the new score included.
    await page.close({ runBeforeUnload: false });
    const next = await context.newPage();
    await next.goto('/');
    await expectTheTournamentInProgress(next, 'Legacy Cup');
    await expect(next.locator('.result-overlay-left input').nth(1)).toHaveValue('20');
    // The one error is the refused migration write.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('console.error: Could not write the migrated copy of a legacy localStorage value');
  });

  test('R-TOURNAMENT-STORE: a legacy saved list whose migrated copy cannot be written is still offered, and the next Save keeps it', async ({ page, context }) => {
    const errors = collectErrors(page);
    const dialogs = collectDialogs(page);
    // Given a saved tournament under the legacy key only, and storage that
    // refuses the saved list.
    const { schedule } = await captureALegacyTournamentInProgress(context);
    const legacySave = aLosslessLegacySave('Legacy Save', schedule);
    const rawSaved = JSON.stringify([legacySave]);
    await plantStorageOnce(page, {
      [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: null, [SAVED_TOURNAMENTS_MIGRATED_KEY]: null,
      [LEGACY_SAVED_TOURNAMENTS_KEY]: rawSaved,
    });
    await refuseWritesOfOnFirstPage(page, SAVED_TOURNAMENTS_KEY);

    // When the app opens,
    await page.goto('/');

    // then the legacy save is offered, though nothing could be stored,
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(1);
    await expect(page.locator('#savedTournamentSelect option')).toContainText('Legacy Save');
    expect(await storedRaw(page, SAVED_TOURNAMENTS_KEY)).toBeNull();
    expect(await storedRaw(page, SAVED_TOURNAMENTS_MIGRATED_KEY)).toBeNull();
    expect(await storedRaw(page, LEGACY_SAVED_TOURNAMENTS_KEY)).toBe(rawSaved);

    // When storage works again and the Organizer saves a new tournament,
    await allowWrites(page);
    await page.fill('#tournamentName', 'New Cup');
    await page.click('#startTournamentBtn');
    await page.click('#saveTournamentBtn');
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs).toEqual(['Tournament saved!']);

    // then the stored list keeps the legacy save next to the new one: it is
    // migrated, marked as migrated, and the legacy list (copied losslessly) is removed,
    const stored = await storedJson(page, SAVED_TOURNAMENTS_KEY);
    expect(stored.map((t) => t.tournamentName)).toEqual(['Legacy Save', 'New Cup']);
    expect(stored[0]).toEqual(legacySave);
    expect(await storedRaw(page, SAVED_TOURNAMENTS_MIGRATED_KEY)).not.toBeNull();
    expect(await storedRaw(page, LEGACY_SAVED_TOURNAMENTS_KEY)).toBeNull();

    // and after reopening both are offered, and the legacy save loads where it was left.
    await page.reload();
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(2);
    await page.selectOption('#savedTournamentSelect', '0');
    await page.click('#loadTournamentBtn');
    await expect(page.locator('#tournamentTitle')).toHaveText('Legacy Save');
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.scoreboard-container')).toContainText('Ada');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('console.error: Could not write the migrated copy of a legacy localStorage value');
  });

  test('R-STATE-PERSIST: a legacy tournament whose migrated marker cannot be written is stored only with its marker, so it is never migrated again', async ({ page, context }) => {
    const errors = collectErrors(page);
    const dialogs = [];
    // Given a legacy tournament in progress whose copy is lossy (the schedule
    // module's own fields are left out, so the legacy value is kept), and storage
    // that refuses the migrated marker.
    const state = await captureALegacyTournamentInProgress(context);
    state.schedule.playerCount = state.schedule.players.length;
    state.schedule.totalRounds = state.schedule.rounds.length;
    const rawState = JSON.stringify(state);
    await plantStorageOnce(page, { [STATE_KEY]: null, [STATE_MIGRATED_KEY]: null, [LEGACY_STATE_KEY]: rawState });
    await refuseWritesOfOnFirstPage(page, STATE_MIGRATED_KEY);

    // When the returning Organizer opens the app,
    await page.goto('/');

    // then the tournament resumes at round 3 with its scores and names, but its
    // copy is not stored without the marker (the Organizer is warned),
    await expectTheTournamentInProgress(page, 'Legacy Cup');
    await expect(page.locator('#autoSaveWarning')).not.toHaveText('');
    expect(await storedRaw(page, STATE_KEY)).toBeNull();
    expect(await storedRaw(page, STATE_MIGRATED_KEY)).toBeNull();
    expect(await storedRaw(page, LEGACY_STATE_KEY)).toBe(rawState);

    // and once storage works again, the next save stores it with its marker,
    // keeping the lossy legacy value.
    await allowWrites(page);
    await page.locator('.result-overlay-left input').nth(1).fill('20');
    await expect(page.locator('#autoSaveWarning')).toHaveText('');
    expect((await storedJson(page, STATE_KEY)).tournamentName).toBe('Legacy Cup');
    expect(await storedRaw(page, STATE_MIGRATED_KEY)).not.toBeNull();
    expect(await storedRaw(page, LEGACY_STATE_KEY)).toBe(rawState);

    // When the Organizer starts a new tournament without saving the old one,
    // chooses another schedule (which removes the stored state) and the page is
    // closed without its save on leaving (as a killed tab is),
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      if (dialog.type() === 'confirm') dialog.dismiss(); else dialog.accept();
    });
    await page.click('#newTournamentBtn');
    await expect(page.locator('.round')).toHaveCount(0);
    await page.selectOption('#scheduleSelect', '16p15r.js');
    expect(await storedRaw(page, STATE_KEY)).toBeNull();
    await page.close({ runBeforeUnload: false });

    // then reopening the app shows a fresh setup, not the old tournament: the
    // kept legacy value is not migrated again.
    const next = await context.newPage();
    const nextErrors = collectErrors(next);
    await next.goto('/');
    await expectAFreshSetup(next);
    expect(await storedRaw(next, LEGACY_STATE_KEY)).toBe(rawState);
    expect(dialogs).toEqual(['Do you want to save the current tournament before creating a new one?', 'Ready for a new tournament!']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('console.error: Could not write the migrated copy of a legacy localStorage value');
    expect(nextErrors).toEqual([]);
  });

  // A setup not yet started, as the app stored it before its keys were prefixed,
  // its copy lossless (see captureALegacyTournamentInProgress).
  async function captureALegacySetup(context) {
    const state = await captureARealTournamentState(context, { started: false });
    delete state.schedule.playerCount;
    delete state.schedule.totalRounds;
    state.tournamentName = 'Legacy Setup';
    return state;
  }

  // The same, as a Mexicano setup (12 players): Start draws a new schedule.
  async function captureALegacyMexicanoSetup(context) {
    const state = await captureALegacySetup(context);
    state.format = 'mexicano';
    expect(state.mexicanoPlayerCount).toBe(12);
    return state;
  }

  // Ways the Organizer drops the tournament the app holds, each with what is
  // stored afterwards. Choosing a schedule saves nothing by itself (it removes the
  // stored state), so a court name is typed after it, which saves.
  const LEGACY_STATE_DROPS = [
    ['starts a new tournament without saving it', captureALegacyTournamentInProgress, async (page) => {
      await page.click('#newTournamentBtn');
      await expect(page.locator('.round')).toHaveCount(0);
    }, (stored) => {
      expect(stored.tournamentStarted).toBe(false);
      expect(stored.tournamentName).toBe('');
    }],
    ['loads another saved tournament', captureALegacyTournamentInProgress, async (page) => {
      await page.selectOption('#savedTournamentSelect', '0');
      await page.click('#loadTournamentBtn');
      await expect(page.locator('#tournamentTitle')).toHaveText('Other Save');
    }, (stored) => {
      expect(stored.tournamentName).toBe('Other Save');
    }],
    ['chooses another schedule for the setup', captureALegacySetup, async (page) => {
      await page.selectOption('#scheduleSelect', '16p15r.js');
      await page.fill('#courtNameInput_1', 'North');
    }, (stored) => {
      expect(stored.schedule.players).toHaveLength(16);
    }],
    ['starts a Mexicano tournament from the setup', captureALegacyMexicanoSetup, async (page) => {
      await page.fill('#tournamentName', 'Mexi Cup');
      await page.click('#startTournamentBtn');
      await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    }, (stored) => {
      expect(stored.format).toBe('mexicano');
      expect(stored.tournamentStarted).toBe(true);
      expect(stored.tournamentName).toBe('Mexi Cup');
    }],
  ];
  // Migration safety, not a Requirement's scenario: untagged.
  for (const [description, captureLegacy, drop, expectStored] of LEGACY_STATE_DROPS) {
    test(`A legacy tournament not yet migrated is kept in place when the Organizer ${description}`, async ({ page, context }) => {
      const errors = collectErrors(page);
      page.on('dialog', (dialog) => (dialog.type() === 'confirm' ? dialog.dismiss() : dialog.accept()));
      // Given a legacy tournament (copied losslessly) and a saved one, and storage
      // that refuses the tournament state,
      const state = await captureLegacy(context);
      const rawState = JSON.stringify(state);
      await plantStorageOnce(page, {
        [STATE_KEY]: null, [STATE_MIGRATED_KEY]: null, [LEGACY_STATE_KEY]: rawState,
        [SAVED_TOURNAMENTS_KEY]: JSON.stringify([aLosslessLegacySave('Other Save', state.schedule)]),
      });
      await refuseWritesOfOnFirstPage(page, STATE_KEY);
      // the app opens on the legacy tournament, from its copy, which is not stored.
      await page.goto('/');
      await expect(page.locator('#tournamentTitle')).toHaveText(state.tournamentName);
      expect(await storedRaw(page, STATE_KEY)).toBeNull();

      // When storage works again and the Organizer drops that tournament,
      await allowWrites(page);
      await drop(page);

      // then what is stored is the new tournament, marked as migrated (so the
      // legacy value is not migrated again over it),
      await expect.poll(() => storedRaw(page, STATE_MIGRATED_KEY)).not.toBeNull();
      expectStored(await storedJson(page, STATE_KEY));
      // and the legacy value, whose data is stored nowhere else, is kept byte for byte.
      expect(await storedRaw(page, LEGACY_STATE_KEY)).toBe(rawState);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('console.error: Could not write the migrated copy of a legacy localStorage value');
    });
  }

  test('R-TOURNAMENT-STORE: a legacy saved list another page changes while its migration is pending is left in place, and Save still keeps the copied save', async ({ page, context }) => {
    const errors = collectErrors(page);
    const dialogs = collectDialogs(page);
    // Given a saved tournament under the legacy key only, and storage that
    // refuses the saved list, so its migration is pending,
    const { schedule } = await captureALegacyTournamentInProgress(context);
    const legacySave = aLosslessLegacySave('Legacy Save', schedule);
    await plantStorageOnce(page, {
      [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: null, [SAVED_TOURNAMENTS_MIGRATED_KEY]: null,
      [LEGACY_SAVED_TOURNAMENTS_KEY]: JSON.stringify([legacySave]),
    });
    await refuseWritesOfOnFirstPage(page, SAVED_TOURNAMENTS_KEY);
    await page.goto('/');
    await expect(page.locator('#savedTournamentSelect option')).toContainText(['Legacy Save']);

    // when another page writes the legacy key meanwhile,
    const changed = '[{"id":7,"title":"note"}]';
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [LEGACY_SAVED_TOURNAMENTS_KEY, changed]);
    // and, storage working again, the Organizer saves a new tournament,
    await allowWrites(page);
    await page.fill('#tournamentName', 'New Cup');
    await page.click('#startTournamentBtn');
    await page.click('#saveTournamentBtn');
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs).toEqual(['Tournament saved!']);

    // then the stored list keeps the copied legacy save next to the new one,
    // marked as migrated,
    const stored = await storedJson(page, SAVED_TOURNAMENTS_KEY);
    expect(stored.map((t) => t.tournamentName)).toEqual(['Legacy Save', 'New Cup']);
    expect(stored[0]).toEqual(legacySave);
    expect(await storedRaw(page, SAVED_TOURNAMENTS_MIGRATED_KEY)).not.toBeNull();
    // but the legacy key, no longer what was migrated, is left as the other page wrote it.
    expect(await storedRaw(page, LEGACY_SAVED_TOURNAMENTS_KEY)).toBe(changed);
    expect(errors).toHaveLength(1);
  });

  // The first saved list written that does not keep the legacy save unchanged.
  const LEGACY_SAVE_DROPS = [
    ['deletes the legacy save', async (page) => {
      await page.fill('#tournamentName', 'Legacy Save');
      await page.click('#deleteTournamentBtn');
    }, ['Are you sure you want to delete "Legacy Save"? Your secret sauce will vanish forever!',
      'Tournament "Legacy Save" deleted!'], []],
    ['saves over the legacy save under its name', async (page) => {
      await page.click('#loadTournamentBtn');
      await expect(page.locator('#tournamentTitle')).toHaveText('Legacy Save');
      await page.click('#saveTournamentBtn');
    }, ['Tournament saved!'], ['Legacy Save']],
  ];
  // Migration safety, not a Requirement's scenario: untagged.
  for (const [description, drop, expectedDialogs, expectedNames] of LEGACY_SAVE_DROPS) {
    test(`A legacy saved list not yet migrated is kept in place when the Organizer ${description}`, async ({ page, context }) => {
      const errors = collectErrors(page);
      const dialogs = collectDialogs(page);
      // Given a saved tournament under the legacy key only (copied losslessly),
      // and storage that refuses the saved list, so its migration is pending,
      const { schedule } = await captureALegacyTournamentInProgress(context);
      const rawSaved = JSON.stringify([aLosslessLegacySave('Legacy Save', schedule)]);
      await plantStorageOnce(page, {
        [STATE_KEY]: null, [SAVED_TOURNAMENTS_KEY]: null, [SAVED_TOURNAMENTS_MIGRATED_KEY]: null,
        [LEGACY_SAVED_TOURNAMENTS_KEY]: rawSaved,
      });
      await refuseWritesOfOnFirstPage(page, SAVED_TOURNAMENTS_KEY);
      await page.goto('/');
      await expect(page.locator('#savedTournamentSelect option')).toContainText(['Legacy Save']);

      // when, storage working again, the first list the Organizer stores no
      // longer holds that save as it was,
      await allowWrites(page);
      await drop(page);
      await expect.poll(() => dialogs.length).toBe(expectedDialogs.length);
      expect(dialogs).toEqual(expectedDialogs);

      // then that list is stored, marked as migrated,
      expect((await storedJson(page, SAVED_TOURNAMENTS_KEY)).map((t) => t.tournamentName)).toEqual(expectedNames);
      expect(await storedRaw(page, SAVED_TOURNAMENTS_MIGRATED_KEY)).not.toBeNull();
      // and the legacy list, whose save is stored nowhere else as it was, is kept byte for byte.
      expect(await storedRaw(page, LEGACY_SAVED_TOURNAMENTS_KEY)).toBe(rawSaved);
      expect(errors).toHaveLength(1);
    });
  }

  test('R-STATE-PERSIST: a legacy migration another tab completes meanwhile is left to it: its marker stays and its legacy value is untouched', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a tournament in progress under the legacy key only (copied
    // losslessly), and storage that refuses the tournament state,
    const state = await captureALegacyTournamentInProgress(context);
    const rawState = JSON.stringify(state);
    await plantStorageOnce(page, { [STATE_KEY]: null, [STATE_MIGRATED_KEY]: null, [LEGACY_STATE_KEY]: rawState });
    await refuseWritesOfOnFirstPage(page, STATE_KEY);
    // the tournament resumes at round 3 from its copy, which is not stored.
    await page.goto('/');
    await expectTheTournamentInProgress(page, 'Legacy Cup');
    expect(await storedRaw(page, STATE_KEY)).toBeNull();

    // When another tab completes the migration (it writes the marker),
    await page.evaluate((key) => localStorage.setItem(key, 'true'), STATE_MIGRATED_KEY);
    // and a save here still fails,
    await page.locator('.result-overlay-left input').nth(1).fill('20');

    // then that tab's marker is not taken off,
    await expect(page.locator('#autoSaveWarning')).not.toHaveText('');
    expect(await storedRaw(page, STATE_MIGRATED_KEY)).toBe('true');

    // and once a save here works, the tournament is stored while the legacy
    // value is left as it is: what to do with it was the other tab's call.
    await allowWrites(page);
    await page.locator('.result-overlay-left input').nth(2).fill('18');
    await expect(page.locator('#autoSaveWarning')).toHaveText('');
    const stored = await storedJson(page, STATE_KEY);
    expect(stored.tournamentName).toBe('Legacy Cup');
    expect(stored.schedule.rounds[2].matches[1].result).toEqual({ left: '20', right: '4' });
    expect(await storedRaw(page, STATE_MIGRATED_KEY)).toBe('true');
    expect(await storedRaw(page, LEGACY_STATE_KEY)).toBe(rawState);
    expect(errors).toHaveLength(1);
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
    test(`R-SCHEDULE-SELECT, R-STATE-PERSIST: ${players} players play with ${resting} resting per round, across a reload`, async ({ page }) => {
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
      const schedule = (await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STATE_KEY)).schedule;
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
    return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STATE_KEY);
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

    // When the Organizer then starts a New Tournament (declining to save first),
    await page.click('#newTournamentBtn');
    await expect.poll(() => dialogs.length).toBe(5);
    await expect(page.locator('#settingsContainer')).toBeVisible();
    // Then the new setup keeps the 16-player schedule the select shows,
    // with its default names and one court per four players.
    await expect(page.locator('#scheduleSelect')).toHaveValue('16p15r.js');
    await expect(page.locator('#scheduleSelect')).toBeEnabled();
    const inputs = page.locator('[id^="playerInput_"]');
    await expect(inputs).toHaveCount(16);
    expect(await inputs.evaluateAll((all) => all.map((input) => input.value)))
      .toEqual(Array.from({ length: 16 }, (_, i) => `P${i + 1}`));
    await expect(page.locator('[id^="courtNameInput_"]')).toHaveCount(4);
    expect(errors).toEqual([]);
  });

  test('R-FORMAT-SELECT, R-SCHEDULE-SELECT, R-STATE-PERSIST: switching a restored Mexicano setup back to Americano shows the kept schedule', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a 16-player Americano setup, not started, switched to Mexicano,
    await page.selectOption('#scheduleSelect', '16p15r.js');
    await page.fill('#tournamentName', 'Switch Back Cup');
    await page.selectOption('#formatSelect', 'mexicano');
    await page.reload();
    await expect(page.locator('#formatSelect')).toHaveValue('mexicano');

    // and restored in a fresh tab, whose hidden select starts at the default,
    const fresh = await context.newPage();
    const freshErrors = collectErrors(fresh);
    await fresh.goto('/');
    await expect(fresh.locator('#formatSelect')).toHaveValue('mexicano');
    await expect(fresh.locator('#scheduleSelect')).toBeHidden();
    await expect(fresh.locator('#scheduleSelect')).toHaveValue('12p11r.js');
    // (a Mexicano player-count choice leaves the hidden select alone)
    await fresh.selectOption('#playerCountSelect', '20');
    await expect(fresh.locator('[id^="playerInput_"]')).toHaveCount(20);
    await expect(fresh.locator('#scheduleSelect')).toHaveValue('12p11r.js');

    // When the Organizer switches back to Americano,
    await fresh.selectOption('#formatSelect', 'americano');

    // Then the select shows the 16-player schedule the setup kept.
    await expect(fresh.locator('#scheduleSelect')).toBeVisible();
    await expect(fresh.locator('#scheduleSelect')).toHaveValue('16p15r.js');
    await expect(fresh.locator('[id^="playerInput_"]')).toHaveCount(16);
    await expect(fresh.locator('[id^="courtNameInput_"]')).toHaveCount(4);
    expect(freshErrors).toEqual([]);
    await fresh.close();
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

// The tournament state is auto-saved on every change. When that save fails (the
// origin's shared storage is full, or storage is unavailable), the Organizer is
// warned instead of scores silently no longer persisting, and the warning clears
// on the next save that succeeds. While it is shown, a failed save is retried
// without a further change (when another tab changes the origin's storage, and
// when the Organizer returns to the page), and leaving the page asks first. Only
// that auto-save warns: the Save button reports its own outcome, and failed
// writes on load (migration, backup) are logged.
// The warning is pinned in sight on an opaque banner, in setup and in play.
test.describe('A visible warning when the auto-save fails', () => {
  // Factual, and pointing at no in-app action: the app's only way to free storage
  // (Delete Tournament) also resets the running tournament. It names only the
  // retry's triggers the Organizer controls; the warning stays until a save has worked.
  const WARNING = 'Scores and other changes are not being saved in this browser right now. ' +
    'Keep this page open: saving is tried again when you change something or return to this page, ' +
    'and this warning disappears once a save works.';

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

  async function storedRaw(page, key) {
    return page.evaluate((k) => localStorage.getItem(k), key);
  }

  // Storage that refuses the tournament state, as when it is full, while the
  // test sets window.failStateWrites (cleared again by every page load). Each
  // refused write is counted, so a test can wait for the save it caused, and so
  // is every attempt to write the state, refused or not.
  async function refuseStateWritesOnDemand(page) {
    await page.addInitScript((stateKey) => {
      window.failStateWrites = false;
      window.refusedStateWrites = 0;
      window.stateWriteAttempts = 0;
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === stateKey) window.stateWriteAttempts++;
        if (key === stateKey && window.failStateWrites) {
          window.refusedStateWrites++;
          throw new DOMException('Storage is full', 'QuotaExceededError');
        }
        return setItem.call(this, key, value);
      };
    }, STATE_KEY);
  }

  const setStateWritesFailing = (page, failing) =>
    page.evaluate((f) => { window.failStateWrites = f; }, failing);
  const refusedStateWrites = (page) => page.evaluate(() => window.refusedStateWrites);
  const stateWriteAttempts = (page) => page.evaluate(() => window.stateWriteAttempts);

  // Run action and wait until it has caused at least one more refused state save.
  async function expectARefusedSave(page, action) {
    const before = await refusedStateWrites(page);
    await action();
    await expect.poll(() => refusedStateWrites(page)).toBeGreaterThan(before);
  }

  async function startTournament(page, name) {
    await page.fill('#tournamentName', name);
    await page.click('#startTournamentBtn');
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
  }

  const leftScore = (page, i) => page.locator('.result-overlay-left input').nth(i);
  const rightScore = (page, i) => page.locator('.result-overlay-right input').nth(i);

  async function expectNoWarning(page) {
    await expect(page.locator('#autoSaveWarning')).toHaveText('');
    await expect(page.locator('#autoSaveWarning')).toBeHidden();
  }

  async function expectTheWarning(page) {
    const warning = page.getByRole('alert');
    await expect(warning).toHaveCount(1);
    await expect(warning).toHaveId('autoSaveWarning');
    await expect(warning).toBeVisible();
    await expect(warning).toHaveText(WARNING);
  }

  // The alpha of a computed CSS color ("rgb(...)" is opaque).
  function alphaOf(color) {
    const rgba = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/.exec(color);
    if (rgba) return Number(rgba[1]);
    if (/^rgb\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*\)$/.test(color)) return 1;
    throw new Error(`Unexpected computed color: ${color}`);
  }

  // The warning is in sight wherever the page is scrolled: entirely inside the
  // viewport, on top of whatever is beneath it there (the round view's courts are
  // positioned), on an opaque panel rather than as text over the background photo.
  async function expectTheWarningInSight(page) {
    await expectTheWarning(page);
    const warning = page.locator('#autoSaveWarning');
    await expect(warning).toBeInViewport({ ratio: 1 });
    expect(await warning.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return [[0.05, 0.5], [0.5, 0.5], [0.95, 0.5]].every(([x, y]) =>
        el.contains(document.elementFromPoint(box.left + x * box.width, box.top + y * box.height)));
    })).toBe(true);
    expect(alphaOf(await warning.evaluate((el) => getComputedStyle(el).backgroundColor))).toBe(1);
  }

  // Makes a pinning check meaningful: the header's top is above the viewport, so
  // the warning's place in the page flow (above the header) is out of sight too.
  async function expectScrolledPastTheHeader(page) {
    expect((await page.locator('#header').boundingBox()).y).toBeLessThan(0);
  }

  async function chooseSchedule(page, module, courts) {
    await page.selectOption('#scheduleSelect', module);
    await expect(page.locator('#courtNamesContainer input')).toHaveCount(courts);
  }

  test('R-STATE-PERSIST: a failing auto-save shows a warning, and the tournament stays playable', async ({ page }) => {
    const errors = collectErrors(page);
    await refuseStateWritesOnDemand(page);
    await page.goto('/');
    // No warning while nothing has failed: not on load, not after a save that works.
    await expectNoWarning(page);
    await startTournament(page, 'Full Cup');
    await expectNoWarning(page);

    // Given storage that refuses the tournament state, when a score is entered,
    const storedBefore = await storedRaw(page, STATE_KEY);
    const resultBefore = JSON.parse(storedBefore).schedule.rounds[0].matches[0].result;
    expect(resultBefore).not.toEqual({ left: '10', right: '14' });
    await setStateWritesFailing(page, true);
    await expectARefusedSave(page, () => leftScore(page, 0).fill('10'));

    // then the Organizer is warned that it is not being saved (it was not: the
    // stored state is exactly the one saved before, without the score),
    await expectTheWarning(page);
    expect(await storedRaw(page, STATE_KEY)).toBe(storedBefore);
    expect((await storedJson(page, STATE_KEY)).schedule.rounds[0].matches[0].result).toEqual(resultBefore);

    // and the tournament plays on: scores are completed and counted,
    await expect(rightScore(page, 0)).toHaveValue('14');
    await leftScore(page, 1).fill('20');
    await expect(rightScore(page, 1)).toHaveValue('4');
    await expect(page.locator('.scoreboard-container td', { hasText: /^20$/ })).toHaveCount(2);
    // and the rounds can be browsed, the scores kept on screen.
    await page.getByRole('button', { name: 'NEXT ROUND' }).click();
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    await page.getByRole('button', { name: 'PREVIOUS ROUND' }).click();
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(leftScore(page, 0)).toHaveValue('10');
    await expect(leftScore(page, 1)).toHaveValue('20');
    await expectTheWarning(page);
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST: scores entered while the auto-save failed are saved by the next save that works, which clears the warning', async ({ page }) => {
    const errors = collectErrors(page);
    await refuseStateWritesOnDemand(page);
    await page.goto('/');
    await startTournament(page, 'Recovered Cup');

    // Given scores entered and a round advanced while the state could not be saved,
    await setStateWritesFailing(page, true);
    await expectARefusedSave(page, () => leftScore(page, 0).fill('10'));
    await page.getByRole('button', { name: 'NEXT ROUND' }).click();
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    await expectARefusedSave(page, () => leftScore(page, 0).fill('15'));
    await expectTheWarning(page);

    // when storage works again and the next change is saved,
    await setStateWritesFailing(page, false);
    await leftScore(page, 1).fill('7');

    // then the warning clears,
    await expectNoWarning(page);

    // and when the Organizer reopens the app, the tournament resumes at round 2
    // with every score intact, those entered while saving failed included.
    await page.reload();
    await expectNoWarning(page);
    await expect(page.locator('#tournamentTitle')).toHaveText('Recovered Cup');
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    await expect(leftScore(page, 0)).toHaveValue('15');
    await expect(leftScore(page, 1)).toHaveValue('7');
    await page.getByRole('button', { name: 'PREVIOUS ROUND' }).click();
    await expect(leftScore(page, 0)).toHaveValue('10');
    await expect(rightScore(page, 0)).toHaveValue('14');
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST: an auto-save that keeps failing announces the warning once, without re-setting or flickering it, the scores kept on screen', async ({ page }) => {
    const errors = collectErrors(page);
    await refuseStateWritesOnDemand(page);
    await page.goto('/');
    await startTournament(page, 'Repeat Cup');
    await setStateWritesFailing(page, true);
    await expectARefusedSave(page, () => leftScore(page, 0).fill('10'));
    await expectTheWarning(page);

    // Given every change to the warning element is recorded from now on,
    await page.evaluate(() => {
      window.warningChanges = [];
      new MutationObserver((records) => window.warningChanges.push(...records.map((r) => r.type)))
        .observe(document.getElementById('autoSaveWarning'),
          { childList: true, characterData: true, subtree: true, attributes: true });
    });

    // when more saves fail (score edits and round changes),
    await expectARefusedSave(page, () => leftScore(page, 0).fill('11'));
    await expectARefusedSave(page, () => leftScore(page, 1).fill('5'));
    await expectARefusedSave(page, () => page.getByRole('button', { name: 'NEXT ROUND' }).click());
    await expectARefusedSave(page, () => page.getByRole('button', { name: 'PREVIOUS ROUND' }).click());

    // then the warning is left exactly as it was: not cleared and set again,
    expect(await page.evaluate(() => window.warningChanges)).toEqual([]);
    await expectTheWarning(page);
    // and the scores recorded meanwhile remain on screen.
    await expect(leftScore(page, 0)).toHaveValue('11');
    await expect(rightScore(page, 0)).toHaveValue('13');
    await expect(leftScore(page, 1)).toHaveValue('5');
    await expect(rightScore(page, 1)).toHaveValue('19');

    // (The record does see a real change: the save that works clears it.)
    await setStateWritesFailing(page, false);
    await leftScore(page, 0).fill('12');
    await expectNoWarning(page);
    expect((await page.evaluate(() => window.warningChanges)).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  // Retrying a failed save. Once storage works again, the page is not told: it
  // saves nothing until it has a reason to try. While the warning is shown it
  // tries when another tab frees some of this origin's storage (removes or
  // shortens a value other than the state's own) and when the Organizer returns
  // to the page, without waiting for a further change; such a retry waits a
  // second, the triggers arriving meanwhile join it, and any other save cancels
  // it. It also tries, at once, each time the page is hidden or left.
  const RETRY_DELAY_MS = 1000;

  // A tournament whose auto-save has failed: a score entered and refused, the
  // warning shown. Returns the state stored before, which lacks the score.
  async function failASave(page, name) {
    await startTournament(page, name);
    const storedBefore = await storedRaw(page, STATE_KEY);
    expect(JSON.parse(storedBefore).schedule.rounds[0].matches[0].result).not.toEqual({ left: '10', right: '14' });
    await setStateWritesFailing(page, true);
    await expectARefusedSave(page, () => leftScore(page, 0).fill('10'));
    await expectTheWarning(page);
    return storedBefore;
  }

  // Storage works again, the page not told: no attempt to save, the warning
  // still shown and the stored state still the one saved before the failure.
  async function freeStorageQuietly(page, storedBefore) {
    const attempts = await stateWriteAttempts(page);
    await setStateWritesFailing(page, false);
    expect(await stateWriteAttempts(page)).toBe(attempts);
    expect(await storedRaw(page, STATE_KEY)).toBe(storedBefore);
    await expectTheWarning(page);
  }

  // The retried save stored the score, and reopening the app restores it.
  async function expectTheScoreSavedAndRestored(page) {
    expect((await storedJson(page, STATE_KEY)).schedule.rounds[0].matches[0].result)
      .toEqual({ left: '10', right: '14' });
    await page.reload();
    await expectNoWarning(page);
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(leftScore(page, 0)).toHaveValue('10');
    await expect(rightScore(page, 0)).toHaveValue('14');
  }

  // A document of this origin that is not the app (it writes no state), for
  // storage changes made "in another tab".
  // It relies on web/css/style.css existing: any other static file would do.
  async function anotherTab(context) {
    const other = await context.newPage();
    await other.goto('/css/style.css');
    return other;
  }

  test('R-STATE-PERSIST: a failed save is retried without a further change when another tab frees storage', async ({ page, context }) => {
    const errors = collectErrors(page);
    await refuseStateWritesOnDemand(page);
    await page.goto('/');
    // Another app on this shared origin holds some storage.
    await page.evaluate(() => localStorage.setItem('another-app-on-this-origin', 'x'.repeat(1000)));
    // Given a failed auto-save is being announced,
    const storedBefore = await failASave(page, 'Freed Cup');
    // and the browser accepts storage again,
    await freeStorageQuietly(page, storedBefore);

    // when that other app frees its storage in another tab (a real storage event
    // in this page), the Organizer changing nothing,
    const other = await anotherTab(context);
    await other.evaluate(() => localStorage.removeItem('another-app-on-this-origin'));

    // then the warning is no longer shown,
    await expectNoWarning(page);
    await other.close();
    // and progress is saved: the score entered while saving failed is stored and restored.
    await expectTheScoreSavedAndRestored(page);
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST: a failed save is retried without a further change when the Organizer returns to the page', async ({ page }) => {
    const errors = collectErrors(page);
    await refuseStateWritesOnDemand(page);
    await page.goto('/');
    // Given a failed auto-save is being announced,
    const storedBefore = await failASave(page, 'Return Cup');
    // and the Organizer switches away from the page (it becomes hidden: the save
    // is tried once, at once, and still refused),
    const refused = await refusedStateWrites(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await refusedStateWrites(page)).toBe(refused + 1);
    await expectTheWarning(page);
    // and storage is freed meanwhile,
    await freeStorageQuietly(page, storedBefore);

    // when the Organizer returns to the page without changing anything,
    await page.evaluate(() => {
      delete document.visibilityState; // the page's own again: visible
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');

    // then the warning is no longer shown,
    await expectNoWarning(page);
    // and progress is saved: the score entered while saving failed is stored and restored.
    await expectTheScoreSavedAndRestored(page);
    expect(errors).toEqual([]);
  });

  for (const [where, trigger] of [['focus', 'the window gets the focus back'],
    ['pageshow', 'the page comes back from the back/forward cache']]) {
    test(`R-STATE-PERSIST: a failed save is retried without a further change when ${trigger}`, async ({ page }) => {
      const errors = collectErrors(page);
      await refuseStateWritesOnDemand(page);
      await page.goto('/');
      // Given a failed auto-save is being announced, and storage is freed,
      const storedBefore = await failASave(page, 'Window Cup');
      await freeStorageQuietly(page, storedBefore);

      // when the Organizer returns to the page (a window that was never hidden),
      await page.evaluate((type) => {
        if (type === 'focus') window.dispatchEvent(new FocusEvent('focus'));
        else window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      }, where);

      // then the warning is no longer shown,
      await expectNoWarning(page);
      // and progress is saved: the score entered while saving failed is stored and restored.
      await expectTheScoreSavedAndRestored(page);
      expect(errors).toEqual([]);
    });
  }

  for (const [where, description] of [['hidden', 'the page is hidden'], ['pagehide', 'the page is left (pagehide)']]) {
    test(`While saves fail, the save is tried at once, with no prompt, when ${description}`, async ({ page }) => {
      const errors = collectErrors(page);
      const prompts = [];
      page.on('dialog', (dialog) => { prompts.push(dialog.type()); dialog.accept(); });
      await refuseStateWritesOnDemand(page);
      await page.goto('/');
      // Given a failed auto-save is being announced, and storage is freed,
      const storedBefore = await failASave(page, 'Hide Cup');
      await freeStorageQuietly(page, storedBefore);
      const attempts = await stateWriteAttempts(page);

      // when the page is hidden or left (no beforeunload: as on many mobile
      // browsers), then the save is tried at once, before any timer could run,
      // and stores the score,
      const storedAtOnce = await page.evaluate(([type, key]) => {
        if (type === 'hidden') {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
        } else {
          window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
        }
        return localStorage.getItem(key);
      }, [where, STATE_KEY]);
      expect(JSON.parse(storedAtOnce).schedule.rounds[0].matches[0].result).toEqual({ left: '10', right: '14' });
      expect(await stateWriteAttempts(page)).toBe(attempts + 1);
      // the warning clears, and nothing asked.
      await expectNoWarning(page);
      expect(prompts).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test('Retries are coalesced: a burst of triggers while saves still fail is one retry, and leaves the warning as it was', async ({ page }) => {
    const errors = collectErrors(page);
    await refuseStateWritesOnDemand(page);
    await page.goto('/');
    const storedBefore = await failASave(page, 'Storm Cup');
    await page.evaluate(() => {
      window.warningChanges = [];
      new MutationObserver((records) => window.warningChanges.push(...records.map((r) => r.type)))
        .observe(document.getElementById('autoSaveWarning'),
          { childList: true, characterData: true, subtree: true, attributes: true });
    });
    const refused = await refusedStateWrites(page);
    // Storage events that free room, as another tab's would (a value shortened,
    // a key removed): each is a trigger on its own.
    const freeingStorageEvents = () => page.evaluate(() => {
      for (let i = 0; i < 20; i++) {
        window.dispatchEvent(new StorageEvent('storage', i % 2
          ? { key: 'elsewhere', oldValue: 'ab', newValue: 'a' }
          : { key: 'elsewhere', oldValue: 'a', newValue: null }));
      }
    });
    const returnsToThePage = () => page.evaluate(() => {
      for (let i = 0; i < 2; i++) document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new FocusEvent('focus'));
    });

    // Given storage still refuses the state, when a burst of twenty freeing
    // storage events arrives,
    await freeingStorageEvents();
    // then no save is tried at once, one is tried after the delay, refused,
    expect(await refusedStateWrites(page)).toBe(refused);
    await expect.poll(() => refusedStateWrites(page)).toBe(refused + 1);
    // and nothing more follows of its own accord;
    await page.waitForTimeout(RETRY_DELAY_MS * 1.5);
    expect(await refusedStateWrites(page)).toBe(refused + 1);
    // a later burst of both kinds (twenty storage events, two returns to the
    // page, a focus) is again one retry.
    await freeingStorageEvents();
    await returnsToThePage();
    expect(await refusedStateWrites(page)).toBe(refused + 1);
    await expect.poll(() => refusedStateWrites(page)).toBe(refused + 2);
    await page.waitForTimeout(RETRY_DELAY_MS * 1.5);
    expect(await refusedStateWrites(page)).toBe(refused + 2);
    // The warning is left exactly as it was, the score on screen, the stored
    // state unchanged.
    expect(await page.evaluate(() => window.warningChanges)).toEqual([]);
    await expectTheWarning(page);
    await expect(leftScore(page, 0)).toHaveValue('10');
    expect(await storedRaw(page, STATE_KEY)).toBe(storedBefore);
    expect(errors).toEqual([]);
  });

  // Two tabs of the app whose state saves both fail while a legacy state's
  // migration is pending: each failed save writes and takes back off the
  // migrated marker, a storage event in the other tab each time. Neither tab
  // answers those: no loop of saves between them.
  test('Two failing tabs with a pending legacy migration do not retry each other in a loop', async ({ context }) => {
    // Given a tournament stored under the legacy key only,
    const donor = await context.newPage();
    await donor.goto('/');
    await startTournament(donor, 'Legacy Cup');
    const rawState = await storedRaw(donor, STATE_KEY);
    await donor.close();
    const seeder = await anotherTab(context);
    await seeder.evaluate((keys) => {
      localStorage.setItem(keys.LEGACY_STATE_KEY, keys.rawState);
      localStorage.removeItem(keys.STATE_KEY);
      localStorage.removeItem(keys.STATE_MIGRATED_KEY);
    }, { LEGACY_STATE_KEY, STATE_KEY, STATE_MIGRATED_KEY, rawState });
    await seeder.close();

    // and two tabs of the app, each refusing every write of the state while
    // writing the marker as asked (each attempt counted),
    const openFailingTab = async () => {
      const tab = await context.newPage();
      await tab.addInitScript((stateKey) => {
        window.stateWriteAttempts = 0;
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === stateKey) {
            window.stateWriteAttempts++;
            throw new DOMException('Storage is full', 'QuotaExceededError');
          }
          return setItem.call(this, key, value);
        };
      }, STATE_KEY);
      await tab.goto('/');
      await expect(tab.locator('#tournamentTitle')).toHaveText('Legacy Cup');
      await expectTheWarning(tab);
      return tab;
    };
    const first = await openFailingTab();
    const second = await openFailingTab();
    // (the migration still pending: no marker, the legacy value in place),
    expect(await storedRaw(second, STATE_MIGRATED_KEY)).toBeNull();
    expect(await storedRaw(second, LEGACY_STATE_KEY)).toBe(rawState);

    // when they have settled and two more seconds pass,
    const attempts = async () => (await stateWriteAttempts(first)) + (await stateWriteAttempts(second));
    await first.waitForTimeout(RETRY_DELAY_MS * 1.5);
    const settled = await attempts();
    await first.waitForTimeout(2 * RETRY_DELAY_MS);

    // then neither tab tried again: the few attempts are the loads' own.
    expect(await attempts()).toBe(settled);
    expect(settled).toBeLessThanOrEqual(6);
    await expectTheWarning(first);
    await expectTheWarning(second);
  });

  test('A failing tab does not answer another tab saving the state: no retry, no overwrite', async ({ page, context }) => {
    const errors = collectErrors(page);
    await refuseStateWritesOnDemand(page);
    await page.goto('/');
    // Given a failed auto-save is being announced, and storage is freed (so a
    // retry here would store this tab's state),
    const storedBefore = await failASave(page, 'Shared Cup');
    await freeStorageQuietly(page, storedBefore);
    const attempts = await stateWriteAttempts(page);
    await page.evaluate((key) => {
      window.stateEventsSeen = 0;
      window.addEventListener('storage', (event) => { if (event.key === key) window.stateEventsSeen++; });
    }, STATE_KEY);

    // when another tab of the app saves the state (it resumes Shared Cup and
    // records a score of its own),
    const other = await context.newPage();
    await other.goto('/');
    await expect(other.locator('#tournamentTitle')).toHaveText('Shared Cup');
    await leftScore(other, 1).fill('20');
    await expect.poll(async () => (await storedJson(other, STATE_KEY)).schedule.rounds[0].matches[1].result)
      .toEqual({ left: '20', right: '4' });
    const theirs = await storedRaw(other, STATE_KEY);
    await expect.poll(() => page.evaluate(() => window.stateEventsSeen)).toBeGreaterThan(0);
    await other.close();

    // then this tab neither retries nor writes over that save,
    await page.waitForTimeout(RETRY_DELAY_MS * 1.5);
    expect(await stateWriteAttempts(page)).toBe(attempts);
    expect(await storedRaw(page, STATE_KEY)).toBe(theirs);
    // and its own warning stays: its score is still not saved.
    await expectTheWarning(page);
    await expect(leftScore(page, 0)).toHaveValue('10');
    expect(errors).toEqual([]);
  });

  test('R-STATE-PERSIST: another tab shortening a value retries the failed save; adding, growing or rewriting one at its size does not', async ({ page, context }) => {
    const errors = collectErrors(page);
    await refuseStateWritesOnDemand(page);
    await page.goto('/');
    // Another app on this shared origin holds a value.
    await page.evaluate(() => localStorage.setItem('another-app-on-this-origin', 'x'.repeat(100)));
    // Given a failed auto-save is being announced, and storage is freed (so a
    // retry here would work),
    const storedBefore = await failASave(page, 'Shrink Cup');
    await freeStorageQuietly(page, storedBefore);
    const attempts = await stateWriteAttempts(page);
    await page.evaluate(() => {
      window.storageEventsSeen = 0;
      window.addEventListener('storage', () => { window.storageEventsSeen++; });
    });

    // when another tab adds a value, rewrites one at its size and grows it,
    const other = await anotherTab(context);
    await other.evaluate(() => {
      localStorage.setItem('another-app-new-key', 'x');
      localStorage.setItem('another-app-on-this-origin', 'y'.repeat(100));
      localStorage.setItem('another-app-on-this-origin', 'z'.repeat(200));
    });
    await expect.poll(() => page.evaluate(() => window.storageEventsSeen)).toBe(3);
    // then none of these frees room, so none retries: past the delay nothing
    // was tried and the warning stays,
    await page.waitForTimeout(RETRY_DELAY_MS * 1.5);
    expect(await stateWriteAttempts(page)).toBe(attempts);
    expect(await storedRaw(page, STATE_KEY)).toBe(storedBefore);
    await expectTheWarning(page);

    // and when it then shortens the value, the Organizer changing nothing,
    await other.evaluate(() => localStorage.setItem('another-app-on-this-origin', 'z'));
    // then the warning is no longer shown,
    await expectNoWarning(page);
    await other.close();
    // and progress is saved: the score entered while saving failed is stored and restored.
    await expectTheScoreSavedAndRestored(page);
    expect(errors).toEqual([]);
  });

  // DEFERRED: AB#106 (timing race: the score entry must land within the 1 s retry delay)
  test('A save made while a retry is pending cancels the retry, which would only repeat it', async ({ page }) => {
    const errors = collectErrors(page);
    await refuseStateWritesOnDemand(page);
    await page.goto('/');
    // Given storage still refuses the state and the warning is shown,
    await failASave(page, 'Cancel Cup');
    const refused = await refusedStateWrites(page);

    // when a retry is pending (a return to the window) and the Organizer enters
    // a score before it runs,
    await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
    await expectARefusedSave(page, () => leftScore(page, 1).fill('20'));
    // then that save was tried, and the pending retry is not: past its delay,
    // the score's save is the only attempt.
    await page.waitForTimeout(RETRY_DELAY_MS * 1.5);
    expect(await refusedStateWrites(page)).toBe(refused + 1);

    // And when a retry is pending and the page is hidden before it runs, the
    // save on hiding is tried at once and the retry is not.
    await page.evaluate(() => {
      window.dispatchEvent(new FocusEvent('focus'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.visibilityState;
    });
    expect(await refusedStateWrites(page)).toBe(refused + 2);
    await page.waitForTimeout(RETRY_DELAY_MS * 1.5);
    expect(await refusedStateWrites(page)).toBe(refused + 2);
    await expectTheWarning(page);
    await expect(rightScore(page, 1)).toHaveValue('4');
    expect(errors).toEqual([]);
  });

  for (const [where, description] of [['hidden', 'hidden'], ['pagehide', 'left (pagehide)']]) {
    test(`While saves fail, a page hidden or left after a cancelled leave prompt and a rename still tries the save: ${description}`, async ({ page }) => {
      const errors = collectErrors(page);
      const prompts = [];
      page.on('dialog', (dialog) => {
        prompts.push(dialog.type());
        if (dialog.type() === 'beforeunload') dialog.dismiss();
        else dialog.accept();
      });
      await refuseStateWritesOnDemand(page);
      await page.goto('/');
      // Given a failed auto-save is being announced,
      const storedBefore = await failASave(page, 'Before Cup');
      // and the Organizer tried to leave and stayed (the prompt cancelled),
      await page.close({ runBeforeUnload: true });
      await expect.poll(() => prompts).toEqual(['beforeunload']);
      expect(page.isClosed()).toBe(false);
      // then renamed the tournament (a change the name field does not save by itself),
      await page.click('#toggleSettingsBtn'); // the name is among the settings
      await page.fill('#tournamentName', 'After Cup');
      await expect(page.locator('#tournamentTitle')).toHaveText('After Cup');
      // and storage is freed, the page not told,
      await freeStorageQuietly(page, storedBefore);
      const attempts = await stateWriteAttempts(page);

      // when the page is hidden or left,
      const storedAtOnce = await page.evaluate(([type, key]) => {
        if (type === 'hidden') {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
          delete document.visibilityState;
        } else {
          window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
        }
        return localStorage.getItem(key);
      }, [where, STATE_KEY]);

      // then the save is tried at once and stores the new name with the score,
      expect(await stateWriteAttempts(page)).toBe(attempts + 1);
      const stored = JSON.parse(storedAtOnce);
      expect(stored.tournamentName).toBe('After Cup');
      expect(stored.schedule.rounds[0].matches[0].result).toEqual({ left: '10', right: '14' });
      // and the warning clears, nothing more asked.
      await expectNoWarning(page);
      expect(prompts).toEqual(['beforeunload']);
      expect(errors).toEqual([]);
    });
  }

  test('Leaving always tries the save on beforeunload: after a cancelled prompt, a reload once storage works asks nothing and keeps the state', async ({ page }) => {
    const errors = collectErrors(page);
    const prompts = [];
    let stay = true;
    page.on('dialog', (dialog) => {
      prompts.push(dialog.type());
      if (dialog.type() === 'beforeunload' && stay) dialog.dismiss();
      else dialog.accept();
    });
    await refuseStateWritesOnDemand(page);
    await page.goto('/');
    // Given a failed auto-save is being announced,
    const storedBefore = await failASave(page, 'Again Cup');
    // and the Organizer tried to leave and stayed (the prompt cancelled),
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => prompts).toEqual(['beforeunload']);
    expect(page.isClosed()).toBe(false);
    // and storage is freed, the page not told,
    await freeStorageQuietly(page, storedBefore);

    // when the Organizer reloads the page (any prompt now would be confirmed),
    stay = false;
    await page.reload();

    // then the save on leaving was tried again and worked: nothing asked,
    expect(prompts).toEqual(['beforeunload']);
    // and the score entered while saving failed is stored and restored.
    await expectNoWarning(page);
    await expect(page.locator('#tournamentTitle')).toHaveText('Again Cup');
    await expect(leftScore(page, 0)).toHaveValue('10');
    await expect(rightScore(page, 0)).toHaveValue('14');
    expect((await storedJson(page, STATE_KEY)).schedule.rounds[0].matches[0].result)
      .toEqual({ left: '10', right: '14' });
    expect(errors).toEqual([]);
  });

  test('While saving works, storage events, returning to and leaving the page save nothing', async ({ page, context }) => {
    const errors = collectErrors(page);
    await refuseStateWritesOnDemand(page);
    await page.goto('/');
    await startTournament(page, 'Quiet Cup');
    await leftScore(page, 0).fill('10');
    await expect.poll(async () => (await storedJson(page, STATE_KEY)).schedule.rounds[0].matches[0].result)
      .toEqual({ left: '10', right: '14' });
    await expectNoWarning(page);
    // (another app on this shared origin holds a value),
    await page.evaluate(() => localStorage.setItem('another-app-on-this-origin', 'x'));
    const attempts = await stateWriteAttempts(page);
    const stored = await storedRaw(page, STATE_KEY);
    await page.evaluate(() => {
      window.storageEventsSeen = 0;
      window.addEventListener('storage', () => { window.storageEventsSeen++; });
    });

    // Given no warning is shown, when storage events that free room (three
    // dispatched, a value shortened or a key removed, and a real removal from
    // another tab), returns to the page (visible, focus, pageshow from the
    // back/forward cache) and leaving it (hidden, pagehide) arrive,
    await page.evaluate(() => {
      for (let i = 0; i < 3; i++) {
        window.dispatchEvent(new StorageEvent('storage', i % 2
          ? { key: 'elsewhere', oldValue: 'ab', newValue: 'a' }
          : { key: 'elsewhere', oldValue: 'a', newValue: null }));
      }
      for (let i = 0; i < 2; i++) document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new FocusEvent('focus'));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.visibilityState;
    });
    const other = await anotherTab(context);
    await other.evaluate(() => localStorage.removeItem('another-app-on-this-origin'));
    await expect.poll(() => page.evaluate(() => window.storageEventsSeen)).toBe(4);
    await other.close();
    await page.waitForTimeout(RETRY_DELAY_MS * 1.5); // past any retry's delay

    // then nothing is written and nothing changes.
    expect(await stateWriteAttempts(page)).toBe(attempts);
    expect(await storedRaw(page, STATE_KEY)).toBe(stored);
    await expectNoWarning(page);
    expect(errors).toEqual([]);
  });

  // Leaving while saves are failing: the unload's own save is tried first; only
  // when it fails too does the browser ask the Organizer to confirm leaving.

  test('R-STATE-PERSIST: leaving or reloading while saves are failing asks the Organizer to confirm first', async ({ page }) => {
    const errors = collectErrors(page);
    const prompts = [];
    let stay = true;
    page.on('dialog', (dialog) => {
      prompts.push(dialog.type());
      if (dialog.type() === 'beforeunload' && stay) dialog.dismiss();
      else dialog.accept();
    });
    await refuseStateWritesOnDemand(page);
    await page.goto('/');
    // Given a failed auto-save is being announced,
    await failASave(page, 'Leave Cup');
    const refused = await refusedStateWrites(page);

    // when the Organizer closes the page,
    await page.close({ runBeforeUnload: true });
    // then the Organizer is asked to confirm leaving (the unload's own save was
    // tried first, and refused),
    await expect.poll(() => prompts).toEqual(['beforeunload']);
    expect(await refusedStateWrites(page)).toBeGreaterThan(refused);
    // and, staying, finds the page as it was: open, the score on screen, the warning shown.
    expect(page.isClosed()).toBe(false);
    await expect(leftScore(page, 0)).toHaveValue('10');
    await expectTheWarning(page);

    // When the Organizer reloads the page, they are asked again, and the page
    // reloads once they confirm.
    stay = false;
    await page.reload();
    expect(prompts).toEqual(['beforeunload', 'beforeunload']);
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    expect(errors).toEqual([]);
  });

  test('Leaving asks nothing while saving works, nor when the save on leaving works again', async ({ page, context }) => {
    const prompts = [];
    page.on('dialog', (dialog) => { prompts.push(dialog.type()); dialog.accept(); });
    await refuseStateWritesOnDemand(page);
    await page.goto('/');
    // Given no warning is shown, when the Organizer reloads and then closes the page,
    await startTournament(page, 'Calm Cup');
    await leftScore(page, 0).fill('10');
    await expectNoWarning(page);
    await page.reload();
    await expect(leftScore(page, 0)).toHaveValue('10');
    let closed = page.waitForEvent('close');
    await page.close({ runBeforeUnload: true });
    await closed;
    // then nothing asked, and the page closed.
    expect(prompts).toEqual([]);

    // Given a failed auto-save is being announced (Calm Cup resumed in a new
    // page) and storage works again, the page not told,
    const second = await context.newPage();
    second.on('dialog', (dialog) => { prompts.push(dialog.type()); dialog.accept(); });
    await refuseStateWritesOnDemand(second);
    await second.goto('/');
    await expect(leftScore(second, 0)).toHaveValue('10');
    const storedBefore = await storedRaw(second, STATE_KEY);
    await setStateWritesFailing(second, true);
    await expectARefusedSave(second, () => leftScore(second, 1).fill('20'));
    await expectTheWarning(second);
    await freeStorageQuietly(second, storedBefore);
    // when the Organizer closes the page,
    closed = second.waitForEvent('close');
    await second.close({ runBeforeUnload: true });
    await closed;
    // then the save on leaving worked, so nothing asked, and the page closed
    // with the score stored.
    expect(prompts).toEqual([]);
    const check = await anotherTab(context);
    expect(JSON.parse(await check.evaluate((k) => localStorage.getItem(k), STATE_KEY))
      .schedule.rounds[0].matches[1].result).toEqual({ left: '20', right: '4' });
    await check.close();
  });

  test('Leaving asks nothing when the save on leaving is the first to fail', async ({ page }) => {
    const prompts = [];
    page.on('dialog', (dialog) => { prompts.push(dialog.type()); dialog.accept(); });
    const warnings = [];
    page.on('console', (message) => { if (message.type() === 'warning') warnings.push(message.text()); });
    await refuseStateWritesOnDemand(page);
    await page.goto('/');
    // Given every change saved, no warning ever shown,
    await startTournament(page, 'First Cup');
    await leftScore(page, 0).fill('10');
    await expect.poll(async () => (await storedJson(page, STATE_KEY)).schedule.rounds[0].matches[0].result)
      .toEqual({ left: '10', right: '14' });
    await expectNoWarning(page);
    // and storage that refuses the state from now on, nothing changed since,
    await setStateWritesFailing(page, true);
    expect(warnings.filter((w) => w.includes(STATE_KEY))).toEqual([]);

    // when the Organizer closes the page,
    const closed = page.waitForEvent('close');
    await page.close({ runBeforeUnload: true });
    await closed;

    // then the save on leaving was tried and refused, yet nothing asked (the
    // Organizer was never warned, and every change was saved), and the page closed.
    expect(warnings.some((w) => w.includes('Could not write localStorage value') && w.includes(STATE_KEY))).toBe(true);
    expect(prompts).toEqual([]);
  });

  test('A legacy migration whose writes fail on load does not show the auto-save warning', async ({ page, context }) => {
    const errors = collectErrors(page);
    // Given a tournament and a saved list under the legacy keys only,
    const donor = await context.newPage();
    await donor.goto('/');
    await startTournament(donor, 'Legacy Cup');
    const rawState = await storedRaw(donor, STATE_KEY);
    await donor.close();
    const rawSaved = JSON.stringify([{
      tournamentName: 'Saved Cup', schedule: JSON.parse(rawState).schedule, currentRoundIndex: 0, courtNames: [],
      format: 'americano', mexicanoSeed: null, totalPoints: 24, savedAt: '2026-01-01T00:00:00.000Z',
    }]);
    // and storage that refuses the migrated copy of the state (only that first
    // state write) and the saved list's migrated marker.
    await page.addInitScript((keys) => {
      for (const key of [keys.STATE_KEY, keys.SAVED_TOURNAMENTS_KEY, keys.STATE_MIGRATED_KEY,
        keys.SAVED_TOURNAMENTS_MIGRATED_KEY]) localStorage.removeItem(key);
      localStorage.setItem(keys.LEGACY_STATE_KEY, keys.rawState);
      localStorage.setItem(keys.LEGACY_SAVED_TOURNAMENTS_KEY, keys.rawSaved);
      let stateWrites = 0;
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === keys.STATE_KEY && stateWrites++ === 0) throw new DOMException('Storage is full', 'QuotaExceededError');
        if (key === keys.SAVED_TOURNAMENTS_MIGRATED_KEY) throw new DOMException('Storage is full', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
    }, {
      STATE_KEY, SAVED_TOURNAMENTS_KEY, STATE_MIGRATED_KEY, SAVED_TOURNAMENTS_MIGRATED_KEY,
      LEGACY_STATE_KEY, LEGACY_SAVED_TOURNAMENTS_KEY, rawState, rawSaved,
    });

    // When the app loads,
    await page.goto('/');

    // then both migrations ran into the refused writes and are pending: the
    // tournament resumes from the state's copy, whose auto-save on restoring
    // (the second state write) worked and so completed its migration, and the
    // saved list is offered from its copy, which is not stored without its marker,
    await expect(page.locator('#tournamentTitle')).toHaveText('Legacy Cup');
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    expect((await storedJson(page, STATE_KEY)).tournamentName).toBe('Legacy Cup');
    expect(await storedRaw(page, STATE_MIGRATED_KEY)).not.toBeNull();
    await expect(page.locator('#savedTournamentSelect option')).toContainText(['Saved Cup']);
    expect(await storedRaw(page, SAVED_TOURNAMENTS_KEY)).toBeNull();
    expect(await storedRaw(page, SAVED_TOURNAMENTS_MIGRATED_KEY)).toBeNull();
    // but that is no auto-save failure: no warning, now or once the app auto-saves.
    await expectNoWarning(page);
    await leftScore(page, 0).fill('10');
    await expect.poll(async () => (await storedJson(page, STATE_KEY)).schedule.rounds[0].matches[0].result)
      .toEqual({ left: '10', right: '14' });
    await expectNoWarning(page);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('console.error: Could not write the migrated copy of a legacy localStorage value');
    expect(errors[0]).toContain(LEGACY_STATE_KEY);
    expect(errors[1]).toContain('console.error: Could not write the migrated copy of a legacy localStorage value');
    expect(errors[1]).toContain(LEGACY_SAVED_TOURNAMENTS_KEY);
  });

  test('A backup write that fails on load does not show the auto-save warning', async ({ page }) => {
    const errors = collectErrors(page);
    const warnings = [];
    page.on('console', (message) => { if (message.type() === 'warning') warnings.push(message.text()); });
    // Given an unusable stored state, and storage that refuses its backup (each
    // refused backup write counted),
    await page.addInitScript((keys) => {
      localStorage.setItem(keys.STATE_KEY, '{"schedule": ');
      localStorage.removeItem(keys.STATE_BACKUP_KEY);
      window.refusedBackupWrites = 0;
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === keys.STATE_BACKUP_KEY) {
          window.refusedBackupWrites++;
          throw new DOMException('Storage is full', 'QuotaExceededError');
        }
        return setItem.call(this, key, value);
      };
    }, { STATE_KEY, STATE_BACKUP_KEY });

    // when the app loads and falls back to a fresh setup, its one backup write
    // attempted and refused (so a failed write did happen on this page),
    await page.goto('/');
    await expect(page.locator('#settingsContainer')).toBeVisible();
    await expect(page.locator('.round')).toHaveCount(0);
    expect(await page.evaluate(() => window.refusedBackupWrites)).toBe(1);
    expect(await storedRaw(page, STATE_BACKUP_KEY)).toBeNull();
    expect(warnings.some((w) => w.includes('Could not back up the stored tournament state'))).toBe(true);

    // then there is no warning, now or once the app auto-saves.
    await expectNoWarning(page);
    await startTournament(page, 'Fresh Cup');
    await leftScore(page, 0).fill('10');
    await expect.poll(async () => (await storedJson(page, STATE_KEY)).schedule.rounds[0].matches[0].result)
      .toEqual({ left: '10', right: '14' });
    await expectNoWarning(page);
    expect(errors).toEqual([]);
  });

  // Site data blocked: the browser refuses every call on the storage, or the
  // storage object itself (as Chromium does when a site's data is blocked).
  // Either refusal is a DOMException SecurityError, as real Chromium and Firefox
  // throw with a site's data blocked. Or storage is disabled: window.localStorage
  // is null (Firefox with dom.storage.enabled=false), so every use of it throws a
  // TypeError. window.liftStorageRefusal() lifts it again in the page, as when
  // the Organizer unblocks the site's data.
  const refuseEveryStorageCall = () => {
    const originals = {};
    for (const method of ['getItem', 'setItem', 'removeItem', 'key', 'clear']) {
      originals[method] = Storage.prototype[method];
      Storage.prototype[method] = function () { throw new DOMException('The operation is insecure.', 'SecurityError'); };
    }
    window.liftStorageRefusal = () => Object.assign(Storage.prototype, originals);
  };
  const refuseTheStorageObject = () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('Access is denied for this document.', 'SecurityError'); },
    });
    window.liftStorageRefusal = () => {
      if (original) Object.defineProperty(window, 'localStorage', original);
      else delete window.localStorage;
    };
  };
  const disableTheStorage = () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { return null; } });
    window.liftStorageRefusal = () => {
      if (original) Object.defineProperty(window, 'localStorage', original);
      else delete window.localStorage;
    };
  };
  // What reading storage in the page then gives: a refusal names its
  // DOMException, disabled storage is null.
  const probeTheStorage = (page) => page.evaluate(() => {
    try {
      if (localStorage === null) return 'null';
      localStorage.getItem('probe');
      return 'readable';
    } catch (err) {
      return err instanceof DOMException ? err.name : `not a DOMException: ${err}`;
    }
  });
  const BLOCKED_STARTS = [
    ['every storage call is refused', refuseEveryStorageCall, 'SecurityError', 'Americano'],
    ['the storage object itself is refused', refuseTheStorageObject, 'SecurityError', 'Americano'],
    ['storage is disabled (localStorage is null)', disableTheStorage, 'null', 'Americano'],
    ['every storage call is refused', refuseEveryStorageCall, 'SecurityError', 'Mexicano'],
  ];
  for (const [description, block, probed, format] of BLOCKED_STARTS) {
    test(`R-STATE-PERSIST: when ${description}, a tournament (${format}) still starts and the auto-save warning shows`, async ({ page }) => {
      const errors = collectErrors(page);
      const dialogs = collectDialogs(page);
      await page.addInitScript(block);
      // Given the browser refuses all storage,
      await page.goto('/');
      expect(await probeTheStorage(page)).toBe(probed);
      await expect(page.locator('#settingsContainer')).toBeVisible();
      if (format === 'Mexicano') await page.selectOption('#formatSelect', 'mexicano');

      // when the Organizer starts a tournament,
      await startTournament(page, 'Blocked Cup');

      // then the tournament starts, under the name given (no saved list to clash with),
      await expect(page.locator('#tournamentTitle')).toHaveText('Blocked Cup');
      await expect(page.locator('#tournamentName')).toHaveValue('Blocked Cup');
      await expect(page.locator('#settingsContainer')).toBeHidden();
      await expect(page.locator('.court')).toHaveCount(3);
      await expect(page.locator('.scoreboard-container table tr')).toHaveCount(13);
      // the warning that progress is not being saved is shown,
      await expectTheWarning(page);
      // and the tournament plays on.
      await leftScore(page, 0).fill('15');
      await expect(rightScore(page, 0)).toHaveValue('9');
      await expectTheWarning(page);
      // Nothing threw and nothing alerted: the errors logged are the load's, the
      // two legacy migrations and the saved-tournament list, none of which can read.
      expect(dialogs).toEqual([]);
      expect(errors).toEqual([
        expect.stringContaining('console.error: Could not migrate a legacy localStorage value'),
        expect.stringContaining('console.error: Could not migrate a legacy localStorage value'),
        expect.stringContaining('console.error: Could not list the saved tournaments'),
      ]);
    });
  }

  // A tournament the app saves under name, and again under each of moreNames,
  // on a page of its own (the saved list is shared by every page of the
  // origin), and the saved list as it then stands.
  async function saveATournamentAs(context, name, ...moreNames) {
    const donor = await context.newPage();
    donor.on('dialog', (dialog) => dialog.accept());
    await donor.goto('/');
    await startTournament(donor, name);
    await leftScore(donor, 0).fill('10');
    await donor.click('#saveTournamentBtn');
    await expect.poll(() => storedRaw(donor, SAVED_TOURNAMENTS_KEY)).not.toBeNull();
    if (moreNames.length > 0) await donor.click('#toggleSettingsBtn'); // the name is among the settings
    for (const [i, more] of moreNames.entries()) {
      await donor.fill('#tournamentName', more);
      await donor.click('#saveTournamentBtn');
      await expect.poll(async () => (await storedJson(donor, SAVED_TOURNAMENTS_KEY)).length).toBe(i + 2);
    }
    const savedList = await storedJson(donor, SAVED_TOURNAMENTS_KEY);
    await donor.close();
    expect(savedList.map((t) => t.tournamentName)).toEqual([name, ...moreNames]);
    return savedList;
  }

  // The errors logged by a page loaded with storage refused: the load's, which
  // could not read storage (the two legacy migrations and the saved-tournament list).
  // DEFERRED: AB#104 (use it in place of the inlined arrays; share liftStorageRefusal)
  const LOAD_ERRORS_WITH_STORAGE_REFUSED = [
    expect.stringContaining('console.error: Could not migrate a legacy localStorage value'),
    expect.stringContaining('console.error: Could not migrate a legacy localStorage value'),
    expect.stringContaining('console.error: Could not list the saved tournaments'),
  ];

  // A tournament started as name while the browser refused all storage (block),
  // so Start could not check the name against the saved tournaments; storage then
  // works again.
  async function startUncheckedThenRecover(page, name, block = refuseEveryStorageCall) {
    await page.addInitScript(block);
    await page.goto('/');
    await startTournament(page, name);
    await expect(page.locator('#tournamentName')).toHaveValue(name);
    await expectTheWarning(page);
    await page.evaluate(() => window.liftStorageRefusal());
  }

  // A saved tournament as the app writes it back whenever it rewrites the saved
  // list: its schedule keeps only the players and the rounds.
  const asRewritten = (entry) =>
    ({ ...entry, schedule: { players: entry.schedule.players, rounds: entry.schedule.rounds } });

  // Start could not check the name against the saved tournaments (storage
  // refused), so the tournament runs under the name of an older saved one. Once
  // storage works again, a write to the saved list, which matches by name,
  // checks the name first and renames the tournament to the unique name: the
  // older save is never replaced nor deleted.
  const UNCHECKED_NAME_WRITES = [
    ['Save', refuseEveryStorageCall, 'every storage call was refused'],
    ['Save', refuseTheStorageObject, 'the storage object itself was refused'],
    ['Save', disableTheStorage, 'storage was disabled (localStorage was null)'],
    ['Delete', refuseEveryStorageCall, 'every storage call was refused'],
    ['New Tournament, saving first', refuseEveryStorageCall, 'every storage call was refused'],
  ];
  for (const [action, block, description] of UNCHECKED_NAME_WRITES) {
    test(`R-NAME-UNIQUE, R-TOURNAMENT-STORE: when ${description} at Start, ${action} once storage works again keeps the older save of the same name`, async ({ page, context }) => {
      const errors = collectErrors(page);
      const dialogs = collectDialogs(page);
      // Given a saved tournament "Blocked Cup",
      const olderList = await saveATournamentAs(context, 'Blocked Cup');
      // and a tournament of that name started while the browser refused all storage,
      await page.addInitScript(block);
      await page.goto('/');
      await startTournament(page, 'Blocked Cup');
      await expect(page.locator('#tournamentName')).toHaveValue('Blocked Cup');
      await expectTheWarning(page);
      // when storage works again
      await page.evaluate(() => window.liftStorageRefusal());
      expect(await storedJson(page, SAVED_TOURNAMENTS_KEY)).toEqual(olderList);

      // and the Organizer uses the action,
      if (action === 'Save') {
        await page.click('#saveTournamentBtn');
        await expect.poll(() => dialogs.length).toBe(1);
        expect(dialogs).toEqual(['Tournament saved!']);
      } else if (action === 'Delete') {
        await page.click('#toggleSettingsBtn'); // Delete is among the settings
        await page.click('#deleteTournamentBtn');
        await expect.poll(() => dialogs.length).toBe(2);
      } else {
        await page.click('#newTournamentBtn');
        await expect.poll(() => dialogs.length).toBe(3);
        expect(dialogs).toEqual([
          'Do you want to save the current tournament before creating a new one?',
          'Tournament saved!',
          'Ready for a new tournament!',
        ]);
      }

      // then the older save of that name is kept unchanged,
      const savedList = await storedJson(page, SAVED_TOURNAMENTS_KEY);
      expect(savedList[0]).toEqual(asRewritten(olderList[0]));
      if (action === 'Delete') {
        // and the delete removed nothing else (the running tournament was never
        // saved): it was asked for, and reported, under the unique name.
        expect(savedList).toHaveLength(1);
        expect(dialogs[0]).toContain('Are you sure you want to delete "Blocked Cup-1"?');
        expect(dialogs[1]).toBe('Tournament "Blocked Cup-1" deleted!');
      } else {
        // and the running tournament is saved beside it, under the unique name.
        expect(savedList.map((t) => t.tournamentName)).toEqual(['Blocked Cup', 'Blocked Cup-1']);
        expect(savedList[1].schedule).not.toEqual(olderList[0].schedule);
      }
      if (action === 'Save') {
        // The running tournament now carries the unique name, on screen and stored,
        await expect(page.locator('#tournamentName')).toHaveValue('Blocked Cup-1');
        await expect(page.locator('#tournamentTitle')).toHaveText('Blocked Cup-1');
        expect((await storedJson(page, STATE_KEY)).tournamentName).toBe('Blocked Cup-1');
        // and, its name checked now, a second Save replaces its own save only.
        await page.click('#saveTournamentBtn');
        await expect.poll(() => dialogs.length).toBe(2);
        expect(dialogs[1]).toBe('Tournament saved!');
        const resaved = await storedJson(page, SAVED_TOURNAMENTS_KEY);
        expect(resaved.map((t) => t.tournamentName)).toEqual(['Blocked Cup', 'Blocked Cup-1']);
        expect(resaved[0]).toEqual(asRewritten(olderList[0]));
      }
      // The errors logged are the load's, which could not read storage.
      expect(errors).toEqual([
        expect.stringContaining('console.error: Could not migrate a legacy localStorage value'),
        expect.stringContaining('console.error: Could not migrate a legacy localStorage value'),
        expect.stringContaining('console.error: Could not list the saved tournaments'),
      ]);
    });
  }

  // Only an error from storage itself (reading the saved list's key) lets Start
  // go on with the name unchecked. An error past that read, in the migration
  // lookup or the copy layer (pendingMigrationFor, copySavedTournamentList), is
  // a bug, not a storage refusal, and must never switch the check off: here the
  // copy layer throws a TypeError, as a null storage does at the read. (An
  // unparsable list throws nothing: parseStoredJson logs it and the list reads
  // as empty.)
  // DEFERRED: AB#104 (retag R-STATE-PERSIST; weak for R-NAME-UNIQUE)
  test('R-NAME-UNIQUE: an error in the saved list\'s copy layer stops Start rather than skipping the name check', async ({ page }) => {
    const errors = collectErrors(page);
    const dialogs = collectDialogs(page);
    // Given readable storage, and a copy layer for the saved list that fails,
    await page.goto('/');
    await expect(page.locator('#settingsContainer')).toBeVisible();
    expect(await probeTheStorage(page)).toBe('readable');
    await page.evaluate(() => {
      window.copySavedTournamentList = () => { throw new TypeError('not a storage refusal'); };
    });

    // when the Organizer starts a tournament,
    await page.fill('#tournamentName', 'Bug Cup');
    await page.click('#startTournamentBtn');

    // then the error surfaces and the tournament does not start.
    await expect.poll(() => errors.length).toBe(1);
    expect(errors).toEqual([expect.stringContaining('not a storage refusal')]);
    expect(errors[0]).toMatch(/^pageerror: /);
    await expect(page.locator('#settingsContainer')).toBeVisible();
    await expect(page.locator('#startTournamentBtn')).toBeEnabled();
    await expect(page.locator('.round-header')).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });

  // The safeguard is bound to the name that went unchecked at Start: once the
  // Organizer has typed another name, Save replaces, and Delete deletes, the
  // saved tournament of that name, as for any tournament.
  const RETYPED_NAME_WRITES = [
    ['Save', 'R-TOURNAMENT-STORE, R-NAME-UNIQUE', 'replaces'],
    ['Delete', 'R-TOURNAMENT-STORE', 'deletes'],
  ];
  for (const [action, tags, outcome] of RETYPED_NAME_WRITES) {
    test(`${tags}: after an unchecked Start and storage working again, ${action} under another saved name the Organizer typed ${outcome} that save`, async ({ page, context }) => {
      const errors = collectErrors(page);
      const dialogs = collectDialogs(page);
      // Given saved tournaments "Blocked Cup" and "Old Cup",
      const olderList = await saveATournamentAs(context, 'Blocked Cup', 'Old Cup');
      // and a tournament "Blocked Cup" started while storage was refused, which works again,
      await startUncheckedThenRecover(page, 'Blocked Cup');
      // when the Organizer types the other saved name, "Old Cup",
      await page.click('#toggleSettingsBtn'); // the name is among the settings
      await page.fill('#tournamentName', 'Old Cup');
      await expect(page.locator('#tournamentTitle')).toHaveText('Old Cup');

      // and uses the action,
      if (action === 'Save') {
        await page.click('#saveTournamentBtn');
        await expect.poll(() => dialogs.length).toBe(1);
        // then the running tournament replaces the save "Old Cup", under that name,
        expect(dialogs).toEqual(['Tournament saved!']);
        const savedList = await storedJson(page, SAVED_TOURNAMENTS_KEY);
        expect(savedList.map((t) => t.tournamentName)).toEqual(['Blocked Cup', 'Old Cup']);
        expect(savedList[0]).toEqual(asRewritten(olderList[0]));
        expect(savedList[1].schedule).not.toEqual(olderList[1].schedule);
        await expect(page.locator('#tournamentName')).toHaveValue('Old Cup');
        await expect(page.locator('#tournamentTitle')).toHaveText('Old Cup');
        // and once the Organizer types the unchecked name back, it is checked:
        // a Save keeps the older "Blocked Cup" and saves under the unique name.
        await page.fill('#tournamentName', 'Blocked Cup');
        await page.click('#saveTournamentBtn');
        await expect.poll(() => dialogs.length).toBe(2);
        expect(dialogs[1]).toBe('Tournament saved!');
        await expect(page.locator('#tournamentName')).toHaveValue('Blocked Cup-1');
        const resaved = await storedJson(page, SAVED_TOURNAMENTS_KEY);
        expect(resaved.map((t) => t.tournamentName)).toEqual(['Blocked Cup', 'Old Cup', 'Blocked Cup-1']);
        expect(resaved[0]).toEqual(asRewritten(olderList[0]));
      } else {
        await page.click('#deleteTournamentBtn');
        await expect.poll(() => dialogs.length).toBe(2);
        // then the save "Old Cup" is deleted, as asked and reported, and "Blocked Cup" kept.
        expect(dialogs).toEqual([
          'Are you sure you want to delete "Old Cup"? Your secret sauce will vanish forever!',
          'Tournament "Old Cup" deleted!',
        ]);
        expect(await storedJson(page, SAVED_TOURNAMENTS_KEY)).toEqual([asRewritten(olderList[0])]);
      }
      expect(errors).toEqual(LOAD_ERRORS_WITH_STORAGE_REFUSED);
    });
  }

  // Delete names, in its confirmation, what it will delete: for an unchecked
  // name, the unique name it is checked to. A Delete the Organizer cancels
  // changes nothing: the rename is applied only once Delete goes ahead.
  test('R-TOURNAMENT-STORE, R-NAME-UNIQUE: after an unchecked Start, a cancelled Delete leaves the name, the title and the stored state unchanged', async ({ page, context }) => {
    const errors = collectErrors(page);
    const dialogs = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      if (dialog.type() === 'confirm') dialog.dismiss();
      else dialog.accept();
    });
    // Given a saved tournament "Blocked Cup",
    const olderList = await saveATournamentAs(context, 'Blocked Cup');
    // and a tournament of that name started while storage was refused, which works again,
    await startUncheckedThenRecover(page, 'Blocked Cup');
    await page.click('#toggleSettingsBtn'); // Delete is among the settings
    const storedState = await storedRaw(page, STATE_KEY);
    const storedList = await storedRaw(page, SAVED_TOURNAMENTS_KEY);

    // when the Organizer clicks Delete and cancels it,
    await page.click('#deleteTournamentBtn');
    await expect.poll(() => dialogs.length).toBe(1);

    // then the confirmation named the save it would delete, under the unique name,
    expect(dialogs).toEqual(['Are you sure you want to delete "Blocked Cup-1"? Your secret sauce will vanish forever!']);
    // and nothing changed: the name, the title, the stored state and the saved list,
    await expect(page.locator('#tournamentName')).toHaveValue('Blocked Cup');
    await expect(page.locator('#tournamentTitle')).toHaveText('Blocked Cup');
    expect(await storedRaw(page, STATE_KEY)).toBe(storedState);
    expect(await storedRaw(page, SAVED_TOURNAMENTS_KEY)).toBe(storedList);
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    // and the name is still checked before a write: a Save keeps the older save.
    await page.click('#saveTournamentBtn');
    await expect.poll(() => dialogs.length).toBe(2);
    expect(dialogs[1]).toBe('Tournament saved!');
    await expect(page.locator('#tournamentName')).toHaveValue('Blocked Cup-1');
    const savedList = await storedJson(page, SAVED_TOURNAMENTS_KEY);
    expect(savedList.map((t) => t.tournamentName)).toEqual(['Blocked Cup', 'Blocked Cup-1']);
    expect(savedList[0]).toEqual(asRewritten(olderList[0]));
    expect(errors).toEqual(LOAD_ERRORS_WITH_STORAGE_REFUSED);
  });

  // Load replaces the running tournament with a saved one, whose name is its
  // own: the name that went unchecked at Start is no longer held. (The list to
  // load from is only shown once a Save under another name has read it.)
  test('R-TOURNAMENT-STORE: after an unchecked Start, a loaded tournament of the same name saves over its own entry', async ({ page, context }) => {
    const errors = collectErrors(page);
    const dialogs = collectDialogs(page);
    // Given a saved tournament "Blocked Cup",
    const olderList = await saveATournamentAs(context, 'Blocked Cup');
    // a tournament of that name started while storage was refused, which works again,
    await startUncheckedThenRecover(page, 'Blocked Cup');
    // and saved under another name, which lists the saved tournaments,
    await page.click('#toggleSettingsBtn');
    await page.fill('#tournamentName', 'Other Cup');
    await page.click('#saveTournamentBtn');
    await expect.poll(() => dialogs.length).toBe(1);
    await expect(page.locator('#savedTournamentSelect option')).toHaveCount(2);
    // when the Organizer loads the saved "Blocked Cup",
    await page.selectOption('#savedTournamentSelect', '0');
    await page.click('#loadTournamentBtn');
    await expect(page.locator('#tournamentName')).toHaveValue('Blocked Cup');

    // and saves it,
    await page.click('#saveTournamentBtn');
    await expect.poll(() => dialogs.length).toBe(2);

    // then it replaces its own entry, under its own name, with no "-1" copy.
    expect(dialogs).toEqual(['Tournament saved!', 'Tournament saved!']);
    await expect(page.locator('#tournamentName')).toHaveValue('Blocked Cup');
    await expect(page.locator('#tournamentTitle')).toHaveText('Blocked Cup');
    const savedList = await storedJson(page, SAVED_TOURNAMENTS_KEY);
    expect(savedList.map((t) => t.tournamentName)).toEqual(['Blocked Cup', 'Other Cup']);
    expect(savedList[0].schedule).toEqual(asRewritten(olderList[0]).schedule);
    expect(errors).toEqual(LOAD_ERRORS_WITH_STORAGE_REFUSED);
  });

  // A Save while storage still refuses the saved list cannot check the name: it
  // fails (the read throws) and changes nothing, so the name stays unchecked.
  test('R-NAME-UNIQUE, R-TOURNAMENT-STORE: a Save still refused after an unchecked Start fails, and the Save once storage works keeps the older save', async ({ page, context }) => {
    const errors = collectErrors(page);
    const dialogs = collectDialogs(page);
    // Given a saved tournament "Blocked Cup",
    const olderList = await saveATournamentAs(context, 'Blocked Cup');
    // and a tournament of that name started while the browser refuses all storage,
    await page.addInitScript(refuseEveryStorageCall);
    await page.goto('/');
    await startTournament(page, 'Blocked Cup');
    await expectTheWarning(page);

    // when the Organizer clicks Save while storage is still refused,
    await page.click('#saveTournamentBtn');
    // then the Save fails, saving and renaming nothing;
    await expect.poll(() => errors.length).toBe(4);
    expect(errors).toEqual([...LOAD_ERRORS_WITH_STORAGE_REFUSED, 'pageerror: The operation is insecure.']);
    expect(dialogs).toEqual([]);
    await expect(page.locator('#tournamentName')).toHaveValue('Blocked Cup');
    await expect(page.locator('#tournamentTitle')).toHaveText('Blocked Cup');

    // when storage works again and the Organizer clicks Save,
    await page.evaluate(() => window.liftStorageRefusal());
    expect(await storedJson(page, SAVED_TOURNAMENTS_KEY)).toEqual(olderList);
    await page.click('#saveTournamentBtn');
    await expect.poll(() => dialogs.length).toBe(1);

    // then the name is checked now: the older save is kept and the running
    // tournament saved beside it, under the unique name.
    expect(dialogs).toEqual(['Tournament saved!']);
    await expect(page.locator('#tournamentName')).toHaveValue('Blocked Cup-1');
    await expect(page.locator('#tournamentTitle')).toHaveText('Blocked Cup-1');
    const savedList = await storedJson(page, SAVED_TOURNAMENTS_KEY);
    expect(savedList.map((t) => t.tournamentName)).toEqual(['Blocked Cup', 'Blocked Cup-1']);
    expect(savedList[0]).toEqual(asRewritten(olderList[0]));
    expect(errors).toHaveLength(4);
  });

  test('The Save button reports its own outcome, apart from the auto-save warning', async ({ page }) => {
    const errors = collectErrors(page);
    const dialogs = collectDialogs(page);
    // Given storage that refuses the saved-tournament list until the test lifts
    // it (the state still saves),
    await refuseStateWritesOnDemand(page);
    await page.addInitScript((savedKey) => {
      window.failSavedWrites = true;
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === savedKey && window.failSavedWrites) throw new DOMException('Storage is full', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
    }, SAVED_TOURNAMENTS_KEY);
    await page.goto('/');
    await startTournament(page, 'Button Cup');
    await leftScore(page, 0).fill('10');

    // when the Organizer saves the tournament, the failure is reported as before
    // (one alert), and the auto-save warning is not shown: the state still saves.
    await page.click('#saveTournamentBtn');
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs).toEqual(['The tournament could not be saved.']);
    await expectNoWarning(page);
    expect((await storedJson(page, STATE_KEY)).schedule.rounds[0].matches[0].result).toEqual({ left: '10', right: '14' });

    // And when the auto-save fails but Save works, Save reports success as before,
    // and the warning stays: the live state is still not being saved.
    await page.evaluate(() => { window.failSavedWrites = false; });
    await setStateWritesFailing(page, true);
    await expectARefusedSave(page, () => leftScore(page, 1).fill('20'));
    await expectTheWarning(page);
    await page.click('#saveTournamentBtn');
    await expect.poll(() => dialogs.length).toBe(2);
    expect(dialogs[1]).toBe('Tournament saved!');
    await expectTheWarning(page);
    expect(errors).toEqual([]);
  });

  // The warning has one element, first in the body, shown in every view: setup,
  // and play (the scoreboard is part of the round view, the settings toggled open
  // during play are the setup panel). It is checked where it is hardest to see:
  // after scrolling down a long page, at a phone and a desktop viewport.
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
    test.describe(`at ${viewport.width}x${viewport.height}`, () => {
      test.use({ viewport });

      test('R-STATE-PERSIST: the warning stays in sight after a score on the last court of a 24-player round, and covers nothing at the top', async ({ page }) => {
        const errors = collectErrors(page);
        await refuseStateWritesOnDemand(page);
        await page.goto('/');
        await chooseSchedule(page, '24p23r.js', 6);
        await startTournament(page, 'Big Cup');
        await expect(leftScore(page, 5)).toBeAttached();
        await expectNoWarning(page);

        // Given storage that refuses the tournament state, when a score is entered
        // on the last court, the page scrolled down to it,
        await leftScore(page, 5).scrollIntoViewIfNeeded();
        await expectScrolledPastTheHeader(page);
        await setStateWritesFailing(page, true);
        await expectARefusedSave(page, () => leftScore(page, 5).fill('10'));
        await expectScrolledPastTheHeader(page);

        // then the warning is in sight, pinned at the top of the viewport,
        await expectTheWarningInSight(page);
        // above the score input just used, not over it,
        const warningBox = await page.locator('#autoSaveWarning').boundingBox();
        expect((await leftScore(page, 5).boundingBox()).y).toBeGreaterThanOrEqual(warningBox.y + warningBox.height);
        // and the score recorded remains on screen,
        await expect(leftScore(page, 5)).toHaveValue('10');
        await expect(rightScore(page, 5)).toHaveValue('14');

        // and at the top of the page it sits above the header, covering nothing.
        await page.evaluate(() => window.scrollTo(0, 0));
        await expectTheWarningInSight(page);
        const topBox = await page.locator('#autoSaveWarning').boundingBox();
        expect(topBox.y + topBox.height).toBeLessThanOrEqual((await page.locator('#header').boundingBox()).y);
        expect(errors).toEqual([]);
      });

      test('The warning stays in sight after a setup change low on the setup page', async ({ page }) => {
        const errors = collectErrors(page);
        await refuseStateWritesOnDemand(page);
        await page.goto('/');
        await chooseSchedule(page, '24p23r.js', 6);
        await expectNoWarning(page);

        // Given storage that refuses the tournament state, when the last court is
        // named in the setup, the page scrolled down to it,
        await page.locator('#courtNameInput_6').scrollIntoViewIfNeeded();
        await expectScrolledPastTheHeader(page);
        await setStateWritesFailing(page, true);
        await expectARefusedSave(page, () => page.fill('#courtNameInput_6', 'Centre Court'));
        await expectScrolledPastTheHeader(page);

        // then the warning is in sight.
        await expectTheWarningInSight(page);
        expect(errors).toEqual([]);
      });
    });
  }
});
