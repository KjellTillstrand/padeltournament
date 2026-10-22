// tests/scoreboard_ranking.spec.js
const { test, expect } = require('@playwright/test');
const { STATE_KEY } = require('./storage-keys');

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

const NameAPlayer = (index, name) => async (actor) => {
  await actor.page.fill(`#playerInput_${index}`, name);
};

// Simulates tampered storage: the 20-character name limit only guards the
// start button, so a restored tournament state can carry any player name.
// The seed is derived from the app's own live state (so it tracks the state
// shape) and installed by an init script, which runs before the app on the
// next load. Writing localStorage from the live page would not stick: the
// app re-saves its in-memory state on beforeunload.
const TamperWithAStoredPlayerName = (hostileName) => async (actor) => {
  const state = JSON.parse(
    await actor.page.evaluate((key) => localStorage.getItem(key), STATE_KEY)
  );
  const originalName = state.schedule.players[0];
  const rename = (name) => (name === originalName ? hostileName : name);
  state.schedule.players = state.schedule.players.map(rename);
  state.schedule.rounds.forEach((round) => {
    round.matches.forEach((match) => {
      match.teams = match.teams.map((team) => team.map(rename));
    });
  });
  await actor.page.addInitScript(({ key, seed }) => {
    localStorage.setItem(key, seed);
  }, { key: STATE_KEY, seed: JSON.stringify(state) });
  await actor.page.reload();
};

const RecordDescendingScores = async (actor) => {
  // Give each match a different, decreasing left-side score so the standings
  // have a distinct, verifiable order.
  const leftInputs = actor.page.locator('.result-overlay-left input');
  const count = await leftInputs.count();
  for (let i = 0; i < count; i++) {
    await leftInputs.nth(i).fill(String(24 - i * 2));
  }
  await actor.page.waitForTimeout(200);
};

// --- Questions ---
const StandingsScores = async (actor) => {
  const rows = actor.page.locator('.scoreboard-container table tr');
  const count = await rows.count();
  const scores = [];
  // Row 0 is the header ("Player" / "Points"); data rows start at index 1.
  for (let i = 1; i < count; i++) {
    const pointsText = await rows.nth(i).locator('td').nth(1).textContent();
    scores.push(parseInt(pointsText, 10));
  }
  return scores;
};

const StandingsRowCount = async (actor) => {
  const rows = actor.page.locator('.scoreboard-container table tr');
  return (await rows.count()) - 1; // exclude header row
};

// --- Planted standings fixtures ---
// Ties are set up exactly by resuming a planted, completed tournament rather than
// by playing one: a full round-robin makes every pair meet, so the "never opposed"
// case only exists in partial schedules. Eight players on two courts; each game is
// [left team, right team, left points, right points] out of 24, or just
// [left team, right team] for a game not scored yet.
const PLAYERS = ['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal'];

// Rounds 1 and 2 scored (totals: Bo 45, Gus 39, Hal 35, Di 23, Ada 21, Flo 13,
// Ed 9, Cy 7), round 3 not scored yet.
const TWO_ROUNDS_SCORED_THIRD_OPEN = [
  [[['Ada', 'Bo'], ['Cy', 'Di'], 21, 3], [['Ed', 'Flo'], ['Gus', 'Hal'], 9, 15]],
  [[['Ada', 'Ed'], ['Bo', 'Gus'], 0, 24], [['Cy', 'Flo'], ['Di', 'Hal'], 4, 20]],
  [[['Ada', 'Flo'], ['Cy', 'Gus']], [['Bo', 'Ed'], ['Di', 'Hal']]],
];

const GOLD = 'rgb(255, 215, 0)';
const SILVER = 'rgb(192, 192, 192)';
const BRONZE = 'rgb(205, 127, 50)';
const GREY = 'rgb(238, 238, 238)';

// Seeds the stored tournament before any app script runs, then opens the app on
// the final round, so the standings cover every game. The players, in player-list
// order, default to PLAYERS; extraState adds fields to the stored state (such as
// totalPoints).
const ResumeACompletedTournament = (rounds, players = PLAYERS, extraState = {}) => async (actor) => {
  const state = {
    schedule: {
      players: players,
      rounds: rounds.map((games, index) => ({
        roundNumber: index + 1,
        matches: games.map(([left, right, leftPoints, rightPoints], court) => ({
          court: court + 1,
          teams: [left, right],
          result: leftPoints === undefined
            ? null
            : { left: String(leftPoints), right: String(rightPoints) },
        })),
      })),
    },
    currentRoundIndex: rounds.length - 1,
    tournamentStarted: true,
    tournamentName: 'Tiebreak',
    courtNames: [],
    format: 'americano',
    ...extraState,
  };
  await actor.page.addInitScript(({ key, seed }) => {
    localStorage.setItem(key, seed);
  }, { key: STATE_KEY, seed: JSON.stringify(state) });
  await actor.page.goto('/');
  await expect(actor.page.locator('.scoreboard-container table tr')).toHaveCount(1 + players.length);
};

// Each standings row, top to bottom: the player, total points, placement and the
// row's rendered colour.
const Standings = async (actor) =>
  actor.page.locator('.scoreboard-container table tr').evaluateAll((rows) =>
    rows.slice(1).map((row) => ({
      player: row.cells[0].textContent,
      points: Number(row.cells[1].textContent),
      placement: Number(row.dataset.placement),
      color: getComputedStyle(row).backgroundColor,
    }))
  );

