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

    // Given a ranking with at least four players.
    await organizer.attemptsTo(StartTheTournament('Color Coding Test'));
    await organizer.attemptsTo(RecordDescendingScores);
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
    await expect(scoreboard.locator('td', { hasText: payload })).toHaveCount(1);
    // and no injected handler shall have run.
    expect(await page.evaluate(() => window.p)).toBeUndefined();
  });
});
