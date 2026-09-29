/**
 * Start arrangements for the local search (R-EQUITABLE-MIX).
 *
 * The tabu search in search.mjs polishes whatever it starts from; for some
 * shapes a random start leaves it stranded one or two violations short of
 * the optimum. These algebraic constructions give it far better starts, and
 * often an already optimal schedule (startArrangement picks one):
 *
 * Cyclic development. Players are points (x, i) of Z_m x {0..k-1} plus f
 * fixed points; round r is a base round with every x shifted by r (mod m),
 * so t base rounds develop into t * m rounds. A pair's meeting count is
 * then set by its orbit under the shift: a base round that opposes (x, i)
 * and (y, j) opposes every pair (x + r, i), (y + r, j) once (twice for the
 * half-orbit {x, x + m/2} when m is even). Choosing t base rounds whose
 * orbit counts are all in the equitable band therefore settles the whole
 * schedule, and that is a search over t rounds instead of t * m. This is
 * how the mid-length shapes (e.g. 14/7, 16/7, 18/9, 20/9, 22/11, 24/10) are
 * built. Which shapes admit it: m = R / t rounds per development, k =
 * floor(N / m) levels, f = N - k * m fixed points; see cyclicPlan.
 *
 * Matching round. For N = 4n at R = N/2 the development of N/2 - 1 rounds
 * leaves a perfect matching of never-opposed pairs; one extra round that
 * opposes exactly those pairs is equitable (16/8, 20/10, 24/12). See
 * matchingRound.
 *
 * Whist subset. A whist tournament Wh(N) (every pair partners once and
 * opposes exactly twice) exists for N = 4n (N - 1 rounds, whist-generate.js)
 * and N = 4n + 1 (N rounds with one sit-out each; the cyclic development
 * above with m = N). Keeping R of its rounds never repeats a partner and
 * keeps sit-outs within one; which R rounds to keep decides the opponent
 * spread, and for the near-full shapes (e.g. 17/15, 20/16, 21/19, 24/20) a
 * well-chosen subset is already optimal. See bestRoundSubset. For N = 4n + 2
 * the same role is played by an N - 1 round development over Z_{N-1} with
 * one fixed point that trades one seat for a sit-out (18/17, 22/21); see
 * nearWhistRows.
 *
 * Arrangements are R rows of N player indices in seat order: seats 4c..4c+3
 * are court c (two teams of two), the remaining seats are the sit-outs.
 */

import whist from '../whist-generate.js';
import { costFloor } from './feasibility.mjs';

const { mulberry32, shuffled } = whist;

/** Uniform integer in [0, n). */
const randInt = (rand, n) => Math.floor(rand() * n);

/** Opponent pairs of a seat row, as pair keys i * N + j with i < j. */
function opponentKeys(row, N, C) {
  const keys = [];
  const key = (i, j) => (i < j ? i * N + j : j * N + i);
  for (let c = 0; c < C; c++) {
    const [a, b, x, y] = [row[4 * c], row[4 * c + 1], row[4 * c + 2], row[4 * c + 3]];
    keys.push(key(a, x), key(a, y), key(b, x), key(b, y));
  }
  return keys;
}

/**
 * The shape of a cyclic development for N players over R rounds from t base
 * rounds, or null when this shape cannot be equitable by construction:
 *   m = R / t shifts, k = floor(N / m) levels of m points, f = N - k * m
 *   fixed points. Fixed points never sit out (they would sit every shift)
 *   and never share a table (they would meet every shift); two fixed points
 *   therefore never oppose, which the band allows only when q = 0. Level i
 *   sits out bench[u][...] times per base round u, so a level-i player sits
 *   out the level's total once per development: the totals must be within
 *   one of each other and of the fixed points' zero.
 * `q` is the floor of the mean opponent count; the band is q..q+1.
 * relaxed: also accept the one near miss that a trade repairs (plan.trade):
 * one fixed point, one level sitting out twice per development.
 */