test.describe('R-SCOREBOARD: Standings ranking and colour coding', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  // @verifies REQ-12
  test('R-SCOREBOARD: Players are ranked by points', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given scores have been recorded across rounds.
    await organizer.attemptsTo(StartTheTournament('Ranking Test'));
    await organizer.attemptsTo(RecordDescendingScores);

    // When the Organizer reviews the standings.
    const scores = await organizer.asksFor(StandingsScores);

    // Then players shall be listed in descending order of total points.
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  // @verifies REQ-12
  test('R-SCOREBOARD: an overshooting score is never credited and leaves the standings as they were', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given scores have been recorded across rounds 1 and 2, with distinct totals
    // in an order unlike the player-list order, and round 3 not scored yet.
    await organizer.attemptsTo(ResumeACompletedTournament(TWO_ROUNDS_SCORED_THIRD_OPEN));
    const ranked = [
      { player: 'Bo', points: 45, placement: 1, color: GOLD },
      { player: 'Gus', points: 39, placement: 2, color: SILVER },
      { player: 'Hal', points: 35, placement: 3, color: BRONZE },
      { player: 'Di', points: 23, placement: 4, color: GREY },
      { player: 'Ada', points: 21, placement: 5, color: GREY },
      { player: 'Flo', points: 13, placement: 6, color: GREY },
      { player: 'Ed', points: 9, placement: 7, color: GREY },
      { player: 'Cy', points: 7, placement: 8, color: GREY },
    ];
    expect(await organizer.asksFor(Standings)).toEqual(ranked);

    // When the Organizer types a round-3 score key by key and overshoots the
    // points total: "25" is no valid score out of 24.
    const leftScore = page.locator('.result-overlay-left input').first();
    await leftScore.pressSequentially('25');
    await expect(leftScore).toHaveValue('25');
    await expect(page.locator('.error-message').first()).toHaveText(/whole number from 0 to 24/);

    // Then the overshooting entry is not credited, and the players are still
    // listed in descending order of total points, exactly as before.
    await expect.poll(() => organizer.asksFor(Standings)).toEqual(ranked);
  });

  // @verifies REQ-12
  test('R-SCOREBOARD: The top three placements are color-coded', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given a ranking with at least four players and no tied totals (after a
    // single round partners always tie, and tied players may share a placement:
    // see R-TIEBREAK-H2H).
    await organizer.attemptsTo(ResumeACompletedTournament([
      [[['Ada', 'Bo'], ['Cy', 'Di'], 21, 3], [['Ed', 'Flo'], ['Gus', 'Hal'], 9, 15]],
      [[['Ada', 'Ed'], ['Bo', 'Gus'], 0, 24], [['Cy', 'Flo'], ['Di', 'Hal'], 4, 20]],
      [[['Ada', 'Flo'], ['Cy', 'Gus'], 12, 12], [['Bo', 'Ed'], ['Di', 'Hal'], 11, 13]],
    ]));
    expect(await organizer.asksFor(StandingsRowCount)).toBeGreaterThanOrEqual(4);

    // When the Organizer reviews the standings.
    const rows = page.locator('.scoreboard-container table tr');

    // Then first place shall be marked gold, second silver, third bronze,
    // and the remaining rows shall be marked light grey.
    await expect(rows.nth(1)).toHaveCSS('background-color', GOLD);
    await expect(rows.nth(2)).toHaveCSS('background-color', SILVER);
    await expect(rows.nth(3)).toHaveCSS('background-color', BRONZE);
    await expect(rows.nth(4)).toHaveCSS('background-color', GREY);
  });

  // @verifies REQ-12
  test('R-SCOREBOARD: player names render as text, never as markup', async ({ page }) => {
    const organizer = theOrganizer(page);
    // Kept within the 20-character player name limit (16 characters).
    const payload = '<svg onload=p=1>';

    // Given the Organizer names a player with an XSS payload.
    await organizer.attemptsTo(NameAPlayer(0, payload));
    await organizer.attemptsTo(StartTheTournament('XSS Regression'));

    // When the Organizer reviews the standings.
    const scoreboard = page.locator('.scoreboard-container');
    await expect(scoreboard.locator('table tr')).toHaveCount(
      1 + (await page.locator('#playerInputsContainer input').count())
    );

    // Then no element shall be injected into the scoreboard,
    await expect(scoreboard.locator('svg')).toHaveCount(0);
    // the name shall render as literal text in a player cell,
    const playerCell = scoreboard.locator('td', { hasText: payload });
    await expect(playerCell).toHaveCount(1);
    expect(await playerCell.textContent()).toBe(payload);
    // and no injected handler shall have run.
    expect(await page.evaluate(() => window.p)).toBeUndefined();
  });

  // @verifies REQ-12
  test('R-SCOREBOARD: a player name restored from tampered storage renders as text, never as markup', async ({ page }) => {
    const organizer = theOrganizer(page);
    // Longer than the 20-character input limit: only reachable via storage.
    const payload = '<img src=x onerror=window.q=1>';

    // Given a started tournament whose stored player name was tampered with.
    await organizer.attemptsTo(StartTheTournament('Tampered Storage'));
    await organizer.attemptsTo(TamperWithAStoredPlayerName(payload));

    // When the returning Organizer's app restores it and shows the standings.
    await expect(page.locator('.round')).toBeVisible();
    const scoreboard = page.locator('.scoreboard-container');
    await expect(scoreboard.locator('table tr')).toHaveCount(
      1 + (await page.locator('#playerInputsContainer input').count())
    );

    // Then no element shall be injected into the scoreboard,
    await expect(scoreboard.locator('img')).toHaveCount(0);
    // the name shall render as literal text in a player cell,
    const playerCell = scoreboard.locator('td', { hasText: payload });
    await expect(playerCell).toHaveCount(1);
    expect(await playerCell.textContent()).toBe(payload);
    // and no injected handler shall have run.
    expect(await page.evaluate(() => window.q)).toBeUndefined();
  });
});

