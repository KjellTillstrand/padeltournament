const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// R-EQUITABLE-MIX: the scheduling engine (scheduler/engine) produces an
// equitable schedule for any player and round count — no repeated partners,
// opponent counts within one of each other, sit-outs spread evenly — and the
// same inputs and seed always give the same schedule. These checks call the
// engine directly and count meetings from its output; no page needed.

const ENGINE_DIR = path.join(__dirname, '..', 'scheduler', 'engine');
const SCHEDULE_DIR = path.join(__dirname, '..', 'web', 'schedules');

let generateSchedule;
let feasibility;
let exhaustive;
test.beforeAll(async () => {
  ({ generateSchedule } = await import(path.join(ENGINE_DIR, 'index.mjs')));
  feasibility = await import(path.join(ENGINE_DIR, 'feasibility.mjs'));
  ({ exhaustive } = await import(path.join(ENGINE_DIR, 'prove-infeasible.mjs')));
});

// Structural check: every round seats each player exactly once, on courts
// 1..floor(N/4) or on the bench (byes). Returns a list of problems.
function shapeProblems(schedule, n, rounds) {
  const problems = [];
  const courts = Math.floor(n / 4);
  if (schedule.playerCount !== n) problems.push(`playerCount ${schedule.playerCount}`);
  if (schedule.totalRounds !== rounds) problems.push(`totalRounds ${schedule.totalRounds}`);
  if (schedule.players.length !== n || new Set(schedule.players).size !== n) {
    problems.push('players is not a list of n distinct names');
  }
  if (schedule.rounds.length !== rounds) problems.push(`${schedule.rounds.length} rounds`);
  schedule.rounds.forEach((round, r) => {
    if (round.roundNumber !== r + 1) problems.push(`round ${r + 1}: roundNumber ${round.roundNumber}`);
    const courtList = round.matches.map((m) => m.court).join(',');
    const expected = Array.from({ length: courts }, (_, i) => i + 1).join(',');
    if (courtList !== expected) problems.push(`round ${r + 1}: courts ${courtList}`);
    const seated = round.matches.flatMap((m) => m.teams.flat());
    const benched = round.byes || [];
    if (n % 4 !== 0 && !Array.isArray(round.byes)) problems.push(`round ${r + 1}: no byes list`);
    const everyone = [...seated, ...benched];
    if (everyone.length !== n || new Set(everyone).size !== n) {
      problems.push(`round ${r + 1}: players not seated exactly once`);
    }
    for (const p of everyone) {
      if (!schedule.players.includes(p)) problems.push(`round ${r + 1}: unknown player ${p}`);
    }
  });
  return problems;
}

// Partner and opponent counts for every unordered pair, and sit-out counts
// per player (a player sits out a round when no match seats them).
function meetingCounts(schedule) {
  const players = schedule.players;
  const partner = new Map();
  const opponent = new Map();
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      partner.set(key(players[i], players[j]), 0);
      opponent.set(key(players[i], players[j]), 0);
    }
  }
  const byes = new Map(players.map((p) => [p, 0]));
  const bump = (map, a, b) => map.set(key(a, b), map.get(key(a, b)) + 1);
  for (const round of schedule.rounds) {
    const seated = new Set();
    for (const { teams } of round.matches) {
      const [[a, b], [c, d]] = teams;
      [a, b, c, d].forEach((p) => seated.add(p));
      bump(partner, a, b);
      bump(partner, c, d);
      for (const x of [a, b]) for (const y of [c, d]) bump(opponent, x, y);
    }
    for (const p of players) if (!seated.has(p)) byes.set(p, byes.get(p) + 1);
  }
  return { partner, opponent, byes };
}

const spread = (counts) => {
  const values = [...counts.values()];
  return { min: Math.min(...values), max: Math.max(...values) };
};
const repeated = (partner) =>
  [...partner].filter(([, n]) => n > 1).map(([pair, n]) => `${pair.replace('|', '-')}: ${n}`);

// Everything the engine promises unconditionally: correct shape, no repeated
// partner, sit-out counts within one. Also checks that the engine's own
// equity report agrees with the independent opponent count. Returns the
// independently counted opponent range.
function expectSound(schedule, n, rounds, label) {
  expect(shapeProblems(schedule, n, rounds), `${label}: schedule shape`).toEqual([]);
  const { partner, opponent, byes } = meetingCounts(schedule);
  expect(repeated(partner), `${label}: pairs partnered more than once`).toEqual([]);
  const sitOuts = spread(byes);
  expect(sitOuts.max - sitOuts.min, `${label}: sit-out counts range ${sitOuts.min}..${sitOuts.max}`)
    .toBeLessThanOrEqual(1);
  const opp = spread(opponent);
  expect(schedule.equity.opponentSpread, `${label}: equity.opponentSpread`).toBe(opp.max - opp.min);
  expect(schedule.equity.optimal, `${label}: equity.optimal agrees with cost`).toBe(
    schedule.equity.cost === schedule.equity.lowerBound
  );
  return opp;
}

