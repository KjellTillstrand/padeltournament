/**
 * sitout-generate.mjs — rest-round schedule generator (R-SITOUT-PLAY)
 *
 * Writes the shipped Americano tables for player counts that are not a
 * multiple of 4 (9, 10, 11, 13, ... 23): floor(N/4) courts play each round
 * and the other B = N mod 4 players rest. Multiples of 4 keep their perfect
 * whist tables (scheduler/whist-generate.js).
 *
 * Length: N rounds for N players, the full rest cycle (see maxRounds in
 * index.mjs). Over it every player rests exactly B times and plays exactly
 * N - B games, so totals stay comparable (points only come from games
 * played), and nobody partners anyone twice. No shorter length gives equal
 * rests for B = 1 or 3 (it needs R * B to be a multiple of N), and for
 * B = 2 the only shorter one, N/2 rounds, halves the tournament.
 *
 * The schedule comes from the engine (generateSchedule). Several seeds are
 * tried (defaultSeed(N) + 0 .. SEED_CANDIDATES - 1) and the best is kept:
 * among the schedules that pass verification, the one whose rests are spaced
 * furthest apart (equity.restSpaced, then equity.restGap), the lowest seed
 * on a tie. Deterministic, so regenerating reproduces the same files.
 *
 * Every schedule is checked by an independent verifier (verifySitOuts, which
 * counts straight from the round list and knows nothing of the engine). The
 * script refuses to write any file unless: every round seats floor(N/4)
 * courts numbered 1..C and lists as byes exactly the players it does not
 * seat; nobody partners anyone twice; every player rests exactly B times
 * (hence plays N - B games); and every pair's opponent count is within one
 * of every other's. Rest spacing is a soft goal and only reported.
 *
 * Usage:
 *   node scheduler/engine/sitout-generate.mjs           # writes all twelve tables
 *   node scheduler/engine/sitout-generate.mjs 9 22      # writes selected sizes
 *   node scheduler/engine/sitout-generate.mjs --check   # generate + verify, no write
 *
 * Output: web/schedules/<N>p<N>r.js assigning window.schedule<N>p<N>r, the
 * whist tables' format plus a `byes` list on every round.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSeed, generateSchedule, maxRounds } from './index.mjs';

const SIZES = [9, 10, 11, 13, 14, 15, 17, 18, 19, 21, 22, 23];
const SCHEDULE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'schedules');
// Seeds tried per size. Each engine call at these shapes takes milliseconds
// to a quarter of a second, so this is a few seconds per size at most.
const SEED_CANDIDATES = 16;

/**
 * Independent verifier: counts everything from the round list. Returns a
 * list of problems; an empty list means the schedule meets the guarantees
 * above.
 */
export function verifySitOuts(schedule) {
  const problems = [];
  const N = schedule.playerCount;
  const C = Math.floor(N / 4);
  const B = N - 4 * C;
  const R = N;
  const players = schedule.players;
  if (!Array.isArray(players) || players.length !== N) return [`players is not a list of ${N}`];
  if (new Set(players).size !== N) problems.push('player names are not unique');
  if (schedule.totalRounds !== R) problems.push(`totalRounds ${schedule.totalRounds} != ${R}`);
  if (schedule.rounds.length !== R) problems.push(`rounds.length ${schedule.rounds.length} != ${R}`);
  const idx = new Map(players.map((p, i) => [p, i]));
  const partner = Array.from({ length: N }, () => new Array(N).fill(0));
  const opponent = Array.from({ length: N }, () => new Array(N).fill(0));
  const rests = new Array(N).fill(0);
  const games = new Array(N).fill(0);

  schedule.rounds.forEach((round, r) => {
    const label = `round ${r + 1}`;
    if (round.roundNumber !== r + 1) problems.push(`${label}: roundNumber ${round.roundNumber}`);
    if (round.matches.length !== C) problems.push(`${label}: ${round.matches.length} matches, not ${C}`);
    const seated = new Set();
    round.matches.forEach((match, c) => {
      if (match.court !== c + 1) problems.push(`${label}: court ${match.court} at index ${c}`);
      const teams = match.teams;
      const wellFormed = Array.isArray(teams) && teams.length === 2 &&
        teams.every((t) => Array.isArray(t) && t.length === 2 && t.every((p) => idx.has(p)));
      if (!wellFormed) {
        problems.push(`${label}, court ${match.court}: teams are not two pairs of known players`);
        return;
      }
      for (const p of teams.flat()) {
        if (seated.has(p)) problems.push(`${label}: ${p} plays twice`);
        seated.add(p);
        games[idx.get(p)]++;
      }
      const [[a, b], [c2, d]] = teams.map((t) => t.map((p) => idx.get(p)));
      partner[a][b]++; partner[b][a]++;
      partner[c2][d]++; partner[d][c2]++;
      for (const x of [a, b]) for (const y of [c2, d]) { opponent[x][y]++; opponent[y][x]++; }
    });
    const expected = players.filter((p) => !seated.has(p));
    const byes = round.byes;
    if (!Array.isArray(byes) || byes.length !== B ||
      expected.length !== B || !expected.every((p) => byes.includes(p))) {
      problems.push(`${label}: byes ${JSON.stringify(byes)} are not the unseated players ${JSON.stringify(expected)}`);
    }
    for (const p of expected) rests[idx.get(p)]++;
  });

  rests.forEach((n, i) => {
    if (n !== B) problems.push(`${players[i]} rests ${n}x, not ${B}x`);
    if (games[i] !== R - B) problems.push(`${players[i]} plays ${games[i]} games, not ${R - B}`);
  });
  let minOpp = Infinity;
  let maxOpp = -Infinity;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (partner[i][j] > 1) problems.push(`${players[i]}-${players[j]} partnered ${partner[i][j]}x`);
      minOpp = Math.min(minOpp, opponent[i][j]);
      maxOpp = Math.max(maxOpp, opponent[i][j]);
    }
  }
  if (maxOpp - minOpp > 1) problems.push(`opponent counts range ${minOpp}..${maxOpp}, more than one apart`);
  return problems;
}

