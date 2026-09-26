/**
 * Parametrized scheduling engine (R-EQUITABLE-MIX).
 *
 *   import { generateSchedule } from './scheduler/engine/index.mjs';
 *   const schedule = generateSchedule({ players: 14, rounds: 10, seed: 7 });
 *
 * Produces a schedule for any supported player count (4..24) and any round
 * count up to players - 1, in the app's schedule shape:
 *   { playerCount, totalRounds, players,
 *     rounds: [{ roundNumber, matches: [{ court, teams: [[a, b], [c, d]] }],
 *                byes: [...] }] }
 * `byes` (the players sitting out that round) is present only when the
 * player count is not a multiple of 4.
 *
 * Guarantees: no two players partner more than once (the engine throws
 * rather than return a schedule that repeats a partnership), and sit-out
 * counts differ by at most one. Goal: opponent counts over all pairs within
 * one of each other; the search stops as soon as that is reached, which it
 * is for the shapes covered by the acceptance suite. The same inputs and
 * seed always produce the identical schedule.
 *
 * Full-length case (players = 4n, rounds = 4n - 1): the schedule is the
 * whist construction of scheduler/whist-generate.js, i.e. a perfect mix
 * (partners exactly once, opponents exactly twice). With the default seed it
 * is exactly the shipped web/schedules/<N>p<N-1>r.js table.
 */

import whist from '../whist-generate.js';
import { searchSchedule } from './search.mjs';

const { findBaseRound, buildSchedule, balanceCourts } = whist;

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 24;

// Work budget for the local search, in candidate-move evaluations (a
// deterministic cut-off, unlike wall time). ~3M evaluations is roughly one
// second on a laptop; the acceptance shapes need well under 1M.
const MAX_EVALUATIONS = 3000000;

/** The seed whist-generate.js uses per size; the default here as well. */
export function defaultSeed(playerCount) {
  return playerCount * 7919;
}

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
  if (!players.every((p) => typeof p === 'string' && p.trim() !== '')) {
    throw new TypeError('player names must be non-empty strings');
  }
  if (new Set(players).size !== players.length) {
    throw new RangeError('player names must be unique');
  }
  return players.slice();
}

/** Whist schedule for 4n players over 4n - 1 rounds, or null if not found. */
function wholeWhist(names, seed) {
  const N = names.length;
  const found = findBaseRound(N, seed);
  if (!found) return null;
  return renamed(balanceCourts(buildSchedule(N, found.base)), names);
}

/**
 * The first R rounds of a whist tournament on N = 4n players, as seat rows
 * for the local search (or null if no base round was found). Dropping rounds
 * from a whist tournament never repeats a partner and lowers each opponent
 * count by at most one per dropped round, so this is an excellent start:
 * already equitable at R = N - 2.
 */
function truncatedWhistSeats(N, R, seed) {
  const found = findBaseRound(N, seed);
  if (!found) return null;
  const index = (label) => Number(label.slice(1)) - 1;
  return buildSchedule(N, found.base)
    .rounds.slice(0, R)
    .map((round) => round.matches.flatMap((m) => m.teams.flat().map(index)));
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
 * Generate an equitable schedule.
 * @param {{players: number|string[], rounds: number, seed?: number}} options
 *   players: a count (players are then named P1..PN) or the list of names.
 *   rounds:  1 .. players - 1.
 *   seed:    any integer; defaults to defaultSeed(player count).
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

  if (N % 4 === 0 && R === N - 1) {
    const perfect = wholeWhist(names, seed);
    if (perfect) return perfect;
  }

  const C = Math.floor(N / 4);
  const initial = N % 4 === 0 ? truncatedWhistSeats(N, R, seed) : null;
  const result = searchSchedule({
    N,
    R,
    seed,
    maxEvaluations: MAX_EVALUATIONS,
    initial: initial || undefined,
  });
  if (result.partnerExcess !== 0) {
    throw new Error(
      `no schedule without repeated partners found for ${N} players and ${R} rounds (seed ${seed})`
    );
  }

  const schedule = {
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
  // Spread every player over the courts; this only relabels courts within a
  // round, so who partners or opposes whom is unchanged.
  return balanceCourts(schedule);
}
