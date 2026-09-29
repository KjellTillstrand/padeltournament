/**
 * Parametrized scheduling engine (R-EQUITABLE-MIX).
 *
 *   import { generateSchedule } from './scheduler/engine/index.mjs';
 *   const schedule = generateSchedule({ players: 14, rounds: 10, seed: 7 });
 *   if (!schedule.equity.optimal) { ... opponent counts are not all within one ... }
 *
 * Produces a schedule for any supported player count (4..24) and any round
 * count up to players - 1, in the app's schedule shape:
 *   { playerCount, totalRounds, players,
 *     rounds: [{ roundNumber, matches: [{ court, teams: [[a, b], [c, d]] }],
 *                byes: [...] }],
 *     equity: { optimal, infeasible, cost, lowerBound, opponentSpread } }
 * `byes` (the players sitting out that round) is present only when the
 * player count is not a multiple of 4. `equity` reports how close the
 * opponent mix came to the equitable target; see generateSchedule.
 *
 * Shorter schedules start from the algebraic constructions of construct.mjs
 * (often already equitable) and are finished by the local search of
 * search.mjs. Shapes proven unable to be equitable (feasibility.mjs) are
 * reported as such, without spending the search budget on the impossible.
 *
 * Full-length case (players = 4n, rounds = 4n - 1): the schedule is the
 * whist construction of scheduler/whist-generate.js, i.e. a perfect mix
 * (partners exactly once, opponents exactly twice), with its rounds ordered
 * by that script's spacing stage (spacedWhist). With the default seed its
 * rounds are exactly the shipped web/schedules/<N>p<N-1>r.js table.
 */

import whist from '../whist-generate.js';
import { minSumOfSquares, searchSchedule } from './search.mjs';
import { startArrangement } from './construct.mjs';
import { costFloor } from './feasibility.mjs';

const { defaultSeed, balanceCourts, spacedWhist } = whist;

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 24;

// Work budget for the constructions plus the local search, in candidate-move
// evaluations (a deterministic cut-off, unlike wall time). ~3M evaluations is
// roughly one second on a laptop; most shapes need well under 1M. It governs
// only shorter schedules: the full-length path runs
// whist-generate.js's spacedWhist under that script's own fixed budgets
// (SPACING_CANDIDATES base rounds, etc.), about 5 s at 24 players.
const MAX_EVALUATIONS = 3000000;
// Budget for a shape that provably cannot be equitable (feasibility.mjs):
// the search stops at the proven least cost, for the small shapes within a
// few thousand evaluations (about a millisecond); this caps, at about 0.1 s,
// the shapes whose least cost is only a lower bound (e.g. 18/10, 22/12).
const INFEASIBLE_EVALUATIONS = 300000;

/** The per-size seed whist-generate.js uses; the default here as well. */
export { defaultSeed };

function normalizePlayers(players) {
  if (Number.isInteger(players)) {
    if (players < MIN_PLAYERS || players > MAX_PLAYERS) {
      throw new RangeError(
        `players must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}, got ${players}`
      );
    }
    return Array.from({ length: players }, (_, i) => `P${i + 1}`);
  }
  if (!Array.isArray(players)) {
    throw new TypeError('players must be a player count or an array of names');
  }
  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new RangeError(
      `between ${MIN_PLAYERS} and ${MAX_PLAYERS} players are supported, got ${players.length}`
    );
  }
  // Index loop, not every(): every() skips holes, so a sparse array such as
  // ['a', , 'b', 'c'] would pass. Here a hole reads as undefined and fails.
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (typeof p !== 'string' || p.trim() === '') {
      throw new TypeError(`player names must be non-empty strings (index ${i})`);
    }
  }
  if (new Set(players).size !== players.length) {
    throw new RangeError('player names must be unique');
  }
  return players.slice();
}

/** Relabel a P1..PN schedule with the given names; P(i+1) is names[i]. */
function renamed(schedule, names) {
  const rename = (label) => names[Number(label.slice(1)) - 1];
  schedule.players = names.slice();
  for (const round of schedule.rounds) {
    for (const match of round.matches) {
      match.teams = match.teams.map((team) => team.map(rename));
    }
  }
  return schedule;
}

/**
 * Opponent equity of a finished schedule, counted from its matches:
 * cost is the sum over all player pairs of (times opposed)^2, lowerBound the
 * smallest cost possible for this player and round count, and optimal means
 * cost === lowerBound, i.e. every pair's opponent count is the floor or ceil
 * of the mean (opponentSpread = max - min <= 1). infeasible is passed
 * through: whether the shape is proven unable to be optimal.
 */
