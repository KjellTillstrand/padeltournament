/**
 * Shapes that provably cannot be equitable (R-EQUITABLE-MIX).
 *
 * For these (players, rounds) no schedule without a repeated partner and
 * with sit-outs within one keeps every opponent count within one of every
 * other. The engine does not search for the impossible: it stops as soon as
 * it reaches the shape's cost floor, or after a small budget
 * (INFEASIBLE_EVALUATIONS in index.mjs), and reports equity.infeasible.
 *
 * Costs are sums over all pairs of (times opposed)^2 with the total number of
 * oppositions fixed by the shape, so any two costs differ by an even number
 * and the least unequitable cost is lowerBound + 2.
 *
 * A floor is a proven LOWER BOUND: no schedule costs less than lowerBound +
 * floor. It is tight (the least cost there is) only where a schedule at the
 * floor is known:
 *   - tight, witnessed by the exhaustive search: 5/2, 5/3, 6/3, 6/4, 7/5,
 *     10/6 (+2) and 9/4, 9/5, 12/5 (+4);
 *   - tight, witnessed by the engine itself: 14/8 (+2, default seed);
 *   - undecided: 11/7. +0 is exhaustively impossible, so the floor is +2;
 *     whether +2 is reachable is open (an exhaustive run did not finish in
 *     25 CPU-minutes), and the search reaches +4;
 *   - lower bound only: 18/10 and 22/12 (+2 by counting; the search
 *     reaches about +6 and +12).
 * Where the floor is not reached the search cannot know it is done and runs
 * its whole (small) budget.
 *
 * NOTES — accepted trade-offs (AB#32), default seed, versus the AB#28 engine:
 *   - 18/10 +4 -> +6 and 22/12 +8 -> +12: proven-impossible shapes now get
 *     INFEASIBLE_EVALUATIONS (300k, about 0.1 s) instead of the full 3M
 *     (about 1.2 s); the spread stays 2, the squared-cost excess grows.
 *     Accepted for the roughly tenfold speed-up; raising the cap buys back
 *     cost (1M reaches about +4 and +6).
 *   - 17/8 +2 -> +4 (not proven impossible; spread still 2): the cyclic
 *     constructions fail there and spend part of the budget, and the
 *     search from scratch lands differently. 17/8 closes on 3 of 16 seeds.
 *   - 19/10 at seed 2 was optimal and now ends at +2 (search variance; it
 *     closes on 13 of 16 seeds, and at the default seed, where it did not
 *     before).
 * No shape optimal at the default seed before is non-optimal now.
 */

/**
 * Floors proven by exhaustive search (prove-infeasible.mjs re-proves every
 * entry): no schedule costs less than lowerBound + floor. Tight except 11/7
 * (see above). Six of these also follow from countingInfeasible below; 6/3,
 * 9/4, 9/5 and 12/5 need the search, as does every floor above 2.
 */
export const EXHAUSTIVE_FLOORS = new Map([
  ['5/2', 2],
  ['5/3', 2],
  ['6/3', 2],
  ['6/4', 2],
  ['7/5', 2],
  ['9/4', 4],
  ['9/5', 4],
  ['10/6', 2],
  ['11/7', 2],
  ['12/5', 4],
]);

/** Erdős–Gallai: is there a simple graph with this degree sequence? */
function graphical(degrees) {
  const d = [...degrees].sort((x, y) => y - x);
  if (d.reduce((sum, x) => sum + x, 0) % 2 !== 0) return false;
  for (let k = 1; k <= d.length; k++) {
    let left = 0;
    for (let i = 0; i < k; i++) left += d[i];
    let right = k * (k - 1);
    for (let i = k; i < d.length; i++) right += Math.min(d[i], k);
    if (left > right) return false;
  }
  return true;
}

/**
 * A counting argument, for any size. In an equitable schedule every pair's
 * opponent count is q or q + 1 (q the floor of the mean), so the pairs at
 * q + 1 form a simple graph. A player who plays g rounds meets 2g opponents
 * among the N - 1 others, so has degree 2g - q(N - 1) in that graph. Sit-out
 * counts within one fix how many players play each number of rounds (b
 * sit-outs per round: bR mod N players sit out ceil(bR/N) times, the rest
 * floor(bR/N)), hence the whole degree sequence; if no simple graph has it
 * (a degree outside 0..N-1, or Erdős–Gallai fails), no equitable schedule
 * exists. Within 4..24 players this rules out 5/2, 5/3, 6/4, 7/5, 10/6,
 * 11/7, 14/8, 18/10 and 22/12. E.g. 14 players over 8 rounds (q = 1): the
 * two players who sit out twice meet only 12 opponents but must meet all 13
 * others. 5 over 2 (q = 0): the three players who never sit out oppose all
 * four others, so the two who sit out once would each oppose at least
 * three, in the one round they play (two opponents).
 */
export function countingInfeasible(N, R) {
  const C = Math.floor(N / 4);
  const byes = N - 4 * C;
  const q = Math.floor((4 * C * R) / ((N * (N - 1)) / 2));
  const low = Math.floor((byes * R) / N);
  const extra = byes * R - low * N; // players sitting out low + 1 times
  const degrees = Array.from({ length: N }, (_, i) => 2 * (R - low - (i < extra ? 1 : 0)) - q * (N - 1));
  if (degrees.some((d) => d < 0 || d > N - 1)) return true;
  return !graphical(degrees);
}

/**
 * A proven lower bound on the excess over lowerBound of any schedule of this
 * shape (tight or not: see above), or 0 when the shape is not known to be
 * infeasible (it may still be unreachable in practice; see equity.optimal).
 */
export function costFloor(N, R) {
  const floor = EXHAUSTIVE_FLOORS.get(`${N}/${R}`);
  if (floor !== undefined) return floor;
  return countingInfeasible(N, R) ? 2 : 0;
}
