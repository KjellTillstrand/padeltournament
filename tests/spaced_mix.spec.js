const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// R-SPACED-MIX: the shipped full-length schedules spread repeat encounters
// across the tournament — with 4 or more courts no pair opposes in two
// consecutive rounds, and no pair that partners in a round opposes each other
// in the round before or after; with 3 courts (12 players) such adjacent
// repeats are unavoidable and the table holds exactly the proven minimum —
// while keeping the perfect mix (partners once, opponents twice) and putting
// every player on every court. These checks read the schedule data directly
// and count meetings themselves; no page needed.

const SCHEDULE_DIR = path.join(__dirname, '..', 'web', 'schedules');

// Read a schedule module as pure data, never executing it: the file must be
// exactly `window.schedule<name> = ` followed by a JSON document.
function loadSchedule(name) {
  const source = fs.readFileSync(path.join(SCHEDULE_DIR, `${name}.js`), 'utf8');
  const prefix = `window.schedule${name} = `;
  expect(source.startsWith(prefix), `${name}.js starts with "${prefix}"`).toBe(true);
  return JSON.parse(source.slice(prefix.length));
}

const pairKey = (a, b) =>
  a.localeCompare(b, 'en', { numeric: true }) < 0 ? `${a}-${b}` : `${b}-${a}`;

// Every meeting of every pair, in play order: pair -> [{ round, kind }] where
// round is the 1-based position in the round list and kind is 'partner' or
// 'opponent'.
function meetings(schedule) {
  const byPair = new Map();
  const add = (a, b, round, kind) => {
    const key = pairKey(a, b);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push({ round, kind });
  };
  schedule.rounds.forEach((round, r) => {
    for (const { teams } of round.matches) {
      const [[a, b], [c, d]] = teams;
      add(a, b, r + 1, 'partner');
      add(c, d, r + 1, 'partner');
      for (const x of [a, b]) for (const y of [c, d]) add(x, y, r + 1, 'opponent');
    }
  });
  return byPair;
}

// Pairs that oppose each other in two consecutive rounds.
function backToBackOppositions(schedule) {
  const bad = [];
  for (const [pair, list] of meetings(schedule)) {
    const rounds = list.filter((m) => m.kind === 'opponent').map((m) => m.round);
    for (const r of rounds) {
      if (rounds.includes(r + 1)) bad.push(`${pair}: opposed in rounds ${r} and ${r + 1}`);
    }
  }
  return bad;
}

// Pairs that partner in a round and oppose each other in the round before or after.
function partnerNextToOpposition(schedule) {
  const bad = [];
  for (const [pair, list] of meetings(schedule)) {
    const opposed = list.filter((m) => m.kind === 'opponent').map((m) => m.round);
    for (const { round, kind } of list) {
      if (kind !== 'partner') continue;
      for (const r of [round - 1, round + 1]) {
        if (opposed.includes(r)) bad.push(`${pair}: partnered in round ${round}, opposed in round ${r}`);
      }
    }
  }
  return bad;
}

// Sizes with 4 or more courts: zero adjacent repeats. 12 players (3 courts)
// are held to the minimum instead, per the REQ-34 amendment: every match of a
// round seats 4 players drawn from the 3 matches of the round before, so at
// least two of them shared a match there and meet again (pigeonhole). That is
// at least 1 repeat per match, 3 per round change, 3 x 10 = 30 over 11
// rounds; see adjacentRepeatBound() in scheduler/whist-generate.js.
const SPACED_SIZES = [
  { players: 16, rounds: 15 },
  { players: 20, rounds: 19 },
  { players: 24, rounds: 23 },
];
const TWELVE = { players: 12, rounds: 11, minimumAdjacentRepeats: 30 };

test.describe('Spaced-mix schedules', () => {
  test(`R-SPACED-MIX: 12-player schedule has exactly the minimum ${TWELVE.minimumAdjacentRepeats} adjacent repeat encounters`, () => {
    const schedule = loadSchedule('12p11r');
    expect(schedule.rounds).toHaveLength(TWELVE.rounds);
    schedule.rounds.forEach((round, r) => expect(round.roundNumber).toBe(r + 1));
    const backToBack = backToBackOppositions(schedule);
    const partnerAdjacent = partnerNextToOpposition(schedule);
    expect(
      backToBack.length + partnerAdjacent.length,
      `adjacent repeats: ${backToBack.length} back-to-back oppositions + ` +
        `${partnerAdjacent.length} partner-adjacent oppositions`
    ).toBe(TWELVE.minimumAdjacentRepeats);
  });

  for (const { players: n, rounds } of SPACED_SIZES) {
    const name = `${n}p${rounds}r`;

    test(`R-SPACED-MIX: ${n}-player schedule never has a pair oppose in consecutive rounds`, () => {
      const schedule = loadSchedule(name);
      expect(schedule.rounds).toHaveLength(rounds);
      schedule.rounds.forEach((round, r) => expect(round.roundNumber).toBe(r + 1));
      expect(backToBackOppositions(schedule), 'pairs opposing in consecutive rounds').toEqual([]);
    });

    test(`R-SPACED-MIX: ${n}-player schedule never has partners oppose each other in the round before or after`, () => {
      const schedule = loadSchedule(name);
      expect(schedule.rounds).toHaveLength(rounds);
      expect(partnerNextToOpposition(schedule), 'partners opposing in an adjacent round').toEqual([]);
    });
  }

  for (const { players: n, rounds } of [TWELVE, ...SPACED_SIZES]) {
    const name = `${n}p${rounds}r`;

    test(`R-SPACED-MIX: ${n}-player schedule keeps the perfect mix and every player on every court`, () => {
      const schedule = loadSchedule(name);
      expect(schedule.playerCount).toBe(n);
      expect(schedule.totalRounds).toBe(rounds);
      const players = Array.from({ length: n }, (_, i) => `P${i + 1}`);
      expect([...schedule.players].sort()).toEqual([...players].sort());
      schedule.rounds.forEach((round, r) => {
        expect(round.matches.map((m) => m.court), `round ${r + 1} courts`).toEqual(
          Array.from({ length: n / 4 }, (_, i) => i + 1)
        );
        const seated = round.matches.flatMap((m) => m.teams.flat());
        expect(seated, `round ${r + 1} seats every player once`).toHaveLength(n);
        expect(new Set(seated).size, `round ${r + 1} seats every player once`).toBe(n);
      });

      const byPair = meetings(schedule);
      const off = [];
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const key = pairKey(players[i], players[j]);
          const list = byPair.get(key) || [];
          const partnered = list.filter((m) => m.kind === 'partner').length;
          const opposed = list.filter((m) => m.kind === 'opponent').length;
          if (partnered !== 1 || opposed !== 2) off.push(`${key}: partnered ${partnered}x, opposed ${opposed}x`);
        }
      }
      expect(off, 'pairs not partnered exactly once and opposed exactly twice').toEqual([]);

      const missed = [];
      for (const player of players) {
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
