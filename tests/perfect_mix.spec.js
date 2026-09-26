const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// R-PERFECT-MIX: every shipped full-length schedule is a whist tournament —
// over all rounds each pair of players partners exactly once and opposes
// exactly twice. These checks read the schedule data directly; no page needed.

const SCHEDULE_DIR = path.join(__dirname, '..', 'web', 'schedules');

// Read a schedule module as pure data, never executing it: the file must be
// exactly `window.schedule<name> = ` followed by a JSON document. JSON.parse
// rejects anything else (embedded or trailing code), so a table that is code
// rather than data fails here.
function loadSchedule(name) {
  const source = fs.readFileSync(path.join(SCHEDULE_DIR, `${name}.js`), 'utf8');
  const prefix = `window.schedule${name} = `;
  expect(source.startsWith(prefix), `${name}.js starts with "${prefix}"`).toBe(true);
  return JSON.parse(source.slice(prefix.length));
}

// Count partner and opponent meetings for every unordered pair of players.
function meetingCounts(schedule) {
  const players = schedule.players;
  const partner = new Map();
  const opponent = new Map();
  const key = (a, b) =>
    a.localeCompare(b, 'en', { numeric: true }) < 0 ? `${a}|${b}` : `${b}|${a}`;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      partner.set(key(players[i], players[j]), 0);
      opponent.set(key(players[i], players[j]), 0);
    }
  }
  const bump = (map, a, b) => map.set(key(a, b), (map.get(key(a, b)) || 0) + 1);
  for (const round of schedule.rounds) {
    for (const { teams } of round.matches) {
      const [[a, b], [c, d]] = teams;
      bump(partner, a, b);
      bump(partner, c, d);
      for (const x of [a, b]) for (const y of [c, d]) bump(opponent, x, y);
    }
  }
  return { partner, opponent };
}

// Pairs whose count differs from the target, e.g. ["P15-P22: 0"].
function offTarget(counts, target) {
  const bad = [];
  for (const [pair, n] of counts) if (n !== target) bad.push(`${pair.replace('|', '-')}: ${n}`);
  return bad;
}

const SIZES = [
  { players: 12, rounds: 11 },
  { players: 16, rounds: 15 },
  { players: 20, rounds: 19 },
  { players: 24, rounds: 23 },
];

test.describe('Perfect-mix schedules', () => {
  for (const { players: n, rounds } of SIZES) {
    test(`R-PERFECT-MIX: ${n}-player schedule partners once and opposes twice`, () => {
      const name = `${n}p${rounds}r`;
      const schedule = loadSchedule(name);
      expect(schedule, `window.schedule${name} is defined`).toBeTruthy();

      // Shape: player labels, round count, courts per round, full attendance.
      expect(schedule.playerCount).toBe(n);
      expect(schedule.totalRounds).toBe(rounds);
      expect([...schedule.players].sort()).toEqual(
        Array.from({ length: n }, (_, i) => `P${i + 1}`).sort()
      );
      expect(schedule.rounds).toHaveLength(rounds);
      schedule.rounds.forEach((round, r) => {
        expect(round.roundNumber).toBe(r + 1);
        expect(round.matches.map((m) => m.court)).toEqual(
          Array.from({ length: n / 4 }, (_, i) => i + 1)
        );
        const seated = round.matches.flatMap((m) => m.teams.flat());
        expect(new Set(seated).size, `round ${r + 1} seats every player once`).toBe(n);
        expect(seated).toHaveLength(n);
      });

      // The whist property itself.
      const { partner, opponent } = meetingCounts(schedule);
      expect(offTarget(partner, 1), 'pairs not partnered exactly once').toEqual([]);
      expect(offTarget(opponent, 2), 'pairs not opposed exactly twice').toEqual([]);
    });

    test(`R-PERFECT-MIX: ${n}-player schedule puts every player on every court`, () => {
      const name = `${n}p${rounds}r`;
      const schedule = loadSchedule(name);
      const missed = [];
      for (const player of schedule.players) {
        for (let court = 1; court <= n / 4; court++) {
          const plays = schedule.rounds.some((round) =>
            round.matches.some((m) => m.court === court && m.teams.flat().includes(player))
          );
          if (!plays) missed.push(`${player}@court${court}`);
        }
      }
      expect(missed, 'players who never play a court').toEqual([]);
    });
  }
});
