/************************************************************
 * whist-generate.js — perfect-mix schedule generator (R-PERFECT-MIX)
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
 * Every generated schedule is checked by an independent verifier that
 * counts partner and opponent meetings over the full round list. The
 * script refuses to write any file unless the partner matrix is all 1s
 * and the opponent matrix is all 2s.
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
    // Base table i is always court i+1. Every rotating player therefore
    // visits court 1 three times and each other court four times; the
    // fixed player (P<N>) stays on court 1. Courts do not affect mixing.
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
  const partner = Array.from({ length: N }, () => new Array(N).fill(0));
  const opponent = Array.from({ length: N }, () => new Array(N).fill(0));

  schedule.rounds.forEach((round, r) => {
    if (round.roundNumber !== r + 1) problems.push(`round ${r + 1}: roundNumber ${round.roundNumber}`);
    if (round.matches.length !== N / 4) problems.push(`round ${r + 1}: ${round.matches.length} matches`);
    const seen = new Set();
    round.matches.forEach((match, c) => {
      if (match.court !== c + 1) problems.push(`round ${r + 1}: court ${match.court} at index ${c}`);
      const [t1, t2] = match.teams;
      for (const p of [...t1, ...t2]) {
        if (!idx.has(p)) problems.push(`round ${r + 1}: unknown player ${p}`);
        if (seen.has(p)) problems.push(`round ${r + 1}: ${p} plays twice`);
        seen.add(p);
      }
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

  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (partner[i][j] !== 1) problems.push(`${players[i]}-${players[j]} partnered ${partner[i][j]}x`);
      if (opponent[i][j] !== 2) problems.push(`${players[i]}-${players[j]} opposed ${opponent[i][j]}x`);
    }
  }
  return problems;
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
    const found = findBaseRound(N, N * 7919);
    if (!found) {
      console.error(`Wh(${N}): no base round found within the search budget; nothing written`);
      failed = true;
      continue;
    }
    const schedule = buildSchedule(N, found.base);
    const problems = verifySchedule(schedule);
    if (problems.length) {
      console.error(`Wh(${N}): VERIFICATION FAILED (${problems.length} problems); nothing written`);
      problems.slice(0, 20).forEach((p) => console.error(`  ${p}`));
      failed = true;
      continue;
    }
    const pairs = (N * (N - 1)) / 2;
    console.log(
      `Wh(${N}): verified — ${N - 1} rounds x ${N / 4} courts; ` +
        `${pairs} pairs all partnered 1x and opposed 2x (search restarts: ${found.restarts})`
    );
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

module.exports = { findBaseRound, buildSchedule, verifySchedule };
