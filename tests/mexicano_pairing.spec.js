// DEFERRED: AB#66 — add this spec to NODE_ONLY_SPECS in playwright.config.js so it runs once, not per browser project.
const { test, expect } = require('@playwright/test');
const path = require('path');

// R-MEXICANO-PAIRING: the Scheduler produces the next Mexicano round from the
// standings. Node-only: drives web/mexicano.js directly, no page needed.

const Mexicano = require(path.join(__dirname, '..', 'web', 'mexicano.js'));

const COUNTS = Array.from({ length: 17 }, (_, i) => 8 + i); // 8..24
const idsOf = (n) => Array.from({ length: n }, (_, i) => `P${i + 1}`);

// --- Screenplay vocabulary -------------------------------------------------
// Actor: the Scheduler. Task: ProduceNextRound. Questions: CompositionOfRound,
// RestingPlayers.
function theScheduler() {
  return {
    attemptsTo(task) {
      return task();
    },
  };
}
const ProduceNextRound = (opts) => () => Mexicano.nextRound(opts);
const CompositionOfRound = (round) => round.matches;
const RestingPlayers = (round) => round.byes;
const fielded = (round) => CompositionOfRound(round).flatMap((m) => m.teams.flat());

function standingsFor(n, rotate = 0) {
  const ids = idsOf(n);
  return ids.slice(rotate).concat(ids.slice(0, rotate));
}

