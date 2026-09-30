const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// R-SPACED-MIX: the shipped full-length schedules spread repeat encounters
// across the tournament — with 4 or more courts no pair opposes in two
// consecutive rounds, and no pair that partners in a round opposes each other
// in the round before or after; with 3 courts (12 players) such adjacent
// repeats are unavoidable and the table holds exactly the proven minimum;
// with 2 courts (8 players) it holds exactly the minimum too, none of them
// back-to-back — while keeping the perfect mix (partners once, opponents
// twice) and putting every player on every court. These checks read the
// schedule data directly and count meetings themselves; no page needed.

const { adjacentRepeatBound, zeroBackToBackRequired } = require('../scheduler/whist-generate.js');

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

// 8 players (2 courts): every match of a round takes at best 2 players from
// each match of the round before, so holds at least 2 repeat pairs: 4 per
// round change, 4 x 6 = 24 over 7 rounds. The exception to R-SPACED-MIX here:
// the table holds exactly those 24 and none of them is a back-to-back
// opposition, so all 24 are partner-adjacent. The test "every 8-player whist
// tournament ..." below establishes by exhaustive check, over every possible
// 8-player design and round order, that 24 is the floor and that it can always
// be met with zero back-to-back oppositions.
const EIGHT = { players: 8, rounds: 7, minimumAdjacentRepeats: 24 };

// Every labeled 8-player whist tournament, as lists of 7 rounds, each round a
// list of two matches [[a, b], [c, d]] over player indices 0..7. Rounds are
// listed by whom player 0 partners (players 1..7 in turn), which lists each
// tournament exactly once; the search keeps every pair to at most one
// partnering and two oppositions, and 7 rounds then force exactly that.
function allEightPlayerWhistTournaments() {
  const splits = (four) => {
    const [a, b, c, d] = four;
    return [[[a, b], [c, d]], [[a, c], [b, d]], [[a, d], [b, c]]];
  };
  const byPartnerOf0 = new Map();
  for (let x = 1; x < 8; x++) {
    for (let y = x + 1; y < 8; y++) {
      for (let z = y + 1; z < 8; z++) {
        const first = [0, x, y, z];
        const second = [...Array(8).keys()].filter((p) => !first.includes(p));
        for (const m1 of splits(first)) {
          for (const m2 of splits(second)) {
            const partnerOf0 = m1[0][1];
            if (!byPartnerOf0.has(partnerOf0)) byPartnerOf0.set(partnerOf0, []);
            byPartnerOf0.get(partnerOf0).push([m1, m2]);
          }
        }
      }
    }
  }
  const partner = new Uint8Array(64);
  const opponent = new Uint8Array(64);
  const cell = (x, y) => (x < y ? x * 8 + y : y * 8 + x);
  const meetingsOf = ([[[a, b], [c, d]], [[e, f], [g, h]]]) => ({
    partners: [cell(a, b), cell(c, d), cell(e, f), cell(g, h)],
    opponents: [a, b].flatMap((x) => [c, d].map((y) => cell(x, y)))
      .concat([e, f].flatMap((x) => [g, h].map((y) => cell(x, y)))),
  });
  const found = [];
  const chosen = [];
  (function extend(partnerOf0) {
    if (partnerOf0 === 8) {
      found.push(chosen.slice());
      return;
    }
    for (const round of byPartnerOf0.get(partnerOf0)) {
      const { partners, opponents } = meetingsOf(round);
      if (partners.some((k) => partner[k] >= 1) || opponents.some((k) => opponent[k] >= 2)) continue;
      partners.forEach((k) => partner[k]++);
      opponents.forEach((k) => opponent[k]++);
      chosen.push(round);
      extend(partnerOf0 + 1);
      chosen.pop();
      partners.forEach((k) => partner[k]--);
      opponents.forEach((k) => opponent[k]--);
    }
  })(1);
  return found;
}

// Round list (player indices) -> schedule object in the shipped format.
function asSchedule(rounds) {
  const label = (p) => `P${p + 1}`;
  return {
    rounds: rounds.map((matches, r) => ({
      roundNumber: r + 1,
      matches: matches.map((teams, c) => ({ court: c + 1, teams: teams.map((t) => t.map(label)) })),
    })),
  };
}