// Sound, and the equitable mix itself: opponent counts within one.
function expectEquitable(schedule, n, rounds, label) {
  const { min, max } = expectSound(schedule, n, rounds, label);
  expect(max - min, `${label}: opponent counts range ${min}..${max}`).toBeLessThanOrEqual(1);
  expect(schedule.equity.optimal, `${label}: equity.optimal`).toBe(true);
}

const EXAMPLES = [
  { players: 12, rounds: 6 },
  { players: 14, rounds: 10 },
  { players: 20, rounds: 8 },
];
const SEEDS = [1, 2, 3];

test.describe('Equitable schedules for any length', () => {
  for (const { players: n, rounds } of EXAMPLES) {
    test(`R-EQUITABLE-MIX: ${n} players over ${rounds} rounds never repeat a partner and keep opponent counts within one`, () => {
      for (const seed of SEEDS) {
        expectEquitable(generateSchedule({ players: n, rounds, seed }), n, rounds, `seed ${seed}`);
      }
    });
  }

  test('R-EQUITABLE-MIX: odd-sized 9/6 and 13/6 tournaments keep opponent counts within one', () => {
    for (const { players: n, rounds } of [{ players: 9, rounds: 6 }, { players: 13, rounds: 6 }]) {
      expectEquitable(generateSchedule({ players: n, rounds }), n, rounds, `${n}/${rounds}`);
    }
  });

  test('R-EQUITABLE-MIX: a shape the search cannot balance still succeeds and says so', () => {
    // Known-hard shapes at the default seed, not proven impossible: the
    // search budget runs out above the optimum. The contract is honest
    // degradation — the hard guarantees hold and equity reports the miss —
    // never a silent "equitable" claim. (A tripwire: if the engine closes
    // these, move the test to shapes that still miss.)
    for (const { players: n, rounds } of [{ players: 17, rounds: 9 }, { players: 21, rounds: 11 }]) {
      const schedule = generateSchedule({ players: n, rounds });
      const { min, max } = expectSound(schedule, n, rounds, `${n}/${rounds}`);
      expect(schedule.equity.optimal, `${n}/${rounds}: equity.optimal`).toBe(false);
      expect(schedule.equity.infeasible, `${n}/${rounds}: equity.infeasible`).toBe(false);
      expect(schedule.equity.cost).toBeGreaterThan(schedule.equity.lowerBound);
      expect(max - min, `${n}/${rounds}: opponent counts range ${min}..${max}`).toBeGreaterThan(1);
    }
  });

  test('R-EQUITABLE-MIX: formerly unbalanced shapes now keep opponent counts within one', () => {
    // Each of these missed the optimum at the default seed before the
    // constructions of scheduler/engine/construct.mjs (AB#32). One or more
    // per construction: cyclic development (14/7, 16/7, 18/9, 20/9, 22/11,
    // 24/10), one matching round past it (16/8, 20/10, 24/12), whist subsets
    // (17/15, 20/16, 21/19, 24/20), the 4n + 2 near-whist design with its
    // sit-out trade (18/17, 22/21), and the search alone (13/11). About 1.5 s.
    const shapes = [
      [13, 11], [14, 7], [16, 7], [16, 8], [17, 15], [18, 9], [18, 17], [20, 9], [20, 10],
      [20, 16], [21, 19], [22, 11], [22, 21], [24, 10], [24, 12], [24, 20],
    ];
    for (const [n, rounds] of shapes) {
      expectEquitable(generateSchedule({ players: n, rounds }), n, rounds, `${n}/${rounds}`);
    }
  });

  test('R-EQUITABLE-MIX: a provably unbalanceable shape returns at once and says so', () => {
    // 5 players over 2 rounds cannot keep opponent counts within one (proven
    // by exhaustive search); the engine used to spend its whole budget (about
    // a second) finding that out. Now it stops at the proven least cost.
    const start = performance.now();
    const schedule = generateSchedule({ players: 5, rounds: 2 });
    const elapsed = performance.now() - start;
    const { min, max } = expectSound(schedule, 5, 2, '5/2');
    expect(schedule.equity).toEqual(expect.objectContaining({ optimal: false, infeasible: true }));
    expect(schedule.equity.cost, '5/2: the least cost any schedule has').toBe(schedule.equity.lowerBound + 2);
    expect(max - min, `5/2: opponent counts range ${min}..${max}`).toBe(2);
    expect(elapsed, '5/2: returns without a search budget burn').toBeLessThan(100);

    // Proven by counting alone (14 players over 8 rounds; too large for the
    // exhaustive search): flagged, still sound.
    const counted = generateSchedule({ players: 14, rounds: 8 });
    expectSound(counted, 14, 8, '14/8');
    expect(counted.equity).toEqual(expect.objectContaining({ optimal: false, infeasible: true }));
  });

  // Independent check of an exhaustive search witness (seat rows): no
  // repeated partner, sit-outs within one, opponent cost within the bound.
  function witnessProblems(n, rows, excess) {
    const courts = Math.floor(n / 4);
    const partner = new Map();
    const opponent = new Map();
    const byes = new Array(n).fill(0);
    const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const bump = (map, a, b) => map.set(key(a, b), (map.get(key(a, b)) || 0) + 1);
    for (const row of rows) {
      expect([...row].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
      for (let c = 0; c < courts; c++) {
        const [a, b, x, y] = row.slice(4 * c, 4 * c + 4);
        bump(partner, a, b);
        bump(partner, x, y);
        for (const [u, v] of [[a, x], [a, y], [b, x], [b, y]]) bump(opponent, u, v);
      }
      for (const p of row.slice(4 * courts)) byes[p]++;
    }
    const problems = [];
    if ([...partner.values()].some((v) => v > 1)) problems.push('repeated partner');
    if (Math.max(...byes) - Math.min(...byes) > 1) problems.push('sit-outs not within one');
    const pairs = (n * (n - 1)) / 2;
    const counts = [...opponent.values()];
    const total = counts.reduce((a, b) => a + b, 0);
    const q = Math.floor(total / pairs);
    const lowerBound = pairs * q * q + (total - q * pairs) * (2 * q + 1);
    const cost = counts.reduce((a, o) => a + o * o, 0);
    if (cost > lowerBound + excess) problems.push(`cost ${cost} above ${lowerBound} + ${excess}`);
    return problems;
  }

  test('R-EQUITABLE-MIX: the infeasible table is re-proven by exhaustive search', () => {
    // scheduler/engine/prove-infeasible.mjs is a complete search; re-run it
    // for the table entries that take under a second (the rest: run the
    // script, a few minutes). For each: nothing below the floor, and a
    // witness at the floor. Controls: shapes the engine does balance are
    // found feasible, with a checked witness — the prover is not vacuous.
    const quick = ['5/2', '5/3', '6/3', '6/4', '7/5', '9/4', '9/5', '12/5'];
    for (const shape of quick) {
      const [n, rounds] = shape.split('/').map(Number);
      const floor = feasibility.EXHAUSTIVE_FLOORS.get(shape);
      expect(exhaustive(n, rounds, floor - 2).feasible, `${shape}: below lowerBound + ${floor}`).toBe(false);
      const { feasible, rounds: witness } = exhaustive(n, rounds, floor);
      expect(feasible, `${shape}: at lowerBound + ${floor}`).toBe(true);
      expect(witnessProblems(n, witness, floor), `${shape}: witness`).toEqual([]);
      expect(generateSchedule({ players: n, rounds }).equity.infeasible, `${shape}: engine flag`).toBe(true);
    }
    for (const [n, rounds] of [[8, 4], [9, 3], [9, 6], [12, 4]]) {
      const { feasible, rounds: witness } = exhaustive(n, rounds, 0);
      expect(feasible, `${n}/${rounds}: equitable schedule exists`).toBe(true);
      expect(witnessProblems(n, witness, 0), `${n}/${rounds}: witness`).toEqual([]);
    }
  });

  test('R-EQUITABLE-MIX: the counting argument agrees with the exhaustive search', () => {
    // feasibility.countingInfeasible is a closed-form proof (a degree sequence
    // no simple graph has); every shape it rules out that is small enough for
    // the exhaustive search is also in the exhaustively proven table.
    const ruledOut = [];
    for (let n = 4; n <= 24; n++) {
      for (let rounds = 1; rounds < n; rounds++) {
        if (feasibility.countingInfeasible(n, rounds)) ruledOut.push(`${n}/${rounds}`);
      }
    }
    expect(ruledOut).toEqual(['5/2', '5/3', '6/4', '7/5', '10/6', '11/7', '14/8', '18/10', '22/12']);
    for (const shape of ruledOut.filter((s) => Number(s.split('/')[0]) <= 12)) {
      expect(feasibility.EXHAUSTIVE_FLOORS.has(shape), `${shape}: exhaustively proven too`).toBe(true);
    }
  });

  test('R-EQUITABLE-MIX: 14 players over 10 rounds spread their byes evenly', () => {
    const names = ['Ana', 'Ben', 'Cai', 'Dov', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kim', 'Lea', 'Max', 'Noa'];
    for (const seed of SEEDS) {
      const schedule = generateSchedule({ players: names, rounds: 10, seed });
      expect(shapeProblems(schedule, 14, 10), `seed ${seed}: schedule shape`).toEqual([]);
      expect(schedule.players).toEqual(names);
      schedule.rounds.forEach((round, r) => {
        expect(round.byes, `seed ${seed}, round ${r + 1}: two players sit out`).toHaveLength(2);
      });
      const { byes } = meetingCounts(schedule);
      // 10 rounds x 2 byes = 20 sit-outs over 14 players: everyone sits 1 or 2.
      const { min, max } = spread(byes);
      expect(max - min, `seed ${seed}: sit-out counts range ${min}..${max}`).toBeLessThanOrEqual(1);
      expect([...byes.values()].reduce((a, b) => a + b, 0)).toBe(20);
    }
  });

  test('R-EQUITABLE-MIX: the same players, rounds and seed reproduce the schedule', () => {
    for (const { players: n, rounds } of EXAMPLES) {
      const first = generateSchedule({ players: n, rounds, seed: 42 });
      const second = generateSchedule({ players: n, rounds, seed: 42 });
      expect(second, `${n}/${rounds}: two runs with seed 42`).toEqual(first);
      const other = generateSchedule({ players: n, rounds, seed: 43 });
      expect(other, `${n}/${rounds}: seed 43 differs from seed 42`).not.toEqual(first);
    }
  });

  // Perfect mix over 4n players and 4n - 1 rounds: partners exactly once,
  // opponents exactly twice.
  function expectPerfectMix(schedule, n, label) {
    expect(shapeProblems(schedule, n, n - 1), `${label}: schedule shape`).toEqual([]);
    const { partner, opponent } = meetingCounts(schedule);
    const off = (counts, target) =>
      [...counts].filter(([, v]) => v !== target).map(([pair, v]) => `${pair}: ${v}`);
    expect(off(partner, 1), `${label}: pairs not partnered exactly once`).toEqual([]);
    expect(off(opponent, 2), `${label}: pairs not opposed exactly twice`).toEqual([]);
    expect(schedule.equity).toEqual(
      expect.objectContaining({ optimal: true, opponentSpread: 0 })
    );
  }

  test('R-EQUITABLE-MIX: 12 players over 11 rounds achieve the perfect mix', () => {
    for (const seed of [undefined, ...SEEDS]) {
      expectPerfectMix(generateSchedule({ players: 12, rounds: 11, seed }), 12, `seed ${seed}`);
    }
  });

  test('R-EQUITABLE-MIX: 8, 16, 20 and 24 players over a full length achieve the perfect mix', () => {
    for (const n of [8, 16, 20, 24]) {
      expectPerfectMix(generateSchedule({ players: n, rounds: n - 1 }), n, `${n}/${n - 1}`);
    }
  });

  test('R-EQUITABLE-MIX: the full-length default is the shipped whist table', () => {
    // The engine reuses scheduler/whist-generate.js for the full-length case;
    // with the default seed it must reproduce each canonical table (apart from
    // the engine's added equity report). Cost: the spacing stage tries 16
    // base rounds per size, about 0.3 s at 16, 0.7 s at 20 and 5 s at 24
    // players, so this test takes about 6 s.
    for (const n of [12, 16, 20, 24]) {
      const name = `${n}p${n - 1}r`;
      const source = fs.readFileSync(path.join(SCHEDULE_DIR, `${name}.js`), 'utf8');
      const prefix = `window.schedule${name} = `;
      expect(source.startsWith(prefix), `${name}.js starts with "${prefix}"`).toBe(true);
      const { equity, ...table } = generateSchedule({ players: n, rounds: n - 1 });
      expect(equity.optimal, `${name}: equity.optimal`).toBe(true);
      expect(table, `${name}: engine output equals the shipped table`).toEqual(
        JSON.parse(source.slice(prefix.length))
      );
    }
  });

  test('R-EQUITABLE-MIX: more rounds than distinct partners allow are rejected', () => {
    // 12 players have only 11 possible partners each.
    expect(() => generateSchedule({ players: 12, rounds: 12 })).toThrow(/rounds must be between 1 and 11/);
  });

  test('R-EQUITABLE-MIX: malformed player lists are rejected', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(() => generateSchedule({ players: ['a', , 'b', 'c'], rounds: 2 })).toThrow(/non-empty strings/);
    expect(() => generateSchedule({ players: ['a', 'b', 'a', 'c'], rounds: 2 })).toThrow(/unique/);
    expect(() => generateSchedule({ players: ['a', 'b', ' ', 'c'], rounds: 2 })).toThrow(/non-empty strings/);
  });
});
