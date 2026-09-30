const { test, expect } = require('@playwright/test');

test.describe('Score Auto-Calculation', () => {
  test('R-SCORE-ENTRY, R-POINTS-TOTAL: should auto-calculate opponent score based on global total', async ({ page }) => {
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

// Start a tournament with the given points total and wait for its first round.
async function startWithPointsTotal(page, total) {
  await page.goto('/');
  await page.fill('#tournamentName', 'Point Pool ' + total);
  await page.selectOption('#globalTotalPoints', String(total));
  await page.click('#startTournamentBtn');
  await expect(page.locator('.result-overlay-container').first()).toBeVisible();
}

test.describe('Point pools', () => {
  test('R-POINT-POOLS: the Organizer can choose 16, 21, 24 or 32, with 24 as the default', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#globalTotalPoints option')).toHaveText(['16', '21', '24', '32']);
    await expect(page.locator('#globalTotalPoints')).toHaveValue('24');
  });

  // Scenario Outline: The selected pool governs every match.
  const examples = [
    { total: 16, entered: 9, complement: 7 },
    { total: 21, entered: 13, complement: 8 },
    { total: 24, entered: 15, complement: 9 },
    { total: 32, entered: 20, complement: 12 },
  ];
  for (const { total, entered, complement } of examples) {
    test(`R-POINT-POOLS: with a points total of ${total}, entering ${entered} makes the opposing score ${complement}`, async ({ page }) => {
      await startWithPointsTotal(page, total);
      const matches = page.locator('.result-overlay-container');
      expect(await matches.count()).toBeGreaterThan(1);

      // Recorded for the left team of the first match...
      const first = matches.first();
      await first.locator('.result-overlay-left input').fill(String(entered));
      await expect(first.locator('.result-overlay-right input')).toHaveValue(String(complement));
      await expect(first.locator('.error-message')).toHaveText('');

      // ...and for the right team of another match: the pool governs every match.
      const last = matches.last();
      await last.locator('.result-overlay-right input').fill(String(entered));
      await expect(last.locator('.result-overlay-left input')).toHaveValue(String(complement));
      await expect(last.locator('.error-message')).toHaveText('');
    });
  }

  // Scenario: An odd pool cannot draw. The two scores always sum to the total, so a
  // draw would need 2 * score = 21, which no whole number satisfies. Exercised
  // through the UI for every score a team can reach in a game to 21, on both sides.
  test('R-POINT-POOLS: with a points total of 21 the two teams never score equally', async ({ page }) => {
    await startWithPointsTotal(page, 21);
    const matches = page.locator('.result-overlay-container');
    const first = matches.first();
    const last = matches.last();
    for (let entered = 0; entered <= 21; entered++) {
      await first.locator('.result-overlay-left input').fill(String(entered));
      await expect(first.locator('.result-overlay-right input')).toHaveValue(String(21 - entered));
      await last.locator('.result-overlay-right input').fill(String(entered));
      await expect(last.locator('.result-overlay-left input')).toHaveValue(String(21 - entered));

      for (const match of [first, last]) {
        const left = await match.locator('.result-overlay-left input').inputValue();
        const right = await match.locator('.result-overlay-right input').inputValue();
        expect(Number(left) + Number(right)).toBe(21);
        expect(left).not.toBe(right);
      }
    }
  });
});