export function cyclicPlan(N, R, t, relaxed = false) {
  if (R % t !== 0) return null;
  const C = Math.floor(N / 4);
  const A = 4 * C;
  const B = N - A;
  const m = R / t;
  const k = Math.floor(N / m);
  const f = N - k * m;
  if (m < 3 || k < 1 || f > C) return null;
  const q = Math.floor((4 * C * R) / ((N * (N - 1)) / 2));
  // Sit-outs per level over the t base rounds, as even as possible.
  const total = Array.from({ length: k }, (_, i) => Math.floor((B * t) / k) + (i < (B * t) % k ? 1 : 0));
  const exact = !(f >= 2 && q > 0) && !(f > 0 && total[0] > 1);
  // One fixed point and one level sitting out twice per development: all
  // pairs can be in the band, but the fixed point never sits out. Trading
  // its seat in one round for a sit-out evens the sit-outs; see cyclicRows.
  const trade = !exact && t === 1 && k === 1 && f === 1 && total[0] === 2;
  if (!exact && !(relaxed && trade)) return null;
  const bench = [];
  let level = 0;
  for (let u = 0; u < t; u++) {
    const row = [];
    for (let b = 0; b < B; b++) {
      while (total[level % k] === 0) level++;
      total[level % k]--;
      row.push(level++ % k);
    }
    bench.push(row);
  }
  const plan = { N, R, t, m, k, f, C, A, B, q, bench, exact, trade };
  return parityObstructed(plan) ? null : plan;
}

/**
 * Pair orbits of a plan: orbitOf[a * N + b] is the orbit id of pair {a, b}
 * (-1 for two fixed points, which may never share a table), mult[o] how many
 * times each pair of orbit o meets per base-round use, size[o] its pair count.
 * Player (x, i) is index i * m + x; fixed point s is k * m + s.
 */
function pairOrbits({ N, m, k }) {
  const fixed0 = k * m;
  const orbitOf = new Int32Array(N * N).fill(-1);
  const mult = [];
  const size = [];
  const odd = [];
  const ids = new Map();
  const orbit = (name, mul, sz, isOdd) => {
    if (!ids.has(name)) {
      ids.set(name, mult.length);
      mult.push(mul);
      size.push(sz);
      odd.push(isOdd);
    }
    return ids.get(name);
  };
  for (let a = 0; a < N; a++) {
    for (let b = a + 1; b < N; b++) {
      let o = -1;
      if (b >= fixed0 && a < fixed0) {
        o = orbit(`f${b - fixed0}:${Math.floor(a / m)}`, 1, m, false);
      } else if (b < fixed0) {
        const i = Math.floor(a / m);
        const j = Math.floor(b / m);
        const d = (((b % m) - (a % m)) % m + m) % m;
        if (i === j) {
          const e = Math.min(d, m - d);
          const half = 2 * e === m;
          o = orbit(`p${i}:${e}`, half ? 2 : 1, half ? m / 2 : m, e % 2 === 1);
        } else {
          o = orbit(`x${i}:${j}:${d}`, 1, m, d % 2 === 1);
        }
      }
      orbitOf[a * N + b] = o;
      orbitOf[b * N + a] = o;
    }
  }
  return { orbitOf, mult, size, odd };
}

/**
 * A parity obstruction for even m without fixed points: at every table
 * {a, b} vs {c, d} the four opponent differences c-a, d-a, c-b, d-b sum to
 * 2(c + d - a - b), so an even number of them is odd, and the number of
 * odd-difference orbit uses over all base rounds must be even. When the
 * band forces that number to be odd (e.g. 20 players over 10 rounds with
 * m = 10), no base round exists and searching for one only burns budget.
 */
