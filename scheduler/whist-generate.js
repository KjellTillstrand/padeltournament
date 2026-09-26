/************************************************************
 * whist-generate.js — perfect-mix schedule generator (R-PERFECT-MIX,
 * R-SPACED-MIX)
 *
 * Generates a whist tournament Wh(N) for N players (N divisible by 4):
 * N-1 rounds of N/4 matches in which every pair of players partners
 * exactly once and opposes exactly twice.
 *
 * Method: Z-cyclic construction. Players are the elements of Z_{N-1}
 * plus one fixed player "inf". A base round (N/4 tables) is found by a
 * seeded randomized backtracking search; round r is the base round with
 * every finite player shifted by +r mod N-1. The base round yields a
 * whist tournament exactly when, over its finite pairs,
 *   - the partner differences +-(a-b) cover every non-zero residue once,
 *   - the opponent differences +-(a-c) cover every non-zero residue twice.
 * (Pairs involving "inf" are balanced by the rotation automatically.)
 *
 * A spacing stage then reorders the rounds so repeat encounters are spread
 * out: no pair opposes in consecutive rounds, no pair partners in a round
 * next to one where it opposes, and the smallest gap between two meetings
 * of a pair is as large as the search finds. Reordering whole rounds cannot
 * change who partners or opposes whom. Several base rounds (seeds seed,
 * seed + 1, ...) are tried and the best-spaced one is kept. With fewer than
 * 4 courts some adjacent repeats are unavoidable (see adjacentRepeatBound)
 * and the stage is skipped: the constructed 12-player order already has
 * exactly the minimum, 30.
 *
 * A court balancing pass then permutes court assignments within each
 * round (which cannot change who meets whom) so every player visits
 * every court.
 *
 * Every generated schedule is checked by independent verifiers that count
 * meetings over the full round list. The script refuses to write any file
 * unless the partner matrix is all 1s, the opponent matrix is all 2s, no
 * player misses a court, and adjacent repeat encounters (verifySpacing) are
 * none with 4+ courts, or exactly the proven minimum with fewer.
 *
 * Usage:
 *   node scheduler/whist-generate.js            # writes all four tables
 *   node scheduler/whist-generate.js 16 20      # writes selected sizes
 *   node scheduler/whist-generate.js --check    # generate + verify, no write
 *
 * Output: web/schedules/<N>p<N-1>r.js assigning window.schedule<N>p<N-1>r.
 * Deterministic: a fixed seed per size reproduces the same files.
 ************************************************************/

const fs = require('fs');
const path = require('path');

const SIZES = [12, 16, 20, 24];
const SCHEDULE_DIR = path.join(__dirname, '..', 'web', 'schedules');
const MAX_RESTARTS = 100000;
const NODE_BUDGET_PER_RESTART = 20000;
// Spacing stage budget: base rounds tried per size, and random restarts of
// the round-order search per base round.
const SPACING_CANDIDATES = 16;
const SPACING_RESTARTS = 24;
// Node budget of each depth-first search for a round order with a given gap.
const SPACING_NODE_BUDGET = 200000;

/** Fixed per-size seed, so regenerating a table reproduces the same file. */
function defaultSeed(N) {
  return N * 7919;
}

// Small deterministic PRNG (mulberry32) so regeneration is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Search for a Z-cyclic base round for N players.
 * Returns an array of tables [[a, b], [c, d]] over Z_{N-1}, where the
 * value INF (= N-1) denotes the fixed player; or null if the budget runs out.
 */
