// tests/phone-layout.spec.js
//
// AB#92: the app on a phone. The page declares a device-width viewport, and at
// phone widths (320-390 CSS pixels) no view is wider than the screen: every
// court's score inputs are on screen, uncovered, inside their court (reachable
// by vertical scrolling alone) and the page never scrolls sideways. The
// R-SCORE-ENTRY tests record a score there.
const { test, expect } = require('@playwright/test');
const { STATE_KEY } = require('./storage-keys');

const PHONE = { width: 390, height: 844 };
const PHONE_WIDTHS = [320, 390];
const DESKTOP = { width: 1280, height: 720 };

// The width of the layout viewport, a classic scrollbar excluded.
const layoutWidth = (page) => page.evaluate(() => document.documentElement.clientWidth);

// The page is no wider than the screen: nothing to scroll sideways.
async function expectNoSidewaysScroll(page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

// Every rendered element matching the selector lies within the screen width
// (elements not rendered, such as the other format's select, are skipped).
// Returns the boxes checked.
async function expectAllWithinTheScreenWidth(page, selector) {
  const { boxes, width } = await page.evaluate((sel) => ({
    boxes: [...document.querySelectorAll(sel)]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { what: el.className || el.id || el.tagName, left: r.left, right: r.right, width: r.width };
      }),
    width: document.documentElement.clientWidth,
  }), selector);
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.width, box.what).toBeGreaterThan(0);
    expect(box.left, box.what).toBeGreaterThanOrEqual(0);
    expect(box.right, box.what).toBeLessThanOrEqual(width);
  }
  return boxes;
}

