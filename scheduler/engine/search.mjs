/**
 * Local search for equitable schedules (R-EQUITABLE-MIX).
 *
 * A schedule is R rounds; each round seats all N players: seats 0..4C-1 are
 * the C courts (seats 4c, 4c+1 = team 1 and 4c+2, 4c+3 = team 2 of court c),
 * the remaining N - 4C seats are byes (sit-outs).
 *
 * Byes (sit-outs) are an invariant, not a cost: the start arrangement has
 * bye counts at most one apart, and the only bench swaps ever made hand a
 * sit-out from a player with more byes to one with fewer, which keeps them so.
 *
 * Cost (lower is better), both terms tracked incrementally:
 *   - partner excess  sum over pairs of p(p-1)   0 iff nobody partners twice
 *   - opponent spread sum over pairs of o^2      minimal iff opponent counts differ by <= 1
 * The total of o is fixed by N and R alone, so the sum of squares is at its
 * lower bound exactly when every count is floor or ceil of the mean. The
 * partner term is weighted so the search treats it as hard.
 *
 * Moves swap two players within one round. A swap touches at most two
 * matches, so its cost delta is computed by un-counting those matches,
 * swapping, and re-counting them: O(1) per candidate, never a full recount.
 * The search is a tabu search over conflict-directed swaps (see below); it
 * stops as soon as the cost reaches the provable lower bound, or when its
 * work budget (candidate evaluations, so the cut-off is deterministic) runs
 * out, returning the best arrangement seen.
 */

import whist from '../whist-generate.js';

// One seeded PRNG and shuffle for the whole scheduler: the whist generator's.
const { mulberry32, shuffled } = whist;

/** Uniform integer in [0, n). */
const randInt = (rand, n) => Math.floor(rand() * n);

const PARTNER_WEIGHT = 16;
// Tabu parameters, tuned on the 12/6, 14/10 and 20/8 shapes (24 seeds each
// reach the optimum within ~0.6M candidate evaluations).
const MAX_CONFLICTS = 2; // violating pairs attacked per step
const TENURE_BASE = 2; // steps a moved player stays tabu in its round ...
const TENURE_RAND = 3; // ... plus 0..TENURE_RAND-1 more
const STALL = 200; // steps without a new best before a kick
const KICK = 3; // random swaps per kick

/** Minimal sum of squares of `count` non-negative integers summing to `total`. */
export function minSumOfSquares(total, count) {
  const q = Math.floor(total / count);
  const rem = total - q * count;
  return count * q * q + rem * (2 * q + 1);
}

/**
 * Search for an equitable arrangement.
 * @param {{N: number, R: number, seed: number, maxEvaluations: number,
 *          initial?: number[][]}} opts
 *   initial: optional starting arrangement, R rows of N player indices in
 *   seat order (courts first, then byes), with bye counts at most one apart;
 *   by default a seeded random one.
 * @returns {{seats: Int32Array[], optimal: boolean, iterations: number,
 *            evaluations: number, partnerExcess: number, cost: number,
 *            lowerBound: number}}
 *   seats[r][s] = player index in seat s of round r; optimal means every
 *   partner and opponent count is within the equitable band.
 */