function findBaseRound(N, seed) {
  const m = N - 1;
  const INF = m;
  const tables = N / 4;
  const rand = mulberry32(seed);

  for (let restart = 0; restart < MAX_RESTARTS; restart++) {
    const used = new Array(m).fill(false);
    const partnerDiff = new Array(m).fill(0); // count per residue, target 1
    const opponentDiff = new Array(m).fill(0); // count per residue, target 2
    const chosen = [];
    let nodes = 0;

    const d = (x, y) => ((x - y) % m + m) % m;
    const addPartner = (x, y, s) => {
      partnerDiff[d(x, y)] += s;
      partnerDiff[d(y, x)] += s;
    };
    const addOpp = (x, y, s) => {
      opponentDiff[d(x, y)] += s;
      opponentDiff[d(y, x)] += s;
    };
    const partnerOk = (x, y) => {
      const k1 = d(x, y);
      const k2 = d(y, x);
      // k1 === k2 cannot happen for odd m, but guard anyway.
      return k1 !== k2 && partnerDiff[k1] === 0 && partnerDiff[k2] === 0;
    };
    const oppFits = (x, ys) => {
      // Would adding opponent pairs (x, y) for y in ys keep every count <= 2?
      const extra = {};
      for (const y of ys) {
        for (const k of [d(x, y), d(y, x)]) {
          extra[k] = (extra[k] || 0) + 1;
          if (opponentDiff[k] + extra[k] > 2) return false;
        }
      }
      return true;
    };

    // WLOG (translation) the fixed player partners residue 0 in table 1.
    used[0] = true;

    function placeInfTable() {
      // Table: [INF, 0] vs [c, d]; finite opponent pairs are (0,c), (0,d).
      const free = shuffled([...Array(m).keys()].filter((x) => !used[x]), rand);
      for (let i = 0; i < free.length; i++) {
        for (let j = i + 1; j < free.length; j++) {
          const c = free[i];
          const e = free[j];
          if (!partnerOk(c, e)) continue;
          if (!oppFits(0, [c, e])) continue;
          used[c] = used[e] = true;
          addPartner(c, e, 1);
          addOpp(0, c, 1);
          addOpp(0, e, 1);
          chosen.push([[INF, 0], [c, e]]);
          if (placeTables()) return true;
          chosen.pop();
          addOpp(0, e, -1);
          addOpp(0, c, -1);
          addPartner(c, e, -1);
          used[c] = used[e] = false;
          if (nodes > NODE_BUDGET_PER_RESTART) return false;
        }
      }
      return false;
    }

    function placeTables() {
      nodes++;
      if (nodes > NODE_BUDGET_PER_RESTART) return false;
      if (chosen.length === tables) return true;
      // Anchor on the smallest unused residue to avoid symmetric re-search.
      const a = used.indexOf(false);
      used[a] = true;
      const free = shuffled([...Array(m).keys()].filter((x) => !used[x]), rand);
      for (const b of free) {
        if (!partnerOk(a, b)) continue;
        used[b] = true;
        addPartner(a, b, 1);
        const rest = free.filter((x) => x !== b);
        for (let i = 0; i < rest.length; i++) {
          for (let j = i + 1; j < rest.length; j++) {
            const c = rest[i];
            const e = rest[j];
            if (!partnerOk(c, e)) continue;
            if (!oppFits(a, [c, e])) continue;
            addOpp(a, c, 1);
            addOpp(a, e, 1);
            const okB = oppFits(b, [c, e]);
            if (okB) {
              addOpp(b, c, 1);
              addOpp(b, e, 1);
              used[c] = used[e] = true;
              addPartner(c, e, 1);
              chosen.push([[a, b], [c, e]]);
              if (placeTables()) return true;
              chosen.pop();
              addPartner(c, e, -1);
              used[c] = used[e] = false;
              addOpp(b, e, -1);
              addOpp(b, c, -1);
            }
            addOpp(a, e, -1);
            addOpp(a, c, -1);
            if (nodes > NODE_BUDGET_PER_RESTART) break;
          }
          if (nodes > NODE_BUDGET_PER_RESTART) break;
        }
        addPartner(a, b, -1);
        used[b] = false;
        if (nodes > NODE_BUDGET_PER_RESTART) break;
      }
      used[a] = false;
      return false;
    }

    if (placeInfTable()) return { base: chosen, restarts: restart + 1 };
  }
  return null;
}