// Every uncaught page error and console.error, for asserting a flow ran cleanly.
function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
  return errors;
}

// Every console.warn text, for asserting a flow reported what it skipped.
function collectWarnings(page) {
  const warnings = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  return warnings;
}

test.describe('Standings without a current round', () => {
  test('changing the points total with no schedule loaded neither throws nor skips the save', async ({ page }) => {
    // Given the default schedule module fails to load, so the app starts on the
    // unknown-module branch with no schedule. The init path reports it in
    // showInitialView step 4; steps 5-6 (the format controls, the setup view) and
    // the rest of the load handler (the saved list, releasing the controls) run
    // after it in the same task, reporting nothing. So the report is the
    // readiness signal: once it is seen, the load handler has finished.
    const errors = collectErrors(page);
    await page.route('**/schedules/12p11r.js', (route) => route.abort());
    await page.goto('/');
    await expect.poll(() => errors).toContain('console.error: No schedule loaded; please load a schedule first.');
    expect(errors).toContain('console.error: Unknown module name: 12p11r.js');

    // When the Organizer changes the points total.
    await page.selectOption('#globalTotalPoints', '32');

    // Then the change is saved, and no page error is thrown on the way.
    await expect.poll(() =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), STATE_KEY)
    ).toMatchObject({ schedule: null, totalPoints: 32 });
    expect(errors.filter((error) => error.startsWith('pageerror:'))).toEqual([]);
  });

  test('a score entered while the round index is outside the schedule warns, neither throws nor skips the save', async ({ page }) => {
    // Given a resumed tournament whose round index has been pushed outside its
    // three rounds. Every restore path normalises a stored index, so the corrupt
    // index is set on the live app (a top-level binding of its script).
    const errors = collectErrors(page);
    const warnings = collectWarnings(page);
    const organizer = theOrganizer(page);
    await organizer.attemptsTo(ResumeACompletedTournament(TWO_ROUNDS_SCORED_THIRD_OPEN));
    const shown = await organizer.asksFor(Standings);
    await page.evaluate(() => { currentRoundIndex = 99; });

    // When the Organizer enters a complete score in the round on screen.
    await page.locator('.result-overlay-left input').first().fill('24');

    // Then the missing round is reported, not hidden,
    await expect.poll(() => warnings).toContain(
      'No standings: round index 99 is not a round of the loaded schedule.'
    );
    // the score is still saved,
    await expect.poll(async () => {
      const state = JSON.parse(await page.evaluate((key) => localStorage.getItem(key), STATE_KEY));
      return state.schedule.rounds[2].matches[0].result;
    }).toEqual({ left: '24', right: '0' });
    // the standings on screen are left as drawn (not redrawn for another round),
    expect(await organizer.asksFor(Standings)).toEqual(shown);
    // and no page error is thrown on the way.
    expect(errors.filter((error) => error.startsWith('pageerror:'))).toEqual([]);
  });
});

