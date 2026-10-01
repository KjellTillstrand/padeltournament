// tests/scoreboard_ranking.spec.js
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

const NameAPlayer = (index, name) => async (actor) => {
  await actor.page.fill(`#playerInput_${index}`, name);
};

// Simulates tampered storage: the 20-character name limit only guards the
// start button, so a restored tournamentState can carry any player name.
// The seed is derived from the app's own live state (so it tracks the state
// shape) and installed by an init script, which runs before the app on the
// next load. Writing localStorage from the live page would not stick: the
// app re-saves its in-memory state on beforeunload.
const TamperWithAStoredPlayerName = (hostileName) => async (actor) => {
  const state = JSON.parse(
    await actor.page.evaluate(() => localStorage.getItem('tournamentState'))
  );
  const originalName = state.schedule.players[0];
  const rename = (name) => (name === originalName ? hostileName : name);
  state.schedule.players = state.schedule.players.map(rename);
  state.schedule.rounds.forEach((round) => {
    round.matches.forEach((match) => {
      match.teams = match.teams.map((team) => team.map(rename));
    });
  });
  await actor.page.addInitScript((seed) => {
    localStorage.setItem('tournamentState', seed);
  }, JSON.stringify(state));
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
// [left team, right team, left points, right points] out of 24.
const PLAYERS = ['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal'];

const GOLD = 'rgb(255, 215, 0)';
const SILVER = 'rgb(192, 192, 192)';
const BRONZE = 'rgb(205, 127, 50)';
const GREY = 'rgb(238, 238, 238)';

// Seeds the stored tournament before any app script runs, then opens the app on
// the final round, so the standings cover every game.
const ResumeACompletedTournament = (rounds) => async (actor) => {
  const state = {
    schedule: {
      players: PLAYERS,
      rounds: rounds.map((games, index) => ({
        roundNumber: index + 1,
        matches: games.map(([left, right, leftPoints, rightPoints], court) => ({
          court: court + 1,
          teams: [left, right],
          result: { left: String(leftPoints), right: String(rightPoints) },
        })),
      })),
    },
    currentRoundIndex: rounds.length - 1,
    tournamentStarted: true,
    tournamentName: 'Tiebreak',
    courtNames: [],
    format: 'americano',
  };
  await actor.page.addInitScript((seed) => {
    localStorage.setItem('tournamentState', seed);
  }, JSON.stringify(state));
  await actor.page.goto('/');
  await expect(actor.page.locator('.scoreboard-container table tr')).toHaveCount(1 + PLAYERS.length);
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
    await expect(rows.nth(1)).toHaveCSS('background-color', 'rgb(255, 215, 0)');
    await expect(rows.nth(2)).toHaveCSS('background-color', 'rgb(192, 192, 192)');
    await expect(rows.nth(3)).toHaveCSS('background-color', 'rgb(205, 127, 50)');
    await expect(rows.nth(4)).toHaveCSS('background-color', 'rgb(238, 238, 238)');
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
