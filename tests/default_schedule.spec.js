const { test, expect } = require('@playwright/test');

test.describe('Default Schedule Loading', () => {
  test.beforeEach(async ({ page }) => {
    // Clear any saved state and start with a fresh page.
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('should load default schedule with 12 player inputs and default title', async ({ page }) => {
    // Expect 12 player inputs (IDs begin with "playerInput_")
    const playerInputs = page.locator('[id^="playerInput_"]');
    await expect(playerInputs).toHaveCount(12);
    // The default tournament title should be displayed.
    await expect(page.locator('#tournamentTitle')).toHaveText('Tournament Title');
    // The settings container and player inputs should be visible.
    await expect(page.locator('#settingsContainer')).toBeVisible();
    await expect(page.locator('#playerInputsContainer')).toBeVisible();
  });
});