test.describe('R-TIEBREAK-H2H: Head-to-head tiebreak, then shared placement', () => {
  // @verifies REQ-44
  test('R-TIEBREAK-H2H: a two-way tie with a mutual game resolves head-to-head', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given Di and Ed end level on 44 points, Di listed first,
    // and Ed beat Di 17-7 in their only mutual game (round 3).
    await organizer.attemptsTo(ResumeACompletedTournament([
      [[['Ada', 'Bo'], ['Cy', 'Di'], 3, 21], [['Ed', 'Flo'], ['Gus', 'Hal'], 23, 1]],
      [[['Ada', 'Ed'], ['Bo', 'Gus'], 4, 20], [['Cy', 'Flo'], ['Di', 'Hal'], 8, 16]],
      [[['Ada', 'Flo'], ['Cy', 'Gus'], 10, 14], [['Bo', 'Ed'], ['Di', 'Hal'], 17, 7]],
    ]));

    // When the Organizer reviews the standings.
    const standings = await organizer.asksFor(Standings);

    // Then the player with more points across their mutual games shall rank higher,
    expect(standings.slice(0, 2)).toEqual([
      { player: 'Ed', points: 44, placement: 1, color: GOLD },
      { player: 'Di', points: 44, placement: 2, color: SILVER },
    ]);
    // and the placements below are unaffected.
    expect(standings.slice(2, 4)).toEqual([
      { player: 'Cy', points: 43, placement: 3, color: BRONZE },
      { player: 'Flo', points: 41, placement: 4, color: GREY },
    ]);
  });

  // @verifies REQ-44
  test('R-TIEBREAK-H2H: the head-to-head winner keeps first place when already listed first', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given Bo and Ed end level on 44 points, Bo listed first,
    // and Bo beat Ed 16-8 in their only mutual game (round 2).
    await organizer.attemptsTo(ResumeACompletedTournament([
      [[['Ada', 'Bo'], ['Cy', 'Di'], 8, 16], [['Ed', 'Flo'], ['Gus', 'Hal'], 16, 8]],
      [[['Ada', 'Ed'], ['Bo', 'Gus'], 8, 16], [['Cy', 'Flo'], ['Di', 'Hal'], 7, 17]],
      [[['Ada', 'Flo'], ['Cy', 'Gus'], 8, 16], [['Bo', 'Ed'], ['Di', 'Hal'], 20, 4]],
    ]));

    // When the Organizer reviews the standings.
    const standings = await organizer.asksFor(Standings);

    // Then the head-to-head winner shall rank higher.
    expect(standings.slice(0, 4)).toEqual([
      { player: 'Bo', points: 44, placement: 1, color: GOLD },
      { player: 'Ed', points: 44, placement: 2, color: SILVER },
      { player: 'Gus', points: 40, placement: 3, color: BRONZE },
      { player: 'Cy', points: 39, placement: 4, color: GREY },
    ]);
  });

  // @verifies REQ-44
  test('R-TIEBREAK-H2H: head-to-head counts points across mutual games, not games won', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given Ada and Cy end level on 43 points and won one mutual game each,
    // but Cy scored more across them: Cy won 19-5 (round 1), Ada won 14-10
    // (round 3), so 29 points to 19.
    await organizer.attemptsTo(ResumeACompletedTournament([
      [[['Ada', 'Bo'], ['Cy', 'Di'], 5, 19], [['Ed', 'Flo'], ['Gus', 'Hal'], 1, 23]],
      [[['Ada', 'Ed'], ['Bo', 'Gus'], 24, 0], [['Cy', 'Flo'], ['Di', 'Hal'], 14, 10]],
      [[['Ada', 'Flo'], ['Cy', 'Gus'], 14, 10], [['Bo', 'Ed'], ['Di', 'Hal'], 17, 7]],
    ]));

    // When the Organizer reviews the standings.
    const standings = await organizer.asksFor(Standings);

    // Then the player with more points across their mutual games shall rank higher.
    expect(standings.slice(0, 4)).toEqual([
      { player: 'Cy', points: 43, placement: 1, color: GOLD },
      { player: 'Ada', points: 43, placement: 2, color: SILVER },
      { player: 'Ed', points: 42, placement: 3, color: BRONZE },
      { player: 'Hal', points: 40, placement: 4, color: GREY },
    ]);
  });

  // @verifies REQ-44
  test('R-TIEBREAK-H2H: a tie with no mutual game is shared, and colours follow the shared placement', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given Di and Hal end level on 57 points and never opposed each other
    // (they were partners in rounds 2 and 3, on separate courts in round 1).
    await organizer.attemptsTo(ResumeACompletedTournament([
      [[['Ada', 'Bo'], ['Cy', 'Di'], 2, 22], [['Ed', 'Flo'], ['Gus', 'Hal'], 2, 22]],
      [[['Ada', 'Ed'], ['Bo', 'Gus'], 7, 17], [['Cy', 'Flo'], ['Di', 'Hal'], 13, 11]],
      [[['Ada', 'Flo'], ['Cy', 'Gus'], 18, 6], [['Bo', 'Ed'], ['Di', 'Hal'], 0, 24]],
    ]));

    // When the Organizer reviews the standings.
    const standings = await organizer.asksFor(Standings);

    // Then both shall share first place, and both shall be marked gold;
    // the next player is third (no second place) and is marked bronze.
    expect(standings.slice(0, 4)).toEqual([
      { player: 'Di', points: 57, placement: 1, color: GOLD },
      { player: 'Hal', points: 57, placement: 1, color: GOLD },
      { player: 'Gus', points: 45, placement: 3, color: BRONZE },
      { player: 'Cy', points: 41, placement: 4, color: GREY },
    ]);
  });

  // @verifies REQ-44
  test('R-TIEBREAK-H2H: a tie level even head-to-head is shared', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given Ada and Cy end level on 48 points, and their two mutual games are
    // level too: Ada won 17-7 in round 1, Cy won 17-7 in round 3.
    await organizer.attemptsTo(ResumeACompletedTournament([
      [[['Ada', 'Bo'], ['Cy', 'Di'], 17, 7], [['Ed', 'Flo'], ['Gus', 'Hal'], 16, 8]],
      [[['Ada', 'Ed'], ['Bo', 'Gus'], 24, 0], [['Cy', 'Flo'], ['Di', 'Hal'], 24, 0]],
      [[['Ada', 'Flo'], ['Cy', 'Gus'], 7, 17], [['Bo', 'Ed'], ['Di', 'Hal'], 3, 21]],
    ]));

    // When the Organizer reviews the standings.
    const standings = await organizer.asksFor(Standings);

    // Then they shall share first place, and colours follow the shared placement.
    expect(standings.slice(0, 4)).toEqual([
      { player: 'Ada', points: 48, placement: 1, color: GOLD },
      { player: 'Cy', points: 48, placement: 1, color: GOLD },
      { player: 'Flo', points: 47, placement: 3, color: BRONZE },
      { player: 'Ed', points: 43, placement: 4, color: GREY },
    ]);
  });

  // @verifies REQ-44
  test('R-TIEBREAK-H2H: a shared placement keeps player-list order for integer-like player names', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given players named "10", "1" and "2", listed in that order, where "10" and
    // "2" end level on 57 points and never opposed each other (the shared-tie
    // fixture above, with Di, Hal and Gus renamed). Integer-like keys enumerate
    // first and in numeric order, so ranking by enumerating names would list
    // "2" before "10".
    await organizer.attemptsTo(ResumeACompletedTournament([
      [[['Ada', 'Bo'], ['Cy', '10'], 2, 22], [['Ed', 'Flo'], ['1', '2'], 2, 22]],
      [[['Ada', 'Ed'], ['Bo', '1'], 7, 17], [['Cy', 'Flo'], ['10', '2'], 13, 11]],
      [[['Ada', 'Flo'], ['Cy', '1'], 18, 6], [['Bo', 'Ed'], ['10', '2'], 0, 24]],
    ], ['Ada', 'Bo', 'Cy', '10', 'Ed', 'Flo', '1', '2']));

    // When the Organizer reviews the standings.
    const standings = await organizer.asksFor(Standings);

    // Then both shall share first place, listed in player-list order, and the
    // colours follow the shared placement.
    expect(standings.slice(0, 4)).toEqual([
      { player: '10', points: 57, placement: 1, color: GOLD },
      { player: '2', points: 57, placement: 1, color: GOLD },
      { player: '1', points: 45, placement: 3, color: BRONZE },
      { player: 'Cy', points: 41, placement: 4, color: GREY },
    ]);
  });

  // @verifies REQ-44
  test('R-TIEBREAK-H2H: a tie of three or more is shared, even when a pair met head-to-head', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given Bo, Di and Gus end level on 45 points, where Di leads Bo 25-23
    // across their mutual games (21-3 in round 1, 4-20 in round 3). Pairwise
    // comparisons can form a cycle, so 3+-way ties fall back to a shared placement.
    await organizer.attemptsTo(ResumeACompletedTournament([
      [[['Ada', 'Bo'], ['Cy', 'Di'], 3, 21], [['Ed', 'Flo'], ['Gus', 'Hal'], 14, 10]],
      [[['Ada', 'Ed'], ['Bo', 'Gus'], 2, 22], [['Cy', 'Flo'], ['Di', 'Hal'], 4, 20]],
      [[['Ada', 'Flo'], ['Cy', 'Gus'], 11, 13], [['Bo', 'Ed'], ['Di', 'Hal'], 20, 4]],
    ]));

    // When the Organizer reviews the standings.
    const standings = await organizer.asksFor(Standings);

    // Then all three shall share first place and be marked gold, in player
    // order; the next player is fourth and is marked light grey.
    expect(standings.slice(0, 4)).toEqual([
      { player: 'Bo', points: 45, placement: 1, color: GOLD },
      { player: 'Di', points: 45, placement: 1, color: GOLD },
      { player: 'Gus', points: 45, placement: 1, color: GOLD },
      { player: 'Cy', points: 38, placement: 4, color: GREY },
    ]);
  });

  // @verifies REQ-44
  test('R-TIEBREAK-H2H: several shared placements in one standings are numbered by competition ranking', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given a live 12-player tournament after round 1, scored 24-0, 22-2 and
    // 20-4: each pair of partners is level and never opposed each other.
    await page.goto('/');
    await organizer.attemptsTo(StartTheTournament('Shared Placements'));
    await organizer.attemptsTo(RecordDescendingScores);

    // When the Organizer reviews the standings.
    const placements = async () =>
      (await organizer.asksFor(Standings)).map(({ points, placement, color }) => ({ points, placement, color }));

    // Then every pair shares a placement, the next placement skips one
    // (1, 1, 3, 3, 5, 5, ...), and the colours follow the shared placements.
    const row = (points, placement, color) => ({ points, placement, color });
    await expect.poll(placements).toEqual([
      row(24, 1, GOLD), row(24, 1, GOLD),
      row(22, 3, BRONZE), row(22, 3, BRONZE),
      row(20, 5, GREY), row(20, 5, GREY),
      row(4, 7, GREY), row(4, 7, GREY),
      row(2, 9, GREY), row(2, 9, GREY),
      row(0, 11, GREY), row(0, 11, GREY),
    ]);
  });
});

