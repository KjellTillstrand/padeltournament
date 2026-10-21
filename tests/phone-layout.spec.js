// tests/phone-layout.spec.js
//
// AB#92: the app on a phone. The page declares a device-width viewport, and at
// phone widths (320-390 CSS pixels) no view is wider than the screen: every
// court's score inputs are on screen, uncovered, inside their court (reachable
// by vertical scrolling alone) and the page never scrolls sideways. The
// R-SCORE-ENTRY tests record a score there.
const { test, expect } = require('@playwright/test');

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 720 };

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
        return { what: el.className || el.id || el.tagName, left: r.left, right: r.right, width: r.width };
      }),
    innerWidth: window.innerWidth,
  }), selector);
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.width, box.what).toBeGreaterThan(0);
    expect(box.left, box.what).toBeGreaterThanOrEqual(0);
    expect(box.right, box.what).toBeLessThanOrEqual(innerWidth);
  }
  return boxes;
}

// Every score input lies inside its court, in its own team's half, and is what
// a tap at its centre reaches (nothing covers it). Returns how many were checked.
async function expectScoreInputsInsideTheirCourtsAndUncovered(page) {
  const inputs = await page.evaluate(() =>
    [...document.querySelectorAll('.matches-container .court')].flatMap((court) => {
      const c = court.getBoundingClientRect();
      const middle = court.querySelector('.center-line').getBoundingClientRect();
      return [...court.querySelectorAll('.result-overlay-container input')].map((input) => {
        input.scrollIntoView({ block: 'center' });
        const r = input.getBoundingClientRect();
        const courtNow = court.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          side: input.closest('.result-overlay-left') ? 'left' : 'right',
          left: r.left, right: r.right, width: r.width,
          courtLeft: c.left, courtRight: c.right,
          insideVertically: r.top >= courtNow.top && r.bottom <= courtNow.bottom,
          middle: middle.left + middle.width / 2,
          uncovered: hit === input,
        };
      });
    }));
  expect(inputs.length).toBeGreaterThan(0);
  for (const input of inputs) {
    expect(input.left).toBeGreaterThanOrEqual(input.courtLeft);
    expect(input.right).toBeLessThanOrEqual(input.courtRight);
    expect(input.insideVertically).toBe(true);
    if (input.side === 'left') expect(input.right).toBeLessThanOrEqual(input.middle);
    else expect(input.left).toBeGreaterThanOrEqual(input.middle);
    expect(input.uncovered).toBe(true);
  }
  return inputs.length;
}

// One column: the courts above the scoreboard, both the full width of the round.
async function expectCourtsStackedAboveTheScoreboard(page) {
  const layout = await page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const body = document.querySelector('.round-body');
    const style = getComputedStyle(body);
    const inner = box(body).width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return {
      inner,
      matches: box(document.querySelector('.matches-column')),
      scoreboard: box(document.querySelector('.scoreboard-container')),
    };
  });
  expect(layout.matches.bottom).toBeLessThanOrEqual(layout.scoreboard.top);
  expect(layout.matches.width).toBeCloseTo(layout.inner, 0);
  expect(layout.scoreboard.width).toBeCloseTo(layout.inner, 0);
}