function parityObstructed(plan) {
  const { m, f, C, t, q } = plan;
  if (m % 2 !== 0 || f > 0) return false;
  const { mult, odd } = pairOrbits(plan);
  // Allowed uses per orbit: count = mult * uses must lie in q..q+1.
  let oddLo = 0;
  let oddHi = 0;
  let evenLo = 0;
  let evenHi = 0;
  for (let o = 0; o < mult.length; o++) {
    const lo = Math.ceil(q / mult[o]);
    const hi = Math.floor((q + 1) / mult[o]);
    if (lo > hi) return true; // a half orbit that cannot land in the band
    if (odd[o]) {
      oddLo += lo;
      oddHi += hi;
    } else {
      evenLo += lo;
      evenHi += hi;
    }
  }
  const uses = 4 * C * t;
  const low = Math.max(oddLo, uses - evenHi);
  const high = Math.min(oddHi, uses - evenLo);
  return low > high || (low === high && low % 2 === 1);
}

/**
 * Search for t base rounds of a cyclic plan whose developed schedule is
 * equitable: no partner orbit used past one meeting, every opponent orbit's
 * count in the band. Tabu search over swaps within a base round (sit-out
 * swaps only within a level, so the sit-out totals hold).
 * @returns {{rows: number[][]|null, evaluations: number}} the developed R
 *   rows when the base rounds were found, else null.
 */