// --- The standings while a score is typed (AB#93) ---
// Score entry completes the other side from a single digit, so the "1" typed on
// the way to "12" is a whole result (1-23) for an instant. The app redraws the
// standings only once typing pauses (STANDINGS_REDRAW_DELAY_MS) or the entry
// ends. These tests pause the page's clock (Playwright's fake timers), so the
// redraw timer fires only when a test runs the clock: no keystroke can be slow
// enough to let it fire in between, whatever the machine's speed.
// Any test that fills a partial score (one more digit could still make it a
// valid score: 1-2 out of 16-24, 1-3 out of 32) and then reads the standings
// must leave the input (blur) or poll: the redraw is still pending.
const CLOCK_START = new Date('2026-01-01T10:00:00Z');

const InstallThePageClock = async (actor) => {
  await actor.page.clock.install({ time: CLOCK_START });
};
const PauseThePageClock = async (actor) => {
  await actor.page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60 * 60 * 1000));
};
// Run the paused page clock for ms; any timer due by then fires.
const LetTimePass = (ms) => async (actor) => {
  await actor.page.clock.runFor(ms);
};

// Record, from now on, every standings the page draws: each a list of
// "<player> <points>" rows, top to bottom. A redraw identical to the last one
// is not recorded again.
const WatchTheDrawnStandings = async (actor) => {
  await actor.page.evaluate(() => {
    const drawn = () => Array.from(document.querySelectorAll('.scoreboard-container table tr'))
      .slice(1).map((row) => row.cells[0].textContent + ' ' + row.cells[1].textContent);
    window.drawnStandings = [drawn()];
    new MutationObserver(() => {
      const now = drawn();
      const last = window.drawnStandings[window.drawnStandings.length - 1];
      if (now.join('|') !== last.join('|')) window.drawnStandings.push(now);
    }).observe(document.getElementById('tournamentContainer'), { childList: true, subtree: true });
  });
};
const TheDrawnStandings = async (actor) => actor.page.evaluate(() => window.drawnStandings);
const TheRedrawDelay = async (actor) => actor.page.evaluate(() => STANDINGS_REDRAW_DELAY_MS);
const TheStoredResultOfTheFirstMatch = (roundIndex) => async (actor) => {
  const state = JSON.parse(await actor.page.evaluate((key) => localStorage.getItem(key), STATE_KEY));
  return state.schedule.rounds[roundIndex].matches[0].result;
};

