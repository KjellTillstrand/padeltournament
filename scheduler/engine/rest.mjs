/**
 * Rest rounds for player counts that are not a multiple of 4 (R-EQUITABLE-MIX).
 *
 * N players fill C = floor(N/4) courts; the other B = N mod 4 sit out (rest)
 * each round. Two properties of the rests:
 *
 *   - Sit-out counts. Over the whole schedule they differ by at most one: a
 *     hard guarantee, kept by the search (search.mjs) and checked by
 *     index.mjs before it returns.
 *   - Rest spacing. How close together one player's rests fall. In any d
 *     consecutive rounds there are d * B rests, so if no player rests twice
 *     within d rounds then d * B <= N. Whenever someone must rest twice
 *     (R * B > N) the smallest gap between two rests of one player is
 *     therefore at most floor(N / B), and a plain rotation of the bench
 *     reaches it. That is the target, restGapTarget. A soft goal: the rounds
 *     come from the equity search, which ignores spacing, and reordering them
 *     (spaceRests) is the only lever used here. Reordering changes no
 *     partner, opponent or sit-out count, so it can never cost equity.
 *
 * Gaps are counted in rounds: resting in rounds 3 and 5 is a gap of 2, back
 * to back is a gap of 1.
 */

import whist from '../whist-generate.js';
import { randInt } from './search.mjs';

const { mulberry32 } = whist;

// Round-order evaluations spaceRests may spend (each scores one candidate
// order in O(R * B)). Far below the equity budgets: about 10 ms at most.
export const ORDER_EVALUATIONS = 60000;
// Random round swaps per kick, when the climb reaches a local optimum.
const ORDER_KICK = 2;

/**
 * The widest spacing any bench rotation allows: floor(N / B) rounds between
 * two rests of one player, or null when nobody has to rest twice (no byes,
 * or R * B <= N).
 */
export function restGapTarget(N, R) {
  const B = N % 4;
  return B > 0 && R * B > N ? Math.floor(N / B) : null;
}

/**
 * How far the rows in `order` fall short of the target spacing: short[g] is
 * the number of consecutive rest pairs (one player resting twice) g rounds
 * apart, for g = 1 .. target - 1. Lower is better, compared from g = 1 up,
 * so an order with fewer back-to-back rests always wins.
 */
function shortfall(rows, order, N, A, target, last, short) {
  last.fill(-1);
  short.fill(0);
  for (let pos = 0; pos < order.length; pos++) {
    const row = rows[order[pos]];
    for (let s = A; s < N; s++) {
      const p = row[s];
      const gap = pos - last[p];
      if (last[p] >= 0 && gap < target) short[gap]++;
      last[p] = pos;
    }
  }
  return short;
}

/** -1, 0 or 1 as shortfall a is better than, equal to or worse than b. */
function compare(a, b) {
  for (let g = 1; g < a.length; g++) {
    if (a[g] !== b[g]) return a[g] < b[g] ? -1 : 1;
  }
  return 0;
}

/**
 * Reorder the rounds (seat rows: courts first, then the B sit-outs) so that
 * each player's rests fall as far apart as possible, towards restGapTarget.
 * Hill climbing over swaps of two rounds, with seeded kicks from the best
 * order after a stall, spending at most maxEvaluations order evaluations (a
 * hard cap, checked per evaluation); it only ever keeps a better order, so
 * the result is never worse spaced than the input. Deterministic for a given
 * input, seed and budget.
 * @returns {number[][]} the same rows, reordered (a new array).
 */
export function spaceRests(rows, N, seed, maxEvaluations = ORDER_EVALUATIONS) {
  const R = rows.length;
  const A = 4 * Math.floor(N / 4);
  const target = restGapTarget(N, R);
  // No target: nobody has to rest twice. (No separate case is needed for
  // fewer than 3 rounds: shortfall counts gaps 1 .. target - 1, so target 1
  // leaves nothing to improve and the loop never runs, and a target of
  // floor(N / B) >= 2 means R * B > N >= 2 * B, so R >= 3.)
  if (target === null) return rows.slice();
  const last = new Int32Array(N);
  const now = new Int32Array(target);
  const bestShort = new Int32Array(target);
  const zero = new Int32Array(target);
  const order = Array.from({ length: R }, (_, r) => r);
  bestShort.set(shortfall(rows, order, N, A, target, last, now));
  let best = order.slice();
  const cur = bestShort.slice();
  const rand = mulberry32(seed);
  let evaluations = 0;
  const swap = (i, j) => {
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  };
  while (compare(bestShort, zero) > 0 && evaluations < maxEvaluations) {
    // Best-improvement step over every swap of two rounds. A sweep cut short
    // by the budget still takes the best swap it has seen.
    let pickI = -1;
    let pickJ = -1;
    const pick = cur.slice();
    sweep: for (let i = 0; i < R; i++) {
      for (let j = i + 1; j < R; j++) {
        if (evaluations >= maxEvaluations) break sweep;
        swap(i, j);
        evaluations++;
        shortfall(rows, order, N, A, target, last, now);
        swap(i, j);
        if (compare(now, pick) < 0) {
          pick.set(now);
          pickI = i;
          pickJ = j;
        }
      }
    }
    if (pickI >= 0) {
      swap(pickI, pickJ);
      cur.set(pick);
      if (compare(cur, bestShort) < 0) {
        bestShort.set(cur);
        best = order.slice();
      }
      continue;
    }
    if (evaluations >= maxEvaluations) break;
    // A local optimum: restart from the best order with a few random swaps.
    // The kicked order is kept as the best when it beats it outright, even if
    // no swap improves on it afterwards.
    for (let r = 0; r < R; r++) order[r] = best[r];
    for (let k = 0; k < ORDER_KICK; k++) swap(randInt(rand, R), randInt(rand, R));
    cur.set(shortfall(rows, order, N, A, target, last, now));
    evaluations++;
    if (compare(cur, bestShort) < 0) {
      bestShort.set(cur);
      best = order.slice();
    }
  }
  return best.map((r) => rows[r]);
}

/**
 * Rest fairness of a finished schedule, counted from its matches (a player
 * rests in a round when no match seats them):
 *   sitOuts        rests per player, in schedule.players order;
 *   sitOutSpread   max - min of sitOuts (guaranteed <= 1);
 *   restGap        the fewest rounds between two rests of one player, or
 *                  null when nobody rests twice;
 *   restGapTarget  the widest such gap any rotation allows (see above), or
 *                  null when nobody has to rest twice;
 *   restSpaced     no player rests twice within restGapTarget rounds
 *                  (true when there is no target). A soft goal, reported.
 */
export function restEquity(schedule) {
  const { players, rounds } = schedule;
  const idx = new Map(players.map((p, i) => [p, i]));
  const sitOuts = new Array(players.length).fill(0);
  const last = new Array(players.length).fill(-1);
  let restGap = null;
  rounds.forEach((round, r) => {
    const seated = new Uint8Array(players.length);
    for (const { teams } of round.matches) for (const team of teams) for (const p of team) seated[idx.get(p)] = 1;
    for (let i = 0; i < players.length; i++) {
      if (seated[i]) continue;
      sitOuts[i]++;
      if (last[i] >= 0 && (restGap === null || r - last[i] < restGap)) restGap = r - last[i];
      last[i] = r;
    }
  });
  const target = restGapTarget(players.length, rounds.length);
  return {
    sitOuts,
    sitOutSpread: Math.max(...sitOuts) - Math.min(...sitOuts),
    restGap,
    restGapTarget: target,
    restSpaced: target === null || restGap === null || restGap >= target,
  };
}
