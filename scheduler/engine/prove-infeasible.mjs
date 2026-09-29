/**
 * Exhaustive feasibility proofs for small shapes (R-EQUITABLE-MIX).
 *
 *   node scheduler/engine/prove-infeasible.mjs            # re-prove the table
 *   node scheduler/engine/prove-infeasible.mjs 9/4 9/4/4  # N/R[/excess]
 *
 * exhaustive(N, R, excess) decides whether any schedule of N players over R
 * rounds exists with no repeated partner, sit-out counts within one, and an
 * opponent sum of squares at most lowerBound + excess (excess 0: every
 * opponent count within one of every other, the equitable mix). It is a
 * complete depth-first search over whole rounds, pruned only by sound
 * arguments, so "infeasible" is a proof by exhaustion:
 *   - Round 1 is fixed to the canonical round (players 0.. in court order,
 *     the last ones sitting out): relabelling players maps any round to it.
 *   - Round 2 is the smallest round of its orbit under the relabellings that
 *     fix round 1 (courts, teams, team-mates and sit-outs permuted).
 *   - Rounds 3.. are in increasing order: the order of rounds changes no count.
 *   - A round is only added if it repeats no partnership, keeps every
 *     sit-out count reachable within one, and the opponent cost so far plus
 *     the least cost the remaining oppositions can add (spread over the
 *     lowest counts, ignoring all structure) stays within the bound.
 * Constraints only tighten as rounds are added, so each branch filters its
 * parent's candidate list.
 *
 * EXHAUSTIVE_FLOORS in feasibility.mjs records what this script proves; the
 * default run re-proves every entry, i.e. that no schedule costs less than
 * lowerBound + floor (about six minutes, nearly all of it 11/7).
 */

import { pathToFileURL } from 'node:url';
import { EXHAUSTIVE_FLOORS } from './feasibility.mjs';
import { minSumOfSquares } from './search.mjs';