/** Visits per player per court: { min, max } over all players and courts. */
function courtVisits(schedule) {
  const C = Math.floor(schedule.playerCount / 4);
  const visits = new Map(schedule.players.map((p) => [p, new Array(C).fill(0)]));
  for (const round of schedule.rounds) {
    for (const m of round.matches) for (const p of m.teams.flat()) visits.get(p)[m.court - 1]++;
  }
  const all = [...visits.values()].flat();
  return { min: Math.min(...all), max: Math.max(...all) };
}

/** True when equity a is better spaced than b (a strict improvement). */
function betterSpaced(a, b) {
  if (a.restSpaced !== b.restSpaced) return a.restSpaced;
  return (a.restGap ?? Infinity) > (b.restGap ?? Infinity);
}

/** The best verified schedule for N players over its seed candidates, or null. */
function bestSchedule(N) {
  let best = null;
  let rejected = 0;
  for (let k = 0; k < SEED_CANDIDATES; k++) {
    const seed = defaultSeed(N) + k;
    let schedule;
    try {
      schedule = generateSchedule({ players: N, rounds: maxRounds(N), seed });
    } catch (err) {
      // The engine refuses (throws) rather than return a schedule that breaks
      // its guarantees, e.g. when its search budget runs out on this seed.
      rejected++;
      continue;
    }
    if (verifySitOuts(schedule).length) {
      rejected++;
      continue;
    }
    if (!best || betterSpaced(schedule.equity, best.schedule.equity)) best = { schedule, seed, k };
  }
  return best && { ...best, rejected };
}

/** The shipped shape: the whist tables' fields, plus byes; no equity report. */
function shippable(schedule) {
  return {
    playerCount: schedule.playerCount,
    totalRounds: schedule.totalRounds,
    players: schedule.players.slice(),
    rounds: schedule.rounds.map((round) => ({
      roundNumber: round.roundNumber,
      matches: round.matches.map((m) => ({ court: m.court, teams: m.teams.map((t) => t.slice()) })),
      byes: round.byes.slice(),
    })),
  };
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const requested = args.filter((a) => a !== '--check').map(Number);
  const sizes = requested.length ? requested : SIZES;

  let failed = false;
  for (const N of sizes) {
    if (!SIZES.includes(N)) {
      console.error(`${N}: not a rest-round size (one of ${SIZES.join(', ')})`);
      failed = true;
      continue;
    }
    const found = bestSchedule(N);
    if (!found) {
      console.error(`${N}p${N}r: no seed of ${SEED_CANDIDATES} passed verification; nothing written`);
      failed = true;
      continue;
    }
    const schedule = shippable(found.schedule);
    // Re-verify exactly what is written.
    const problems = verifySitOuts(schedule);
    if (problems.length) {
      console.error(`${N}p${N}r: VERIFICATION FAILED (${problems.length} problems); nothing written`);
      problems.slice(0, 20).forEach((p) => console.error(`  ${p}`));
      failed = true;
      continue;
    }
    const { equity } = found.schedule;
    const B = N % 4;
    const visits = courtVisits(schedule);
    console.log(
      `${N}p${N}r: verified — ${N} rounds x ${Math.floor(N / 4)} courts, ${B} resting per round; ` +
        `every player rests ${B}x and plays ${N - B} games; no repeated partner; ` +
        `opponent spread ${equity.opponentSpread}`
    );
    console.log(
      `  rests: closest two of one player ${equity.restGap ?? 'n/a (one rest each)'} rounds apart, ` +
        `target ${equity.restGapTarget ?? 'n/a'} (${equity.restSpaced ? 'met' : 'not met'}); ` +
        `court visits per player per court ${visits.min}..${visits.max}; ` +
        `seed ${found.seed} (offset +${found.k}; ${found.rejected} of ${SEED_CANDIDATES} seeds rejected)`
    );
    if (!checkOnly) {
      const name = `${N}p${N}r`;
      const file = join(SCHEDULE_DIR, `${name}.js`);
      writeFileSync(
        file,
        '// Generated by scheduler/engine/sitout-generate.mjs: do not edit by hand.\n' +
          `window.schedule${name} = ${JSON.stringify(schedule, null, 2)}\n`
      );
      console.log(`  wrote ${relative(process.cwd(), file)}`);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