export function cyclicRows(plan, seed, maxEvaluations) {
  const { N, R, t, m, k, A, q, bench } = plan;
  const rand = mulberry32(seed);
  const { orbitOf, mult, size } = pairOrbits(plan);
  const fixed0 = k * m;
  const oppUse = new Int32Array(mult.length);
  const partnerUse = new Int32Array(mult.length);
  // Pairs outside the band (or partnering twice) per orbit, tabulated by
  // the orbit's use count: cost[o * U + uses].
  const U = 4 * plan.C * t + 2;
  const oppCost = new Int32Array(mult.length * U);
  const partnerCost = new Int32Array(mult.length * U);
  for (let o = 0; o < mult.length; o++) {
    for (let u = 0; u < U; u++) {
      const c = mult[o] * u;
      oppCost[o * U + u] = (c < q ? q - c : c > q + 1 ? c - q - 1 : 0) * size[o];
      partnerCost[o * U + u] = c > 1 ? (c - 1) * size[o] : 0;
    }
  }
  const TOGETHER = 1000; // two fixed points at one table

  const seat = new Int32Array(t * N);
  const bump = (use, table, a, b, s) => {
    const o = orbitOf[a * N + b];
    if (o < 0) return s * TOGETHER;
    const i = o * U + use[o];
    use[o] += s;
    return table[i + s] - table[i];
  };
  const tableUpdate = (u, c, s) => {
    const base = u * N + 4 * c;
    const a = seat[base];
    const b = seat[base + 1];
    const x = seat[base + 2];
    const y = seat[base + 3];
    return (
      bump(partnerUse, partnerCost, a, b, s) + bump(partnerUse, partnerCost, x, y, s) +
      bump(oppUse, oppCost, a, x, s) + bump(oppUse, oppCost, a, y, s) +
      bump(oppUse, oppCost, b, x, s) + bump(oppUse, oppCost, b, y, s)
    );
  };
  const swap = (u, s1, s2) => {
    const c1 = s1 >> 2;
    const c2 = s2 < A ? s2 >> 2 : -1;
    let d = tableUpdate(u, c1, -1);
    if (c2 >= 0 && c2 !== c1) d += tableUpdate(u, c2, -1);
    const i1 = u * N + s1;
    const i2 = u * N + s2;
    const p = seat[i1];
    seat[i1] = seat[i2];
    seat[i2] = p;
    d += tableUpdate(u, c1, 1);
    if (c2 >= 0 && c2 !== c1) d += tableUpdate(u, c2, 1);
    return d;
  };
  // Trade plans (one base round): round 0 must have a sit-out x who can take
  // the fixed point's seat without leaving the band, i.e. x has never
  // partnered the fixed point's partner and has opposed each of its two
  // opponents exactly once. tradeSeat finds the x with the fewest unmet
  // conditions; tradeGap adds them to the cost, weighted like an orbit.
  const tradeSeat = () => {
    const s = seat.indexOf(fixed0);
    const mate = seat[s ^ 1];
    const o = ((s >> 1) ^ 1) * 2;
    let bestGap = 3;
    let bestSeat = -1;
    for (let b = A; b < N; b++) {
      const x = seat[b];
      const gap =
        (partnerUse[orbitOf[x * N + mate]] > 0 ? 1 : 0) +
        (oppUse[orbitOf[x * N + seat[o]]] !== 1 ? 1 : 0) +
        (oppUse[orbitOf[x * N + seat[o + 1]]] !== 1 ? 1 : 0);
      if (gap < bestGap) {
        bestGap = gap;
        bestSeat = b;
      }
    }
    return { gap: bestGap, seat: bestSeat, fixed: s };
  };
  const tradeGap = plan.trade ? () => m * tradeSeat().gap : () => 0;
  const level = (p) => (p >= fixed0 ? -1 : Math.floor(p / m));
  const allowed = (u, s1, s2) =>
    s1 >> 1 !== s2 >> 1 && (s2 < A || level(seat[u * N + s1]) === level(seat[u * N + s2]));

  for (let u = 0; u < t; u++) {
    const pools = Array.from({ length: k }, (_, i) =>
      shuffled(Array.from({ length: m }, (_, x) => i * m + x), rand)
    );
    const benched = bench[u].map((i) => pools[i].pop());
    const out = new Set(benched);
    const active = shuffled(Array.from({ length: N }, (_, p) => p).filter((p) => !out.has(p)), rand);
    [...active, ...benched].forEach((p, s) => (seat[u * N + s] = p));
  }
  let cost = 0;
  for (let o = 0; o < mult.length; o++) cost += oppCost[o * U];
  for (let u = 0; u < t; u++) for (let c = 0; c < plan.C; c++) cost += tableUpdate(u, c, 1);
  let gapNow = tradeGap();
  cost += gapNow;
  const move = (u, s1, s2) => {
    const d = swap(u, s1, s2);
    const gap = tradeGap();
    const delta = d + gap - gapNow;
    gapNow = gap;
    return delta;
  };

  const tabuUntil = new Int32Array(t * N);
  let bestCost = cost;
  let best = seat.slice();
  let evaluations = 0;
  let step = 0;
  let lastImprovement = 0;
  while (bestCost > 0 && evaluations < maxEvaluations) {
    step++;
    let pick = -1;
    let pickDelta = Infinity;
    let ties = 0;
    for (let u = 0; u < t; u++) {
      for (let s1 = 0; s1 < A; s1++) {
        for (let s2 = s1 + 1; s2 < N; s2++) {
          if (!allowed(u, s1, s2)) continue;
          evaluations++;
          const d = move(u, s1, s2);
          move(u, s1, s2);
          const tabu =
            tabuUntil[u * N + seat[u * N + s1]] > step || tabuUntil[u * N + seat[u * N + s2]] > step;
          if (tabu && cost + d >= bestCost) continue;
          const id = (u * N + s1) * N + s2;
          if (d < pickDelta) {
            pick = id;
            pickDelta = d;
            ties = 1;
          } else if (d === pickDelta && randInt(rand, ++ties) === 0) {
            pick = id;
          }
        }
      }
    }
    if (pick >= 0) {
      const s2 = pick % N;
      const s1 = Math.floor(pick / N) % N;
      const u = Math.floor(pick / (N * N));
      tabuUntil[u * N + seat[u * N + s1]] = step + 3 + randInt(rand, 5);
      tabuUntil[u * N + seat[u * N + s2]] = step + 3 + randInt(rand, 5);
      cost += move(u, s1, s2);
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = seat.slice();
      lastImprovement = step;
    } else if (pick < 0 || step - lastImprovement > 100) {
      for (let n = 0; n < 2; n++) {
        const u = randInt(rand, t);
        const s1 = randInt(rand, A);
        const s2 = randInt(rand, N);
        if (allowed(u, s1, s2)) cost += move(u, s1, s2);
      }
      lastImprovement = step;
    }
  }
  if (bestCost > 0) return { rows: null, evaluations };
  let trade = null;
  if (plan.trade) {
    seat.set(best);
    trade = tradeSeat();
  }
  const shift = (p, r) => (p >= fixed0 ? p : p - (p % m) + ((p % m) + r) % m);
  const rows = [];
  for (let r = 0; r < m; r++) {
    for (let u = 0; u < t; u++) {
      rows.push(Array.from(best.subarray(u * N, (u + 1) * N), (p) => shift(p, r)));
    }
  }
  if (trade) {
    // Round 0 is the base round itself: x plays, the fixed point sits out.
    const row = rows[0];
    [row[trade.seat], row[trade.fixed]] = [row[trade.fixed], row[trade.seat]];
  }
  return { rows: rows.slice(0, R), evaluations };
}