/** Every combination of k elements of arr, in lexicographic order. */
function combinations(arr, k) {
  const out = [];
  const pick = (start, acc) => {
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let i = start; i < arr.length; i++) {
      acc.push(arr[i]);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return out;
}

/** Every permutation of 0..n-1. */
function permutations(n) {
  const out = [];
  const used = new Uint8Array(n);
  const build = (acc) => {
    if (acc.length === n) {
      out.push(acc.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = 1;
      acc.push(i);
      build(acc);
      acc.pop();
      used[i] = 0;
    }
  };
  build([]);
  return out;
}

/**
 * @returns {{feasible: boolean, nodes: number, rounds: number[][]|null}}
 *   rounds: a witness schedule (seat rows) when feasible.
 */
export function exhaustive(N, R, excess = 0) {
  const C = Math.floor(N / 4);
  const A = 4 * C;
  const B = N - A;
  const P = (N * (N - 1)) / 2;
  const total = 4 * C * R;
  const bound = minSumOfSquares(total, P) + excess;
  const byeLow = Math.floor((B * R) / N);
  const byeHigh = Math.ceil((B * R) / N);
  const atHigh = B * R - byeLow * N; // players sitting out byeHigh times
  const pairOf = new Int32Array(N * N);
  for (let i = 0, k = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++, k++) {
      pairOf[i * N + j] = k;
      pairOf[j * N + i] = k;
    }
  }

  // All distinct rounds, as canonical seat rows: courts ordered by their
  // smallest player, who sits first; partner next, then the opponents in
  // order; sit-outs last, ascending.
  const rows = [];
  const index = new Map();
  const keyOf = (row) => row.reduce((k, p) => k * N + p, 0);
  const everyone = Array.from({ length: N }, (_, i) => i);
  for (const out of combinations(everyone, B)) {
    const courts = (rest, acc) => {
      if (rest.length === 0) {
        const row = [...acc, ...out];
        index.set(keyOf(row), rows.length);
        rows.push(row);
        return;
      }
      const [a, ...others] = rest;
      for (const b of others) {
        const left = others.filter((p) => p !== b);
        for (const [c, d] of combinations(left, 2)) {
          courts(left.filter((p) => p !== c && p !== d), [...acc, a, b, c, d]);
        }
      }
    };
    courts(everyone.filter((p) => !out.includes(p)), []);
  }
  const canonical = (row) => {
    const courts = [];
    for (let c = 0; c < C; c++) {
      let t1 = [row[4 * c], row[4 * c + 1]].sort((x, y) => x - y);
      let t2 = [row[4 * c + 2], row[4 * c + 3]].sort((x, y) => x - y);
      if (t2[0] < t1[0]) [t1, t2] = [t2, t1];
      courts.push([...t1, ...t2]);
    }
    courts.sort((x, y) => x[0] - y[0]);
    return [...courts.flat(), ...row.slice(A).sort((x, y) => x - y)];
  };
  const M = rows.length;
  const partners = new Int32Array(M * 2 * C);
  const opponents = new Int32Array(M * 4 * C);
  const sitters = new Int32Array(M * B);
  rows.forEach((row, r) => {
    for (let c = 0; c < C; c++) {
      const [a, b, x, y] = row.slice(4 * c, 4 * c + 4);
      partners.set([pairOf[a * N + b], pairOf[x * N + y]], r * 2 * C + 2 * c);
      opponents.set(
        [pairOf[a * N + x], pairOf[a * N + y], pairOf[b * N + x], pairOf[b * N + y]],
        r * 4 * C + 4 * c
      );
    }
    sitters.set(row.slice(A), r * B);
  });

  const partnered = new Uint8Array(P);
  const opposed = new Uint8Array(P);
  const byes = new Uint8Array(N);
  const histogram = new Int32Array(R + 2); // pairs per opponent count
  histogram[0] = P;
  let squares = 0;
  let placed = 0;
  let playersAtHigh = 0;
  // Least sum of squares added by `more` further oppositions: each goes to
  // a currently lowest count.
  const cheapest = (more) => {
    const h = histogram.slice();
    let added = 0;
    for (let v = 0; more > 0; v++) {
      const n = Math.min(more, h[v]);
      added += n * (2 * v + 1);
      h[v + 1] += n;
      more -= n;
    }
    return added;
  };
  const fits = (r) => {
    for (let k = 0; k < 2 * C; k++) if (partnered[partners[r * 2 * C + k]]) return false;
    let newHigh = 0;
    for (let k = 0; k < B; k++) {
      const b = byes[sitters[r * B + k]];
      if (b >= byeHigh) return false;
      if (byeHigh > byeLow && b + 1 === byeHigh) newHigh++;
    }
    if (playersAtHigh + newHigh > atHigh) return false;
    let added = 0;
    for (let k = 0; k < 4 * C; k++) {
      const o = opposed[opponents[r * 4 * C + k]];
      added += 2 * o + 1;
      histogram[o]--;
      histogram[o + 1]++;
    }
    const ok = squares + added + cheapest(total - placed - 4 * C) <= bound;
    for (let k = 0; k < 4 * C; k++) {
      const o = opposed[opponents[r * 4 * C + k]];
      histogram[o]++;
      histogram[o + 1]--;
    }
    return ok;
  };
  const apply = (r, s) => {
    for (let k = 0; k < 2 * C; k++) partnered[partners[r * 2 * C + k]] += s;
    for (let k = 0; k < 4 * C; k++) {
      const p = opponents[r * 4 * C + k];
      histogram[opposed[p]]--;
      if (s < 0) opposed[p]--;
      squares += s * (2 * opposed[p] + 1);
      if (s > 0) opposed[p]++;
      histogram[opposed[p]]++;
    }
    placed += s * 4 * C;
    for (let k = 0; k < B; k++) {
      const p = sitters[r * B + k];
      if (s < 0 && byeHigh > byeLow && byes[p] === byeHigh) playersAtHigh--;
      byes[p] += s;
      if (s > 0 && byeHigh > byeLow && byes[p] === byeHigh) playersAtHigh++;
    }
  };
  // Every player must still be able to reach byeLow sit-outs.
  const byesReachable = (left) => {
    if (byeLow > left) for (let p = 0; p < N; p++) if (byes[p] + left < byeLow) return false;
    return true;
  };

  const first = index.get(keyOf(canonical(everyone)));
  // Relabellings that fix round 1.
  const stabilizer = [];
  for (const courtOrder of permutations(C)) {
    for (let flips = 0; flips < 1 << (3 * C); flips++) {
      for (const benchOrder of permutations(B)) {
        const g = new Int32Array(N);
        for (let c = 0; c < C; c++) {
          let to = [0, 1, 2, 3].map((k) => 4 * courtOrder[c] + k);
          if ((flips >> (3 * c)) & 1) to = [to[2], to[3], to[0], to[1]];
          if ((flips >> (3 * c + 1)) & 1) to = [to[1], to[0], to[2], to[3]];
          if ((flips >> (3 * c + 2)) & 1) to = [to[0], to[1], to[3], to[2]];
          to.forEach((dst, k) => (g[4 * c + k] = dst));
        }
        benchOrder.forEach((k, i) => (g[A + i] = A + k));
        stabilizer.push(g);
      }
    }
  }
  apply(first, 1);
  const seconds = [];
  const seen = new Uint8Array(M);
  for (let r = 0; r < M; r++) {
    if (r === first || seen[r] || !fits(r)) continue;
    let smallest = r;
    for (const g of stabilizer) {
      const image = index.get(keyOf(canonical(rows[r].map((p) => g[p]))));
      seen[image] = 1;
      if (image < smallest) smallest = image;
    }
    seconds.push(smallest);
  }
  const candidates = [];
  for (let r = 0; r < M; r++) if (r !== first && fits(r)) candidates.push(r);

  let nodes = 0;
  const chosen = [first];
  const extend = (list) => {
    nodes++;
    if (chosen.length === R) return true;
    if (!byesReachable(R - chosen.length)) return false;
    for (let n = 0; n < list.length; n++) {
      const r = list[n];
      apply(r, 1);
      const next = [];
      for (let m = n + 1; m < list.length; m++) if (fits(list[m])) next.push(list[m]);
      chosen.push(r);
      if (next.length >= R - chosen.length && extend(next)) return true;
      chosen.pop();
      apply(r, -1);
    }
    return false;
  };
  let feasible = R === 1;
  for (const second of R === 1 ? [] : seconds) {
    apply(second, 1);
    chosen.push(second);
    const next = candidates.filter((r) => r !== second && fits(r));
    if (next.length >= R - 2 && extend(next)) {
      feasible = true;
      break;
    }
    chosen.pop();
    apply(second, -1);
  }
  return { feasible, nodes, rounds: feasible ? chosen.map((r) => rows[r]) : null };
}

function main(args) {
  // Default: re-prove the table's claim for every entry (nothing below its
  // floor). Explicit N/R[/excess] arguments: just report each search.
  const table = args.length === 0;
  const jobs = table
    ? [...EXHAUSTIVE_FLOORS].map(([shape, floor]) => [...shape.split('/').map(Number), floor - 2])
    : args.map((a) => a.split('/').map(Number));
  let confirmed = true;
  for (const [N, R, excess = 0] of jobs) {
    const start = performance.now();
    const { feasible, nodes } = exhaustive(N, R, excess);
    const ms = Math.round(performance.now() - start);
    console.log(`${N}/${R} within lowerBound + ${excess}: ${feasible ? 'feasible' : 'INFEASIBLE'} (${nodes} nodes, ${ms} ms)`);
    if (table && feasible) confirmed = false;
  }
  if (table) {
    console.log(confirmed ? 'table confirmed' : 'TABLE DISAGREES WITH THE PROOFS');
    process.exitCode = confirmed ? 0 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
