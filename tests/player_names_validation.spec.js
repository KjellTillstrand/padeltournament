const { test, expect } = require('@playwright/test');

test.describe('Player Names Uniqueness Validation', () => {
  test('should alert when duplicate player names are entered', async ({ page }) => {
    await page.goto('/');
    // Fill two player inputs with the same name.
    await page.fill('#playerInput_0', 'Duplicate');
    await page.fill('#playerInput_1', 'Duplicate');

    await page.fill('#tournamentName', 'Test Tournament');
    
    // Listen for an alert triggered by duplicate names.
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('Player names must be unique.');
      await dialog.dismiss();
    });
    
    await page.click('#startTournamentBtn');
    
    // Ensure the tournament has not started (settings container remains visible).
    await expect(page.locator('#settingsContainer')).toBeVisible();
  });
});
