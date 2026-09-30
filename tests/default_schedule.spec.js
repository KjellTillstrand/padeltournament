const { test, expect } = require('@playwright/test');

test.describe('Default Schedule Loading', () => {
  test.beforeEach(async ({ page }) => {
    // Clear any saved state and start with a fresh page.
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('R-SCHEDULE-SELECT: should load default schedule with 12 player inputs and default title', async ({ page }) => {
    // Expect 12 player inputs (IDs begin with "playerInput_")
    const playerInputs = page.locator('[id^="playerInput_"]');
    await expect(playerInputs).toHaveCount(12);
    // The default tournament title should be displayed.
    await expect(page.locator('#tournamentTitle')).toHaveText('Tournament Title');
    // The settings container and player inputs should be visible.
    await expect(page.locator('#settingsContainer')).toBeVisible();
    await expect(page.locator('#playerInputsContainer')).toBeVisible();
  });

  test('R-SCHEDULE-SELECT, R-STATE-PERSIST: the 8-player schedule can be selected, played and restored after reload', async ({ page }) => {
    // Any page error or console error (e.g. a broken schedule wiring reading
    // window.schedule8p7r.players) fails the test.
    const errors = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    // Every shipped size is offered.
    await expect(page.locator('#scheduleSelect option')).toHaveText([
      '8 Player, 7 Round Schedule',
      '12 Player, 11 Round Schedule',
      '16 Player, 15 Round Schedule',
      '20 Player, 19 Round Schedule',
      '24 Player, 23 Round Schedule',
    ]);

    // Selecting the 8-player schedule sets up 8 players on 2 courts.
    await page.selectOption('#scheduleSelect', '8p7r.js');
    await expect(page.locator('[id^="playerInput_"]')).toHaveCount(8);
    await expect(page.locator('[id^="courtNameInput_"]')).toHaveCount(2);

    // Start it and enter a score in round 1.
    await page.fill('#tournamentName', 'Eight Player Test');
    await page.click('#startTournamentBtn');
    await expect(page.locator('#tournamentContainer .court')).toHaveCount(2);
    await expect(page.locator('.round-header')).toContainText('Round 1');
    await page.locator('.result-overlay-left input').first().fill('10');
    await expect(page.locator('.result-overlay-right input').first()).toHaveValue('14'); // 24 - 10

    // After a reload the 2-court tournament is restored, not discarded.
    await page.reload();
    await expect(page.locator('#tournamentTitle')).toHaveText('Eight Player Test');
    await expect(page.locator('.round-header')).toContainText('Round 1');
    await expect(page.locator('#tournamentContainer .court')).toHaveCount(2);
    await expect(page.locator('.result-overlay-left input').first()).toHaveValue('10');
    await expect(page.locator('.result-overlay-right input').first()).toHaveValue('14');
    const players = await page.evaluate(
      () => JSON.parse(localStorage.getItem('tournamentState')).schedule.players.length
    );
    expect(players).toBe(8);

    expect(errors, 'page and console errors').toEqual([]);
  });
});
