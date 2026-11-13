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

  // --- A schedule that fails to load (AB#112) ---
  // New Tournament drops the tournament and loads the default schedule. When that
  // schedule's module is missing (its script failed to load), the round shown
  // before must not stay on screen with live controls over no schedule.

  // One scenario, four variants: the route that drops the tournament (New, or
  // Delete through resetTournamentState) x the format in progress (Americano, or
  // Mexicano, whose round shows the next-round announcement). The titles keep
  // the R-ROUND-NAV: prefix; the first is the round-1 title, unchanged.
  const failedLoadVariants = [
    { route: 'New', format: 'americano',
      title: 'R-ROUND-NAV: A New Tournament whose schedule fails to load leaves no round controls behind' },
    { route: 'Delete', format: 'americano',
      title: 'R-ROUND-NAV: A Delete Tournament whose schedule fails to load leaves no round controls behind' },
    { route: 'New', format: 'mexicano',
      title: 'R-ROUND-NAV: A New Tournament whose schedule fails to load leaves no round controls or announcement behind in Mexicano' },
    { route: 'Delete', format: 'mexicano',
      title: 'R-ROUND-NAV: A Delete Tournament whose schedule fails to load leaves no round controls or announcement behind in Mexicano' },
  ];

  for (const { route, format, title } of failedLoadVariants) {
    // @verifies REQ-9
    test(title, async ({ page }) => {
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const consoleErrors = [];
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      const dialogs = [];
      page.on('dialog', async (dialog) => {
        dialogs.push(dialog.message());
        // New asks "save first?": no. Delete asks "are you sure?": yes. Every alert: OK.
        if (dialog.type() === 'confirm') {
          if (route === 'New') await dialog.dismiss(); else await dialog.accept();
        } else await dialog.accept();
      });
      const organizer = theOrganizer(page);
      const container = page.locator('#tournamentContainer');
      const announcer = page.locator('#nextRoundAnnouncement');

      // Given a tournament in progress at round 2 (Mexicano: round 1, still
      // waiting for scores, so the next-round announcement is set),
      if (format === 'mexicano') {
        await page.selectOption('#formatSelect', 'mexicano');
        await page.selectOption('#playerCountSelect', '8');
        await organizer.attemptsTo(StartTheTournament('Nav Lost Schedule'));
        await expect(announcer).toContainText('Waiting for a valid score on');
      } else {
        await organizer.attemptsTo(StartTheTournament('Nav Lost Schedule'), GoToTheNextRound);
        expect(await organizer.asksFor(DisplayedRoundTitle)).toBe('Round 2');
      }
      // whose default schedule's module is gone, as when its script failed to load.
      // The module is the select's default option (read from the page, so a changed
      // default cannot make this vacuous), and it was there until now.
      const moduleName = await page.evaluate(() => {
        const select = document.getElementById('scheduleSelect');
        const defaultOption = Array.from(select.options).find((option) => option.defaultSelected);
        const global = 'schedule' + defaultOption.value.replace(/\.js$/, '');
        const present = typeof window[global] === 'object' && window[global] !== null;
        const chosen = select.value === defaultOption.value;
        if (present && chosen) delete window[global];
        return present && chosen ? defaultOption.value : null;
      });
      expect(moduleName, 'the default schedule module was loaded and chosen before it was deleted').not.toBeNull();

      // When the Organizer drops the tournament,
      if (route === 'New') {
        await page.click('#newTournamentBtn');
      } else {
        // Delete lives in the settings, which the running tournament hides.
        await page.click('#toggleSettingsBtn');
        await page.click('#deleteTournamentBtn');
      }
      await expect.poll(() => dialogs.length).toBe(2);
      const expectedDialogs = [
        route === 'New'
          ? 'Do you want to save the current tournament before creating a new one?'
          : 'Are you sure you want to delete "Nav Lost Schedule"? Your secret sauce will vanish forever!',
        route === 'New' ? 'Ready for a new tournament!' : 'Tournament "Nav Lost Schedule" deleted!',
      ];
      expect(dialogs).toEqual(expectedDialogs);

      // Then the schedule's load failure was reported (so the failure path ran),
      // (polled: the console event may arrive a tick after the dialogs; a missing
      // report fails here on timeout, any other console error fails the toEqual below)
      const expectedError = 'Unknown module name: ' + moduleName;
      await expect.poll(() => consoleErrors).toContain(expectedError);
      expect(consoleErrors.filter((text) => text !== expectedError)).toEqual([]);
      // no round is shown, so none of its controls (PREVIOUS/NEXT ROUND, Save,
      // New Tournament, score inputs) is left to act on the cleared tournament,
      await expect(container.locator('.round')).toHaveCount(0);
      await expect(container.getByRole('button')).toHaveCount(0);
      await expect(container.locator('input')).toHaveCount(0);
      // the dropped tournament's next-round announcement is gone with it,
      await expect(announcer).toHaveText('');
      expect(await announcer.evaluate((element) => 'key' in element.dataset)).toBe(false);
      // the setup view is shown with Start enabled (usable as such in Mexicano only),
      await expect(page.locator('#settingsContainer')).toBeVisible();
      await expect(page.locator('#startTournamentBtn')).toBeEnabled();
      // (Mexicano rebuilds its player inputs. Americano rebuilds the table from an
      // empty player list, so it is empty there, and pressing Start alerts "Please
      // load a schedule first": recovery is only by picking another schedule. That
      // residual is owned by AB#159 and is not asserted here.)
      if (format === 'mexicano') {
        expect(await page.locator('#playerInputsContainer input').count()).toBeGreaterThan(0);
      }
      // and no page error fired.
      expect(errors).toEqual([]);
      // and no late extra dialog arrived while the assertions ran.
      expect(dialogs).toEqual(expectedDialogs);
    });
  }
});
