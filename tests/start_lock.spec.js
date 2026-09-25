// tests/start_lock.spec.js
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

// --- Questions ---
const DisplayedRoundTitle = async (actor) =>
  (await actor.page.locator('.round-header .left').textContent()).trim();

const IsSetupVisible = async (actor) =>
  actor.page.locator('#settingsContainer').isVisible();

const IsSetupDisabled = async (actor) => {
  const scheduleDisabled = await actor.page.locator('#scheduleSelect').isDisabled();
  const totalsDisabled = await actor.page.locator('#globalTotalPoints').isDisabled();
  const startDisabled = await actor.page.locator('#startTournamentBtn').isDisabled();
  return scheduleDisabled && totalsDisabled && startDisabled;
};

test.describe('R-START-LOCK: Starting the tournament begins play and hides setup', () => {
  test.beforeEach(async ({ page }) => {
    // Reset state between tests to avoid the suite's known bleed-through failure mode.
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  // @verifies REQ-8
  test('R-START-LOCK: Starting the tournament begins play and hides setup', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given a schedule is loaded and a valid tournament name is provided.
    await expect(page.locator('#playerInputsContainer')).toBeVisible();

    // When the Organizer starts the tournament.
    await organizer.attemptsTo(StartTheTournament('Lock Test'));

    // Then round 1 and its matches shall be displayed.
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
    await expect(page.locator('.match').first()).toBeVisible();

    // And the setup settings shall be hidden and disabled.
    expect(await organizer.asksFor(IsSetupVisible)).toBe(false);
    expect(await organizer.asksFor(IsSetupDisabled)).toBe(true);
  });
});