test.describe('Mexicano pairing', () => {
  test('R-MEXICANO-PAIRING: round 1 puts every fielded Player in exactly one match, for 8..24 Players', () => {
    for (const n of COUNTS) {
      const players = idsOf(n);
      const round = theScheduler().attemptsTo(ProduceNextRound({ players, roundNumber: 1, seed: 7 }));
      const on = fielded(round);
      expect(on.length, `${n} players fielded`).toBe(n - (n % 4));
      expect(new Set(on).size, `${n} players: no duplicates`).toBe(on.length);
      expect(RestingPlayers(round).length, `${n} players byes`).toBe(n % 4);
      expect([...on, ...RestingPlayers(round)].sort()).toEqual([...players].sort());
      expect(CompositionOfRound(round).map((m) => m.court)).toEqual(
        Array.from({ length: Math.floor(n / 4) }, (_, i) => i + 1),
      );
      expect(round.roundNumber).toBe(1);
    }
  });

  test('R-MEXICANO-PAIRING: later rounds meet each group of four in rank order, 1st and 4th against 2nd and 3rd', () => {
    for (const n of COUNTS) {
      const standings = standingsFor(n, n % 5); // arbitrary ranking, not id order
      const round = theScheduler().attemptsTo(
        ProduceNextRound({ players: idsOf(n), standings, roundNumber: 2 }),
      );
      const ranked = standings.filter((id) => !RestingPlayers(round).includes(id));
      CompositionOfRound(round).forEach((m, g) => {
        const [r1, r2, r3, r4] = ranked.slice(g * 4, g * 4 + 4);
        expect(m.teams, `${n} players, court ${g + 1}`).toEqual([[r1, r4], [r2, r3]]);
        expect(m.court).toBe(g + 1);
      });
    }
  });

  test('R-MEXICANO-PAIRING: with 8 Players the top four share court 1 and the rest court 2', () => {
    const players = idsOf(8);
    const round = Mexicano.nextRound({ players, standings: players, roundNumber: 3 });
    expect(round.matches).toEqual([
      { court: 1, teams: [['P1', 'P4'], ['P2', 'P3']] },
      { court: 2, teams: [['P5', 'P8'], ['P6', 'P7']] },
    ]);
    expect(round.byes).toEqual([]);
  });

  test('R-MEXICANO-PAIRING: with 10 Players the two resting are those with the fewest rests so far', () => {
    const players = idsOf(10);
    // P3 and P7 have never rested; everyone else has rested once.
    const restCounts = Object.fromEntries(players.map((p) => [p, 1]));
    restCounts.P3 = 0;
    restCounts.P7 = 0;
    const round = theScheduler().attemptsTo(
      ProduceNextRound({ players, standings: players, restCounts, roundNumber: 2 }),
    );
    expect([...RestingPlayers(round)].sort()).toEqual(['P3', 'P7']);
    expect(fielded(round).length).toBe(8);
  });

  test('R-MEXICANO-PAIRING: missing rest counts read as zero', () => {
    const players = idsOf(10);
    const restCounts = {};
    for (const p of players) if (p !== 'P2' && p !== 'P9') restCounts[p] = 2;
    const round = Mexicano.nextRound({ players, standings: players, restCounts, roundNumber: 2 });
    expect([...RestingPlayers(round)].sort()).toEqual(['P2', 'P9']);
  });

  test('R-MEXICANO-PAIRING: among equally rested Players the lowest-ranked rests first', () => {
    const players = idsOf(10);
    const standings = ['P4', 'P9', 'P1', 'P6', 'P2', 'P10', 'P8', 'P3', 'P5', 'P7'];
    const round = Mexicano.nextRound({ players, standings, roundNumber: 2 });
    expect([...RestingPlayers(round)].sort()).toEqual(['P5', 'P7']);
    // The top-ranked Player is the only one never rested, so rests despite rank;
    // the second rest goes to the lowest-ranked of the tied rest.
    const restCounts = Object.fromEntries(players.map((p) => [p, 1]));
    restCounts.P4 = 0;
    const round2 = Mexicano.nextRound({ players, standings, restCounts, roundNumber: 2 });
    expect([...RestingPlayers(round2)].sort()).toEqual(['P4', 'P7']);
  });

  test('R-MEXICANO-PAIRING: the same standings and seed give an identical round, twice', () => {
    for (const n of COUNTS) {
      const base = { players: idsOf(n), standings: standingsFor(n, 3), roundNumber: 4, seed: 99 };
      expect(Mexicano.nextRound(base)).toEqual(Mexicano.nextRound(base));
      const r1 = { players: idsOf(n), roundNumber: 1, seed: 12345 };
      expect(Mexicano.nextRound(r1)).toEqual(Mexicano.nextRound(r1));
    }
  });

  test('R-MEXICANO-PAIRING: round 1 differs between seeds', () => {
    const players = idsOf(12);
    const rounds = new Set();
    for (let seed = 1; seed <= 10; seed++) {
      rounds.add(JSON.stringify(Mexicano.nextRound({ players, roundNumber: 1, seed })));
    }
    expect(rounds.size).toBeGreaterThan(1);
  });

  test('R-MEXICANO-PAIRING: later rounds ignore the seed', () => {
    const base = { players: idsOf(12), standings: standingsFor(12, 2), roundNumber: 2 };
    expect(Mexicano.nextRound({ ...base, seed: 1 })).toEqual(Mexicano.nextRound({ ...base, seed: 2 }));
  });

  test('R-MEXICANO-PAIRING: does not mutate its inputs', () => {
    const players = idsOf(10);
    const standings = standingsFor(10, 4);
    const restCounts = { P1: 1 };
    const snap = JSON.stringify({ players, standings, restCounts });
    Mexicano.nextRound({ players, standings, restCounts, roundNumber: 2 });
    expect(JSON.stringify({ players, standings, restCounts })).toBe(snap);
  });

  test('R-MEXICANO-PAIRING: invalid input is rejected with a clear error', () => {
    const ok = { players: idsOf(8), standings: idsOf(8), roundNumber: 2 };
    const bad = [
      ['too few players', { ...ok, players: idsOf(7), standings: idsOf(7) }],
      ['too many players', { ...ok, players: idsOf(25), standings: idsOf(25) }],
      ['duplicate players', { ...ok, players: [...idsOf(7), 'P1'] }],
      ['round 1 without seed', { players: idsOf(8), roundNumber: 1 }],
      ['round 2 without standings', { players: idsOf(8), roundNumber: 2 }],
      ['standings missing a player', { ...ok, standings: idsOf(7) }],
      ['standings with unknown player', { ...ok, standings: [...idsOf(7), 'X'] }],
      ['bad roundNumber', { ...ok, roundNumber: 0 }],
      ['negative rest count', { ...ok, restCounts: { P1: -1 } }],
      ['rest count for unknown player', { ...ok, restCounts: { X: 1 } }],
    ];
    for (const [label, opts] of bad) {
      expect(() => Mexicano.nextRound(opts), label).toThrow(/^Mexicano\.nextRound: /);
    }
    expect(() => Mexicano.nextRound(ok)).not.toThrow();
    expect(Mexicano.MIN_PLAYERS).toBe(8);
    expect(Mexicano.MAX_PLAYERS).toBe(24);
  });
});