// Type into the first match's left score, key by key, a little faster than the
// redraw delay (the paused clock makes the gap irrelevant to the app's timer).
const TypeTheFirstLeftScore = (keys) => async (actor) => {
  await actor.page.locator('.result-overlay-left input').first().focus();
  await actor.page.keyboard.type(keys, { delay: 50 });
};

// TWO_ROUNDS_SCORED_THIRD_OPEN's standings as "<player> <points>" rows: before
// round 3 is scored, and with its first game (Ada & Flo vs Cy & Gus) at 1-23 and
// at 12-12.
const BEFORE_ROUND_3 = ['Bo 45', 'Gus 39', 'Hal 35', 'Di 23', 'Ada 21', 'Flo 13', 'Ed 9', 'Cy 7'];
const WITH_1_23 = ['Gus 62', 'Bo 45', 'Hal 35', 'Cy 30', 'Di 23', 'Ada 22', 'Flo 14', 'Ed 9'];
const WITH_12_12 = ['Gus 51', 'Bo 45', 'Hal 35', 'Ada 33', 'Flo 25', 'Di 23', 'Cy 19', 'Ed 9'];
const asRows = (standings) => standings.map(({ player, points }) => `${player} ${points}`);
// The full standings (placement and colour too) with that game at 1-23.
const RANKED_WITH_1_23 = [
  { player: 'Gus', points: 62, placement: 1, color: GOLD },
  { player: 'Bo', points: 45, placement: 2, color: SILVER },
  { player: 'Hal', points: 35, placement: 3, color: BRONZE },
  { player: 'Cy', points: 30, placement: 4, color: GREY },
  { player: 'Di', points: 23, placement: 5, color: GREY },
  { player: 'Ada', points: 22, placement: 6, color: GREY },
  { player: 'Flo', points: 14, placement: 7, color: GREY },
  { player: 'Ed', points: 9, placement: 8, color: GREY },
];