/**
 * The R rows of `rows` (a full whist-like design) with the most even
 * opponent counts: a tabu search over swapping one kept round for one
 * dropped round, minimising the sum of squared opponent counts. Keeping
 * rounds of a whist tournament never repeats a partner, and sit-outs stay
 * within one (each player sits out at most once in the whole design), so
 * only the opponent spread depends on the choice. (The 4n + 2 design has
 * players sitting out twice; its caller re-evens the sit-outs.)
 * @returns {{rows: number[][], evaluations: number}} kept rows, in design order.
 */
export function bestRoundSubset(N, rows, R, seed, maxEvaluations) {
  const C = Math.floor(N / 4);
  const total = rows.length;
  const keys = rows.map((row) => opponentKeys(row, N, C));
  const opp = new Int32Array(N * N);
  const kept = new Uint8Array(total);
  let cost = 0;
  const toggle = (r, s) => {
    let d = 0;
    for (const key of keys[r]) {
      d += s > 0 ? 2 * opp[key] + 1 : 1 - 2 * opp[key];
      opp[key] += s;
    }
    kept[r] = s > 0 ? 1 : 0;
    return d;
  };
  for (let r = 0; r < R; r++) cost += toggle(r, 1);
  const pairs = (N * (N - 1)) / 2;
  const q = Math.floor((4 * C * R) / pairs);
  const rem = 4 * C * R - q * pairs;
  const lowerBound = pairs * q * q + rem * (2 * q + 1);

  const rand = mulberry32(seed);
  const tabuUntil = new Int32Array(total);
  let best = kept.slice();
  let bestCost = cost;
  let evaluations = 0;
  let step = 0;
  while (bestCost > lowerBound && evaluations < maxEvaluations && R < total) {
    step++;
    let pickOut = -1;
    let pickIn = -1;
    let pickDelta = Infinity;
    let ties = 0;
    for (let out = 0; out < total; out++) {
      if (!kept[out]) continue;
      const dOut = toggle(out, -1);
      for (let into = 0; into < total; into++) {
        if (kept[into] || into === out) continue;
        evaluations++;
        const d = dOut + toggle(into, 1);
        toggle(into, -1);
        const tabu = tabuUntil[out] > step || tabuUntil[into] > step;
        if (tabu && cost + d >= bestCost) continue;
        if (d < pickDelta) {
          pickOut = out;
          pickIn = into;
          pickDelta = d;
          ties = 1;
        } else if (d === pickDelta && randInt(rand, ++ties) === 0) {
          pickOut = out;
          pickIn = into;
        }
      }
      toggle(out, 1);
    }
    if (pickOut < 0) break;
    cost += toggle(pickOut, -1) + toggle(pickIn, 1);
    tabuUntil[pickOut] = step + 2 + randInt(rand, 3);
    tabuUntil[pickIn] = step + 2 + randInt(rand, 3);
    if (cost < bestCost) {
      bestCost = cost;
      best = kept.slice();
    }
  }
  return { rows: rows.filter((_, r) => best[r]), evaluations };
}

