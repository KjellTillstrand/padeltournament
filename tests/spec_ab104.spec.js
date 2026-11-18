// tests/spec_ab104.spec.js
// Spec-pass record (AB#104) of R-TOURNAMENT-STORE and R-NAME-UNIQUE, written from
// the Requirements' Behavior alone.
const { test, expect } = require('@playwright/test');
const { SAVED_TOURNAMENTS_KEY } = require('./storage-keys');

const savedNames = (page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]').map((t) => t.tournamentName),
    SAVED_TOURNAMENTS_KEY);

// Given a tournament in progress named `name`, saved once (every dialog accepted).
async function startAndSave(page, name) {
  page.on('dialog', (d) => d.accept());
  await page.fill('#tournamentName', name);
  await page.click('#startTournamentBtn');
  await expect(page.locator('.round-header .left')).toHaveText('Round 1');
  await page.click('#saveTournamentBtn');
  await expect.poll(() => savedNames(page)).toContain(name);
  page.removeAllListeners('dialog');
}

// Saved tournaments with exactly these names, and a fresh (not started) form.
async function seedSavedAndStartAnew(page, names) {
  await startAndSave(page, names[0]);
  await page.evaluate(([key, all]) => {
    const saved = JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(all.map((n) => ({ ...saved[0], tournamentName: n }))));
  }, [SAVED_TOURNAMENTS_KEY, names]);
  page.on('dialog', (d) => d.dismiss());
  await page.click('#newTournamentBtn');
  await expect(page.locator('#startTournamentBtn')).toBeEnabled();
  expect(await savedNames(page)).toEqual(names);
}

test.describe('AB#104 spec pass', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  // @verifies REQ-11
  test('R-TOURNAMENT-STORE: Saving adds the tournament to the saved list', async ({ page }) => {
    await startAndSave(page, 'Spring Cup');
    expect(await savedNames(page)).toContain('Spring Cup');
  });

  // @verifies REQ-11
  test('R-TOURNAMENT-STORE: Loading restores a saved tournament', async ({ page }) => {
    page.on('dialog', (d) => d.dismiss());
    await page.fill('#playerInput_0', 'Ada');
    await page.fill('#tournamentName', 'Spring Cup');
    await page.click('#startTournamentBtn');
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await page.locator('.result-overlay-left input').first().fill('10');
    await page.click('.round-header .center button:has-text("NEXT ROUND")');
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    await page.click('#saveTournamentBtn');
    await expect.poll(() => savedNames(page)).toContain('Spring Cup');
    await page.click('#newTournamentBtn');
    await expect(page.locator('#startTournamentBtn')).toBeEnabled();

    const dropdown = page.locator('#savedTournamentSelect');
    const value = await dropdown.locator('option', { hasText: 'Spring Cup' }).getAttribute('value');
    await dropdown.selectOption(value);
    await page.click('#loadTournamentBtn');

    await expect(page.locator('#tournamentTitle')).toHaveText('Spring Cup');
    await expect(page.locator('.round-header .left')).toHaveText('Round 2');
    await expect(page.locator('.scoreboard-container')).toContainText('Ada');
    await page.click('.round-header .center button:has-text("PREVIOUS ROUND")');
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await expect(page.locator('.result-overlay-left input').first()).toHaveValue('10');
  });

  // @verifies REQ-11
  test('R-TOURNAMENT-STORE: Deleting removes a saved tournament', async ({ page }) => {
    await startAndSave(page, 'Spring Cup');
    page.on('dialog', (d) => d.accept());
    await page.click('#toggleSettingsBtn');
    await page.click('#deleteTournamentBtn');
    await expect.poll(() => savedNames(page)).not.toContain('Spring Cup');
  });

  // @verifies REQ-11
  test('R-TOURNAMENT-STORE: Starting anew offers to keep the current tournament', async ({ page }) => {
    const messages = [];
    page.on('dialog', async (d) => { messages.push(d.message()); await d.dismiss(); });
    await page.fill('#tournamentName', 'Spring Cup');
    await page.click('#startTournamentBtn');
    await expect(page.locator('.round-header .left')).toHaveText('Round 1');
    await page.click('#newTournamentBtn');
    await expect.poll(() => messages.length).toBeGreaterThan(0);
    expect(messages[0]).toBe('Do you want to save the current tournament before creating a new one?');
  });

  // @verifies REQ-4
  test('R-NAME-UNIQUE: A tournament shall not start without a name', async ({ page }) => {
    const messages = [];
    page.on('dialog', async (d) => { messages.push(d.message()); await d.dismiss(); });
    await page.fill('#tournamentName', '');
    await page.click('#startTournamentBtn');
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toBe('Tournament name must not be empty.');
    await expect(page.locator('.round-header .left')).toHaveCount(0);
    await expect(page.locator('#startTournamentBtn')).toBeEnabled();
  });

  // @verifies REQ-4
  test('R-NAME-UNIQUE: A duplicate name is made unique automatically', async ({ page }) => {
    await seedSavedAndStartAnew(page, ['Spring Cup']);
    await page.fill('#tournamentName', 'Spring Cup');
    await page.click('#startTournamentBtn');
    await expect(page.locator('#tournamentName')).toHaveValue('Spring Cup-1');
    await expect(page.locator('#tournamentTitle')).toHaveText('Spring Cup-1');
  });

  // @verifies REQ-4
  test('R-NAME-UNIQUE: Repeated duplicates increment the suffix', async ({ page }) => {
    await seedSavedAndStartAnew(page, ['Spring Cup', 'Spring Cup-1']);
    await page.fill('#tournamentName', 'Spring Cup');
    await page.click('#startTournamentBtn');
    await expect(page.locator('#tournamentName')).toHaveValue('Spring Cup-2');
    await expect(page.locator('#tournamentTitle')).toHaveText('Spring Cup-2');
  });
});
