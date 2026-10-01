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
 *     equity: { optimal, infeasible, cost, lowerBound, opponentSpread,
 *               sitOuts, sitOutSpread, restGap, restGapTarget, restSpaced } }
 * `byes` (the players sitting out that round) is present only when the
 * player count is not a multiple of 4: floor(N/4) courts play and the other
 * N mod 4 players rest. `equity` reports how close the opponent mix came to
 * the equitable target and how fairly the rests fall; see generateSchedule.
 *
 * Shorter schedules start from the algebraic constructions of construct.mjs
 * (often already equitable) and are finished by the local search of
 * search.mjs. Shapes proven unable to be equitable (feasibility.mjs) are
 * reported as such, without spending the search budget on the impossible.
 * With byes, the rounds are then reordered to space each player's rests
 * apart (rest.mjs; a few milliseconds, ORDER_EVALUATIONS).
 *
 * Full-length case (players = 4n, rounds = 4n - 1): the schedule is the
 * whist construction of scheduler/whist-generate.js, i.e. a perfect mix
 * (partners exactly once, opponents exactly twice), with its rounds ordered
 * by that script's spacing stage (spacedWhist). With the default seed its
 * rounds are exactly the shipped web/schedules/<N>p<N-1>r.js table.
 *
 * Latency budget (for running in a browser). The engine is synchronous and
 * CPU-bound; the cut-offs are evaluation counts, so results do not depend on
 * machine speed but wall time does. Measured on a laptop (Node 22):
 *   - Shorter schedules: at most MAX_EVALUATIONS = 3M candidate evaluations
 *     for the constructions plus the search together, about 1 s. Shapes the
 *     constructions solve return in milliseconds; at the default seed the
 *     slowest shorter shape takes about 1.1 s. Proven-impossible shapes are
 *     capped at INFEASIBLE_EVALUATIONS, about 0.1 s.
 *   - Outside that budget: for 4n players below full length the whist base
 *     round search of whist-generate.js (findBaseRound, its own node budget)
 *     runs as well; unlucky seeds at 24 players take up to about 1.35 s
 *     there, and the slowest whole call seen was about 1.9 s (24/19, seed 5).
 *   - Full length (4n players, 4n - 1 rounds): spacedWhist's own budgets,
 *     about 5 s at 24 players (0.3 s at 16, 0.7 s at 20).
 *   - Evaluation cost is not uniform: a candidate costs about 0.25-0.45 us
 *     in the search and the cyclic constructions, more on the 4n + 2
 *     "trade" shapes (construct.mjs re-scans the sit-outs per move there).
 * Recommendation: call it from a Web Worker, not the UI thread; the budgets
 * are constants here and can be made configurable when the app needs it.
 */

import whist from '../whist-generate.js';
import { minSumOfSquares, searchSchedule } from './search.mjs';
import { MAX_START_EVALUATIONS, startArrangement } from './construct.mjs';
import { costFloor } from './feasibility.mjs';
import { restEquity, spaceRests } from './rest.mjs';

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
// The local search always gets at least this much of MAX_EVALUATIONS, however
// much the constructions spent (they are capped well below; checked at load).
const MIN_SEARCH_EVALUATIONS = 900000;
if (MAX_EVALUATIONS - MAX_START_EVALUATIONS < MIN_SEARCH_EVALUATIONS) {
  throw new Error(
    `construction budgets (${MAX_START_EVALUATIONS}) leave the search less than ${MIN_SEARCH_EVALUATIONS} of ${MAX_EVALUATIONS} evaluations`
  );
}
// Budget for a shape that provably cannot be equitable (feasibility.mjs):
// the search stops as soon as it reaches the shape's cost floor, a proven
// lower bound. Where that floor is tight (a schedule at the floor is known)
// this takes a few thousand evaluations, about a millisecond; where it is a
// lower bound only (11/7, 18/10, 22/12) the search cannot know it is done
// and runs to this cap, about 0.1 s. See feasibility.mjs for the trade-off.
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
 * search stops at the shape's cost floor (a proven lower bound), or after a
 * small budget where the floor is not reached. A few
 * others (e.g. 17 players over 9 rounds) are not known to be impossible but
 * the search budget runs out above the optimum. Either way the call still
 * succeeds; check `schedule.equity.optimal` (and `opponentSpread`) before
 * relying on the equitable-mix property.
 *
 * Also NOT guaranteed: rest spacing. When some players must rest twice, the
 * rounds are ordered to keep each player's rests at least restGapTarget
 * rounds apart; the rounds' contents come from the equity search, so most
 * shapes land a round or two short. `equity.restSpaced` and `restGap`
 * report it (see restEquity in rest.mjs).
 *
 * @param {{players: number|string[], rounds: number, seed?: number}} options
 *   players: a count (players are then named P1..PN) or the list of names.
 *   rounds:  1 .. players - 1.
 *   seed:    any integer; defaults to defaultSeed(player count).
 * @returns the schedule, with `equity: {optimal, infeasible, cost,
 *   lowerBound, opponentSpread}` describing its opponent mix (see
 *   opponentEquity; infeasible: the shape provably cannot be optimal) and
 *   `{sitOuts, sitOutSpread, restGap, restGapTarget, restSpaced}` its rests
 *   (see restEquity).
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
  // unless the shape provably cannot be equitable (floor > 0, a proven lower
  // bound on its excess over the equitable cost; see feasibility.mjs): then
  // it searches from scratch and stops as soon as it reaches the floor.
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
      maxEvaluations: floor
        ? INFEASIBLE_EVALUATIONS
        : Math.max(MIN_SEARCH_EVALUATIONS, MAX_EVALUATIONS - start.evaluations),
      initial: start.rows,
      targetExcess: floor,
    });
    if (result.partnerExcess !== 0) {
      throw new Error(
        `no schedule without repeated partners found for ${N} players and ${R} rounds (seed ${seed})`
      );
    }
    // The search keeps sit-outs within one by construction; check anyway, as
    // for partners, rather than return a schedule that breaks the guarantee.
    const sitOuts = new Int32Array(N);
    for (const row of result.seats) for (let s = 4 * C; s < N; s++) sitOuts[row[s]]++;
    if (Math.max(...sitOuts) - Math.min(...sitOuts) > 1) {
      throw new Error(`sit-out counts more than one apart for ${N} players and ${R} rounds (seed ${seed})`);
    }
    // Space each player's rests apart; this only reorders whole rounds, so
    // every partner, opponent and sit-out count is unchanged.
    const rows = spaceRests(result.seats, N, seed);
    schedule = {
      playerCount: N,
      totalRounds: R,
      players: names.slice(),
      rounds: rows.map((row, r) => {
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
  schedule.equity = { ...opponentEquity(schedule, floor > 0), ...restEquity(schedule) };
  return schedule;
}