test.describe('The standings while a score is typed', () => {
  test.beforeEach(async ({ page }) => {
    const organizer = theOrganizer(page);
    await organizer.attemptsTo(InstallThePageClock);
    await organizer.attemptsTo(ResumeACompletedTournament(TWO_ROUNDS_SCORED_THIRD_OPEN));
    await organizer.attemptsTo(PauseThePageClock);
    expect(asRows(await organizer.asksFor(Standings))).toEqual(BEFORE_ROUND_3);
  });

  // @verifies REQ-12
  test('R-SCOREBOARD: a two-digit score typed key by key ranks the players by its full result, never by its first digit', async ({ page }) => {
    const organizer = theOrganizer(page);
    await organizer.attemptsTo(WatchTheDrawnStandings);

    // When the Organizer types "12" into a round-3 score, key by key.
    await organizer.attemptsTo(TypeTheFirstLeftScore('12'));
    await expect(page.locator('.result-overlay-right input').first()).toHaveValue('12');

    // Then the players are listed in descending order of total points with the
    // game at 12-12, at once (no time has passed on the page),
    expect(await organizer.asksFor(Standings)).toEqual([
      { player: 'Gus', points: 51, placement: 1, color: GOLD },
      { player: 'Bo', points: 45, placement: 2, color: SILVER },
      { player: 'Hal', points: 35, placement: 3, color: BRONZE },
      { player: 'Ada', points: 33, placement: 4, color: GREY },
      { player: 'Flo', points: 25, placement: 5, color: GREY },
      { player: 'Di', points: 23, placement: 6, color: GREY },
      { player: 'Cy', points: 19, placement: 7, color: GREY },
      { player: 'Ed', points: 9, placement: 8, color: GREY },
    ]);
    // and the standings went straight there: the 1-23 order of the first digit
    // was never drawn, not even once the redraw delay has passed.
    await organizer.attemptsTo(LetTimePass(2 * await organizer.asksFor(TheRedrawDelay)));
    expect(await organizer.asksFor(TheDrawnStandings)).toEqual([BEFORE_ROUND_3, WITH_12_12]);
  });

  test('a first digit is saved at once, and its standings are drawn once the redraw delay has passed', async ({ page }) => {
    const organizer = theOrganizer(page);
    const delay = await organizer.asksFor(TheRedrawDelay);
    expect(delay).toBeGreaterThanOrEqual(150);
    expect(delay).toBeLessThanOrEqual(300);

    // When the Organizer types "1" into a round-3 score and pauses.
    await organizer.attemptsTo(TypeTheFirstLeftScore('1'));

    // Then the other side is completed and the 1-23 result is stored at once,
    await expect(page.locator('.result-overlay-right input').first()).toHaveValue('23');
    expect(await organizer.asksFor(TheStoredResultOfTheFirstMatch(2))).toEqual({ left: '1', right: '23' });
    // while the standings wait, until the redraw delay has passed,
    expect(asRows(await organizer.asksFor(Standings))).toEqual(BEFORE_ROUND_3);
    await organizer.attemptsTo(LetTimePass(delay - 1));
    expect(asRows(await organizer.asksFor(Standings))).toEqual(BEFORE_ROUND_3);
    // and then show it.
    await organizer.attemptsTo(LetTimePass(1));
    expect(asRows(await organizer.asksFor(Standings))).toEqual(WITH_1_23);
  });

  // @verifies REQ-12
  test('R-SCOREBOARD: once the Organizer leaves a score input, the standings rank by its score at once', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given the Organizer has typed "1" into a round-3 score,
    await organizer.attemptsTo(TypeTheFirstLeftScore('1'));
    expect(asRows(await organizer.asksFor(Standings))).toEqual(BEFORE_ROUND_3);

    // When the Organizer leaves the input (Tab to the next one), no time passing.
    await page.keyboard.press('Tab');
    await expect(page.locator('.result-overlay-right input').first()).toBeFocused();

    // Then the players are listed in descending order of total points with the
    // game at 1-23, with the medal colours of that order.
    expect(await organizer.asksFor(Standings)).toEqual(RANKED_WITH_1_23);
  });

  // @verifies REQ-12
  test('R-SCOREBOARD: navigating rounds right after typing a score shows the standings with it', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given the Organizer has just typed "1" into a round-3 score,
    await organizer.attemptsTo(TypeTheFirstLeftScore('1'));

    // When the Organizer goes back to round 2 and forward to round 3 again, no
    // time passing on the page. (This guards the requirement end to end, by
    // whatever means the app keeps the standings current: leaving the input,
    // or the round's own redraw.)
    await page.getByRole('button', { name: 'PREVIOUS ROUND', exact: true }).click();
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    // (Round 2's standings cover rounds 1 and 2 only.)
    expect(asRows(await organizer.asksFor(Standings))).toEqual(BEFORE_ROUND_3);
    await page.getByRole('button', { name: 'NEXT ROUND', exact: true }).click();
    await expect(page.locator('.round-header .left')).toHaveText('Round 3');

    // Then round 3's standings rank the players by total points with the game
    // at 1-23, at once, and stay so once the redraw delay has passed.
    expect(await organizer.asksFor(Standings)).toEqual(RANKED_WITH_1_23);
    await organizer.attemptsTo(LetTimePass(2 * await organizer.asksFor(TheRedrawDelay)));
    expect(await organizer.asksFor(Standings)).toEqual(RANKED_WITH_1_23);
  });
});

// Which typed entries make the standings wait, by points total: one that one more
// digit could still turn into another valid score waits (an emptied input too);
// any other is drawn at once, 0 included. One unscored round, so the game typed
// into (Ada & Bo vs Cy & Di) decides the standings alone.
const ONE_ROUND_UNSCORED = [[[['Ada', 'Bo'], ['Cy', 'Di']], [['Ed', 'Flo'], ['Gus', 'Hal']]]];
const ALL_LEVEL = PLAYERS.map((player) => `${player} 0`);
const REDRAW_CASES = [
  // [points total, keys typed into the left score, left score, whether the standings wait]
  [16, '2', 2, false],
  [21, '2', 2, true],
  [21, '3', 3, false],
  [24, '0', 0, false],
  [32, '3', 3, true],
];