/**
 * One more round for an N = 4n schedule `rows` in which every pair has
 * opposed at most once and the never-opposed pairs form a perfect matching
 * (the q = 0 cyclic developments at R = N/2 - 1 have exactly this shape):
 * a round whose tables each seat two matched pairs {a, a'}, {b, b'} as
 * a, b vs a', b' (or a, b' vs a', b) opposes every matched pair once and
 * two other pairs a second time, which is the equitable profile of R = N/2,
 * provided no table repeats a partnership. Depth-first over the pairings.
 * @returns {number[]|null} the seat row, or null when no pairing works.
 */
function matchingRound(N, rows) {
  const C = N / 4;
  const opposed = new Uint8Array(N * N);
  const partnered = new Uint8Array(N * N);
  for (const row of rows) {
    for (const key of opponentKeys(row, N, C)) opposed[key] = 1;
    for (let s = 0; s < N; s += 2) {
      partnered[row[s] * N + row[s + 1]] = 1;
      partnered[row[s + 1] * N + row[s]] = 1;
    }
  }
  const mate = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (opposed[i * N + j]) continue;
      if (mate[i] >= 0 || mate[j] >= 0) return null; // not a matching
      mate[i] = j;
      mate[j] = i;
    }
  }
  if (mate.includes(-1)) return null;
  const edges = [];
  for (let i = 0; i < N; i++) if (i < mate[i]) edges.push([i, mate[i]]);
  const used = new Uint8Array(edges.length);
  const row = [];
  const place = (e) => {
    while (e < edges.length && used[e]) e++;
    if (e === edges.length) return true;
    const [a, a2] = edges[e];
    used[e] = 1;
    for (let g = e + 1; g < edges.length; g++) {
      if (used[g]) continue;
      for (const [b, b2] of [edges[g], [edges[g][1], edges[g][0]]]) {
        if (partnered[a * N + b] || partnered[a2 * N + b2]) continue;
        used[g] = 1;
        row.push(a, b, a2, b2);
        if (place(e + 1)) return true;
        row.length -= 4;
        used[g] = 0;
      }
    }
    used[e] = 0;
    return false;
  };
  return place(0) ? row : null;
}

/**
 * Even out sit-outs in place: while two players' sit-out counts differ by
 * more than one, seat the one who sat out most in place of the one who sat
 * out least, in a round where the first sits and the second plays. Used on
 * a subset of the 4n + 2 design, where dropped rounds can leave sit-outs
 * two apart; the swap may cost an equity violation or a repeated partner,
 * which the search repairs.
 */
function balanceByes(rows, N, A) {
  const byes = new Int32Array(N);
  for (const row of rows) for (let s = A; s < N; s++) byes[row[s]]++;
  for (;;) {
    let most = 0;
    let least = 0;
    for (let p = 1; p < N; p++) {
      if (byes[p] > byes[most]) most = p;
      if (byes[p] < byes[least]) least = p;
    }
    if (byes[most] - byes[least] <= 1) return rows;
    const row = rows.find((r) => r.indexOf(most) >= A && r.indexOf(least) < A);
    const i = row.indexOf(most);
    const j = row.indexOf(least);
    row[i] = least;
    row[j] = most;
    byes[most]--;
    byes[least]++;
  }
}

// Evaluation budgets of the constructions (same unit as the search budget:
// candidate swaps scored). A cyclic base round, when one exists, is found
// well inside its budget; a whist subset search is cheap per step.
const CYCLIC_BUDGET = 300000;
const WHIST_BUDGET = 1000000; // a whole whist-like design: the hardest base rounds
const SUBSET_BUDGET = 100000;
// Whist subsets pay off near full length: with few rounds dropped a subset
// is often already equitable, while shorter subsets of these cyclic designs
// start far from it (every short run of shifts repeats the same oppositions)
// and the search does better from scratch. Wh(4n) costs no evaluations
// (whist-generate.js's own search) and is used at every length.
const MAX_DROPPED = 5;