/** Expand a base round into the full N-1 round schedule object. */
function buildSchedule(N, base) {
  const m = N - 1;
  const INF = m;
  const label = (x, r) => (x === INF ? `P${N}` : `P${((x + r) % m) + 1}`);
  const rounds = [];
  for (let r = 0; r < m; r++) {
    // Base table i starts on court i+1; balanceCourts() reassigns courts.
    rounds.push({
      roundNumber: r + 1,
      matches: base.map(([t1, t2], i) => ({
        court: i + 1,
        teams: [t1.map((x) => label(x, r)), t2.map((x) => label(x, r))],
      })),
    });
  }
  return {
    playerCount: N,
    totalRounds: m,
    players: Array.from({ length: N }, (_, i) => `P${i + 1}`),
    rounds,
  };
}

/** All permutations of [0..n-1], in lexicographic order. */
function permutations(n) {
  if (n === 0) return [[]];
  const out = [];
  for (const rest of permutations(n - 1)) {
    for (let pos = 0; pos <= rest.length; pos++) {
      out.push([...rest.slice(0, pos), n - 1, ...rest.slice(pos)]);
    }
  }
  return out.sort((x, y) => {
    for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
}

/**
 * Court balancing pass. Within each round, permutes which match is played
 * on which court; this cannot change who partners or opposes whom. Greedy,
 * round by round: choose the assignment minimising (1) the largest
 * per-player court-visit count so far, then (2) the sum of squared visit
 * counts. Ties go to the first permutation in lexicographic order, so the
 * result is deterministic. Mutates and returns the schedule.
 */
function balanceCourts(schedule) {
  const courts = schedule.rounds[0].matches.length;
  const perms = permutations(courts);
  const visits = new Map(schedule.players.map((p) => [p, new Array(courts).fill(0)]));

  for (const round of schedule.rounds) {
    const seats = round.matches.map((m) => m.teams.flat());
    let best = null;
    let bestMax = Infinity;
    let bestSq = Infinity;
    for (const perm of perms) {
      // perm[i] = court index for match i.
      let max = 0;
      let sq = 0;
      seats.forEach((players, i) => {
        for (const p of players) {
          const v = visits.get(p)[perm[i]] + 1;
          if (v > max) max = v;
          sq += v * v - (v - 1) * (v - 1);
        }
      });
      if (max < bestMax || (max === bestMax && sq < bestSq)) {
        best = perm;
        bestMax = max;
        bestSq = sq;
      }
    }
    seats.forEach((players, i) => players.forEach((p) => visits.get(p)[best[i]]++));
    round.matches.forEach((m, i) => { m.court = best[i] + 1; });
    round.matches.sort((x, y) => x.court - y.court);
  }
  return schedule;
}

/**
 * Court-visit spread: for every player and court, how many rounds that
 * player plays on that court. Returns { min, max, missing } where missing
 * lists "player@court" entries with zero visits.
 */
function courtSpread(schedule) {
  const courts = schedule.playerCount / 4;
  const visits = new Map(schedule.players.map((p) => [p, new Array(courts).fill(0)]));
  for (const round of schedule.rounds) {
    for (const m of round.matches) {
      for (const p of m.teams.flat()) {
        if (visits.has(p) && m.court >= 1 && m.court <= courts) visits.get(p)[m.court - 1]++;
      }
    }
  }
  let min = Infinity;
  let max = 0;
  const missing = [];
  for (const [p, counts] of visits) {
    counts.forEach((v, c) => {
      if (v < min) min = v;
      if (v > max) max = v;
      if (v === 0) missing.push(`${p}@court${c + 1}`);
    });
  }
  return { min, max, missing };
}

/**
 * Encounter weights between rounds, counted from the round list: for rounds
 * a and b, opp[a][b] is the number of pairs that oppose each other in both,
 * mixed[a][b] the number that partner in one and oppose in the other, and
 * any[a][b] the number that meet (in any role) in both.
 */
function encounterWeights(schedule) {
  const idx = new Map(schedule.players.map((p, i) => [p, i]));
  const P = schedule.players.length;
  const R = schedule.rounds.length;
  // role[r][pair]: 0 = not met, 1 = partners, 2 = opponents in round r.
  const role = schedule.rounds.map((round) => {
    const row = new Uint8Array(P * P);
    const set = (x, y, v) => {
      const i = idx.get(x);
      const j = idx.get(y);
      row[i < j ? i * P + j : j * P + i] = v;
    };
    for (const { teams } of round.matches) {
      const [[a, b], [c, d]] = teams;
      set(a, b, 1);
      set(c, d, 1);
      for (const x of [a, b]) for (const y of [c, d]) set(x, y, 2);
    }
    return row;
  });
  const grid = () => Array.from({ length: R }, () => new Array(R).fill(0));
  const opp = grid();
  const mixed = grid();
  const any = grid();
  for (let a = 0; a < R; a++) {
    for (let b = a + 1; b < R; b++) {
      let o = 0;
      let m = 0;
      let n = 0;
      for (let k = 0; k < P * P; k++) {
        const x = role[a][k];
        const y = role[b][k];
        if (!x || !y) continue;
        n++;
        if (x === 2 && y === 2) o++;
        else if (x !== y) m++;
      }
      opp[a][b] = opp[b][a] = o;
      mixed[a][b] = mixed[b][a] = m;
      any[a][b] = any[b][a] = n;
    }
  }
  return { opp, mixed, any };
}

/**
 * Spacing score of a round order (order[k] = original index of the round
 * played k-th), as an array compared lexicographically, smaller is better:
 *   [0] back-to-back oppositions: pairs opposing in consecutive rounds,
 *   [1] partner-adjacent oppositions: pairs that partner in a round and
 *       oppose in the round before or after,
 *   [2..] for gap g = 2, 3, ...: the number of repeat meetings (any role)
 *       exactly g rounds apart.
 * Minimising [2..] lexicographically maximises the smallest gap between two
 * meetings of the same pair, then makes that gap as rare as possible.
 */
function spacingScore(order, weights) {
  const R = order.length;
  const score = new Array(R + 1).fill(0);
  for (let i = 0; i < R; i++) {
    for (let j = i + 1; j < R; j++) {
      const a = order[i];
      const b = order[j];
      if (j === i + 1) {
        score[0] += weights.opp[a][b];
        score[1] += weights.mixed[a][b];
      } else {
        score[j - i] += weights.any[a][b];
      }
    }
  }
  return score;
}

function compareScores(x, y) {
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Smallest number of rounds between two meetings of the same pair. */
function minMeetingGap(score) {
  if (score[0] || score[1]) return 1;
  for (let g = 2; g < score.length; g++) if (score[g]) return g;
  return Infinity;
}

/**
 * Randomized depth-first search for a round order in which every two rounds
 * fewer than `gap` places apart share no pair of players, except that rounds
 * next to each other may share pairs that meet as partners in both (which a
 * whist tournament never has anyway). Returns the order, or null when the
 * search is exhausted or runs out of its node budget.
 */
function orderWithGap(weights, gap, rand, nodeBudget) {
  const R = weights.any.length;
  const order = [];
  const used = new Array(R).fill(false);
  let nodes = 0;
  const fits = (round) => {
    for (let back = 1; back < gap && back <= order.length; back++) {
      const prev = order[order.length - back];
      const clash = back === 1
        ? weights.opp[prev][round] + weights.mixed[prev][round]
        : weights.any[prev][round];
      if (clash) return false;
    }
    return true;
  };
  function extend() {
    if (order.length === R) return true;
    if (++nodes > nodeBudget) return false;
    for (const round of shuffled([...Array(R).keys()], rand)) {
      if (used[round] || !fits(round)) continue;
      used[round] = true;
      order.push(round);
      if (extend()) return true;
      order.pop();
      used[round] = false;
      if (nodes > nodeBudget) return false;
    }
    return false;
  }
  return extend() ? order : null;
}

/**
 * Spacing stage. Searches for an order of the schedule's rounds that spreads
 * repeat encounters (see spacingScore), in two steps:
 *   1. Depth-first search for an order with no repeat meeting closer than
 *      `gap` rounds, for gap = 2, 3, ... until the search fails; gap 2 is the
 *      bar (no back-to-back or partner-adjacent oppositions).
 *   2. Local search over swaps of two rounds (first improvement, random move
 *      order), started from each order the first step found plus seeded
 *      random orders, lowering the score lexicographically. A swap is taken
 *      only if it improves the score, so it never loses the gap already won.
 *
 * Reordering whole rounds cannot change the perfect mix or court coverage:
 * who partners or opposes whom, and on which court, travels with each round;
 * only when things happen changes. Returns { order, score, gap, evaluations }
 * where gap is the smallest distance between two meetings of the same pair.
 */
function searchRoundOrder(schedule, { seed, restarts = SPACING_RESTARTS } = {}) {
  const weights = encounterWeights(schedule);
  const R = schedule.rounds.length;
  const rand = mulberry32(seed);
  let evaluations = 0;

  const starts = [];
  for (let gap = 2; gap < R; gap++) {
    const order = orderWithGap(weights, gap, rand, SPACING_NODE_BUDGET);
    if (!order) break;
    starts.push(order);
  }
  starts.reverse(); // widest gap first
  for (let i = 0; i < restarts; i++) starts.push(shuffled([...Array(R).keys()], rand));

  const swaps = [];
  for (let i = 0; i < R; i++) for (let j = i + 1; j < R; j++) swaps.push([i, j]);
  const delta = new Array(R + 1);
  // Score contribution of rounds a and b placed g apart, added into acc.
  const add = (acc, a, b, g, sign) => {
    if (g === 1) {
      acc[0] += sign * weights.opp[a][b];
      acc[1] += sign * weights.mixed[a][b];
    } else {
      acc[g] += sign * weights.any[a][b];
    }
  };

  let best = null;
  for (const order of starts) {
    const score = spacingScore(order, weights);
    evaluations++;
    let improved = true;
    while (improved) {
      improved = false;
      for (const [i, j] of shuffled(swaps, rand)) {
        // Only pairs involving positions i or j change distance.
        delta.fill(0);
        const a = order[i];
        const b = order[j];
        for (let k = 0; k < R; k++) {
          if (k === i || k === j) continue;
          const c = order[k];
          const gi = Math.abs(i - k);
          const gj = Math.abs(j - k);
          add(delta, a, c, gi, -1);
          add(delta, b, c, gj, -1);
          add(delta, b, c, gi, 1);
          add(delta, a, c, gj, 1);
        }
        evaluations++;
        const firstChange = delta.findIndex((v) => v !== 0);
        if (firstChange !== -1 && delta[firstChange] < 0) {
          order[i] = b;
          order[j] = a;
          for (let g = 0; g <= R; g++) score[g] += delta[g];
          improved = true;
        }
      }
    }
    if (!best || compareScores(score, best.score) < 0) best = { order, score };
  }
  return { ...best, gap: minMeetingGap(best.score), evaluations };
}

/** Put the rounds in the given order and renumber them 1..R. Mutates. */
function applyRoundOrder(schedule, order) {
  const rounds = order.map((k) => schedule.rounds[k]);
  rounds.forEach((round, r) => { round.roundNumber = r + 1; });
  schedule.rounds = rounds;
  return schedule;
}

/**
 * Lower bound on adjacent repeat encounters (back-to-back oppositions plus
 * partner-adjacent oppositions) for any full-length schedule of N players.
 *
 * Every match of round r + 1 seats 4 players, drawn from the C = N / 4
 * matches of round r; two players drawn from the same match there meet in
 * both rounds. The fewest such pairs a match can hold comes from spreading
 * its 4 players as evenly as possible over the C matches: with q = floor(4/C)
 * and s = 4 mod C, that is s * (q+1 choose 2) + (C - s) * (q choose 2). So
 * each of the N - 2 round-to-round transitions has at least C times that:
 *
 *   bound = (N - 2) * C * [s * (q+1 choose 2) + (C - s) * (q choose 2)]
 *
 * With 4 or more courts the bound is 0; with 3 courts (12 players) each
 * match holds at least 1 such pair, 3 per transition, 30 over 10
 * transitions. In a whist tournament partners never repeat, so every such
 * repeat is a back-to-back opposition or a partnering next to an opposition.
 */
function adjacentRepeatBound(N) {
  const C = N / 4;
  const q = Math.floor(4 / C);
  const s = 4 % C;
  const choose2 = (k) => (k * (k - 1)) / 2;
  return (N - 2) * C * (s * choose2(q + 1) + (C - s) * choose2(q));
}

/**
 * Can a schedule for N players avoid every adjacent repeat encounter? Only
 * with 4 or more courts; see adjacentRepeatBound.
 */
function spacingPossible(N) {
  return adjacentRepeatBound(N) === 0;
}

/**
 * The full perfect-mix pipeline with spacing: whist construction, the
 * spacing stage, then court balancing over the final order. Tries `candidates` base rounds (seeds
 * seed, seed + 1, ...), orders each one's rounds with searchRoundOrder and
 * keeps the best: first one that puts every player on every court, then the
 * best spacing score, ties going to the earliest candidate. The result is
 * deterministic for a given N and seed.
 *
 * Returns { schedule, score, spaced, candidate, restarts, evaluations } where
 * spaced means zero back-to-back oppositions and zero partner-adjacent
 * oppositions (possible only with 4+ courts), candidate is the chosen base round's index (seed + candidate),
 * restarts is that base round's search restarts and evaluations counts
 * round-order scores over all candidates; or null if no base round was found. When spacing is
 * impossible (spacingPossible(N) is false) the stage is skipped and the
 * rounds keep their constructed order; for 12 players that order already
 * meets adjacentRepeatBound exactly, which verifySpacing's caller checks.
 */
function spacedWhist(N, seed, { candidates = SPACING_CANDIDATES, restarts = SPACING_RESTARTS } = {}) {
  if (!spacingPossible(N)) {
    const found = findBaseRound(N, seed);
    if (!found) return null;
    const schedule = balanceCourts(buildSchedule(N, found.base));
    const score = spacingScore([...Array(N - 1).keys()], encounterWeights(schedule));
    return { schedule, score, spaced: false, candidate: 0, restarts: found.restarts, evaluations: 0 };
  }
  let best = null;
  let evaluations = 0;
  for (let k = 0; k < candidates; k++) {
    const found = findBaseRound(N, seed + k);
    if (!found) continue;
    const schedule = buildSchedule(N, found.base);
    const result = searchRoundOrder(schedule, { seed: seed + k, restarts });
    evaluations += result.evaluations;
    // Courts are balanced over the final round order; like the reordering,
    // this only moves matches between courts within a round.
    balanceCourts(applyRoundOrder(schedule, result.order));
    // A base round that leaves a player off a court ranks below any that
    // does not, whatever its spacing.
    const rank = [courtSpread(schedule).missing.length ? 1 : 0, ...result.score];
    if (!best || compareScores(rank, best.rank) < 0) {
      best = { schedule, score: result.score, rank, candidate: k, restarts: found.restarts };
    }
  }
  if (!best) return null;
  return {
    schedule: best.schedule,
    score: best.score,
    spaced: best.score[0] === 0 && best.score[1] === 0,
    candidate: best.candidate,
    restarts: best.restarts,
    evaluations,
  };
}

/**
 * Independent verifier: counts meetings directly from the round list
 * (no knowledge of the cyclic construction). Returns a list of problems;
 * an empty list means the schedule is a perfect whist tournament.
 */
function verifySchedule(schedule) {
  const problems = [];
  const N = schedule.playerCount;
  const players = schedule.players;
  if (players.length !== N) problems.push(`players.length ${players.length} != ${N}`);
  if (schedule.totalRounds !== N - 1) problems.push(`totalRounds ${schedule.totalRounds} != ${N - 1}`);
  if (schedule.rounds.length !== N - 1) problems.push(`rounds.length ${schedule.rounds.length} != ${N - 1}`);
  const idx = new Map(players.map((p, i) => [p, i]));
  // Sized by the actual player list so a wrong playerCount cannot index out of range.
  const P = players.length;
  const partner = Array.from({ length: P }, () => new Array(P).fill(0));
  const opponent = Array.from({ length: P }, () => new Array(P).fill(0));

  schedule.rounds.forEach((round, r) => {
    if (round.roundNumber !== r + 1) problems.push(`round ${r + 1}: roundNumber ${round.roundNumber}`);
    if (round.matches.length !== N / 4) problems.push(`round ${r + 1}: ${round.matches.length} matches`);
    const seen = new Set();
    round.matches.forEach((match, c) => {
      if (match.court !== c + 1) problems.push(`round ${r + 1}: court ${match.court} at index ${c}`);
      const teams = match.teams;
      const wellFormed =
        Array.isArray(teams) && teams.length === 2 &&
        teams.every((t) => Array.isArray(t) && t.length === 2);
      if (!wellFormed) {
        problems.push(`round ${r + 1}, court ${match.court}: teams is not two pairs`);
        return;
      }
      const [t1, t2] = teams;
      let known = true;
      for (const p of [...t1, ...t2]) {
        if (!idx.has(p)) {
          problems.push(`round ${r + 1}: unknown player ${p}`);
          known = false;
        }
        if (seen.has(p)) problems.push(`round ${r + 1}: ${p} plays twice`);
        seen.add(p);
      }
      // Skip counting a match with an unknown label (already reported) so
      // verification runs to completion and reports every problem.
      if (!known) return;
      const [a, b] = t1.map((p) => idx.get(p));
      const [c2, d] = t2.map((p) => idx.get(p));
      partner[a][b]++; partner[b][a]++;
      partner[c2][d]++; partner[d][c2]++;
      for (const x of [a, b]) {
        for (const y of [c2, d]) {
          opponent[x][y]++; opponent[y][x]++;
        }
      }
    });
    if (seen.size !== N) problems.push(`round ${r + 1}: ${seen.size} distinct players`);
  });

  for (let i = 0; i < P; i++) {
    for (let j = i + 1; j < P; j++) {
      if (partner[i][j] !== 1) problems.push(`${players[i]}-${players[j]} partnered ${partner[i][j]}x`);
      if (opponent[i][j] !== 2) problems.push(`${players[i]}-${players[j]} opposed ${opponent[i][j]}x`);
    }
  }
  return problems;
}

/**
 * Independent spacing verifier: lists, straight from the round list, every
 * pair that opposes in two consecutive rounds and every pair that partners
 * in a round and opposes in the round before or after. Also returns the
 * smallest number of rounds between two meetings of the same pair.
 * An empty problem list means the schedule meets R-SPACED-MIX.
 */
function verifySpacing(schedule) {
  const meetings = new Map(); // "a|b" -> [[roundIndex, 'partner' | 'opponent']]
  const meet = (x, y, r, kind) => {
    const key = x.localeCompare(y, 'en', { numeric: true }) < 0 ? `${x}|${y}` : `${y}|${x}`;
    if (!meetings.has(key)) meetings.set(key, []);
    meetings.get(key).push([r, kind]);
  };
  schedule.rounds.forEach((round, r) => {
    for (const { teams } of round.matches) {
      const [[a, b], [c, d]] = teams;
      meet(a, b, r, 'partner');
      meet(c, d, r, 'partner');
      for (const x of [a, b]) for (const y of [c, d]) meet(x, y, r, 'opponent');
    }
  });
  const problems = [];
  let backToBack = 0;
  let minGap = Infinity;
  for (const [key, list] of meetings) {
    const pair = key.replace('|', '-');
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [r1, k1] = list[i];
        const [r2, k2] = list[j];
        const gap = Math.abs(r1 - r2);
        if (gap < minGap) minGap = gap;
        if (gap !== 1) continue;
        const [first, second] = r1 < r2 ? [[r1, k1], [r2, k2]] : [[r2, k2], [r1, k1]];
        if (k1 === 'opponent' && k2 === 'opponent') {
          backToBack++;
          problems.push(`${pair} opposed in rounds ${first[0] + 1} and ${second[0] + 1}`);
        } else if (k1 !== k2) {
          problems.push(`${pair} ${first[1]}s in round ${first[0] + 1}, ${second[1]}s in round ${second[0] + 1}`);
        }
      }
    }
  }
  return { problems, backToBack, partnerAdjacent: problems.length - backToBack, minGap };
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const requested = args.filter((a) => a !== '--check').map(Number);
  const sizes = requested.length ? requested : SIZES;

  let failed = false;
  for (const N of sizes) {
    if (!Number.isInteger(N) || N < 4 || N % 4 !== 0) {
      console.error(`Wh(${N}): player count must be a positive multiple of 4`);
      failed = true;
      continue;
    }
    const result = spacedWhist(N, defaultSeed(N));
    if (!result) {
      console.error(`Wh(${N}): no base round found within the search budget; nothing written`);
      failed = true;
      continue;
    }
    const { schedule } = result;
    const problems = verifySchedule(schedule);
    const spread = courtSpread(schedule);
    if (spread.missing.length) {
      problems.push(`players missing a court: ${spread.missing.join(', ')}`);
    }
    const spacing = verifySpacing(schedule);
    const adjacent = spacing.backToBack + spacing.partnerAdjacent;
    const bound = adjacentRepeatBound(N);
    if (bound === 0) {
      problems.push(...spacing.problems);
    } else if (adjacent !== bound) {
      // Fewer than the bound is impossible, so anything else is above it.
      problems.push(
        `${adjacent} adjacent repeat encounters; with ${N / 4} courts the minimum is ${bound} ` +
          '(adjacentRepeatBound) and a table must meet it exactly',
        ...spacing.problems
      );
    }
    const spacingLine =
      `  spacing: ${spacing.backToBack} back-to-back oppositions, ` +
      `${spacing.partnerAdjacent} partner-adjacent oppositions ` +
      `(${adjacent} adjacent repeats, minimum possible ${bound}), min meeting gap ${spacing.minGap} ` +
      `(base round ${result.candidate + 1} of ${spacingPossible(N) ? SPACING_CANDIDATES : 1}, ` +
      `${result.evaluations} order evaluations)`;
    if (problems.length) {
      console.error(`Wh(${N}): VERIFICATION FAILED (${problems.length} problems); nothing written`);
      console.error(spacingLine);
      problems.slice(0, 20).forEach((p) => console.error(`  ${p}`));
      failed = true;
      continue;
    }
    const pairs = (N * (N - 1)) / 2;
    console.log(
      `Wh(${N}): verified — ${N - 1} rounds x ${N / 4} courts; ` +
        `${pairs} pairs all partnered 1x and opposed 2x (search restarts: ${result.restarts})`
    );
    console.log(`  court visits per player per court: min ${spread.min}, max ${spread.max}`);
    console.log(spacingLine);
    if (!checkOnly) {
      const name = `${N}p${N - 1}r`;
      const file = path.join(SCHEDULE_DIR, `${name}.js`);
      fs.writeFileSync(file, `window.schedule${name} = ${JSON.stringify(schedule, null, 2)}`);
      console.log(`  wrote ${path.relative(process.cwd(), file)}`);
    }
  }
  if (failed) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  defaultSeed,
  mulberry32,
  shuffled,
  findBaseRound,
  buildSchedule,
  balanceCourts,
  courtSpread,
  verifySchedule,
  encounterWeights,
  spacingScore,
  searchRoundOrder,
  applyRoundOrder,
  minMeetingGap,
  adjacentRepeatBound,
  spacingPossible,
  spacedWhist,
  verifySpacing,
};
