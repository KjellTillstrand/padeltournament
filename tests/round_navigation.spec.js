// tests/round_navigation.spec.js
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

const GoToTheNextRound = async (actor) => {
  await actor.page.getByRole('button', { name: 'NEXT ROUND' }).click();
};

const GoToThePreviousRound = async (actor) => {
  // The app only renders a "previous" affordance when a previous round exists;
  // attempting to go back from round 1 is a no-op because there is nothing to click.
  const previousButton = actor.page.getByRole('button', { name: 'PREVIOUS ROUND' });
  if (await previousButton.count() > 0) {
    await previousButton.click();
  }
};

// By keyboard (AB#94): Tab to a round step from the round's heading (focusable
// from script only), as the Organizer reaches it: PREVIOUS ROUND comes first,
// then NEXT ROUND.
const TabToTheRoundStep = (name) => async (actor) => {
  const { page } = actor;
  await page.locator('.round-header .left').focus();
  await page.keyboard.press('Tab');
  const previous = page.getByRole('button', { name: 'PREVIOUS ROUND', exact: true });
  if (name === 'NEXT ROUND' && await previous.count() > 0) await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name, exact: true })).toBeFocused();
};

// --- Questions ---
const DisplayedRoundTitle = async (actor) =>
  (await actor.page.locator('.round-header .left').textContent()).trim();
// Whether the focused element shows a focus ring (a click must not leave one).
const AFocusRingIsShown = async (actor) =>
  actor.page.evaluate(() => document.activeElement.matches(':focus-visible'));

// A round step (PREVIOUS ROUND, NEXT ROUND) and the heading of the round shown.
const theStep = (page, name) => page.getByRole('button', { name, exact: true });
const theStepOfRound = (page, roundNumber, name) =>
  page.locator(`.round[data-round="${roundNumber}"]`).getByRole('button', { name, exact: true });
const theHeadingOf = (page, roundNumber) =>
  page.getByRole('heading', { name: `Round ${roundNumber}`, level: 2, exact: true });

