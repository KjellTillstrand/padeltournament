const { test, expect } = require('@playwright/test');

test.describe('Score Auto-Calculation', () => {
  test('should auto-calculate opponent score based on global total', async ({ page }) => {
    await page.goto('/');
    // Set up with a tournament name and choose global total points 24.
    await page.fill('#tournamentName', 'Score Test');
    await page.selectOption('#globalTotalPoints', '24');
    await page.click('#startTournamentBtn');
    
    // Wait for the round to load and get the first match's score inputs.
    const leftInput = page.locator('.result-overlay-left input').first();
    const rightInput = page.locator('.result-overlay-right input').first();
    await leftInput.fill('10');
    // Allow for auto-calculation.
    await page.waitForTimeout(500);
    const rightScore = await rightInput.inputValue();
    expect(rightScore).toBe('14'); // 24 - 10 = 14
  });
});