function opponentEquity(schedule, infeasible) {
  const N = schedule.playerCount;
  const idx = new Map(schedule.players.map((p, i) => [p, i]));
  const opp = new Int32Array(N * N);
  let total = 0;
  for (const round of schedule.rounds) {
    for (const { teams } of round.matches) {
      for (const x of teams[0]) {
        for (const y of teams[1]) {
          const i = idx.get(x);
          const j = idx.get(y);
          opp[i < j ? i * N + j : j * N + i]++;
          total++;
        }
      }
    }
  }
  let cost = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const o = opp[i * N + j];
      cost += o * o;
      if (o < min) min = o;
      if (o > max) max = o;
    }
  }
  const lowerBound = minSumOfSquares(total, (N * (N - 1)) / 2);
  return { optimal: cost === lowerBound, infeasible, cost, lowerBound, opponentSpread: max - min };
}

/**
 * Generate a schedule, as equitable as the search can make it.
 *
 * Always guaranteed (or the call throws): no two players partner more than
 * once, and sit-out counts differ by at most one. The same inputs and seed
 * always return the identical schedule.
 *
 * NOT always guaranteed: opponent counts within one of each other. Some
 * shapes provably cannot have it (e.g. 5 players over 2 rounds, 14 over 8;
 * see feasibility.mjs): for those `equity.infeasible` is true and the
 * search stops at the least cost possible, or after a small budget. A few
 * others (e.g. 17 players over 9 rounds) are not known to be impossible but
 * the search budget runs out above the optimum. Either way the call still
 * succeeds; check `schedule.equity.optimal` (and `opponentSpread`) before
 * relying on the equitable-mix property.
 *
 * @param {{players: number|string[], rounds: number, seed?: number}} options
 *   players: a count (players are then named P1..PN) or the list of names.
 *   rounds:  1 .. players - 1.
 *   seed:    any integer; defaults to defaultSeed(player count).
 * @returns the schedule, with `equity: {optimal, infeasible, cost,
 *   lowerBound, opponentSpread}` describing its opponent mix (see
 *   opponentEquity); infeasible: the shape provably cannot be optimal.
 */
export function generateSchedule({ players, rounds, seed } = {}) {
  const names = normalizePlayers(players);
  const N = names.length;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > N - 1) {
    // More than N - 1 rounds would force a repeated partner.
    throw new RangeError(`rounds must be between 1 and ${N - 1} for ${N} players, got ${rounds}`);
  }
  const R = rounds;
  if (seed === undefined) seed = defaultSeed(N);
  if (!Number.isInteger(seed)) throw new TypeError(`seed must be an integer, got ${seed}`);

  // Full length: the whist pipeline of whist-generate.js, including its
  // spacing stage, so the default seed reproduces the shipped tables. It is
  // null only if no whist base round was found; the search below then starts
  // from scratch. Shorter: the search starts from the best construction,
  // unless the shape provably cannot be equitable (floor > 0, the proven
  // least excess over the lower bound): then it goes straight for the floor.
  const whole = N % 4 === 0 && R === N - 1 ? spacedWhist(N, seed) : null;
  const floor = costFloor(N, R);

  let schedule;
  if (whole) {
    schedule = renamed(whole.schedule, names);
  } else {
    const C = Math.floor(N / 4);
    const start = floor ? { evaluations: 0 } : startArrangement(N, R, seed);
    const result = searchSchedule({
      N,
      R,
      seed,
      maxEvaluations: floor ? INFEASIBLE_EVALUATIONS : Math.max(0, MAX_EVALUATIONS - start.evaluations),
      initial: start.rows,
      targetExcess: floor,
    });
    if (result.partnerExcess !== 0) {
      throw new Error(
        `no schedule without repeated partners found for ${N} players and ${R} rounds (seed ${seed})`
      );
    }
    schedule = {
      playerCount: N,
      totalRounds: R,
      players: names.slice(),
      rounds: result.seats.map((row, r) => {
        const round = {
          roundNumber: r + 1,
          matches: Array.from({ length: C }, (_, c) => ({
            court: c + 1,
            teams: [
              [names[row[4 * c]], names[row[4 * c + 1]]],
              [names[row[4 * c + 2]], names[row[4 * c + 3]]],
            ],
          })),
        };
        if (N % 4 !== 0) round.byes = Array.from(row.subarray(4 * C), (p) => names[p]);
        return round;
      }),
    };
    // Spread every player over the courts; this only relabels courts within
    // a round, so who partners or opposes whom is unchanged.
    balanceCourts(schedule);
  }
  schedule.equity = opponentEquity(schedule, floor > 0);
  return schedule;
}
