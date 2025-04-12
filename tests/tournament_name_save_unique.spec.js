// tests/tournament_name_save_unique.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Tournament Save Unique Name Functionality', () => {
  test.beforeEach(async ({ page }) => {
    // Clear any saved state.
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('should save tournaments with unique names when duplicate names are entered', async ({ page }) => {
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
    let savedTournaments = await page.evaluate(() => JSON.parse(localStorage.getItem('savedTournaments')));
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
    savedTournaments = await page.evaluate(() => JSON.parse(localStorage.getItem('savedTournaments')));
    // Expect two saved tournaments now.
    expect(savedTournaments).toHaveLength(2);
    const names = savedTournaments.map(t => t.tournamentName);
    // One should be the original name...
    expect(names).toContain('Test Tournament');
    // ...and the other should have a "-1" suffix (or similar) ensuring uniqueness.
    expect(names.some(name => /^Test Tournament-\d+$/.test(name))).toBe(true);
  });
});
