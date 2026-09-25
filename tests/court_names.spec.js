// tests/court_names.spec.js
//
// NOTE (requirement gap): R-COURT-NAMES also specifies that the Organizer can
// give a court a custom name (e.g. "Center Court") and that the custom name
// persists across reloads. The app has no such affordance: court labels are
// baked into a site's static courts.css as a `::before` pseudo-element per
// court class, are not editable via any UI, and are not part of the
// localStorage-persisted tournament state (see web/index.html and
// web/sites/*/courts.css). Those two scenarios are therefore left untested
// here rather than faked; see the completion report for details.
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
const CourtLabel = (courtNumber) => async (actor) =>
  actor.page.evaluate((n) => {
    const el = document.querySelector(`.court-${n}`);
    if (!el) return null;
    return window.getComputedStyle(el, '::before').content;
  }, courtNumber);

test.describe('R-COURT-NAMES: Courts carry default names', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  // @verifies REQ-7
  test('R-COURT-NAMES: Courts carry default names', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given a schedule is loaded and no custom court names are set.
    await organizer.attemptsTo(StartTheTournament('Court Naming Test'));

    // Then the courts shall be named "Court 1", "Court 2", and so on.
    await expect.poll(() => organizer.asksFor(CourtLabel(1))).toBe('"Court 1"');
    await expect.poll(() => organizer.asksFor(CourtLabel(2))).toBe('"Court 2"');
    await expect.poll(() => organizer.asksFor(CourtLabel(3))).toBe('"Court 3"');
  });
});