export function searchSchedule({ N, R, seed, maxEvaluations, initial }) {
  const C = Math.floor(N / 4);
  const A = 4 * C; // active seats per round
  const B = N - A; // byes per round
  const rand = mulberry32(seed);

  const seat = new Int32Array(R * N);
  const where = new Int32Array(R * N); // where[r*N + p] = seat of player p in round r
  const partner = new Int32Array(N * N);
  const opp = new Int32Array(N * N);
  const bye = new Int32Array(N);
  let partnerExcess = 0;

  const place = (r, row) => {
    for (let s = 0; s < N; s++) {
      seat[r * N + s] = row[s];
      where[r * N + row[s]] = s;
    }
    for (let s = A; s < N; s++) bye[row[s]]++;
  };
  if (initial) {
    initial.forEach((row, r) => place(r, row));
  } else {
    // Byes rotate through a seeded player order, so bye counts start
    // balanced (at most one apart); active players are shuffled onto courts.
    const order = shuffled(Array.from({ length: N }, (_, i) => i), rand);
    for (let r = 0; r < R; r++) {
      const benched = new Set();
      for (let k = 0; k < B; k++) benched.add(order[(r * B + k) % N]);
      const active = shuffled(order.filter((p) => !benched.has(p)), rand);
      place(r, [...active, ...order.filter((p) => benched.has(p))]);
    }
  }

  const key = (i, j) => (i < j ? i * N + j : j * N + i);
  // Each bump returns the change in its (unweighted) cost term.
  const bumpPartner = (i, j, s) => {
    const k = key(i, j);
    const c = partner[k];
    partner[k] = c + s;
    return s > 0 ? 2 * c : -2 * (c - 1);
  };
  const bumpOpp = (i, j, s) => {
    const k = key(i, j);
    const c = opp[k];
    opp[k] = c + s;
    return 2 * c * s + 1;
  };
  // Count (s = +1) or un-count (s = -1) one match; returns the weighted delta
  // and keeps the running partner-excess total in step.
  const matchUpdate = (r, c, s) => {
    const base = r * N + 4 * c;
    const a = seat[base];
    const b = seat[base + 1];
    const x = seat[base + 2];
    const y = seat[base + 3];
    const dp = bumpPartner(a, b, s) + bumpPartner(x, y, s);
    partnerExcess += dp;
    return (
      PARTNER_WEIGHT * dp +
      bumpOpp(a, x, s) + bumpOpp(a, y, s) + bumpOpp(b, x, s) + bumpOpp(b, y, s)
    );
  };

  let cost = 0;
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) cost += matchUpdate(r, c, 1);
  const lowerBound = minSumOfSquares(R * C * 4, (N * (N - 1)) / 2);

  // Swap seats s1 (active) and s2 in round r; returns the weighted delta.
  // Applying the same swap again undoes it exactly.
  // A bench swap keeps bye counts within one only if it benches a player
  // with fewer byes than the one it brings back.
  const byeSafe = (r, s1, s2) => s2 < A || bye[seat[r * N + s1]] < bye[seat[r * N + s2]];
  const swap = (r, s1, s2) => {
    const c1 = s1 >> 2;
    const c2 = s2 < A ? s2 >> 2 : -1;
    const i1 = r * N + s1;
    const i2 = r * N + s2;
    let d = matchUpdate(r, c1, -1);
    if (c2 >= 0 && c2 !== c1) d += matchUpdate(r, c2, -1);
    if (c2 < 0) {
      // seat[i1] goes to the bench, seat[i2] comes off it.
      bye[seat[i1]]++;
      bye[seat[i2]]--;
    }
    const t = seat[i1];
    seat[i1] = seat[i2];
    seat[i2] = t;
    where[r * N + seat[i1]] = s1;
    where[r * N + seat[i2]] = s2;
    d += matchUpdate(r, c1, 1);
    if (c2 >= 0 && c2 !== c1) d += matchUpdate(r, c2, 1);
    return d;
  };

  const totalOpp = R * C * 4;
  const pairs = (N * (N - 1)) / 2;
  const oppLow = Math.floor(totalOpp / pairs);
  const oppHigh = Math.ceil(totalOpp / pairs);

  // Candidate moves, as parallel arrays of (round, active seat, other seat).
  const cr = [];
  const cs1 = [];
  const cs2 = [];
  const addCandidate = (r, s1, s2) => {
    if (s1 >> 1 === s2 >> 1) return; // same team (or same seat): no-op
    if (s1 >= A) {
      if (s2 >= A) return; // bench to bench: no-op
      const t = s1;
      s1 = s2;
      s2 = t;
    }
    if (!byeSafe(r, s1, s2)) return;
    cr.push(r);
    cs1.push(s1);
    cs2.push(s2);
  };

  // Neighbourhood: only swaps that attack a pair breaking the target —
  // a repeated partnership, or an opponent count above or below the
  // equitable band — so every candidate can remove a violation.
  const bad = [];
  const collectCandidates = () => {
    cr.length = 0;
    cs1.length = 0;
    cs2.length = 0;
    bad.length = 0;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const k = i * N + j;
        if (partner[k] > 1 || opp[k] > oppHigh || opp[k] < oppLow) bad.push(k);
      }
    }
    // Sample a bounded number of conflicts so early iterations stay cheap.
    const take = Math.min(MAX_CONFLICTS, bad.length);
    for (let n = 0; n < take; n++) {
      const pick = n + randInt(rand, bad.length - n);
      const k = bad[pick];
      bad[pick] = bad[n];
      bad[n] = k;
      const i = Math.floor(k / N);
      const j = k % N;
      const repeatPartner = partner[k] > 1;
      const tooFew = !repeatPartner && opp[k] < oppLow;
      for (let r = 0; r < R; r++) {
        const si = where[r * N + i];
        const sj = where[r * N + j];
        const bothActive = si < A && sj < A;
        const sameCourt = bothActive && si >> 2 === sj >> 2;
        const sameTeam = sameCourt && si >> 1 === sj >> 1;
        if (tooFew) {
          if (sameCourt && !sameTeam) continue; // already opposed this round
          // Seat one of them on the team facing the other.
          if (si < A) {
            const t = ((si >> 1) ^ 1) * 2;
            addCandidate(r, t, sj);
            addCandidate(r, t + 1, sj);
          }
          if (sj < A) {
            const t = ((sj >> 1) ^ 1) * 2;
            addCandidate(r, t, si);
            addCandidate(r, t + 1, si);
          }
        } else if (repeatPartner ? sameTeam : sameCourt && !sameTeam) {
          // Move either of them anywhere off their team.
          for (let s = 0; s < N; s++) {
            addCandidate(r, si, s);
            addCandidate(r, sj, s);
          }
        }
      }
    }
  };

  let best = null;
  let bestCost = Infinity;
  let bestPartnerExcess = Infinity;
  const improves = () =>
    partnerExcess < bestPartnerExcess ||
    (partnerExcess === bestPartnerExcess && cost < bestCost);
  const snapshot = () => {
    best = seat.slice();
    bestCost = cost;
    bestPartnerExcess = partnerExcess;
  };
  snapshot();

  // Tabu search: take the best non-tabu candidate each step (ties broken at
  // random); a player just moved in a round stays put there for a few steps
  // unless moving it again beats the best cost so far (aspiration). After a
  // long stall, a few random swaps kick the search out of its basin.
  const tabuUntil = new Int32Array(R * N);
  let iterations = 0;
  let evaluations = 0;
  let lastImprovement = 0;
  while (bestCost > lowerBound && evaluations < maxEvaluations) {
    iterations++;
    collectCandidates();
    evaluations += cr.length + 1;
    let pick = -1;
    let pickDelta = Infinity;
    let ties = 0;
    for (let n = 0; n < cr.length; n++) {
      const r = cr[n];
      const d = swap(r, cs1[n], cs2[n]);
      swap(r, cs1[n], cs2[n]);
      const a = seat[r * N + cs1[n]];
      const b = seat[r * N + cs2[n]];
      const tabu = tabuUntil[r * N + a] > iterations || tabuUntil[r * N + b] > iterations;
      if (tabu && cost + d >= bestCost) continue;
      if (d < pickDelta) {
        pick = n;
        pickDelta = d;
        ties = 1;
      } else if (d === pickDelta && randInt(rand, ++ties) === 0) {
        pick = n;
      }
    }
    if (pick >= 0) {
      const r = cr[pick];
      const a = seat[r * N + cs1[pick]];
      const b = seat[r * N + cs2[pick]];
      cost += swap(r, cs1[pick], cs2[pick]);
      tabuUntil[r * N + a] = iterations + TENURE_BASE + randInt(rand, TENURE_RAND);
      tabuUntil[r * N + b] = iterations + TENURE_BASE + randInt(rand, TENURE_RAND);
    }
    if (improves()) {
      snapshot();
      lastImprovement = iterations;
    } else if (pick < 0 || iterations - lastImprovement > STALL) {
      for (let n = 0; n < KICK; n++) {
        const r = randInt(rand, R);
        const s1 = randInt(rand, A);
        const s2 = randInt(rand, N);
        if (s1 >> 1 !== s2 >> 1 && byeSafe(r, s1, s2)) cost += swap(r, s1, s2);
      }
      lastImprovement = iterations;
    }
  }

  const seats = [];
  for (let r = 0; r < R; r++) seats.push(best.subarray(r * N, (r + 1) * N));
  return {
    seats,
    optimal: bestCost === lowerBound,
    iterations,
    evaluations,
    partnerExcess: bestPartnerExcess,
    cost: bestCost,
    lowerBound,
  };
}