// Every score input lies inside its court, in its own team's half, above the
// court's team labels, and is what a tap at its centre reaches (nothing covers
// it). Returns how many were checked.
async function expectScoreInputsInsideTheirCourtsAndUncovered(page) {
  const inputs = await page.evaluate(() =>
    [...document.querySelectorAll('.matches-container .court')].flatMap((court) => {
      const c = court.getBoundingClientRect();
      const middle = court.querySelector('.center-line').getBoundingClientRect();
      return [...court.querySelectorAll('.result-overlay-container input')].map((input) => {
        input.scrollIntoView({ block: 'center' });
        const r = input.getBoundingClientRect();
        const courtNow = court.getBoundingClientRect();
        const labelsTop = Math.min(...[...court.querySelectorAll('.team')].map((t) => t.getBoundingClientRect().top));
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          side: input.closest('.result-overlay-left') ? 'left' : 'right',
          left: r.left, right: r.right, bottom: r.bottom,
          courtLeft: c.left, courtRight: c.right,
          insideVertically: r.top >= courtNow.top && r.bottom <= courtNow.bottom,
          labelsTop,
          middle: middle.left + middle.width / 2,
          hit: hit === input ? 'the input' : (hit ? hit.className || hit.tagName : 'nothing'),
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
    expect(input.bottom, 'the team labels start below the score inputs').toBeLessThanOrEqual(input.labelsTop);
    expect(input.hit).toBe('the input');
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
    has: page.getByRole('cell', { name: player, exact: true }),
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

// The text of every round-header button sits on one line, and no two buttons
// overlap or touch.
async function expectRoundHeaderButtonsOnOneLineAndApart(page) {
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('.round-header button')].map((button) => {
      const range = document.createRange();
      range.selectNodeContents(button);
      const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
      const r = button.getBoundingClientRect();
      return { label: button.textContent, lines: tops.size, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }));
  expect(buttons.length).toBeGreaterThan(1);
  for (const { label, lines } of buttons) expect(lines, label).toBe(1);
  for (const [i, a] of buttons.entries()) {
    for (const b of buttons.slice(i + 1)) {
      const apart = a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top;
      expect(apart, `${a.label} and ${b.label} are apart`).toBe(true);
    }
  }
}

// Each settings select, its right margin included, ends within its container.
async function expectSettingsSelectsWithinTheirContainers(page) {
  const selects = await page.evaluate(() =>
    [...document.querySelectorAll('#settingsContainer select')]
      .filter((select) => select.getClientRects().length > 0)
      .map((select) => {
        const parent = select.parentElement;
        const p = getComputedStyle(parent);
        const contentRight = parent.getBoundingClientRect().right - parseFloat(p.borderRightWidth) - parseFloat(p.paddingRight);
        return {
          id: select.id,
          marginRight: select.getBoundingClientRect().right + parseFloat(getComputedStyle(select).marginRight),
          contentRight,
        };
      }));
  expect(selects.length).toBeGreaterThan(0);
  for (const { id, marginRight, contentRight } of selects) expect(marginRight, id).toBeLessThanOrEqual(contentRight);
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

// Twenty characters, the most Start accepts, of the widest letters.
const wideName = (i) => (i % 2 ? 'M' : 'W').repeat(19) + String.fromCharCode(65 + i);

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
      expect(await layoutWidth(page)).toBe(390);
      await expectNoSidewaysScroll(page);
    });
  });

  for (const width of PHONE_WIDTHS) {
    test.describe(`at ${width}x844`, () => {
      test.use({ viewport: { width, height: PHONE.height } });

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
          await expectSettingsSelectsWithinTheirContainers(page);
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
        await expectSettingsSelectsWithinTheirContainers(page);
      });

      test('a score error shows below the inputs, inside the court, and covers neither input', async ({ page }) => {
        await page.goto('/');
        await startTheTournament(page, 'Error Cup');
        const match = page.locator('.matches-container .match').first();
        await match.locator('.result-overlay-left input').fill('99');
        await expect(match.locator('.error-message')).toHaveText(/must be a whole number/);
        await expectScoreInputsInsideTheirCourtsAndUncovered(page);
        const error = await match.locator('.error-message').boundingBox();
        const right = await match.locator('.result-overlay-right input').boundingBox();
        const court = await match.locator('.court').boundingBox();
        expect(error.y).toBeGreaterThanOrEqual(right.y + right.height);
        expect(error.x).toBeGreaterThanOrEqual(court.x);
        expect(error.x + error.width).toBeLessThanOrEqual(court.x + court.width);
        await expectNoSidewaysScroll(page);
      });

      test('the round header keeps every button label on one line, the buttons apart, from round 1 on', async ({ page }) => {
        // Americano round 2: PREVIOUS ROUND and NEXT ROUND.
        await page.goto('/');
        await startTheTournament(page, 'Header Cup');
        await page.getByRole('button', { name: 'NEXT ROUND', exact: true }).click();
        await expect(page.locator('.round-header .left')).toHaveText('Round 2');
        await expectRoundHeaderButtonsOnOneLineAndApart(page);
        await expectAllWithinTheScreenWidth(page, '.round-header, .round-header button');

        // Mexicano round 1 (GENERATE NEXT ROUND) and round 2 (PREVIOUS ROUND too).
        page.on('dialog', (dialog) => dialog.accept());
        await page.click('#newTournamentBtn');
        await chooseTheTournament(page, { format: 'mexicano', players: 12, courts: 3 });
        await startTheTournament(page, 'Header Cup Mexicano');
        await expectRoundHeaderButtonsOnOneLineAndApart(page);
        const matches = page.locator('.matches-container .match');
        for (let i = 0; i < 3; i++) await matches.nth(i).locator('.result-overlay-left input').fill('12');
        await page.click('#generateNextRoundBtn');
        await expect(page.locator('.round-header .left')).toHaveText('Round 2');
        await expect(page.getByRole('button', { name: 'PREVIOUS ROUND', exact: true })).toBeVisible();
        await expectRoundHeaderButtonsOnOneLineAndApart(page);
        await expectAllWithinTheScreenWidth(page, '.round-header, .round-header button');
      });

      test('team labels of the widest names never cover the score inputs, as started or restored', async ({ page, context }) => {
        await page.goto('/');
        await chooseTheTournament(page, { format: 'americano', schedule: '8p7r.js', courts: 2 });
        for (let i = 0; i < 8; i++) await page.fill(`#playerInput_${i}`, wideName(i));
        await startTheTournament(page, 'Wide Names Cup');
        await expect(page.locator('.matches-container .team').first()).toContainText(/[WM]{19}/);
        await expectNoSidewaysScroll(page);
        expect(await expectScoreInputsInsideTheirCourtsAndUncovered(page)).toBe(4);

        // A stored state may hold names of up to 30 characters (the inputs' limit).
        let state = await page.evaluate((key) => localStorage.getItem(key), STATE_KEY);
        for (let i = 0; i < 8; i++) state = state.split(wideName(i)).join(wideName(i) + (i % 2 ? 'M' : 'W').repeat(10));
        await page.close();
        const restored = await context.newPage();
        await restored.addInitScript(({ key, json }) => {
          if (!sessionStorage.getItem('planted')) {
            localStorage.setItem(key, json);
            sessionStorage.setItem('planted', '1');
          }
        }, { key: STATE_KEY, json: state });
        await restored.goto('/');
        await expect(restored.getByRole('cell', { name: wideName(0) + 'W'.repeat(10), exact: true })).toHaveCount(1);
        await expectNoSidewaysScroll(restored);
        expect(await expectScoreInputsInsideTheirCourtsAndUncovered(restored)).toBe(4);
      });

      test('long unbroken names in the title, team labels and scoreboard wrap, and a court label cuts one with an ellipsis', async ({ page }) => {
        const longTitle = 'TheAnnualMidsummerPadelTurrarCharityInvitationalTournament2026';
        const longCourt = 'W'.repeat(30); // the court name input's limit, too wide for any court
        await page.goto('/');
        await chooseTheTournament(page, { format: 'americano', schedule: '8p7r.js', courts: 2 });
        for (let i = 0; i < 8; i++) await page.fill(`#playerInput_${i}`, wideName(i));
        await page.fill('#courtNameInput_1', longCourt);
        await startTheTournament(page, longTitle);
        await expect(page.locator('#tournamentTitle')).toHaveText(longTitle);
        await expect(page.locator('.matches-container .court-label', { hasText: longCourt })).toHaveCount(1);
        await expectNoSidewaysScroll(page);
        await expectAllWithinTheScreenWidth(page,
          '#header, #tournamentTitle, .matches-container .court, .matches-container .team, ' +
          '.matches-container .court-label, .scoreboard-container');
        const boxes = await page.evaluate(() => {
          const scoreboard = document.querySelector('.scoreboard-container');
          const label = document.querySelector('.matches-container .court-label');
          const court = label.closest('.court').getBoundingClientRect();
          const l = label.getBoundingClientRect();
          return {
            // The scoreboard's table fits inside it: its names wrap.
            scoreboard: { scrollWidth: scoreboard.scrollWidth, clientWidth: scoreboard.clientWidth },
            // A team label's words fit its width.
            teamSpills: [...document.querySelectorAll('.matches-container .team')]
              .filter((t) => t.scrollWidth > t.clientWidth).map((t) => t.textContent),
            // The court name stays inside its court, ellipsized where it is cut.
            label: {
              inside: l.left >= court.left && l.right <= court.right,
              cut: label.scrollWidth > label.clientWidth,
              textOverflow: getComputedStyle(label).textOverflow,
            },
          };
        });
        expect(boxes.scoreboard.scrollWidth).toBeLessThanOrEqual(boxes.scoreboard.clientWidth);
        expect(boxes.teamSpills).toEqual([]);
        expect(boxes.label.inside).toBe(true);
        expect(boxes.label.cut).toBe(true);
        expect(boxes.label.textOverflow).toBe('ellipsis');
        await expectScoreInputsInsideTheirCourtsAndUncovered(page);
        await expect(await pointsOf(page, wideName(0))).toHaveText('0');
      });

      test('the resting players strip wraps a long unbroken name', async ({ page }) => {
        // Nine players of the widest 20-character names: whoever rests has one.
        const names = Array.from({ length: 9 }, (_, i) => 'W'.repeat(19) + String.fromCharCode(65 + i));
        await page.goto('/');
        await chooseTheTournament(page, { format: 'americano', schedule: '9p9r.js', courts: 2 });
        for (const [i, name] of names.entries()) await page.fill(`#playerInput_${i}`, name);
        await startTheTournament(page, 'Resting Cup');
        const strip = page.locator('.resting-players');
        await expect(strip).toContainText(/W{19}[A-I]/);
        await expectNoSidewaysScroll(page);
        await expectAllWithinTheScreenWidth(page, '.resting-players');
        expect(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      });

      test('the Mexicano status line wraps a long unbroken court name', async ({ page }) => {
        const longCourt = 'W'.repeat(30); // the court name input's limit
        await page.goto('/');
        await chooseTheTournament(page, { format: 'mexicano', players: 12, courts: 3 });
        await page.fill('#courtNameInput_1', longCourt);
        await startTheTournament(page, 'Status Cup');
        await expect(page.locator('#nextRoundStatus')).toContainText(longCourt);
        await expectNoSidewaysScroll(page);
        await expectAllWithinTheScreenWidth(page, '#nextRoundStatus');
        expect(await page.locator('#nextRoundStatus').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      });
    });
  }

  // Save and New Tournament stay put from round to round, so a tap that went
  // to NEXT ROUND or PREVIOUS ROUND in one round never lands on them in the
  // next (New Tournament's dialog can discard the tournament).
  for (const width of [320, 360, 390, 412, 430]) {
    test.describe(`at ${width}x844`, () => {
      test.use({ viewport: { width, height: PHONE.height } });

      // The page position of Save and New Tournament, and the screen box of a
      // button, as a finger meets it.
      const saveAndNewOnThePage = (page) => page.evaluate(() =>
        ['#saveTournamentBtn', '#newTournamentBtn'].map((selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return [r.left + window.scrollX, r.top + window.scrollY, r.width, r.height].map(Math.round);
        }));
      const intersects = (a, b) =>
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      async function expectSaveAndNewClearOf(page, tapped) {
        for (const id of ['#saveTournamentBtn', '#newTournamentBtn']) {
          const box = await page.locator(id).boundingBox();
          expect(intersects(box, tapped), `${id} clear of the button just tapped`).toBe(false);
        }
      }

      test('Save and New Tournament keep their place in every round, clear of where NEXT and PREVIOUS were', async ({ page }) => {
        // Americano, 12 players: 11 rounds.
        await page.goto('/');
        await startTheTournament(page, 'Tap Cup');
        const roundOne = await saveAndNewOnThePage(page);
        for (let round = 2; round <= 11; round++) {
          const next = page.getByRole('button', { name: 'NEXT ROUND', exact: true });
          const tapped = await next.boundingBox();
          await next.click();
          await expect(page.locator('.round-header .left')).toHaveText('Round ' + round);
          expect(await saveAndNewOnThePage(page), 'round ' + round).toEqual(roundOne);
          await expectSaveAndNewClearOf(page, tapped);
        }
        await expect(page.getByRole('button', { name: 'NEXT ROUND', exact: true })).toHaveCount(0);

        // Mexicano: back from round 2 to round 1.
        page.on('dialog', (dialog) => dialog.accept());
        await page.click('#newTournamentBtn');
        await chooseTheTournament(page, { format: 'mexicano', players: 12, courts: 3 });
        await startTheTournament(page, 'Tap Cup Mexicano');
        const matches = page.locator('.matches-container .match');
        for (let i = 0; i < 3; i++) await matches.nth(i).locator('.result-overlay-left input').fill('12');
        await page.click('#generateNextRoundBtn');
        await expect(page.locator('.round-header .left')).toHaveText('Round 2');
        const roundTwo = await saveAndNewOnThePage(page);
        const previous = page.getByRole('button', { name: 'PREVIOUS ROUND', exact: true });
        const tapped = await previous.boundingBox();
        await previous.click();
        await expect(page.locator('.round-header .left')).toHaveText('Round 1');
        expect(await saveAndNewOnThePage(page)).toEqual(roundTwo);
        await expectSaveAndNewClearOf(page, tapped);
      });
    });
  }

  test.describe('at 480x844', () => {
    test.use({ viewport: { width: 480, height: PHONE.height } });

    test('a court has its desktop size when the screen allows it', async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await page.goto('/');
      await startTheTournament(page, 'Court Cup');
      const size = () => page.locator('.matches-container .court').first().evaluate((court) => ({
        outer: [court.offsetWidth, court.offsetHeight],
        inner: [court.clientWidth, court.clientHeight],
      }));
      const desktop = await size();
      await page.setViewportSize({ width: 480, height: PHONE.height });
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