test.describe('R-ROUND-NAV: Round navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  // @verifies REQ-9
  test('R-ROUND-NAV: The Organizer advances a round', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given a tournament in progress at round 1.
    await organizer.attemptsTo(StartTheTournament('Nav Test Forward'));
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');

    // When the Organizer goes to the next round.
    await organizer.attemptsTo(GoToTheNextRound);

    // Then round 2 and its matches shall be displayed, and the title identifies round 2.
    await expect(page.locator('.round[data-round="2"]')).toBeVisible();
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');
  });

  // @verifies REQ-9
  test('R-ROUND-NAV: The Organizer steps back a round', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given a tournament in progress at round 2.
    await organizer.attemptsTo(StartTheTournament('Nav Test Backward'));
    await organizer.attemptsTo(GoToTheNextRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');

    // When the Organizer goes to the previous round.
    await organizer.attemptsTo(GoToThePreviousRound);

    // Then round 1 and its matches shall be displayed.
    await expect(page.locator('.round[data-round="1"]')).toBeVisible();
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
  });

  // @verifies REQ-9
  test('R-ROUND-NAV: There is no round before the first', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given a tournament in progress at round 1.
    await organizer.attemptsTo(StartTheTournament('Nav Test Floor'));
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
    await expect(page.getByRole('button', { name: 'PREVIOUS ROUND' })).toHaveCount(0);

    // When the Organizer goes to the previous round.
    await organizer.attemptsTo(GoToThePreviousRound);

    // Then round 1 shall remain displayed.
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
  });

  // --- By keyboard (AB#94) ---
  // Each round is drawn anew, its buttons included: focus on the button used must
  // not fall to the page, where the next Tab would start again from the top.

  // @verifies REQ-9
  test('R-ROUND-NAV: Keyboard navigation keeps the Organizer\'s place', async ({ page, browserName }) => {
    // macOS WebKit's Tab skips buttons (a platform default: Full Keyboard Access is off),
    // so this keyboard path runs on Linux WebKit, which CI uses, and not on a Mac.
    test.skip(browserName === 'webkit' && process.platform === 'darwin',
      'DEFERRED: AB#131: macOS WebKit Tab does not reach buttons');
    const organizer = theOrganizer(page);
    const next = theStep(page, 'NEXT ROUND');

    // Given a tournament in progress at round 2.
    await organizer.attemptsTo(StartTheTournament('Nav Keys Forward'), GoToTheNextRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');

    // When the Organizer goes to the next round using the keyboard,
    await organizer.attemptsTo(TabToTheRoundStep('NEXT ROUND'));
    await page.keyboard.press('Enter');

    // Then keyboard focus shall be on the control used, now round 3's,
    await expect(page.locator('.round-header .left')).toHaveText('Round 3');
    await expect(theStepOfRound(page, 3, 'NEXT ROUND')).toBeFocused();
    // and the next Tab goes on from it, not from the top of the page.
    await page.keyboard.press('Tab');
    await expect(page.locator('#saveTournamentBtn')).toBeFocused();

    // When the Organizer keeps going by keyboard (Enter and Space) to the last round,
    await page.keyboard.press('Shift+Tab');
    let round = 3;
    while (await next.count() > 0) {
      expect(round).toBeLessThan(30); // the schedule has an end
      await expect(next).toBeFocused();
      await page.keyboard.press(round % 2 === 0 ? 'Enter' : 'Space');
      round += 1;
      await expect(page.locator('.round-header .left')).toHaveText(`Round ${round}`);
    }

    // Then, NEXT ROUND being gone there, focus shall be on the round title,
    await expect(theHeadingOf(page, round)).toBeFocused();
    // and the next Tab lands on the round's first control.
    await page.keyboard.press('Tab');
    await expect(theStepOfRound(page, round, 'PREVIOUS ROUND')).toBeFocused();
  });

  // @verifies REQ-9
  test('R-ROUND-NAV: Keyboard navigation back keeps the Organizer\'s place, down to round 1', async ({ page, browserName }) => {
    // macOS WebKit's Tab skips buttons (a platform default: Full Keyboard Access is off),
    // so this keyboard path runs on Linux WebKit, which CI uses, and not on a Mac.
    test.skip(browserName === 'webkit' && process.platform === 'darwin',
      'DEFERRED: AB#131: macOS WebKit Tab does not reach buttons');
    const organizer = theOrganizer(page);

    // Given a tournament in progress at round 3.
    await organizer.attemptsTo(StartTheTournament('Nav Keys Backward'), GoToTheNextRound, GoToTheNextRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 3');

    // When the Organizer goes to the previous round using the keyboard,
    await organizer.attemptsTo(TabToTheRoundStep('PREVIOUS ROUND'));
    await page.keyboard.press('Enter');

    // Then keyboard focus shall be on the control used, now round 2's,
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    await expect(theStepOfRound(page, 2, 'PREVIOUS ROUND')).toBeFocused();
    // and the next Tab goes on from it.
    await page.keyboard.press('Tab');
    await expect(theStepOfRound(page, 2, 'NEXT ROUND')).toBeFocused();

    // When the Organizer goes back once more, to round 1 (Space this time),
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Space');

    // Then, PREVIOUS ROUND being gone there, focus shall be on the round title,
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(theStep(page, 'PREVIOUS ROUND')).toHaveCount(0);
    await expect(theHeadingOf(page, 1)).toBeFocused();
    // and the next Tab lands on the round's first control.
    await page.keyboard.press('Tab');
    await expect(theStepOfRound(page, 1, 'NEXT ROUND')).toBeFocused();
  });

  // @verifies REQ-9
  test('R-ROUND-NAV: Navigating by click or tap moves no focus the Organizer did not put on the control', async ({ page }) => {
    const organizer = theOrganizer(page);

    // Given a tournament in progress, with focus outside the round (the settings toggle),
    await organizer.attemptsTo(StartTheTournament('Nav Pointer'));
    const settingsToggle = page.locator('#toggleSettingsBtn');
    await settingsToggle.focus();
    await expect(settingsToggle).toBeFocused();

    // When the Organizer goes to the next round and back by a click that does not
    // focus the button (a tap, or a click on macOS),
    await theStep(page, 'NEXT ROUND').dispatchEvent('click');
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    // Then focus stays where it was, on the next round as on round 1 (where the
    // title would stand in for the missing PREVIOUS ROUND).
    await expect(settingsToggle).toBeFocused();
    await theStep(page, 'PREVIOUS ROUND').dispatchEvent('click');
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(settingsToggle).toBeFocused();

    // When the Organizer goes on by mouse click (which may focus the button),
    await organizer.attemptsTo(GoToTheNextRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');
    // Then the round title does not take focus, and no focus ring is shown.
    await expect(theHeadingOf(page, 2)).not.toBeFocused();
    expect(await organizer.asksFor(AFocusRingIsShown)).toBe(false);
    await organizer.attemptsTo(GoToThePreviousRound);
    expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 1');
    expect(await organizer.asksFor(AFocusRingIsShown)).toBe(false);
  });
});