test.describe('Which typed scores make the standings wait', () => {
  for (const [total, keys, left, waits] of REDRAW_CASES) {
    test(`out of ${total}, "${keys}" ${waits ? 'waits for the redraw delay' : 'is drawn at once'}`, async ({ page }) => {
      const organizer = theOrganizer(page);
      await organizer.attemptsTo(InstallThePageClock);
      await organizer.attemptsTo(ResumeACompletedTournament(ONE_ROUND_UNSCORED, PLAYERS, { totalPoints: total }));
      await organizer.attemptsTo(PauseThePageClock);
      await organizer.attemptsTo(WatchTheDrawnStandings);
      expect(await organizer.asksFor(TheDrawnStandings)).toEqual([ALL_LEVEL]);

      // When the Organizer types the score, no time passing on the page.
      await organizer.attemptsTo(TypeTheFirstLeftScore(keys));
      await expect(page.locator('.result-overlay-right input').first()).toHaveValue(String(total - left));

      // Then the standings with that result are drawn at once, or only once the
      // redraw delay has passed.
      const withResult = expect.arrayContaining([`Ada ${left}`, `Bo ${left}`, `Cy ${total - left}`, `Di ${total - left}`]);
      if (waits) {
        expect(await organizer.asksFor(TheDrawnStandings)).toEqual([ALL_LEVEL]);
        await organizer.attemptsTo(LetTimePass(await organizer.asksFor(TheRedrawDelay)));
      }
      expect(await organizer.asksFor(TheDrawnStandings)).toEqual([ALL_LEVEL, withResult]);
    });
  }

  test('clearing a score waits for the redraw delay', async ({ page }) => {
    const organizer = theOrganizer(page);
    await organizer.attemptsTo(InstallThePageClock);
    await organizer.attemptsTo(ResumeACompletedTournament(ONE_ROUND_UNSCORED, PLAYERS, { totalPoints: 24 }));
    await organizer.attemptsTo(PauseThePageClock);
    await organizer.attemptsTo(WatchTheDrawnStandings);

    // Given a 5-19 result typed (complete, so drawn at once),
    await organizer.attemptsTo(TypeTheFirstLeftScore('5'));
    const withResult = expect.arrayContaining(['Ada 5', 'Cy 19']);
    expect(await organizer.asksFor(TheDrawnStandings)).toEqual([ALL_LEVEL, withResult]);

    // When the Organizer clears it, no time passing on the page,
    await page.keyboard.press('Backspace');
    await expect(page.locator('.result-overlay-right input').first()).toHaveValue('');

    // Then the standings keep the result until the redraw delay has passed.
    expect(await organizer.asksFor(TheDrawnStandings)).toEqual([ALL_LEVEL, withResult]);
    await organizer.attemptsTo(LetTimePass(await organizer.asksFor(TheRedrawDelay)));
    expect(await organizer.asksFor(TheDrawnStandings)).toEqual([ALL_LEVEL, withResult, ALL_LEVEL]);
  });
});

test.describe('Mexicano pairing right after a score is typed', () => {
  // @verifies REQ-46
  test('R-MEXICANO-PAIRING: generating the next round right after typing a score pairs by the standings with it', async ({ page }) => {
    const organizer = theOrganizer(page);
    const names = ['Ana', 'Ben', 'Cal', 'Dan', 'Eva', 'Fay', 'Gil', 'Hux'];
    const matchesOnScreen = () => page.locator('.matches-container .match').evaluateAll((matches) =>
      matches.map((m) => [m.dataset.teamLeft.split(','), m.dataset.teamRight.split(',')]));

    // Given an 8-player Mexicano tournament on its first round, the page clock
    // paused,
    await organizer.attemptsTo(InstallThePageClock);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await organizer.attemptsTo(PauseThePageClock);
    await page.selectOption('#formatSelect', 'mexicano');
    await page.selectOption('#playerCountSelect', '8');
    for (const [index, name] of names.entries()) await organizer.attemptsTo(NameAPlayer(index, name));
    await organizer.attemptsTo(StartTheTournament('Mexicano Typing'));
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    const [first, second] = await matchesOnScreen();

    // and its first game scored 20-4.
    await page.locator('.result-overlay-left input').nth(0).fill('20');
    await expect(page.locator('.result-overlay-right input').nth(0)).toHaveValue('4');

    // When the Organizer types "1" into the second game's score, completing the
    // round at 1-23, and at once generates the next round. (This guards the
    // requirement end to end, whatever the means: the pairing reads the recorded
    // results, and the click leaves the input first.)
    await page.locator('.result-overlay-left input').nth(1).focus();
    await page.keyboard.type('1');
    await expect(page.locator('.result-overlay-right input').nth(1)).toHaveValue('23');
    await page.locator('#generateNextRoundBtn').click();
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');

    // Then round 2 pairs by the standings with the 1-23 game counted: 23, 20, 4
    // and 1 points per pair of partners, who never opposed each other and so
    // share a placement in player-list order; each four by rank, 1st and 4th
    // against 2nd and 3rd,
    const byListOrder = (pair) => pair.slice().sort((a, b) => names.indexOf(a) - names.indexOf(b));
    const ranking = [
      ...byListOrder(second[1]), ...byListOrder(first[0]),
      ...byListOrder(first[1]), ...byListOrder(second[0]),
    ];
    expect(await matchesOnScreen()).toEqual([
      [[ranking[0], ranking[3]], [ranking[1], ranking[2]]],
      [[ranking[4], ranking[7]], [ranking[5], ranking[6]]],
    ]);
    // and the standings shown are that ranking.
    expect((await organizer.asksFor(Standings)).map(({ player }) => player)).toEqual(ranking);
  });
});
