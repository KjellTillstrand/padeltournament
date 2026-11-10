// tests/tournament_name_save_unique.spec.js
const { test, expect } = require('@playwright/test');
const { SAVED_TOURNAMENTS_KEY } = require('./storage-keys');

test.describe('Tournament Save Unique Name Functionality', () => {
  test.beforeEach(async ({ page }) => {
    // Clear any saved state.
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('R-NAME-UNIQUE: should save tournaments with unique names when duplicate names are entered', async ({ page }) => {
    // Step 1: Start and save a tournament with "Test Tournament".
    await page.fill('#tournamentName', 'Test Tournament');
    await page.click('#startTournamentBtn');

    // Set up a dialog handler for the confirmation dialog that may occur when saving.
    page.once('dialog', async dialog => {
      console.log('Dialog (save):', dialog.message());
      await dialog.accept();
    });
    
    await page.click('#saveTournamentBtn');

    // Wait briefly for state update.
    await page.waitForTimeout(500);

    // Retrieve the saved tournaments from localStorage.
    let savedTournaments = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SAVED_TOURNAMENTS_KEY);
    expect(savedTournaments).toHaveLength(1);
    expect(savedTournaments[0].tournamentName).toBe('Test Tournament');

    // Step 2: Reset state for a new tournament.
    await page.click('#newTournamentBtn');
    await page.waitForTimeout(500);

    // Start a new tournament with the same base name.
    await page.fill('#tournamentName', 'Test Tournament');
    await page.click('#startTournamentBtn');

    // Again, set up a dialog handler for the save confirmation.
    page.once('dialog', async dialog => {
      console.log('Dialog (save on duplicate):', dialog.message());
      await dialog.accept();
    });
    await page.click('#saveTournamentBtn');
    await page.waitForTimeout(500);

    // Retrieve the updated saved tournaments.
    savedTournaments = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SAVED_TOURNAMENTS_KEY);
    // Expect two saved tournaments now.
    expect(savedTournaments).toHaveLength(2);
    const names = savedTournaments.map(t => t.tournamentName);
    // One should be the original name...
    expect(names).toContain('Test Tournament');
    // ...and the other should have a "-1" suffix (or similar) ensuring uniqueness.
    expect(names.some(name => /^Test Tournament-\d+$/.test(name))).toBe(true);
  });

  for (const format of ['americano', 'mexicano']) {
    test(`R-NAME-UNIQUE: a ${format} Start that makes a duplicate name unique shows the unique name in the title at once`, async ({ page }) => {
      const dialogs = [];
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        dialog.accept();
      });

      // Given a saved tournament named "Test Tournament" exists.
      await page.fill('#tournamentName', 'Test Tournament');
      await page.click('#startTournamentBtn');
      await page.click('#saveTournamentBtn');
      await page.click('#newTournamentBtn');
      await expect.poll(() => dialogs.length).toBe(4);
      const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SAVED_TOURNAMENTS_KEY);
      expect(saved.map(t => t.tournamentName)).toEqual(['Test Tournament']);
      await page.selectOption('#formatSelect', format);

      // When the Organizer types the same name and starts.
      await page.fill('#tournamentName', 'Test Tournament');
      await page.click('#startTournamentBtn');

      // Then the tournament runs under the unique name,
      await expect(page.locator('.round-header .left')).toHaveText('Round 1');
      await expect(page.locator('#tournamentName')).toHaveValue('Test Tournament-1');
      // and the visible title shows it at once, without a reload.
      await expect(page.locator('#tournamentTitle')).toHaveText('Test Tournament-1');
    });
  }
});