// A tournament's rounds as a canonical string, independent of round, match,
// team and seat order, to recognise the same design.
function designKey(schedule) {
  return schedule.rounds
    .map(({ matches }) =>
      matches
        .map(({ teams }) =>
          teams
            .map((t) => [...t].sort().join('+'))
            .sort()
            .join(' v ')
        )
        .sort()
        .join(' | ')
    )
    .sort()
    .join(' / ');
}

// All orderings of [0..n-1].
function permutations(n) {
  if (n === 0) return [[]];
  const out = [];
  for (const rest of permutations(n - 1)) {
    for (let pos = 0; pos <= rest.length; pos++) out.push([...rest.slice(0, pos), n - 1, ...rest.slice(pos)]);
  }
  return out;
}

test.describe('Spaced-mix schedules', () => {
  test(`R-SPACED-MIX: 8-player schedule has exactly the minimum ${EIGHT.minimumAdjacentRepeats} adjacent repeat encounters, none back-to-back`, () => {
    const schedule = loadSchedule('8p7r');
    expect(schedule.rounds).toHaveLength(EIGHT.rounds);
    schedule.rounds.forEach((round, r) => expect(round.roundNumber).toBe(r + 1));
    expect(backToBackOppositions(schedule), 'pairs opposing in consecutive rounds').toEqual([]);
    expect(
      partnerNextToOpposition(schedule).length,
      'partner-adjacent oppositions (all adjacent repeats, as none is back-to-back)'
    ).toBe(EIGHT.minimumAdjacentRepeats);
  });

  test('R-SPACED-MIX: every 8-player whist tournament has at least 24 adjacent repeats, and can have exactly 24 with none back-to-back', () => {
    // Exhaustive: every labeled design, each in all 7! = 5040 round orders.
    const designs = allEightPlayerWhistTournaments();
    expect(designs.length, 'labeled 8-player whist tournaments').toBe(720);
    const orders = permutations(EIGHT.rounds);
    expect(orders).toHaveLength(5040);

    let fewestAdjacent = Infinity;
    let fewestPartnerAdjacent = Infinity;
    const withoutSpacedOrder = [];
    const keys = new Set();
    designs.forEach((rounds, d) => {
      const schedule = asSchedule(rounds);
      keys.add(designKey(schedule));
      // Adjacent repeats between two rounds, split by kind, read off the
      // two-round schedule with the same counters as the shipped-table tests.
      const between = rounds.map((x) =>
        rounds.map((y) => {
          if (x === y) return null;
          const pair = asSchedule([x, y]);
          return {
            backToBack: backToBackOppositions(pair).length,
            partnerAdjacent: partnerNextToOpposition(pair).length,
          };
        })
      );
      let spaced = false;
      for (const order of orders) {
        let backToBack = 0;
        let partnerAdjacent = 0;
        for (let i = 0; i + 1 < order.length; i++) {
          const w = between[order[i]][order[i + 1]];
          backToBack += w.backToBack;
          partnerAdjacent += w.partnerAdjacent;
        }
        fewestAdjacent = Math.min(fewestAdjacent, backToBack + partnerAdjacent);
        fewestPartnerAdjacent = Math.min(fewestPartnerAdjacent, partnerAdjacent);
        if (backToBack === 0 && partnerAdjacent === EIGHT.minimumAdjacentRepeats) spaced = true;
      }
      if (!spaced) withoutSpacedOrder.push(d);
    });

    expect(keys.size, 'the enumerated designs are distinct').toBe(designs.length);
    expect(keys.has(designKey(loadSchedule('8p7r'))), 'the shipped table is one of them').toBe(true);
    expect(fewestAdjacent, 'fewest adjacent repeats over every design and order').toBe(
      EIGHT.minimumAdjacentRepeats
    );
    expect(withoutSpacedOrder, 'designs with no order of 24 adjacent repeats, none back-to-back').toEqual([]);
    // Partner-adjacent oppositions alone have no such floor: an order may trade
    // them for back-to-back oppositions. The floor of 24 holds only together
    // with the zero back-to-back rule, which is how the 8-player test states it.
    expect(fewestPartnerAdjacent, 'fewest partner-adjacent oppositions when back-to-back is allowed').toBe(0);
    // The generator refuses a table unless it meets this (whist-generate.js).
    expect(adjacentRepeatBound(EIGHT.players)).toBe(fewestAdjacent);
    expect(zeroBackToBackRequired(EIGHT.players)).toBe(true);
  });

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

  for (const { players: n, rounds } of [EIGHT, TWELVE, ...SPACED_SIZES]) {
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
