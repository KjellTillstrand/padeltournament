// tests/phone-layout.spec.js
//
// AB#92: the app on a phone. The page declares a device-width viewport, and at
// 390x844 CSS pixels no view is wider than the screen: every court's score
// inputs are on screen (reachable by vertical scrolling alone) and the page
// never scrolls sideways. The R-SCORE-ENTRY tests record a score there.
const { test, expect } = require('@playwright/test');

const PHONE = { width: 390, height: 844 };

// The page is no wider than the screen: nothing to scroll sideways.
async function expectNoSidewaysScroll(page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

// Every rendered element matching the selector lies within [0, innerWidth]
// (elements not rendered, such as the other format's select, are skipped).
// Returns the boxes checked.
async function expectAllWithinTheScreenWidth(page, selector) {
  const { boxes, innerWidth } = await page.evaluate((sel) => ({
    boxes: [...document.querySelectorAll(sel)]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      }),
    innerWidth: window.innerWidth,
  }), selector);
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.width).toBeGreaterThan(0);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(innerWidth);
  }
  return boxes;
}

// A player's points on the displayed round's scoreboard.
async function pointsOf(page, player) {
  const row = page.locator('.scoreboard-container table tr').filter({
    has: page.locator('td:first-child', { hasText: new RegExp('^' + player + '$') }),
  });
  await expect(row).toHaveCount(1);
  return row.locator('td').nth(1);
}

// Record a score as a phone user does: tap the court's left input and type.
// Returns the players of both teams of that court.
async function recordAScore(page, matchIndex, left, right) {
  const match = page.locator('.matches-container .match').nth(matchIndex);
  const leftInput = match.locator('.result-overlay-left input');
  await leftInput.click();
  await page.keyboard.type(String(left));
  // Then the score is recorded: the opposing score completes itself, without error,
  await expect(match.locator('.result-overlay-right input')).toHaveValue(String(right));
  await expect(leftInput).toHaveValue(String(left));
  await expect(match.locator('.error-message')).toHaveText('');
  return {
    leftTeam: (await match.getAttribute('data-team-left')).split(','),
    rightTeam: (await match.getAttribute('data-team-right')).split(','),
  };
}

const ROUND_VIEWS = [
  { title: 'an Americano round of 24 players on 6 courts', format: 'americano', schedule: '24p23r.js', courts: 6 },
  { title: 'an Americano round of 9 players on 2 courts, one resting', format: 'americano', schedule: '9p9r.js', courts: 2 },
  { title: 'a Mexicano round of 24 players on 6 courts', format: 'mexicano', players: 24, courts: 6 },
];

async function startTournament(page, view) {
  await page.goto('/');
  if (view.format === 'mexicano') {
    await page.selectOption('#formatSelect', 'mexicano');
    await page.selectOption('#playerCountSelect', String(view.players));
  } else {
    await page.selectOption('#scheduleSelect', view.schedule);
  }
  await expect(page.locator('#courtNamesContainer input')).toHaveCount(view.courts);
  await page.fill('#tournamentName', 'Phone Cup');
  await page.click('#startTournamentBtn');
  await expect(page.locator('.round-header .left')).toHaveText('Round 1');
}

test.describe('Phone layout', () => {
  test('the page declares a device-width viewport and leaves zoom enabled', async ({ page }) => {
    await page.goto('/');
    const viewport = page.locator('head meta[name="viewport"]');
    await expect(viewport).toHaveCount(1);
    const content = (await viewport.getAttribute('content')).replace(/\s+/g, '');
    const settings = content.split(',');
    expect(settings).toContain('width=device-width');
    expect(settings).toContain('initial-scale=1');
    expect(content).not.toMatch(/user-scalable=(no|0)/i);
    expect(content).not.toMatch(/maximum-scale/i);
  });

  test.describe('at 390x844', () => {
    test.use({ viewport: PHONE });

    for (const format of ['americano', 'mexicano']) {
      test(`the ${format} setup view of 24 players fits the screen width`, async ({ page }) => {
        await page.goto('/');
        if (format === 'mexicano') {
          await page.selectOption('#formatSelect', 'mexicano');
          await page.selectOption('#playerCountSelect', '24');
        } else {
          await page.selectOption('#scheduleSelect', '24p23r.js');
        }
        await expect(page.locator('#playerInputsContainer input')).toHaveCount(24);
        await expect(page.locator('#courtNamesContainer input')).toHaveCount(6);
        await expectNoSidewaysScroll(page);
        await expectAllWithinTheScreenWidth(page,
          '#header, #tournamentTitle, #siteName, #settingsContainer, #settingsContainer input, ' +
          '#settingsContainer select, #settingsContainer button');
      });
    }

    for (const view of ROUND_VIEWS) {
      // Scenario: Scores can be recorded on a phone.
      test(`R-SCORE-ENTRY: on a 390px-wide screen, every court's score entry of ${view.title} is on screen without sideways scrolling, and a score recorded there is credited`, async ({ page }) => {
        // Given a tournament in progress on a screen 390 CSS pixels wide,
        await startTournament(page, view);

        // when the Organizer reviews the current round,
        // then every court's score entry lies within the screen width
        await expect(page.locator('.matches-container .court')).toHaveCount(view.courts);
        const boxes = await expectAllWithinTheScreenWidth(page, '.result-overlay-container input');
        expect(boxes).toHaveLength(2 * view.courts);
        // and the page does not scroll sideways.
        await expectNoSidewaysScroll(page);

        // A score recorded on the first and the last court is completed, shown
        // and credited on the scoreboard (24 points a match by default).
        const first = await recordAScore(page, 0, 15, 9);
        const last = await recordAScore(page, view.courts - 1, 7, 17);
        for (const player of first.leftTeam) await expect(await pointsOf(page, player)).toHaveText('15');
        for (const player of first.rightTeam) await expect(await pointsOf(page, player)).toHaveText('9');
        for (const player of last.leftTeam) await expect(await pointsOf(page, player)).toHaveText('7');
        for (const player of last.rightTeam) await expect(await pointsOf(page, player)).toHaveText('17');
        await expectNoSidewaysScroll(page);
      });
    }
  });
});