/**
 * All N - 1 rounds of an equitable schedule for N = 4n + 2 players, built
 * like a whist tournament: the cyclic development over Z_{N-1} with one
 * fixed point, whose base round is searched so that the fixed point can
 * trade its round-0 seat for a sit-out (see cyclicPlan and cyclicRows).
 * @returns {{rows: number[][]|null, evaluations: number}}
 */
function nearWhistRows(N, seed) {
  return cyclicRows(cyclicPlan(N, N - 1, 1, true), seed, WHIST_BUDGET);
}

/** All N - 1 rounds of the whist tournament Wh(N), N = 4n, as seat rows. */
function whistRows(N, base) {
  const index = (label) => Number(label.slice(1)) - 1;
  return whist
    .buildSchedule(N, base)
    .rounds.map((round) => round.matches.flatMap((m) => m.teams.flat().map(index)));
}

/**
 * The best start this module can build for N players over R rounds (R below
 * the full length when N = 4n), and the evaluations spent building it.
 * Tried in order, the first equitable result winning: the matching round
 * (N = 4n, R = N/2); a cyclic development from one base round, then from
 * two; then the best R-round subset of a whist-like design (Wh(N) for
 * N = 4n at any length; for 4n + 1 and 4n + 2 only near full length), as a
 * start whether equitable or not. rows is undefined when nothing applies;
 * the search then starts from a seeded random arrangement.
 * @returns {{rows: number[][]|undefined, evaluations: number}}
 */
export function startArrangement(N, R, seed) {
  let evaluations = 0;
  const before = N % 4 === 0 && R === N / 2 && !costFloor(N, R - 1) ? cyclicPlan(N, R - 1, 1) : null;
  if (before && before.q === 0) {
    // One matching round past the q = 0 development of R - 1 rounds; not
    // every base round admits one, so base rounds are retried (seed + 1, ...).
    for (let attempt = 0; evaluations < CYCLIC_BUDGET; attempt++) {
      const found = cyclicRows(before, seed + attempt, CYCLIC_BUDGET - evaluations);
      evaluations += found.evaluations;
      const extra = found.rows && matchingRound(N, found.rows);
      if (extra) return { rows: [...found.rows, extra], evaluations };
    }
  }
  for (const t of [1, 2]) {
    const plan = cyclicPlan(N, R, t);
    if (!plan) continue;
    const found = cyclicRows(plan, seed, CYCLIC_BUDGET);
    evaluations += found.evaluations;
    if (found.rows) return { rows: found.rows, evaluations };
  }
  let design = null;
  if (N % 4 === 0) {
    const found = whist.findBaseRound(N, seed);
    if (found) design = whistRows(N, found.base);
  } else if (N % 4 === 1 && N > 9 && N - R <= MAX_DROPPED) {
    // Wh(N) for N = 4n + 1: the cyclic development over Z_N, N rounds. Z_9
    // has none (each of the 315 possible base rounds fails), so 9 is skipped.
    const found = cyclicRows(cyclicPlan(N, N, 1), seed, WHIST_BUDGET);
    evaluations += found.evaluations;
    design = found.rows;
  } else if (N % 4 === 2 && N - 1 - R <= MAX_DROPPED) {
    const found = nearWhistRows(N, seed);
    evaluations += found.evaluations;
    design = found.rows;
  }
  if (!design) return { rows: undefined, evaluations };
  const subset = bestRoundSubset(N, design, R, seed, SUBSET_BUDGET);
  const rows = N % 4 === 2 ? balanceByes(subset.rows, N, 4 * Math.floor(N / 4)) : subset.rows;
  return { rows, evaluations: evaluations + subset.evaluations };
}