// A player's points cell on the displayed round's scoreboard.
async function pointsOf(page, player) {
  const row = page.locator('.scoreboard-container table tr').filter({
    has: page.locator('td:first-child', { hasText: new RegExp('^' + escapeRegExp(player) + '$') }),
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

// The text of every round-header button sits on one line.
async function expectRoundHeaderButtonsOnOneLine(page) {
  const lines = await page.evaluate(() =>
    [...document.querySelectorAll('.round-header button')].map((button) => {
      const range = document.createRange();
      range.selectNodeContents(button);
      const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
      return { label: button.textContent, lines: tops.size };
    }));
  expect(lines.length).toBeGreaterThan(0);
  for (const { label, lines: count } of lines) expect(count, label).toBe(1);
}

const ROUND_VIEWS = [
  { title: 'an Americano round of 24 players on 6 courts', format: 'americano', schedule: '24p23r.js', courts: 6, widths: [320, 360, 390] },
  { title: 'an Americano round of 9 players on 2 courts, one resting', format: 'americano', schedule: '9p9r.js', courts: 2, widths: [390] },
  { title: 'a Mexicano round of 24 players on 6 courts', format: 'mexicano', players: 24, courts: 6, widths: [390] },
];

async function chooseTheTournament(page, view) {
  if (view.format === 'mexicano') {
    await page.selectOption('#formatSelect', 'mexicano');
    await page.selectOption('#playerCountSelect', String(view.players));
  } else {
    await page.selectOption('#scheduleSelect', view.schedule);
  }
  await expect(page.locator('#courtNamesContainer input')).toHaveCount(view.courts);
}

async function startTheTournament(page, name) {
  await page.fill('#tournamentName', name);
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

  // A mobile browser honours the viewport meta: the page is laid out at the
  // device's 390px, not the 980px a phone assumes for a page without one.
  // Firefox has no mobile emulation (isMobile), so this runs on Chromium engines.
  test.describe('in a mobile browser at 390x844', () => {
    test.skip(({ browserName }) => browserName !== 'chromium', 'isMobile is supported by Chromium only');
    test.use({ isMobile: true, hasTouch: true, viewport: PHONE, deviceScaleFactor: 3 });

    test('the page is laid out at the device width', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#playerInputsContainer input').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(390);
      await expectNoSidewaysScroll(page);
    });
  });

  test.describe('at 390x844', () => {
    test.use({ viewport: PHONE });

    for (const format of ['americano', 'mexicano']) {
      test(`the ${format} setup view of 24 players fits the screen width`, async ({ page }) => {
        await page.goto('/');
        await chooseTheTournament(page, format === 'mexicano'
          ? { format, players: 24, courts: 6 }
          : { format, schedule: '24p23r.js', courts: 6 });
        await expect(page.locator('#playerInputsContainer input')).toHaveCount(24);
        await expectNoSidewaysScroll(page);
        await expectAllWithinTheScreenWidth(page,
          '#header, #tournamentTitle, #siteName, #settingsContainer, #settingsContainer input, ' +
          '#settingsContainer select, #settingsContainer button');
      });
    }

    test('the setup view fits the screen width with a long-named saved tournament', async ({ page }) => {
      page.on('dialog', (dialog) => dialog.accept());
      const longName = 'The Annual Midsummer Padel Turrar Charity Invitational 2026';
      await page.goto('/');
      await startTheTournament(page, longName);
      await page.click('#saveTournamentBtn');
      // New Tournament (saving the current one) returns to the setup view.
      await page.click('#newTournamentBtn');
      await expect(page.locator('#startTournamentBtn')).toBeVisible();
      await expect(page.locator('#savedTournamentSelect option', { hasText: longName })).toHaveCount(1);
      await expectNoSidewaysScroll(page);
      await expectAllWithinTheScreenWidth(page,
        '#settingsContainer, .saved-tournaments-container, #savedTournamentSelect, ' +
        '#loadTournamentBtn, #deleteTournamentBtn');
    });

    test('a score error shows below the inputs and covers neither of them', async ({ page }) => {
      await page.goto('/');
      await startTheTournament(page, 'Error Cup');
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: PHONE.height });
        const match = page.locator('.matches-container .match').first();
        await match.locator('.result-overlay-left input').fill('99');
        await expect(match.locator('.error-message')).toHaveText(/must be a whole number/);
        await expectScoreInputsInsideTheirCourtsAndUncovered(page);
        const error = await match.locator('.error-message').boundingBox();
        const right = await match.locator('.result-overlay-right input').boundingBox();
        expect(error.y).toBeGreaterThanOrEqual(right.y + right.height);
        await expectNoSidewaysScroll(page);
        await match.locator('.result-overlay-left input').fill('');
      }
    });

    test('the round header keeps every button label on one line', async ({ page }) => {
      await page.goto('/');
      await chooseTheTournament(page, { format: 'mexicano', players: 24, courts: 6 });
      await startTheTournament(page, 'Header Cup');
      await expect(page.locator('#generateNextRoundBtn')).toBeVisible();
      await expectRoundHeaderButtonsOnOneLine(page);
      await expectAllWithinTheScreenWidth(page, '.round-header, .round-header button');
    });

    test('long unbroken player and court names wrap inside the court', async ({ page }) => {
      // Start accepts player names of up to 20 characters; court names take 30.
      const longPlayer = 'ABCDEFGHIJKLMNOPQRST';
      const longCourt = 'CentreCourtSponsoredByAVeryLon';
      await page.goto('/');
      await chooseTheTournament(page, { format: 'americano', schedule: '8p7r.js', courts: 2 });
      await page.fill('#playerInput_0', longPlayer);
      await page.fill('#courtNameInput_1', longCourt);
      await startTheTournament(page, 'Long Names Cup');
      await expect(page.locator('.matches-container .court-label', { hasText: longCourt })).toHaveCount(1);
      await expect(page.locator('.matches-container .team', { hasText: longPlayer })).toHaveCount(1);
      await expectNoSidewaysScroll(page);
      await expectAllWithinTheScreenWidth(page,
        '.matches-container .court, .matches-container .team, .matches-container .court-label, ' +
        '.scoreboard-container');
      // Each name stays inside its own box: no text spills out of it.
      const spills = await page.evaluate(() =>
        [...document.querySelectorAll('.matches-container .team, .matches-container .court-label, .scoreboard-container td')]
          .filter((el) => el.scrollWidth > el.clientWidth)
          .map((el) => el.textContent));
      expect(spills).toEqual([]);
      await expectScoreInputsInsideTheirCourtsAndUncovered(page);
      await expect(await pointsOf(page, longPlayer)).toHaveText('0');
    });

    test('a court has its desktop size when the screen allows it', async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await page.goto('/');
      await startTheTournament(page, 'Court Cup');
      const size = () => page.locator('.matches-container .court').first().evaluate((court) => ({
        outer: [court.offsetWidth, court.offsetHeight],
        inner: [court.clientWidth, court.clientHeight],
      }));
      const desktop = await size();
      await page.setViewportSize(PHONE);
      expect(await size()).toEqual(desktop);
    });
  });

  for (const view of ROUND_VIEWS) {
    for (const width of view.widths) {
      test.describe(`at ${width}x844`, () => {
        test.use({ viewport: { width, height: PHONE.height } });

        // Scenario: Scores can be recorded on a phone.
        test(`R-SCORE-ENTRY: on a ${width}px-wide screen, every court's score entry of ${view.title} is on screen without sideways scrolling, and a score recorded there is credited`, async ({ page }) => {
          // Given a tournament in progress on a screen this narrow,
          await page.goto('/');
          await chooseTheTournament(page, view);
          await startTheTournament(page, 'Phone Cup');

          // when the Organizer reviews the current round,
          // then every court's score entry lies within the screen width,
          await expect(page.locator('.matches-container .court')).toHaveCount(view.courts);
          await expectAllWithinTheScreenWidth(page, '.matches-container .court, .scoreboard-container');
          const boxes = await expectAllWithinTheScreenWidth(page, '.result-overlay-container input');
          expect(boxes).toHaveLength(2 * view.courts);
          // inside its court and uncovered,
          expect(await expectScoreInputsInsideTheirCourtsAndUncovered(page)).toBe(2 * view.courts);
          // the courts stacked above the scoreboard,
          await expectCourtsStackedAboveTheScoreboard(page);
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
      });
    }
  }
});
