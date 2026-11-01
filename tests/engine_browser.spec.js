const { test, expect } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');
const { loadScheduleData } = require('./schedule-data.js');

// The scheduling engine (web/engine/*.mjs) runs in the browser, served from
// web/ like the rest of the app (AB#126). Enabling work with no user-visible
// behaviour of its own, so these titles carry no R- tag. The page loads the
// engine as an ES module straight from the test server, without any change to
// the app, and generates small schedules; the results must equal what the same
// modules produce in Node, so the browser and the generators agree.

const ENGINE_URL = '/engine/index.mjs';
const ENGINE_FILE = path.join(__dirname, '..', 'web', 'engine', 'index.mjs');

// Two cheap shapes that cover both engine paths: the full-length whist
// construction (8 players, 7 rounds) and a shorter schedule with a rest every
// round (13 players, 8 rounds: constructions, search and rest spacing).
const SHAPES = [
  { players: 8, rounds: 7 },
  { players: 13, rounds: 8 },
];

let nodeEngine;
test.beforeAll(async () => {
  nodeEngine = await import(pathToFileURL(ENGINE_FILE).href);
});

test.describe('Scheduling engine in the browser', () => {
  test('the engine module loads in the page and generates the same schedules as in Node', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('/');
    const inBrowser = await page.evaluate(
      async ({ url, shapes }) => {
        const engine = await import(url);
        return shapes.map((shape) => engine.generateSchedule(shape));
      },
      { url: ENGINE_URL, shapes: SHAPES }
    );

    expect(inBrowser).toHaveLength(SHAPES.length);
    SHAPES.forEach((shape, i) => {
      const label = `${shape.players}/${shape.rounds}`;
      const schedule = inBrowser[i];
      expect(schedule.playerCount, `${label}: playerCount`).toBe(shape.players);
      expect(schedule.rounds, `${label}: rounds`).toHaveLength(shape.rounds);
      // Every round seats each player exactly once, on a court or on the bench.
      for (const round of schedule.rounds) {
        const seated = round.matches.flatMap((m) => m.teams.flat()).concat(round.byes || []);
        expect(seated.slice().sort(), `${label} round ${round.roundNumber}: everyone once`).toEqual(
          schedule.players.slice().sort()
        );
        expect(round.matches, `${label} round ${round.roundNumber}: courts`).toHaveLength(
          Math.floor(shape.players / 4)
        );
      }
      expect(schedule.equity.optimal, `${label}: equity.optimal`).toBe(true);
      expect(schedule, `${label}: browser result equals the Node result`).toEqual(
        nodeEngine.generateSchedule(shape)
      );
    });

    // With the default seed the full-length schedule is the shipped table.
    const { equity, ...table } = inBrowser[0];
    expect(table, '8/7 in the browser equals web/schedules/8p7r.js').toEqual(loadScheduleData('8p7r'));

    expect(errors, 'no page or console errors').toEqual([]);
  });
});
