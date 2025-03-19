// tournament.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Padel Turrar Tournament Manager', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to your page.
    await page.goto('/');
  });

  test('Page loads and displays header', async ({ page }) => {
    // Check that the header elements exist.
    await expect(page.locator('#tournamentTitle')).toHaveText('Tournament Title');
    await expect(page.locator('#siteName')).toHaveText('Padel Turrar');
  });

  test('User can set tournament name and start tournament', async ({ page }) => {
    // Fill the tournament name.
    const tournamentName = 'My Test Tournament';
    await page.fill('#tournamentName', tournamentName);
    
    // Click the Start Tournament button.
    await page.click('#startTournamentBtn');

    // Verify that the settings container is hidden and the tournament container is visible.
    await expect(page.locator('#settingsContainer')).toBeHidden();
    await expect(page.locator('#tournamentContainer')).toBeVisible();
    
    // Optionally, check that the tournament title now shows the unique tournament name.
    await expect(page.locator('#tournamentTitle')).toHaveText(tournamentName);
  });

  test('State is preserved after reload', async ({ page }) => {
    // Set tournament name and start tournament.
    const tournamentName = 'State Test';
    await page.fill('#tournamentName', tournamentName);
    await page.click('#startTournamentBtn');
    
    // Wait a moment and then reload.
    await page.reload();
    
    // Check that the tournament title is still the same.
    await expect(page.locator('#tournamentTitle')).toHaveText(tournamentName);
    // Check that round elements are visible.
    await expect(page.locator('.round')).toBeVisible();
  });
});
